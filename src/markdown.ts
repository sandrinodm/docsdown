import { load } from 'cheerio';
import type { Root } from 'mdast';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { isMediaUrl, markdownRelativePath } from './paths.js';

/**
 * Normalized Markdown plus the resources discovered while parsing it.
 */
export interface MarkdownDocument {
  /**
   * Serialized Markdown with rewritten local links and a final newline.
   */
  readonly markdown: string;

  /**
   * Frontmatter title or first Markdown heading, when the document supplies one.
   */
  readonly title: string | undefined;

  /**
   * Unique HTTP(S) page links resolved against the source page.
   */
  readonly links: ReadonlyArray<URL>;

  /**
   * Unique HTTP(S) image and video resources referenced by the document.
   */
  readonly media: ReadonlyArray<URL>;
}

/**
 * One source document and its archive destination.
 */
export interface LocalDocumentInput {
  /**
   * Syntax supplied by the source provider.
   */
  readonly format: 'html' | 'markdown' | 'mdx';

  /**
   * Unmodified source text.
   */
  readonly source: string;

  /**
   * Canonical source URL used to resolve relative references.
   */
  readonly url: URL;

  /**
   * Absolute destination of the localized Markdown file.
   */
  readonly file: string;
}

/**
 * Provider-owned archive mapping consumed by document localization.
 */
export interface LocalizationPolicy {
  /**
   * Resolves an in-scope page URL to its local destination, or rejects it as out of scope.
   */
  readonly pageFile: (url: URL) => string | undefined;

  /**
   * Resolves a downloadable media URL to its local destination.
   */
  readonly mediaFile: (url: URL) => string | undefined;
}

/**
 * Archive-specific resolvers used while localizing one Markdown document.
 */
interface RewriteContext {
  /**
   * Whether the source uses MDX syntax that must preserve JSX and expressions.
   */
  readonly mdx?: boolean;

  /**
   * Canonical source URL used to resolve relative references.
   */
  readonly pageUrl: URL;

  /**
   * Absolute destination of the page currently being rewritten.
   */
  readonly pageFile: string;

  /**
   * Resolves an in-scope page URL to its local destination, or rejects it as out of scope.
   */
  readonly resolvePageFile: (url: URL) => string | undefined;

  /**
   * Resolves a downloadable media URL to its local destination.
   */
  readonly resolveMediaFile: (url: URL) => string | undefined;

  /**
   * Distinguishes direct media links from crawlable page links.
   */
  readonly isMediaUrl: (url: URL) => boolean;

  /**
   * Produces a portable relative link from one archive file to another.
   */
  readonly relativePath: (from: string, to: string) => string;
}

/**
 * GFM-aware parser and serializer shared by native Markdown inputs.
 */
const markdownProcessor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm).use(remarkStringify, {
  bullet: '-',
  fences: true,
  listItemIndent: 'one',
});

/**
 * MDX-aware parser and serializer used only for `.mdx` repository sources.
 */
const mdxProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    fences: true,
    listItemIndent: 'one',
  });

/**
 * HTML-to-Markdown pipeline used after the relevant documentation fragment has been extracted.
 */
const htmlProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark, { document: false })
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    fences: true,
    listItemIndent: 'one',
  });

/**
 * Resolves a reference to HTTP(S), rejecting empty, malformed, and non-downloadable schemes.
 */
const asHttpUrl = (value: string, base: URL): URL | undefined => {
  const destination = value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
  if (!destination || /^(?:data|mailto|tel|javascript):/i.test(destination)) return undefined;
  try {
    const url = new URL(destination, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url;
  } catch {
    return undefined;
  }
};

/**
 * Deduplicates URLs by absolute href while preserving discovery order.
 */
const uniqueUrls = (urls: Iterable<URL>): Array<URL> => {
  const seen = new Set<string>();
  const result: Array<URL> = [];
  for (const url of urls) {
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    result.push(url);
  }
  return result;
};

/**
 * Removes documentation-generator annotations from a human-readable page title.
 */
const normalizeTitle = (value: string): string | undefined => {
  const title = value
    .replace(/\s*\{(?:#[^}]+|\/\*[^}]*\*\/|\/\/)\}\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return title || undefined;
};

/**
 * Reads a scalar `title` from leading YAML frontmatter without interpreting unrelated metadata.
 */
const frontmatterTitle = (source: string): string | undefined => {
  const frontmatter = source.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  const rawTitle = frontmatter?.match(/^title:[ \t]*(.*?)[ \t]*$/mu)?.[1];
  if (!rawTitle || rawTitle === '|' || rawTitle === '>') return undefined;

  let title = rawTitle;
  if (rawTitle.startsWith('"') && rawTitle.endsWith('"')) {
    try {
      const parsed = JSON.parse(rawTitle) as unknown;
      if (typeof parsed === 'string') title = parsed;
    } catch {
      title = rawTitle.slice(1, -1);
    }
  } else if (rawTitle.startsWith("'") && rawTitle.endsWith("'")) {
    title = rawTitle.slice(1, -1).replace(/''/gu, "'");
  }

  return normalizeTitle(title);
};

/**
 * Selects the first candidate from an HTML `srcset` attribute.
 *
 * Asset selection deliberately ignores density and width hints because every candidate represents the same content.
 */
const firstSrcsetUrl = (value: string | undefined): string | undefined => value?.split(',')[0]?.trim().split(/\s+/)[0];

/**
 * Localizes links inside raw HTML nodes that remain embedded in Markdown.
 *
 * Discovered page and media URLs are appended to the supplied collections for crawl scheduling.
 */
const rewriteHtmlAttributes = (html: string, context: RewriteContext, links: Array<URL>, media: Array<URL>): string => {
  const $ = load(html, null, false);
  $('a[href]').each((_, element) => {
    const url = asHttpUrl($(element).attr('href') as string, context.pageUrl);
    if (!url) return;
    links.push(url);
    const local = context.resolvePageFile(url);
    if (local) {
      $(element).attr('href', `${context.relativePath(context.pageFile, local)}${url.hash}`);
    }
  });
  $('img, video, source').each((_, element) => {
    const source =
      $(element).attr('src') ||
      $(element).attr('data-src') ||
      $(element).attr('data-lazy-src') ||
      firstSrcsetUrl($(element).attr('srcset'));
    const url = asHttpUrl(source ?? '', context.pageUrl);
    if (!url) return;
    media.push(url);
    const local = context.resolveMediaFile(url);
    if (local) $(element).attr('src', context.relativePath(context.pageFile, local));
  });
  $('video[poster]').each((_, element) => {
    const url = asHttpUrl($(element).attr('poster') as string, context.pageUrl);
    if (!url) return;
    media.push(url);
    const local = context.resolveMediaFile(url);
    if (local) $(element).attr('poster', context.relativePath(context.pageFile, local));
  });
  return $.root().html() as string;
};

/**
 * Parses Markdown, discovers resources, and rewrites resolvable links to local archive paths.
 *
 * Fenced code is untouched because rewriting operates on semantic MDAST link, image, definition, and HTML nodes.
 */
const rewriteMarkdown = (source: string, context: RewriteContext): MarkdownDocument => {
  const processor = context.mdx ? mdxProcessor : markdownProcessor;
  const tree = processor.parse(source) as Root;
  const links: Array<URL> = [];
  const media: Array<URL> = [];

  /**
   * Rewrites one link-like MDAST node and classifies its target for crawling or media download.
   */
  const rewriteLink = (node: { url: string }): void => {
    const url = asHttpUrl(node.url, context.pageUrl);
    if (!url) return;
    const mediaFile = context.isMediaUrl(url) ? context.resolveMediaFile(url) : undefined;
    if (mediaFile) {
      media.push(url);
      node.url = context.relativePath(context.pageFile, mediaFile);
      return;
    }
    links.push(url);
    const pageFile = context.resolvePageFile(url);
    if (pageFile) node.url = `${context.relativePath(context.pageFile, pageFile)}${url.hash}`;
  };
  visit(tree, 'link', rewriteLink);
  visit(tree, 'definition', rewriteLink);

  visit(tree, 'image', (node: { url: string }) => {
    const url = asHttpUrl(node.url, context.pageUrl);
    if (!url) return;
    media.push(url);
    const mediaFile = context.resolveMediaFile(url);
    if (mediaFile) node.url = context.relativePath(context.pageFile, mediaFile);
  });

  visit(tree, 'html', (node: { value: string }) => {
    node.value = rewriteHtmlAttributes(node.value, context, links, media);
  });

  const firstHeading = tree.children.find((node) => node.type === 'heading');
  let headingTitle: string | undefined;
  if (firstHeading?.type === 'heading') {
    headingTitle = normalizeTitle(
      firstHeading.children
        .filter((node) => node.type === 'text' || node.type === 'inlineCode')
        .map((node) => String(node.value))
        .join('')
    );
  }
  const metadataTitle = frontmatterTitle(source);
  const title =
    metadataTitle?.toLowerCase() === 'index' ? (headingTitle ?? metadataTitle) : (metadataTitle ?? headingTitle);

  return {
    markdown: processor.stringify(tree).trimEnd() + '\n',
    title,
    links: uniqueUrls(links),
    media: uniqueUrls(media),
  };
};

/**
 * Extracts the most likely documentation body and title from a complete HTML response.
 *
 * Navigation, scripts, forms, and other non-content elements are removed before selector ranking.
 */
const preferredContent = (html: string): { readonly content: string; readonly title?: string } => {
  const $ = load(html);
  const title = $('main h1, article h1, h1').first().text().trim() || $('title').first().text().trim() || undefined;
  $('script, style, noscript, template, nav, footer, form, button, svg').remove();
  $('i:empty, em:empty, strong:empty, b:empty').remove();
  const selectors = [
    'main',
    'article',
    "[role='main']",
    '.theme-doc-markdown',
    '.vp-doc',
    '.docs-content',
    '.markdown-body',
  ];
  for (const selector of selectors) {
    const candidate = $(selector).first();
    if (candidate.length > 0 && candidate.text().trim().length > 0) {
      return { content: candidate.html() as string, ...(title ? { title } : {}) };
    }
  }
  return { content: $('body').html() as string, ...(title ? { title } : {}) };
};

/**
 * Converts an HTML response to GFM Markdown after resolving page and media references to absolute URLs.
 *
 * Video elements become poster images and ordinary links so their assets survive Markdown serialization.
 */
const htmlToMarkdown = (html: string, pageUrl: URL): { readonly markdown: string; readonly title?: string } => {
  const { content, title } = preferredContent(html);
  const $ = load(content, null, false);

  $('a[href]').each((_, element) => {
    const url = asHttpUrl($(element).attr('href') as string, pageUrl);
    if (url) $(element).attr('href', url.href);
  });
  $('img').each((_, element) => {
    const source =
      $(element).attr('src') ||
      $(element).attr('data-src') ||
      $(element).attr('data-lazy-src') ||
      firstSrcsetUrl($(element).attr('srcset'));
    const url = source ? asHttpUrl(source, pageUrl) : undefined;
    if (url) $(element).attr('src', url.href);
  });
  $('video, video source').each((_, element) => {
    const source = $(element).attr('src') || firstSrcsetUrl($(element).attr('srcset'));
    const url = asHttpUrl(source ?? '', pageUrl);
    if (url) $(element).attr('src', url.href);
  });
  $('video[poster]').each((_, element) => {
    const url = asHttpUrl($(element).attr('poster') as string, pageUrl);
    if (url) $(element).attr('poster', url.href);
  });

  $('video').each((_, element) => {
    const video = $(element);
    const poster = video.attr('poster');
    const sources = [
      video.attr('src'),
      ...video
        .find('source[src]')
        .map((__, source) => $(source).attr('src'))
        .get(),
    ].filter((value): value is string => Boolean(value));
    const replacement = $('<div></div>');
    if (poster) {
      replacement.append($('<img>').attr('src', poster).attr('alt', 'Video poster'));
    }
    for (const source of sources) {
      replacement.append($('<a>Video</a>').attr('href', source));
    }
    video.replaceWith(replacement);
  });

  return {
    markdown: String(htmlProcessor.processSync($.root().html() as string)).trimEnd(),
    ...(title ? { title } : {}),
  };
};

/**
 * Converts, parses, discovers, and rewrites one source document through a provider localization policy.
 *
 * HTML title extraction takes precedence over a converted Markdown heading, matching website archive behavior.
 */
export const localizeDocument = (document: LocalDocumentInput, policy: LocalizationPolicy): MarkdownDocument => {
  const converted =
    document.format === 'html'
      ? htmlToMarkdown(document.source, document.url)
      : { markdown: document.source, title: undefined };
  const localized = rewriteMarkdown(converted.markdown, {
    mdx: document.format === 'mdx',
    pageUrl: document.url,
    pageFile: document.file,
    resolvePageFile: policy.pageFile,
    resolveMediaFile: policy.mediaFile,
    isMediaUrl,
    relativePath: markdownRelativePath,
  });
  return converted.title ? { ...localized, title: converted.title } : localized;
};

import * as path from 'node:path';
import { load } from 'cheerio';
import { Console, Effect, Result } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import { runArchive } from './archive-run.js';
import { DownloadError, parseInput } from './errors.js';
import { extractLlmsIndexLinks, llmsIndexCandidates, looksLikeLlmsIndex } from './llms-index.js';
import { localizeDocument, resolveHttpReference, type LocalizationPolicy } from './markdown.js';
import {
  isInScope,
  isMediaUrl,
  markdownSuffixUrl,
  mediaFilePath,
  normalizeUrl,
  pageFilePath,
  safeDecode,
  scopePathFor,
} from './paths.js';
import { packageUserAgent } from './package.js';
import type { DownloadOptions, DownloadStrategy } from './providers.js';

/**
 * Ordered acquisition strategies from lossless native Markdown to converted HTML.
 */
type DocumentStrategy = Exclude<DownloadStrategy, 'github-raw'>;

/**
 * Successful source response selected for one documentation page.
 */
interface DocumentSource {
  /**
   * Unmodified response body supplied to the Markdown normalization pipeline.
   */
  readonly body: string;

  /**
   * Lower-cased response content type retained for archive provenance.
   */
  readonly contentType: string;

  /**
   * Probe that produced the selected response.
   */
  readonly strategy: DocumentStrategy;
}

/**
 * Minimal text response retained across document probes.
 */
interface HttpTextResponse {
  /**
   * HTTP status code used to determine whether the probe succeeded.
   */
  readonly status: number;

  /**
   * Normalized content type used to distinguish Markdown from HTML.
   */
  readonly contentType: string;

  /**
   * Decoded response text.
   */
  readonly body: string;
}

/**
 * Successfully discovered LLM index plus the page references extracted from its structural entries.
 */
interface LlmsIndexResult {
  /**
   * Conventional index filename, retained at the corresponding archive path.
   */
  readonly filename: 'llms.txt' | 'llms-full.txt';

  /**
   * Canonical source URL.
   */
  readonly url: URL;

  /**
   * Unmodified remote content written to the archive.
   */
  readonly body: string;

  /**
   * Structured page references contributed to crawl discovery.
   */
  readonly links: ReadonlyArray<URL>;
}

/**
 * Executes one textual HTTP request with the package user agent and caller-selected accept header.
 */
const requestText = Effect.fnUntraced(function* (url: URL, accept: string) {
  const response = yield* HttpClient.get(url, { headers: { accept, 'user-agent': packageUserAgent } });
  const body = yield* response.text;

  return {
    status: response.status,
    contentType: response.headers['content-type']?.toLowerCase() ?? '',
    body,
  } satisfies HttpTextResponse;
});

/**
 * Converts transport and response-body failures into a missing probe so fallback strategies can continue.
 */
const optionalRequestText = (url: URL, accept: string) =>
  requestText(url, accept).pipe(Effect.catch(() => Effect.succeed(undefined)));

/**
 * Narrows optional probe responses to the HTTP success range.
 */
const isSuccess = (response: HttpTextResponse | undefined): response is HttpTextResponse =>
  response !== undefined && response.status >= 200 && response.status < 300;

/**
 * Probes optional root and selected-scope LLM indexes without turning absence into a crawl failure.
 */
const discoverLlmsIndexes = Effect.fnUntraced(function* (startUrl: URL, scopePath: string, concurrency: number) {
  const responses = yield* Effect.forEach(
    llmsIndexCandidates(startUrl, scopePath),
    (candidate) =>
      optionalRequestText(candidate.url, 'text/markdown, text/plain;q=0.9').pipe(
        Effect.map((response) => ({ ...candidate, response }))
      ),
    { concurrency }
  );

  const indexes: Array<LlmsIndexResult> = [];
  for (const { filename, url, response } of responses) {
    // Soft-404 pages return 200 with HTML, so the body itself must look like an index.
    if (!isSuccess(response) || !looksLikeLlmsIndex(response.body)) {
      continue;
    }

    indexes.push({ filename, url, body: response.body, links: extractLlmsIndexLinks(response.body, url, filename) });
  }

  return indexes;
});

/**
 * Recognizes registered and conventional Markdown response media types.
 */
const isMarkdownContentType = (contentType: string): boolean =>
  /(?:text|application)\/(?:x-)?markdown\b/.test(contentType);

/**
 * Detects complete HTML documents without misclassifying ordinary Markdown that embeds small HTML fragments.
 */
const looksLikeHtml = (body: string): boolean => /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(body.slice(0, 2_000));

/**
 * Detects unresolved image variables that require the rendered HTML representation.
 */
const hasImagePlaceholders = (body: string): boolean => /\{__img\d+\}/u.test(body);

/**
 * Pairs a successful probe response with the strategy that produced it.
 */
const documentSource = (response: HttpTextResponse, strategy: DocumentStrategy): DocumentSource => ({
  body: response.body,
  contentType: response.contentType,
  strategy,
});

/**
 * Whether a response body is usable Markdown rather than an HTML page or an unrendered template.
 *
 * Plain-text bodies count as Markdown because many documentation hosts serve `.md` files as `text/plain`.
 */
const isUsableMarkdown = (response: HttpTextResponse, requireMarkdownContentType: boolean): boolean => {
  const declaredMarkdown = isMarkdownContentType(response.contentType);
  const looksLikeMarkdown = declaredMarkdown || (!requireMarkdownContentType && !looksLikeHtml(response.body));
  return looksLikeMarkdown && !hasImagePlaceholders(response.body);
};

/**
 * Selects the best available representation of a page, trying each strategy in order:
 *
 * 1. `page.md`, accepting Markdown or non-HTML plain text.
 * 2. The page itself with `Accept: text/markdown`, accepting only a Markdown content type.
 * 3. The page itself as HTML, which is converted unless the server answered with Markdown after all.
 */
const fetchDocument = Effect.fn('fetchDocument')(function* (url: URL) {
  const suffixResponse = yield* optionalRequestText(
    markdownSuffixUrl(url),
    'text/markdown, text/plain;q=0.9, text/html;q=0.2'
  );
  if (isSuccess(suffixResponse) && isUsableMarkdown(suffixResponse, false)) {
    return documentSource(suffixResponse, 'markdown-suffix');
  }

  const negotiatedResponse = yield* optionalRequestText(url, 'text/markdown');
  if (isSuccess(negotiatedResponse) && isUsableMarkdown(negotiatedResponse, true)) {
    return documentSource(negotiatedResponse, 'markdown-content-negotiation');
  }

  const htmlResponse = yield* optionalRequestText(url, 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5');
  if (!isSuccess(htmlResponse)) {
    const statuses = [suffixResponse, negotiatedResponse, htmlResponse]
      .filter((response) => response !== undefined)
      .map((response) => response.status)
      .join(', ');
    return yield* new DownloadError({
      url: url.href,
      message: `Unable to download ${url.href}${statuses ? ` (HTTP ${statuses})` : ''}`,
    });
  }

  const servedMarkdown = isMarkdownContentType(htmlResponse.contentType) || !looksLikeHtml(htmlResponse.body);
  return documentSource(htmlResponse, servedMarkdown ? 'markdown-content-negotiation' : 'html-conversion');
});

/**
 * Extracts crawl links from an HTML representation without replacing preferred native Markdown content.
 */
const extractHtmlLinks = (html: string, base: URL): ReadonlyArray<URL> => {
  const $ = load(html);
  const links: Array<URL> = [];
  $('a[href]').each((_, element) => {
    const url = resolveHttpReference($(element).attr('href') as string, base);
    if (url) {
      links.push(url);
    }
  });
  return links;
};

/**
 * Requests an HTML representation and extracts its complete navigation surface.
 */
const discoverHtmlLinks = Effect.fnUntraced(function* (url: URL) {
  const response = yield* optionalRequestText(url, 'text/html,application/xhtml+xml;q=0.9');
  if (!isSuccess(response) || !looksLikeHtml(response.body)) {
    return [];
  }

  return extractHtmlLinks(response.body, url);
});

/**
 * Collapses common documentation page aliases for crawl deduplication while preserving the fetched URL.
 */
const crawlPageKey = (url: URL): string => {
  const canonical = new URL(url);
  canonical.hash = '';
  canonical.pathname =
    canonical.pathname
      .replace(/\/index\.(?:html?|md|markdown)$/iu, '/')
      .replace(/\.(?:html?|md|markdown)$/iu, '')
      .replace(/\/+$/u, '') || '/';

  return canonical.href;
};

/**
 * Maps a page to the archive file shared by every alias collapsed by {@link crawlPageKey}.
 *
 * Using one canonical destination keeps rewritten links consistent no matter which alias (`/guide`, `/guide/`,
 * `/guide.md`, or `/guide/index.html`) was crawled first and which alias another page links to.
 */
const pageDestination = (rootDirectory: string, url: URL): string =>
  pageFilePath(rootDirectory, new URL(crawlPageKey(url)));

/**
 * Identifies infrastructure endpoints that appear as links but do not represent documentation pages.
 */
const isIgnoredCrawlUrl = (url: URL): boolean => /\/cdn-cgi\/l\/email-protection\/?$/u.test(url.pathname);

/**
 * Resolves an immediate HTML meta refresh used by static documentation entry pages.
 */
const htmlRefreshTarget = (body: string, base: URL): URL | undefined => {
  const $ = load(body);
  const content = $('meta[http-equiv]')
    .filter((_, element) => $(element).attr('http-equiv')?.toLowerCase() === 'refresh')
    .first()
    .attr('content');

  // The attribute looks like `0; url=/target`, optionally with the URL in quotes.
  const rawTarget = content?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/iu)?.[1];
  if (!rawTarget) {
    return undefined;
  }

  const target = rawTarget.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2');

  try {
    const url = new URL(target, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Serializes frontmatter scalar values using JSON's YAML-compatible string escaping.
 */
const yamlString = (value: string): string => JSON.stringify(value);

/**
 * Prepends source provenance to normalized Markdown without changing its leading content.
 */
const withFrontmatter = (
  markdown: string,
  options: {
    readonly source: URL;
    readonly title: string;
    readonly contentType: string;
    readonly strategy: DocumentStrategy;
  }
): string => {
  const fields = [
    '---',
    `source: ${yamlString(options.source.href)}`,
    `title: ${yamlString(options.title)}`,
    `downloaded_at: ${yamlString(new Date().toISOString())}`,
    `content_type: ${yamlString(options.contentType || 'unknown')}`,
    `download_strategy: ${yamlString(options.strategy)}`,
    '---',
    '',
  ];

  return `${fields.join('\n')}${markdown.trimStart()}`;
};

/**
 * Derives a readable title from the final URL segment when source content provides none.
 */
const fallbackTitle = (url: URL): string => {
  const lastSegment = url.pathname.split('/').filter(Boolean).at(-1);
  const value = lastSegment ? safeDecode(lastSegment) : url.hostname;

  return (
    value
      .replace(/\.(?:html?|md|markdown)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || url.href
  );
};

/**
 * Breadth-first crawl queue that admits each page once, whichever alias it is reached through.
 */
const makeCrawlFrontier = (startUrl: URL, scopePath: string) => {
  const pending: Array<URL> = [startUrl];
  const seen = new Set([crawlPageKey(startUrl)]);
  let dispatched = 0;

  return {
    /**
     * Whether discovered pages are still waiting to be crawled.
     */
    hasPending: (): boolean => pending.length > 0,

    /**
     * Marks a URL as handled without crawling it, such as a preserved `llms.txt` index.
     */
    exclude: (url: URL): void => {
      seen.add(crawlPageKey(url));
    },

    /**
     * Queues an in-scope page link unless it is media, an infrastructure endpoint, or an alias already seen.
     */
    enqueue: (link: URL): void => {
      const url = new URL(link);
      url.hash = '';

      const key = crawlPageKey(url);
      if (!isInScope(url, startUrl, scopePath) || isMediaUrl(url) || isIgnoredCrawlUrl(url) || seen.has(key)) {
        return;
      }

      seen.add(key);
      pending.push(url);
    },

    /**
     * Removes up to `size` pages, never dispatching more than `maxPages` pages over the whole crawl.
     */
    takeBatch: (size: number, maxPages: number | undefined): Array<URL> => {
      const remaining = maxPages === undefined ? size : Math.min(size, maxPages - dispatched);
      const batch = pending.splice(0, remaining);

      dispatched += batch.length;
      return batch;
    },
  };
};

/**
 * Archives one documentation subtree, localizes its media, and finalizes safe ownership metadata.
 *
 * Cleanup occurs only after a failure-free, untruncated crawl. The returned Effect requires filesystem and HTTP adapters.
 */
export const downloadSite = Effect.fn('downloadSite')(function* (options: DownloadOptions) {
  const startUrl = yield* parseInput(() => normalizeUrl(options.url));
  const scopePath = scopePathFor(startUrl);
  const rootDirectory = path.resolve(options.outputDirectory);

  const frontier = makeCrawlFrontier(startUrl, scopePath);
  const localizationPolicy: LocalizationPolicy = {
    /**
     * Maps crawlable in-scope pages to their archive destinations.
     */
    pageFile: (url) =>
      isInScope(url, startUrl, scopePath) && !isMediaUrl(url) ? pageDestination(rootDirectory, url) : undefined,
    /**
     * Maps referenced media to the archive's origin-aware media hierarchy.
     */
    mediaFile: (url) => mediaFilePath(rootDirectory, url),
  };

  /**
   * Explains why an `llms.txt` reference cannot join the crawl, or returns `undefined` when it can.
   */
  const indexLinkSkipReason = (link: URL): string | undefined => {
    if (link.origin !== startUrl.origin) {
      return `outside allowed origin ${startUrl.origin}`;
    }

    if (!isInScope(link, startUrl, scopePath)) {
      return `outside allowed path ${scopePath}`;
    }

    return undefined;
  };

  /**
   * Fetches a page, following an in-scope HTML meta refresh to the document it points at.
   *
   * Returns the source together with the URL its relative links must be resolved against.
   */
  const fetchPageSource = Effect.fnUntraced(function* (url: URL) {
    const source = yield* fetchDocument(url);
    if (source.strategy !== 'html-conversion') {
      return { source, sourceUrl: url };
    }

    const refreshTarget = htmlRefreshTarget(source.body, url);
    if (!refreshTarget || refreshTarget.href === url.href || !isInScope(refreshTarget, startUrl, scopePath)) {
      return { source, sourceUrl: url };
    }

    return { source: yield* fetchDocument(refreshTarget), sourceUrl: refreshTarget };
  });

  return yield* runArchive(
    {
      provider: 'website',
      source: startUrl.href,
      scopePath,
      scopePaths: [scopePath],
      outputDirectory: rootDirectory,
      concurrency: options.concurrency,
      maxMediaBytes: options.maxMediaBytes,
      cleanupEnabled: !options.keepStale,
      strategyKeys: ['markdown-suffix', 'markdown-content-negotiation', 'html-conversion'],
      ...(options.verbose
        ? {
            /**
             * Reports recoverable media failures without changing the run result.
             */
            onMediaFailure: (failure: { readonly url: string; readonly message: string }) =>
              Console.log(`Skipped media ${failure.url}: ${failure.message}`),
          }
        : {}),
    },
    (archive) =>
      Effect.gen(function* () {
        let hasSuccessfulPage = false;
        let nextPageOrder = 0;
        let nextMediaOrder = 0;

        /**
         * Preserves discovered `llms.txt` indexes and queues the in-scope pages they reference.
         */
        const archiveLlmsIndexes = Effect.fnUntraced(function* () {
          const indexes = yield* discoverLlmsIndexes(startUrl, scopePath, options.concurrency);
          const warned = new Set<string>();
          for (const [order, index] of indexes.entries()) {
            yield* archive.writeIndex({
              url: index.url.href,
              order,
              dedupeKey: `website-index:${index.url.href}`,
              destination: pageFilePath(rootDirectory, index.url),
              content: index.body,
            });

            frontier.exclude(index.url);
            for (const reference of index.links) {
              const link = new URL(reference);
              link.hash = '';
              const skipReason = indexLinkSkipReason(link);
              if (skipReason === undefined) {
                frontier.enqueue(link);
              } else if (!warned.has(link.href)) {
                warned.add(link.href);
                yield* Console.warn(`Skipped LLM index reference ${link.href} from ${index.url.href}: ${skipReason}`);
              }
            }
          }
        });

        /**
         * Fetches, localizes, and archives one page together with its media.
         *
         * Returns every link found on the page, including HTML navigation when the content came from Markdown.
         */
        const processPage = Effect.fnUntraced(function* (url: URL, order: number) {
          if (options.verbose) {
            yield* Console.log(`Fetching ${url.href}`);
          }

          const { source, sourceUrl } = yield* fetchPageSource(url);
          const isHtml = source.strategy === 'html-conversion';
          const pageFile = pageDestination(rootDirectory, url);
          const localized = localizeDocument(
            { format: isHtml ? 'html' : 'markdown', source: source.body, url: sourceUrl, file: pageFile },
            localizationPolicy
          );

          // Orders are reserved before dispatch so each page claims a contiguous, deterministic block.
          const mediaDispatches = localized.media.map((mediaUrl) => ({ mediaUrl, order: nextMediaOrder++ }));
          yield* Effect.forEach(
            mediaDispatches,
            ({ mediaUrl, order }) =>
              archive.downloadMedia({
                url: mediaUrl.href,
                order,
                dedupeKey: `website-media:${mediaUrl.href}`,
                destination: mediaFilePath(rootDirectory, mediaUrl),
                headers: { accept: 'image/*,video/*,*/*;q=0.1', 'user-agent': packageUserAgent },
              }),
            { concurrency: options.concurrency }
          );

          const title = localized.title ?? fallbackTitle(url);
          yield* archive.writePage({
            url: url.href,
            title,
            strategy: source.strategy,
            order,
            dedupeKey: `website-page:${url.href}`,
            destination: pageFile,
            content: withFrontmatter(localized.markdown, {
              source: url,
              title,
              contentType: source.contentType,
              strategy: source.strategy,
            }),
          });
          if (!options.verbose) {
            yield* Console.log(`Downloaded ${url.href}`);
          }

          if (options.singlePage) {
            return [];
          }

          const navigationLinks = isHtml
            ? extractHtmlLinks(source.body, sourceUrl)
            : yield* discoverHtmlLinks(sourceUrl);
          return [...navigationLinks, ...localized.links];
        });

        if (!options.singlePage) {
          yield* archiveLlmsIndexes();
        }

        // Pages are crawled in breadth-first batches; links found in one batch feed the next.
        while (frontier.hasPending()) {
          const batch = frontier.takeBatch(options.concurrency, options.maxPages);
          if (batch.length === 0) {
            break;
          }

          const results = yield* Effect.forEach(
            batch.map((url) => ({ url, order: nextPageOrder++ })),
            ({ url, order }) => Effect.result(processPage(url, order)).pipe(Effect.map((result) => ({ url, result }))),
            { concurrency: options.concurrency }
          );

          for (const { url, result } of results) {
            if (Result.isFailure(result)) {
              const message = result.failure.message;
              yield* archive.recordFailure({ url: url.href, message });
              yield* Console.log(`Failed ${url.href}: ${message}`);
              continue;
            }

            hasSuccessfulPage = true;
            for (const link of result.success) {
              frontier.enqueue(link);
            }
          }
        }

        if (!hasSuccessfulPage) {
          return yield* new DownloadError({
            url: startUrl.href,
            message: `No pages could be downloaded from ${startUrl.href}`,
          });
        }

        return { truncated: frontier.hasPending() };
      })
  );
});

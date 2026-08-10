import * as path from 'node:path';
import { load } from 'cheerio';
import { Console, Effect } from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import { runArchive } from './archive-run.js';
import { extractLlmsIndexLinks, llmsIndexCandidates, looksLikeLlmsIndex } from './llms-index.js';
import { localizeDocument, resolveHttpReference, type LocalizationPolicy } from './markdown.js';
import {
  isInScope,
  isMediaUrl,
  markdownSuffixUrl,
  mediaFilePath,
  normalizeUrl,
  pageFilePath,
  scopePathFor,
} from './paths.js';
import { packageUserAgent } from './package.js';
import type { DownloadOptions, DownloadStrategy, DownloadSummary } from './providers.js';

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
 * Internal result used to update the crawl queue after one page completes.
 */
interface PageResult {
  /**
   * Unique page links discovered while rewriting the document.
   */
  readonly links: ReadonlyArray<URL>;
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
const requestText = (url: URL, accept: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url, {
      headers: {
        accept,
        'user-agent': packageUserAgent,
      },
    });
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
const discoverLlmsIndexes = (startUrl: URL, scopePath: string, concurrency: number) =>
  Effect.forEach(
    llmsIndexCandidates(startUrl, scopePath),
    ({ filename, url }) =>
      optionalRequestText(url, 'text/markdown, text/plain;q=0.9').pipe(
        Effect.map((response): LlmsIndexResult | undefined => {
          if (!isSuccess(response) || !looksLikeLlmsIndex(response.body)) return undefined;
          return {
            filename,
            url,
            body: response.body,
            links: extractLlmsIndexLinks(response.body, url, filename),
          };
        })
      ),
    { concurrency }
  ).pipe(Effect.map((results) => results.filter((result): result is LlmsIndexResult => result !== undefined)));

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
 * Selects the best available representation using suffix probing, Markdown negotiation, then HTML fallback.
 *
 * A successful non-HTML plain-text suffix response is accepted because many documentation hosts serve `.md` as text/plain.
 */
const fetchDocument = (url: URL) =>
  Effect.gen(function* () {
    const suffixResponse = yield* optionalRequestText(
      markdownSuffixUrl(url),
      'text/markdown, text/plain;q=0.9, text/html;q=0.2'
    );
    if (
      isSuccess(suffixResponse) &&
      (isMarkdownContentType(suffixResponse.contentType) || !looksLikeHtml(suffixResponse.body)) &&
      !hasImagePlaceholders(suffixResponse.body)
    ) {
      return {
        body: suffixResponse.body,
        contentType: suffixResponse.contentType,
        strategy: 'markdown-suffix',
      } satisfies DocumentSource;
    }

    const negotiatedResponse = yield* optionalRequestText(url, 'text/markdown');
    if (
      isSuccess(negotiatedResponse) &&
      isMarkdownContentType(negotiatedResponse.contentType) &&
      !hasImagePlaceholders(negotiatedResponse.body)
    ) {
      return {
        body: negotiatedResponse.body,
        contentType: negotiatedResponse.contentType,
        strategy: 'markdown-content-negotiation',
      } satisfies DocumentSource;
    }

    const htmlResponse = yield* optionalRequestText(url, 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5');
    if (!isSuccess(htmlResponse)) {
      const statuses = [suffixResponse, negotiatedResponse, htmlResponse]
        .filter((response): response is HttpTextResponse => response !== undefined)
        .map((response) => response.status)
        .join(', ');
      return yield* Effect.fail(new Error(`Unable to download ${url.href}${statuses ? ` (HTTP ${statuses})` : ''}`));
    }

    if (isMarkdownContentType(htmlResponse.contentType) || !looksLikeHtml(htmlResponse.body)) {
      return {
        body: htmlResponse.body,
        contentType: htmlResponse.contentType,
        strategy: 'markdown-content-negotiation',
      } satisfies DocumentSource;
    }

    return {
      body: htmlResponse.body,
      contentType: htmlResponse.contentType,
      strategy: 'html-conversion',
    } satisfies DocumentSource;
  });

/**
 * Extracts crawl links from an HTML representation without replacing preferred native Markdown content.
 */
const extractHtmlLinks = (html: string, base: URL): ReadonlyArray<URL> => {
  const $ = load(html);
  const links: Array<URL> = [];
  $('a[href]').each((_, element) => {
    const url = resolveHttpReference($(element).attr('href') as string, base);
    if (url) links.push(url);
  });
  return links;
};

/**
 * Requests an HTML representation and extracts its complete navigation surface.
 */
const discoverHtmlLinks = (url: URL) =>
  Effect.gen(function* () {
    const response = yield* optionalRequestText(url, 'text/html,application/xhtml+xml;q=0.9');
    if (!isSuccess(response) || !looksLikeHtml(response.body)) return [];
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
  const rawTarget = content?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/iu)?.[1];
  if (!rawTarget) return undefined;
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
 * Normalizes unknown failures for console and manifest reporting.
 */
const errorMessage = (error: { readonly message: string }): string => error.message;

/**
 * Derives a readable title from the final URL segment when source content provides none.
 */
const fallbackTitle = (url: URL): string => {
  const lastSegment = url.pathname.split('/').filter(Boolean).at(-1);
  const value = lastSegment ? decodeURIComponent(lastSegment) : url.hostname;
  return (
    value
      .replace(/\.(?:html?|md|markdown)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || url.href
  );
};

/**
 * Archives one documentation subtree, localizes its media, and finalizes safe ownership metadata.
 *
 * Cleanup occurs only after a failure-free, untruncated crawl. The returned Effect requires filesystem and HTTP adapters.
 */
export const downloadSite = (options: DownloadOptions) =>
  Effect.gen(function* () {
    const startUrl = normalizeUrl(options.url);
    const scopePath = scopePathFor(startUrl);
    const rootDirectory = path.resolve(options.outputDirectory);
    const queue: Array<URL> = [startUrl];
    const queued = new Set([crawlPageKey(startUrl)]);
    const completed = new Set<string>();
    const maxPages = options.maxPages;
    const localizationPolicy: LocalizationPolicy = {
      /**
       * Maps crawlable in-scope pages to their archive destinations.
       */
      pageFile: (url) =>
        isInScope(url, startUrl, scopePath) && !isMediaUrl(url) ? pageFilePath(rootDirectory, url) : undefined,
      /**
       * Maps referenced media to the archive's origin-aware media hierarchy.
       */
      mediaFile: (url) => mediaFilePath(rootDirectory, url),
    };

    const summary: DownloadSummary = yield* runArchive(
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
          const warnedIndexLinks = new Set<string>();

          if (!options.singlePage) {
            const indexes = yield* discoverLlmsIndexes(startUrl, scopePath, options.concurrency);
            for (const [order, index] of indexes.entries()) {
              yield* archive.writeIndex({
                url: index.url.href,
                order,
                dedupeKey: `website-index:${index.url.href}`,
                destination: pageFilePath(rootDirectory, index.url),
                content: index.body,
              });
              queued.add(crawlPageKey(index.url));
              for (const link of index.links) {
                link.hash = '';
                const pageKey = crawlPageKey(link);
                if (link.origin !== startUrl.origin) {
                  if (!warnedIndexLinks.has(link.href)) {
                    warnedIndexLinks.add(link.href);
                    yield* Console.warn(
                      `Skipped LLM index reference ${link.href} from ${index.url.href}: outside allowed origin ${startUrl.origin}`
                    );
                  }
                  continue;
                }
                if (!isInScope(link, startUrl, scopePath)) {
                  if (!warnedIndexLinks.has(link.href)) {
                    warnedIndexLinks.add(link.href);
                    yield* Console.warn(
                      `Skipped LLM index reference ${link.href} from ${index.url.href}: outside allowed path ${scopePath}`
                    );
                  }
                  continue;
                }
                if (isMediaUrl(link) || isIgnoredCrawlUrl(link) || queued.has(pageKey)) continue;
                queued.add(pageKey);
                queue.push(link);
              }
            }
          }

          /**
           * Fetches and localizes one page, then submits its resources to the archive module.
           */
          const processPage = (url: URL, order: number) =>
            Effect.gen(function* () {
              if (options.verbose) yield* Console.log(`Fetching ${url.href}`);
              let source = yield* fetchDocument(url);
              const pageFile = pageFilePath(rootDirectory, url);
              let localizationUrl = url;
              if (source.strategy === 'html-conversion') {
                const refreshTarget = htmlRefreshTarget(source.body, url);
                if (refreshTarget && refreshTarget.href !== url.href && isInScope(refreshTarget, startUrl, scopePath)) {
                  source = yield* fetchDocument(refreshTarget);
                  localizationUrl = refreshTarget;
                }
              }
              const localized = localizeDocument(
                {
                  format: source.strategy === 'html-conversion' ? 'html' : 'markdown',
                  source: source.body,
                  url: localizationUrl,
                  file: pageFile,
                },
                localizationPolicy
              );

              let links = localized.links;
              if (!options.singlePage) {
                const navigationLinks =
                  source.strategy === 'html-conversion'
                    ? extractHtmlLinks(source.body, localizationUrl)
                    : yield* discoverHtmlLinks(localizationUrl);
                links = [...navigationLinks, ...links];
              }

              const mediaDispatches = localized.media.map((url) => ({ url, order: nextMediaOrder++ }));
              yield* Effect.forEach(
                mediaDispatches,
                ({ url: mediaUrl, order }) =>
                  archive.downloadMedia({
                    url: mediaUrl.href,
                    order,
                    dedupeKey: `website-media:${mediaUrl.href}`,
                    destination: mediaFilePath(rootDirectory, mediaUrl),
                    headers: {
                      accept: 'image/*,video/*,*/*;q=0.1',
                      'user-agent': packageUserAgent,
                    },
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
              if (!options.verbose) yield* Console.log(`Downloaded ${url.href}`);
              return {
                links,
              } satisfies PageResult;
            });

          while (queue.length > 0 && (maxPages === undefined || completed.size < maxPages)) {
            const available = maxPages === undefined ? options.concurrency : maxPages - completed.size;
            const batch = queue.splice(0, Math.min(options.concurrency, available));
            for (const url of batch) completed.add(crawlPageKey(url));
            const dispatches = batch.map((url) => ({ url, order: nextPageOrder++ }));

            const results = yield* Effect.forEach(
              dispatches,
              ({ url, order }) =>
                processPage(url, order).pipe(
                  Effect.map((page) => ({ ok: true as const, page })),
                  Effect.catch((error) =>
                    Effect.succeed({
                      ok: false as const,
                      url,
                      message: errorMessage(error),
                    })
                  )
                ),
              { concurrency: options.concurrency }
            );

            for (const result of results) {
              if (!result.ok) {
                yield* archive.recordFailure({ url: result.url.href, message: result.message });
                yield* Console.log(`Failed ${result.url.href}: ${result.message}`);
                continue;
              }
              hasSuccessfulPage = true;
              if (options.singlePage) continue;
              for (const link of result.page.links) {
                link.hash = '';
                const pageKey = crawlPageKey(link);
                if (
                  !isInScope(link, startUrl, scopePath) ||
                  isMediaUrl(link) ||
                  isIgnoredCrawlUrl(link) ||
                  queued.has(pageKey) ||
                  completed.has(pageKey)
                )
                  continue;
                queued.add(pageKey);
                queue.push(link);
              }
            }
          }

          if (!hasSuccessfulPage) {
            return yield* Effect.fail(new Error(`No pages could be downloaded from ${startUrl.href}`));
          }

          return { truncated: queue.length > 0 };
        })
    );

    return summary;
  });

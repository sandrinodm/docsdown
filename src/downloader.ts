import * as path from 'node:path';
import { Console, Effect, FileSystem } from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import { describeArchiveFile, finalizeManifest, type ArchiveFile } from './manifest.js';
import { htmlToMarkdown, rewriteMarkdown, type MarkdownDocument } from './markdown.js';
import {
  isInScope,
  isMediaUrl,
  markdownRelativePath,
  markdownSuffixUrl,
  mediaFilePath,
  normalizeUrl,
  pageFilePath,
  scopePathFor,
} from './paths.js';
import { packageUserAgent } from './package.js';

/**
 * Crawl limits, output policy, and diagnostics selected by the CLI caller.
 */
export interface DownloadOptions {
  /**
   * Starting documentation URL; bare hostnames are interpreted as HTTPS.
   */
  readonly url: string;

  /**
   * Exact destination directory for this documentation archive.
   */
  readonly outputDirectory: string;

  /**
   * Maximum number of simultaneous page or media requests.
   */
  readonly concurrency: number;

  /**
   * Hard crawl limit that prevents unbounded site traversal.
   */
  readonly maxPages: number;

  /**
   * Per-asset byte limit enforced against both declared and actual response sizes.
   */
  readonly maxMediaBytes: number;

  /**
   * Whether to archive only the starting page without following discovered links.
   */
  readonly singlePage: boolean;

  /**
   * Whether stale owned files should remain available for later cleanup.
   */
  readonly keepStale: boolean;

  /**
   * Whether to print request-level progress and media failures.
   */
  readonly verbose: boolean;
}

/**
 * User-facing outcome of a completed archive attempt.
 */
export interface DownloadSummary {
  /**
   * Provider adapter that produced this archive.
   */
  readonly provider: 'website' | 'github';

  /**
   * Absolute archive directory.
   */
  readonly rootDirectory: string;

  /**
   * Number of pages written during this run.
   */
  readonly pagesDownloaded: number;

  /**
   * Number of media files written during this run.
   */
  readonly mediaDownloaded: number;

  /**
   * Number of unmodified stale files removed from the previous ownership set.
   */
  readonly filesRemoved: number;

  /**
   * Number of stale files preserved because their digest changed locally.
   */
  readonly filesPreserved: number;

  /**
   * Number of stale-file operations that failed and remain recorded for a later run.
   */
  readonly cleanupFailures: number;

  /**
   * Whether undispatched pages remained when the page limit was reached.
   */
  readonly truncated: boolean;

  /**
   * Successful immutable manifest snapshot, absent for partial runs.
   */
  readonly historyManifest: string | undefined;

  /**
   * URL and resolved title of each page written during this run.
   */
  readonly pages: ReadonlyArray<{ readonly url: string; readonly title: string }>;

  /**
   * Page, media, or request failures that made the crawl partial.
   */
  readonly failures: ReadonlyArray<{ readonly url: string; readonly message: string }>;
}

/**
 * Ordered acquisition strategies from lossless native Markdown to converted HTML.
 */
type DocumentStrategy = 'markdown-suffix' | 'markdown-content-negotiation' | 'html-conversion';

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
 * Internal result used to update crawl queues and aggregate counters after one page completes.
 */
interface PageResult {
  /**
   * Canonical page URL.
   */
  readonly url: URL;

  /**
   * Extracted heading, HTML title, or URL-derived fallback.
   */
  readonly title: string;

  /**
   * Unique page links discovered while rewriting the document.
   */
  readonly links: ReadonlyArray<URL>;

  /**
   * Number of media resources successfully written for this page.
   */
  readonly mediaCount: number;

  /**
   * Acquisition strategy recorded in the page frontmatter and run manifest.
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
 * Recognizes registered and conventional Markdown response media types.
 */
const isMarkdownContentType = (contentType: string): boolean =>
  /(?:text|application)\/(?:x-)?markdown\b/.test(contentType);

/**
 * Detects complete HTML documents without misclassifying ordinary Markdown that embeds small HTML fragments.
 */
const looksLikeHtml = (body: string): boolean => /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(body.slice(0, 2_000));

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
      (isMarkdownContentType(suffixResponse.contentType) || !looksLikeHtml(suffixResponse.body))
    ) {
      return {
        body: suffixResponse.body,
        contentType: suffixResponse.contentType,
        strategy: 'markdown-suffix',
      } satisfies DocumentSource;
    }

    const negotiatedResponse = yield* optionalRequestText(url, 'text/markdown');
    if (isSuccess(negotiatedResponse) && isMarkdownContentType(negotiatedResponse.contentType)) {
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
    if (options.concurrency < 1) return yield* Effect.fail(new Error('--concurrency must be at least 1'));
    if (options.maxPages < 1) return yield* Effect.fail(new Error('--max-pages must be at least 1'));
    if (options.maxMediaBytes < 1) return yield* Effect.fail(new Error('--max-media-mb must be greater than 0'));

    const startUrl = normalizeUrl(options.url);
    const scopePath = scopePathFor(startUrl);
    const rootDirectory = path.resolve(options.outputDirectory);
    const fileSystem = yield* FileSystem.FileSystem;
    const queue: Array<URL> = [startUrl];
    const queued = new Set([startUrl.href]);
    const completed = new Set<string>();
    const downloadedMedia = new Set<string>();
    const failures: Array<{ url: string; message: string }> = [];
    const pages: Array<{ url: string; title: string }> = [];
    const archiveFiles = new Map<string, ArchiveFile>();
    const strategies: Record<DocumentStrategy, number> = {
      'markdown-suffix': 0,
      'markdown-content-negotiation': 0,
      'html-conversion': 0,
    };

    yield* fileSystem.makeDirectory(rootDirectory, { recursive: true });

    /**
     * Resolves only in-scope non-media page URLs into this archive.
     */
    const resolvePageFile = (url: URL): string | undefined =>
      isInScope(url, startUrl, scopePath) && !isMediaUrl(url) ? pageFilePath(rootDirectory, url) : undefined;

    /**
     * Resolves HTTP(S) media from any referenced origin beneath the archive media directory.
     */
    const resolveMediaFile = (url: URL): string => mediaFilePath(rootDirectory, url);

    /**
     * Downloads one media resource, enforces its byte limit, and records its ownership digest.
     */
    const downloadMedia = (url: URL) =>
      Effect.gen(function* () {
        const destination = mediaFilePath(rootDirectory, url);
        const response = yield* HttpClient.get(url, {
          headers: {
            accept: 'image/*,video/*,*/*;q=0.1',
            'user-agent': packageUserAgent,
          },
        });
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(new Error(`HTTP ${response.status}`));
        }
        const declaredLength = Number(response.headers['content-length'] ?? '0');
        if (declaredLength > options.maxMediaBytes) {
          return yield* Effect.fail(new Error(`Media exceeds ${options.maxMediaBytes} byte limit`));
        }
        const data = new Uint8Array(yield* response.arrayBuffer);
        if (data.byteLength > options.maxMediaBytes) {
          return yield* Effect.fail(new Error(`Media exceeds ${options.maxMediaBytes} byte limit`));
        }
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.writeFile(destination, data);
        const archiveFile = describeArchiveFile(rootDirectory, destination, 'media', url.href, data);
        archiveFiles.set(archiveFile.path, archiveFile);
      });

    /**
     * Fetches, converts, localizes, and writes one page plus its newly discovered media resources.
     */
    const processPage = (url: URL) =>
      Effect.gen(function* () {
        if (options.verbose) yield* Console.log(`Fetching ${url.href}`);
        const source = yield* fetchDocument(url);
        const converted =
          source.strategy === 'html-conversion'
            ? htmlToMarkdown(source.body, url)
            : { markdown: source.body, title: undefined };
        const pageFile = pageFilePath(rootDirectory, url);
        const rewritten: MarkdownDocument = rewriteMarkdown(converted.markdown, {
          pageUrl: url,
          pageFile,
          resolvePageFile,
          resolveMediaFile,
          isMediaUrl,
          relativePath: markdownRelativePath,
        });

        const newMedia = rewritten.media.filter((mediaUrl) => {
          if (downloadedMedia.has(mediaUrl.href)) return false;
          downloadedMedia.add(mediaUrl.href);
          return true;
        });
        const mediaResults = yield* Effect.forEach(
          newMedia,
          (mediaUrl) =>
            downloadMedia(mediaUrl).pipe(
              Effect.map(() => true),
              Effect.catch((error) => {
                failures.push({ url: mediaUrl.href, message: errorMessage(error) });
                return options.verbose
                  ? Console.log(`Skipped media ${mediaUrl.href}: ${errorMessage(error)}`).pipe(Effect.as(false))
                  : Effect.succeed(false);
              })
            ),
          { concurrency: options.concurrency }
        );

        const title = converted.title ?? rewritten.title ?? fallbackTitle(url);
        const document = withFrontmatter(rewritten.markdown, {
          source: url,
          title,
          contentType: source.contentType,
          strategy: source.strategy,
        });
        yield* fileSystem.makeDirectory(path.dirname(pageFile), { recursive: true });
        yield* fileSystem.writeFileString(pageFile, document);
        const archiveFile = describeArchiveFile(rootDirectory, pageFile, 'page', url.href, document);
        archiveFiles.set(archiveFile.path, archiveFile);
        if (!options.verbose) yield* Console.log(`Downloaded ${url.href}`);
        return {
          url,
          title,
          links: rewritten.links,
          mediaCount: mediaResults.filter(Boolean).length,
          strategy: source.strategy,
        } satisfies PageResult;
      });

    let pagesDownloaded = 0;
    let mediaDownloaded = 0;
    while (queue.length > 0 && completed.size < options.maxPages) {
      const available = options.maxPages - completed.size;
      const batch = queue.splice(0, Math.min(options.concurrency, available));
      for (const url of batch) completed.add(url.href);

      const results = yield* Effect.forEach(
        batch,
        (url) =>
          processPage(url).pipe(
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
          failures.push({ url: result.url.href, message: result.message });
          yield* Console.log(`Failed ${result.url.href}: ${result.message}`);
          continue;
        }
        pagesDownloaded += 1;
        mediaDownloaded += result.page.mediaCount;
        pages.push({ url: result.page.url.href, title: result.page.title });
        strategies[result.page.strategy] += 1;
        if (options.singlePage) continue;
        for (const link of result.page.links) {
          link.hash = '';
          if (
            !isInScope(link, startUrl, scopePath) ||
            isMediaUrl(link) ||
            queued.has(link.href) ||
            completed.has(link.href)
          )
            continue;
          queued.add(link.href);
          queue.push(link);
        }
      }
    }

    if (pagesDownloaded === 0) {
      return yield* Effect.fail(new Error(`No pages could be downloaded from ${startUrl.href}`));
    }

    const truncated = queue.length > 0;
    const manifest = yield* finalizeManifest(rootDirectory, {
      provider: 'website',
      source: startUrl.href,
      scopePath,
      scopePaths: [scopePath],
      pagesDownloaded,
      mediaDownloaded,
      pages,
      strategies,
      failures,
      files: [...archiveFiles.values()],
      truncated,
      cleanupEnabled: !options.keepStale,
    });
    const summary: DownloadSummary = {
      provider: 'website',
      rootDirectory,
      pagesDownloaded,
      mediaDownloaded,
      filesRemoved: manifest.removed.length,
      filesPreserved: manifest.preserved.length,
      cleanupFailures: manifest.cleanupFailures.length,
      truncated,
      historyManifest: manifest.historyPath,
      pages,
      failures,
    };
    return summary;
  });

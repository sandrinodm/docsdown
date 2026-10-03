import * as path from 'node:path';
import { Console, Effect, Redacted, Result, Schema } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import { runArchive } from './archive-run.js';
import { DownloadError, parseInput } from './errors.js';
import type { DownloadOptions } from './providers.js';
import {
  isSafeGitHubPath,
  parseGitHubUrl,
  planGitHubSnapshot,
  resolveGitHubScopes,
  type GitHubTarget,
} from './github-snapshot.js';
import { localizeDocument, type LocalizationPolicy } from './markdown.js';
import { mediaFilePath, safeDecode } from './paths.js';
import { packageUserAgent } from './package.js';

export { parseGitHubUrl, resolveGitHubScopes, type GitHubTarget } from './github-snapshot.js';

/**
 * Network origins used by the GitHub provider.
 *
 * Supplying these explicitly keeps production defaults out of tests and allows GitHub-compatible servers later.
 */
export interface GitHubProviderConfig {
  /**
   * REST API origin without a trailing slash.
   */
  readonly apiBaseUrl: string;

  /**
   * Browser URL origin used in manifests and Markdown frontmatter.
   */
  readonly webBaseUrl: string;

  /**
   * Raw-content origin used for unauthenticated public file downloads.
   */
  readonly rawBaseUrl: string;
}

/**
 * Production GitHub endpoints used by automatic provider dispatch.
 */
export const githubProviderConfig: GitHubProviderConfig = {
  /**
   * Public GitHub REST API origin.
   */
  apiBaseUrl: 'https://api.github.com',

  /**
   * Public GitHub browser origin.
   */
  webBaseUrl: 'https://github.com',

  /**
   * Public GitHub raw-content origin.
   */
  rawBaseUrl: 'https://raw.githubusercontent.com',
};

/**
 * GitHub repository metadata required when an input URL does not select a ref.
 */
const RepositoryResponse = Schema.Struct({
  default_branch: Schema.String,
});

/**
 * One file or directory returned by GitHub's Git Trees endpoint.
 */
const TreeEntry = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
  size: Schema.optional(Schema.Number),
});

/**
 * Recursive repository tree used to discover Markdown without per-directory API limits.
 */
const TreeResponse = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(TreeEntry),
});

/**
 * Produces headers accepted by the versioned GitHub REST API.
 */
const githubHeaders = (token: Redacted.Redacted<string> | undefined, accept: string): Record<string, string> => ({
  accept,
  'user-agent': packageUserAgent,
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${Redacted.value(token)}` } : {}),
});

/**
 * Percent-encodes repository path segments while retaining their hierarchy.
 */
const encodeRepositoryPath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');

/**
 * Converts unsuccessful REST responses into provider failures before reading their bodies.
 */
const requireSuccess = (status: number, url: URL): Effect.Effect<void, DownloadError> =>
  status >= 200 && status < 300
    ? Effect.void
    : Effect.fail(new DownloadError({ url: url.href, message: `HTTP ${status} for ${url.href}` }));

/**
 * Fetches and validates JSON from a GitHub REST endpoint.
 */
const requestJson = <A, I, R>(
  url: URL,
  schema: Schema.Codec<A, I, R, unknown>,
  token: Redacted.Redacted<string> | undefined
) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url, {
      headers: githubHeaders(token, 'application/vnd.github+json'),
    });
    yield* requireSuccess(response.status, url);

    const json = yield* response.json;
    return yield* Schema.decodeUnknownEffect(schema)(json);
  });

/**
 * Percent-encodes the `owner/repository` pair used by every GitHub URL shape.
 */
const repositorySlug = (target: GitHubTarget): string =>
  `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;

/**
 * Builds a REST endpoint beneath `/repos/{owner}/{repository}`.
 */
const repositoryApiUrl = (config: GitHubProviderConfig, target: GitHubTarget, suffix = ''): URL =>
  new URL(`${config.apiBaseUrl}/repos/${repositorySlug(target)}${suffix}`);

/**
 * URL builders for files of one repository at one ref.
 */
const makeFileUrls = (config: GitHubProviderConfig, target: GitHubTarget, ref: string) => {
  const slug = repositorySlug(target);
  const encodedRef = encodeURIComponent(ref);

  return {
    /**
     * Browser URL recorded in manifests and frontmatter as the page source.
     */
    browser: (filePath: string): URL =>
      new URL(`${config.webBaseUrl}/${slug}/blob/${encodedRef}/${encodeRepositoryPath(filePath)}`),

    /**
     * Contents API endpoint used for authenticated downloads.
     */
    contents: (filePath: string): URL => {
      const url = repositoryApiUrl(config, target, `/contents/${encodeRepositoryPath(filePath)}`);
      url.searchParams.set('ref', ref);
      return url;
    },

    /**
     * Raw-content endpoint used for unauthenticated public downloads.
     */
    rawDownload: (filePath: string): URL =>
      new URL(`${config.rawBaseUrl}/${slug}/${encodedRef}/${encodeRepositoryPath(filePath)}`),

    /**
     * Canonical raw URL that relative links inside a Markdown file are resolved against.
     *
     * This always uses the public GitHub host, independent of `config`, so links written as absolute
     * `raw.githubusercontent.com` or `github.com/.../blob/...` URLs are recognized as repository files.
     */
    linkBase: (filePath: string): URL =>
      new URL(`https://raw.githubusercontent.com/${slug}/${encodedRef}/${encodeRepositoryPath(filePath)}`),
  };
};

/**
 * Recovers a repository-relative path from raw-content or GitHub blob URLs for the selected repository and ref.
 */
const repositoryPathFromUrl = (url: URL, target: GitHubTarget, ref: string): string | undefined => {
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment));

  let candidate: string | undefined;
  if (
    url.hostname === 'raw.githubusercontent.com' &&
    segments[0] === target.owner &&
    segments[1] === target.repository &&
    segments[2] === ref
  ) {
    candidate = segments.slice(3).join('/');
  } else if (
    url.hostname === 'github.com' &&
    segments[0] === target.owner &&
    segments[1] === target.repository &&
    segments[2] === 'blob' &&
    segments[3] === ref
  ) {
    candidate = segments.slice(4).join('/');
  }

  return candidate && isSafeGitHubPath(candidate) ? candidate : undefined;
};

/**
 * Converts a repository path into a safe absolute page destination.
 */
const pageDestination = (rootDirectory: string, repositoryPath: string): string =>
  path.resolve(rootDirectory, 'content', ...repositoryPath.split('/'));

/**
 * Places repository-owned media under a reserved subtree while preserving its original hierarchy.
 */
const repositoryMediaDestination = (rootDirectory: string, repositoryPath: string): string =>
  path.resolve(rootDirectory, 'media', 'repository', ...repositoryPath.split('/'));

/**
 * Derives a searchable title when a Markdown document has no heading.
 */
const fallbackTitle = (repositoryPath: string): string => {
  const filename = path.posix.basename(repositoryPath).replace(/\.(?:md|mdx|markdown)$/i, '');

  return filename.replace(/[-_]+/g, ' ').trim() || repositoryPath;
};

/**
 * Adds repository provenance to archived Markdown.
 */
const withGitHubFrontmatter = (markdown: string, source: URL, title: string, ref: string): string =>
  [
    '---',
    `source: ${JSON.stringify(source.href)}`,
    `title: ${JSON.stringify(title)}`,
    `downloaded_at: ${JSON.stringify(new Date().toISOString())}`,
    'content_type: "text/markdown"',
    'download_strategy: "github-raw"',
    `github_ref: ${JSON.stringify(ref)}`,
    '---',
    '',
    markdown.trimStart(),
  ].join('\n');

/**
 * Downloads Markdown files and their referenced media from one GitHub repository scope.
 *
 * The recursive Git tree discovers files without the Contents endpoint's 1,000-entry directory limit. A truncated tree
 * produces a partial manifest and suppresses stale cleanup, preventing incomplete discovery from deleting prior files.
 */
export const downloadGitHubRepository = Effect.fn('downloadGitHubRepository')(function* (
  options: DownloadOptions & {
    readonly githubToken?: Redacted.Redacted<string>;
    readonly githubPaths?: ReadonlyArray<string>;
  },
  config: GitHubProviderConfig
) {
  const target = yield* parseInput(() => parseGitHubUrl(options.url));
  const requestedScopes = yield* parseInput(() => resolveGitHubScopes(target, options.githubPaths ?? []));
  const rootDirectory = path.resolve(options.outputDirectory);
  const token = options.githubToken;

  return yield* runArchive(
    {
      provider: 'github',
      source: options.url,
      scopePath: target.repositoryPath || '/',
      scopePaths: requestedScopes.length === 0 ? ['/'] : requestedScopes,
      outputDirectory: rootDirectory,
      concurrency: options.concurrency,
      maxMediaBytes: options.maxMediaBytes,
      cleanupEnabled: !options.keepStale,
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
        // URLs without a branch, tag, or commit archive the repository's default branch.
        const ref =
          target.ref ??
          (yield* requestJson(repositoryApiUrl(config, target), RepositoryResponse, token)).default_branch;
        const fileUrls = makeFileUrls(config, target, ref);

        const treeUrl = repositoryApiUrl(config, target, `/git/trees/${encodeURIComponent(ref)}`);
        treeUrl.searchParams.set('recursive', '1');
        const tree = yield* requestJson(treeUrl, TreeResponse, token);

        const plan = yield* parseInput(() =>
          planGitHubSnapshot({
            url: options.url,
            defaultRef: ref,
            includes: options.githubPaths ?? [],
            ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
            singlePage: options.singlePage,
            tree: { truncated: tree.truncated, entries: tree.tree },
          })
        );

        if (plan.markdown.length === 0) {
          return yield* new DownloadError({ url: options.url, message: `No Markdown files found in ${options.url}` });
        }

        if (tree.truncated) {
          yield* archive.recordFailure({
            url: treeUrl.href,
            message: 'GitHub truncated the recursive repository tree',
          });
        }

        const selectedPaths = new Set(plan.markdown.map((entry) => entry.path));
        const localizationPolicy: LocalizationPolicy = {
          /**
           * Rewrites links only when their repository documents belong to this snapshot.
           */
          pageFile: (url) => {
            const repositoryPath = repositoryPathFromUrl(url, target, ref);
            return repositoryPath && selectedPaths.has(repositoryPath)
              ? pageDestination(rootDirectory, repositoryPath)
              : undefined;
          },
          /**
           * Mirrors repository media separately from external media grouped by origin.
           */

          mediaFile: (url) => {
            const repositoryPath = repositoryPathFromUrl(url, target, ref);
            return repositoryPath
              ? repositoryMediaDestination(rootDirectory, repositoryPath)
              : mediaFilePath(rootDirectory, url);
          },
        };

        /**
         * Chooses how to fetch a repository file: the Contents API with the token, or public raw content without it.
         */
        const repositoryFileRequest = (filePath: string, publicAccept: string) =>
          token
            ? { url: fileUrls.contents(filePath), headers: githubHeaders(token, 'application/vnd.github.raw+json') }
            : {
                url: fileUrls.rawDownload(filePath),
                headers: { accept: publicAccept, 'user-agent': packageUserAgent },
              };

        /**
         * Downloads one referenced image or video, reading repository files through the same channel as pages.
         *
         * The repository token is never sent to external media hosts.
         */
        const downloadMedia = (mediaUrl: URL) => {
          const mediaAccept = 'image/*,video/*,*/*;q=0.1';
          const repositoryPath = repositoryPathFromUrl(mediaUrl, target, ref);
          const request =
            repositoryPath === undefined
              ? { url: mediaUrl, headers: { accept: mediaAccept, 'user-agent': packageUserAgent } }
              : repositoryFileRequest(repositoryPath, mediaAccept);

          const knownBytes = repositoryPath === undefined ? undefined : plan.blobSize(repositoryPath);

          return archive.downloadMedia({
            url: mediaUrl.href,
            requestUrl: request.url.href,
            httpErrorUrl: request.url.href,
            destination: localizationPolicy.mediaFile(mediaUrl) as string,
            headers: request.headers,
            ...(knownBytes !== undefined ? { knownBytes } : {}),
          });
        };

        /**
         * Downloads, localizes, and records one planned repository Markdown file.
         */
        const processPage = Effect.fnUntraced(function* (filePath: string, order: number) {
          if (options.verbose) {
            yield* Console.log(`Fetching ${filePath}`);
          }

          const request = repositoryFileRequest(filePath, 'text/markdown, text/plain;q=0.9');
          const response = yield* HttpClient.get(request.url, { headers: request.headers });
          yield* requireSuccess(response.status, request.url);

          const pageFile = pageDestination(rootDirectory, filePath);
          const localized = localizeDocument(
            {
              format: filePath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown',
              source: yield* response.text,
              url: fileUrls.linkBase(filePath),
              file: pageFile,
            },
            localizationPolicy
          );
          yield* Effect.forEach(localized.media, (mediaUrl) => downloadMedia(mediaUrl), {
            concurrency: options.concurrency,
          });

          const title = localized.title ?? fallbackTitle(filePath);
          const sourceUrl = fileUrls.browser(filePath);
          yield* archive.writePage({
            url: sourceUrl.href,
            title,
            strategy: 'github-raw',
            order,
            destination: pageFile,
            content: withGitHubFrontmatter(localized.markdown, sourceUrl, title, ref),
          });

          if (!options.verbose) {
            yield* Console.log(`Downloaded ${filePath}`);
          }
        });

        const results = yield* Effect.forEach(
          plan.markdown,
          ({ path: filePath }, order) =>
            Effect.result(processPage(filePath, order)).pipe(Effect.map((result) => ({ filePath, result }))),
          { concurrency: options.concurrency }
        );

        let pagesDownloaded = 0;
        for (const { filePath, result } of results) {
          if (Result.isSuccess(result)) {
            pagesDownloaded += 1;
            continue;
          }

          const url = fileUrls.browser(filePath).href;
          yield* archive.recordFailure({ url, message: result.failure.message });
          yield* Console.log(`Failed ${url}: ${result.failure.message}`);
        }

        if (pagesDownloaded === 0) {
          return yield* new DownloadError({
            url: options.url,
            message: `No Markdown files could be downloaded from ${options.url}`,
          });
        }

        return { truncated: plan.truncated };
      })
  );
});

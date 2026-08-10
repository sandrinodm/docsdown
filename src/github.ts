import * as path from 'node:path';
import { Console, Effect, Schema } from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import { runArchive } from './archive-run.js';
import type { DownloadOptions, DownloadSummary } from './providers.js';
import {
  isSafeGitHubPath,
  parseGitHubUrl,
  planGitHubSnapshot,
  resolveGitHubScopes,
  type GitHubTarget,
} from './github-snapshot.js';
import { localizeDocument, type LocalizationPolicy } from './markdown.js';
import { mediaFilePath } from './paths.js';
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
const githubHeaders = (token: string | undefined, accept: string): Record<string, string> => ({
  accept,
  'user-agent': packageUserAgent,
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/**
 * Percent-encodes repository path segments while retaining their hierarchy.
 */
const encodeRepositoryPath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');

/**
 * Converts unsuccessful REST responses into provider failures before reading their bodies.
 */
const requireSuccess = (status: number, url: URL): Effect.Effect<void, Error> =>
  status >= 200 && status < 300 ? Effect.void : Effect.fail(new Error(`HTTP ${status} for ${url.href}`));

/**
 * Fetches and validates JSON from a GitHub REST endpoint.
 */
const requestJson = <A, I, R>(url: URL, schema: Schema.Codec<A, I, R, unknown>, token: string | undefined) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url, {
      headers: githubHeaders(token, 'application/vnd.github+json'),
    });
    yield* requireSuccess(response.status, url);
    const json = yield* response.json;
    return yield* Schema.decodeUnknownEffect(schema)(json);
  });

/**
 * Maps one repository path to the GitHub browser URL recorded as its source.
 */
const browserFileUrl = (config: GitHubProviderConfig, target: GitHubTarget, ref: string, filePath: string): URL =>
  new URL(
    `${config.webBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/blob/${encodeURIComponent(ref)}/${encodeRepositoryPath(filePath)}`
  );

/**
 * Maps one repository path to the raw Contents API endpoint used for authenticated downloads.
 */
const contentsUrl = (config: GitHubProviderConfig, target: GitHubTarget, ref: string, filePath: string): URL => {
  const url = new URL(
    `${config.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/contents/${encodeRepositoryPath(filePath)}`
  );
  url.searchParams.set('ref', ref);
  return url;
};

/**
 * Maps one public repository path to GitHub's raw-content delivery origin.
 */
const rawDownloadUrl = (config: GitHubProviderConfig, target: GitHubTarget, ref: string, filePath: string): URL =>
  new URL(
    `${config.rawBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/${encodeURIComponent(ref)}/${encodeRepositoryPath(filePath)}`
  );

/**
 * Produces the virtual raw URL used to resolve relative links inside repository Markdown.
 */
const rawFileUrl = (target: GitHubTarget, ref: string, filePath: string): URL =>
  new URL(
    `https://raw.githubusercontent.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/${encodeURIComponent(ref)}/${encodeRepositoryPath(filePath)}`
  );

/**
 * Recovers a repository-relative path from raw-content or GitHub blob URLs for the selected repository and ref.
 */
const repositoryPathFromUrl = (url: URL, target: GitHubTarget, ref: string): string | undefined => {
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
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
export const downloadGitHubRepository = (
  options: DownloadOptions & {
    readonly githubToken?: string;
    readonly githubPaths?: ReadonlyArray<string>;
  },
  config: GitHubProviderConfig
) =>
  Effect.gen(function* () {
    const target = parseGitHubUrl(options.url);
    const requestedScopes = resolveGitHubScopes(target, options.githubPaths ?? []);
    const rootDirectory = path.resolve(options.outputDirectory);
    /**
     * Preserves request-level media diagnostics without exposing archive bookkeeping to the provider.
     */
    const logMediaFailure = (failure: { readonly url: string; readonly message: string }) =>
      Console.log(`Skipped media ${failure.url}: ${failure.message}`);
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
        ...(options.verbose ? { onMediaFailure: logMediaFailure } : {}),
      },
      (archive) =>
        Effect.gen(function* () {
          let ref = target.ref;
          let defaultRef: string | undefined;
          if (!ref) {
            const repositoryUrl = new URL(
              `${config.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`
            );
            const repository = yield* requestJson(repositoryUrl, RepositoryResponse, options.githubToken);
            defaultRef = repository.default_branch;
            ref = defaultRef;
          }

          const treeUrl = new URL(
            `${config.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/git/trees/${encodeURIComponent(ref)}`
          );
          treeUrl.searchParams.set('recursive', '1');
          const tree = yield* requestJson(treeUrl, TreeResponse, options.githubToken);
          const plan = planGitHubSnapshot({
            url: options.url,
            ...(defaultRef !== undefined ? { defaultRef } : {}),
            includes: options.githubPaths ?? [],
            ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
            singlePage: options.singlePage,
            tree: { truncated: tree.truncated, entries: tree.tree },
          });
          const selectedMarkdown = plan.markdown;
          if (selectedMarkdown.length === 0) {
            return yield* Effect.fail(new Error(`No Markdown files found in ${options.url}`));
          }

          if (tree.truncated) {
            yield* archive.recordFailure({
              url: treeUrl.href,
              message: 'GitHub truncated the recursive repository tree',
            });
          }
          const selectedPaths = new Set(selectedMarkdown.map((entry) => entry.path));
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
           * Downloads, localizes, and records one planned repository Markdown file.
           */
          const processPage = (entry: (typeof selectedMarkdown)[number], order: number) =>
            Effect.gen(function* () {
              const requestUrl = options.githubToken
                ? contentsUrl(config, target, ref, entry.path)
                : rawDownloadUrl(config, target, ref, entry.path);
              if (options.verbose) yield* Console.log(`Fetching ${entry.path}`);
              const response = yield* HttpClient.get(requestUrl, {
                headers: options.githubToken
                  ? githubHeaders(options.githubToken, 'application/vnd.github.raw+json')
                  : { accept: 'text/markdown, text/plain;q=0.9', 'user-agent': packageUserAgent },
              });
              yield* requireSuccess(response.status, requestUrl);
              const pageFile = pageDestination(rootDirectory, entry.path);
              const pageUrl = rawFileUrl(target, ref, entry.path);
              const localized = localizeDocument(
                {
                  format: entry.path.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown',
                  source: yield* response.text,
                  url: pageUrl,
                  file: pageFile,
                },
                localizationPolicy
              );
              const title = localized.title ?? fallbackTitle(entry.path);
              const sourceUrl = browserFileUrl(config, target, ref, entry.path);
              yield* Effect.forEach(
                localized.media,
                (mediaUrl) => {
                  const repositoryPath = repositoryPathFromUrl(mediaUrl, target, ref);
                  const destination = localizationPolicy.mediaFile(mediaUrl) as string;
                  const requestUrl = repositoryPath
                    ? options.githubToken
                      ? contentsUrl(config, target, ref, repositoryPath)
                      : rawDownloadUrl(config, target, ref, repositoryPath)
                    : mediaUrl;
                  const knownBytes = repositoryPath === undefined ? undefined : plan.blobSize(repositoryPath);
                  return archive.downloadMedia({
                    url: mediaUrl.href,
                    requestUrl: requestUrl.href,
                    httpErrorUrl: requestUrl.href,
                    destination,
                    headers:
                      repositoryPath && options.githubToken
                        ? githubHeaders(options.githubToken, 'application/vnd.github.raw+json')
                        : { accept: 'image/*,video/*,*/*;q=0.1', 'user-agent': packageUserAgent },
                    ...(knownBytes !== undefined ? { knownBytes } : {}),
                  });
                },
                { concurrency: options.concurrency }
              );
              yield* archive.writePage({
                url: sourceUrl.href,
                title,
                strategy: 'github-raw',
                order,
                destination: pageFile,
                content: withGitHubFrontmatter(localized.markdown, sourceUrl, title, ref),
              });
              if (!options.verbose) yield* Console.log(`Downloaded ${entry.path}`);
            });

          const results = yield* Effect.forEach(
            selectedMarkdown,
            (entry, order) =>
              processPage(entry, order).pipe(
                Effect.match({
                  /**
                   * Retains the canonical browser URL for ordered partial-run reporting.
                   */
                  onFailure: (error) => ({
                    ok: false as const,
                    url: browserFileUrl(config, target, ref, entry.path),
                    error,
                  }),
                  /**
                   * Marks successful persistence without exposing provider-local page details.
                   */
                  onSuccess: () => ({ ok: true as const }),
                })
              ),
            { concurrency: options.concurrency }
          );
          let pagesDownloaded = 0;
          for (const result of results) {
            if (result.ok) {
              pagesDownloaded += 1;
              continue;
            }
            const message = result.error.message;
            yield* archive.recordFailure({ url: result.url.href, message });
            yield* Console.log(`Failed ${result.url.href}: ${message}`);
          }
          if (pagesDownloaded === 0) {
            return yield* Effect.fail(new Error(`No Markdown files could be downloaded from ${options.url}`));
          }
          return { truncated: plan.truncated };
        })
    ).pipe(Effect.map((summary) => summary satisfies DownloadSummary));
  });

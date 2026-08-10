import * as path from 'node:path';
import { Console, Effect, FileSystem, Schema } from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import { type DownloadOptions, type DownloadSummary } from './downloader.js';
import { describeArchiveFile, finalizeManifest, type ArchiveFile } from './manifest.js';
import { rewriteMarkdown } from './markdown.js';
import { isMediaUrl, markdownRelativePath, mediaFilePath } from './paths.js';
import { packageUserAgent } from './package.js';

/**
 * Parsed GitHub repository location and optional branch/path selection.
 */
export interface GitHubTarget {
  /**
   * Repository owner or organization.
   */
  readonly owner: string;

  /**
   * Repository name without a trailing `.git`.
   */
  readonly repository: string;

  /**
   * Explicit branch, tag, or commit selected by the input URL.
   */
  readonly ref: string | undefined;

  /**
   * Repository-relative file or directory scope.
   */
  readonly repositoryPath: string;

  /**
   * Whether the URL points at exactly one blob instead of a directory tree.
   */
  readonly exactFile: boolean;
}

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
 * Removes leading and trailing slashes from a repository-relative selection.
 */
const trimPath = (value: string): string => value.replace(/^\/+|\/+$/g, '');

/**
 * Rejects paths that could escape or alias the repository archive hierarchy.
 */
const isSafeRepositoryPath = (value: string): boolean => {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
};

/**
 * Resolves optional user-selected paths against the directory scope encoded by a GitHub URL.
 *
 * An empty result represents the repository root. Duplicate selections are removed without changing their order.
 */
export const resolveGitHubScopes = (target: GitHubTarget, selections: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (selections.length === 0) return target.repositoryPath ? [target.repositoryPath] : [];
  if (target.exactFile) throw new Error('--include cannot be combined with a GitHub blob URL');

  const scopes = selections.map((selection) => {
    const relativePath = trimPath(selection);
    if (!isSafeRepositoryPath(relativePath)) {
      throw new Error(`Invalid GitHub include path: ${JSON.stringify(selection)}`);
    }
    return target.repositoryPath ? `${target.repositoryPath}/${relativePath}` : relativePath;
  });
  return [...new Set(scopes)];
};

/**
 * Recognizes Markdown repository files case-insensitively.
 */
const isMarkdownPath = (value: string): boolean => /\.(?:md|mdx|markdown)$/i.test(value);

/**
 * Parses supported GitHub browser and raw-content URLs into one repository model.
 *
 * Tree and blob URLs use the first segment after `tree` or `blob` as the ref, matching GitHub's browser URL shape.
 */
export const parseGitHubUrl = (value: string | URL): GitHubTarget => {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.hostname === 'github.com') {
    const owner = segments[0];
    const rawRepository = segments[1];
    if (!owner || !rawRepository) throw new Error('GitHub URLs must include an owner and repository');
    const repository = rawRepository.replace(/\.git$/i, '');
    const mode = segments[2];
    if (mode === 'tree' || mode === 'blob') {
      const ref = segments[3];
      if (!ref) throw new Error(`GitHub ${mode} URLs must include a branch, tag, or commit`);
      return {
        owner,
        repository,
        ref,
        repositoryPath: trimPath(segments.slice(4).join('/')),
        exactFile: mode === 'blob',
      };
    }
    return { owner, repository, ref: undefined, repositoryPath: '', exactFile: false };
  }

  if (url.hostname === 'raw.githubusercontent.com') {
    const owner = segments[0];
    const repository = segments[1];
    const ref = segments[2];
    if (!owner || !repository || !ref) {
      throw new Error('Raw GitHub URLs must include an owner, repository, ref, and path');
    }
    const repositoryPath = trimPath(segments.slice(3).join('/'));
    return { owner, repository, ref, repositoryPath, exactFile: isMarkdownPath(repositoryPath) };
  }

  throw new Error(`Unsupported GitHub URL: ${url.href}`);
};

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
  return candidate && isSafeRepositoryPath(candidate) ? candidate : undefined;
};

/**
 * Converts a repository path into a safe absolute page destination.
 */
const pageDestination = (rootDirectory: string, repositoryPath: string): string =>
  path.resolve(rootDirectory, ...repositoryPath.split('/'));

/**
 * Places repository-owned media under a reserved subtree while preserving its original hierarchy.
 */
const repositoryMediaDestination = (rootDirectory: string, repositoryPath: string): string =>
  path.resolve(rootDirectory, '_media', 'repository', ...repositoryPath.split('/'));

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
    if (options.concurrency < 1) return yield* Effect.fail(new Error('--concurrency must be at least 1'));
    if (options.maxPages < 1) return yield* Effect.fail(new Error('--max-pages must be at least 1'));
    if (options.maxMediaBytes < 1) return yield* Effect.fail(new Error('--max-media-mb must be greater than 0'));

    const target = parseGitHubUrl(options.url);
    const scopes = resolveGitHubScopes(target, options.githubPaths ?? []);
    const fileSystem = yield* FileSystem.FileSystem;
    const rootDirectory = path.resolve(options.outputDirectory);
    yield* fileSystem.makeDirectory(rootDirectory, { recursive: true });

    let ref = target.ref;
    if (!ref) {
      const repositoryUrl = new URL(
        `${config.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`
      );
      const repository = yield* requestJson(repositoryUrl, RepositoryResponse, options.githubToken);
      ref = repository.default_branch;
    }

    const treeUrl = new URL(
      `${config.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/git/trees/${encodeURIComponent(ref)}`
    );
    treeUrl.searchParams.set('recursive', '1');
    const tree = yield* requestJson(treeUrl, TreeResponse, options.githubToken);
    const safeBlobs = tree.tree.filter((entry) => entry.type === 'blob' && isSafeRepositoryPath(entry.path));
    const blobByPath = new Map(safeBlobs.map((entry) => [entry.path, entry]));
    /**
     * Checks whether one tree path is inside the selected blob or directory scope.
     */
    const inScope = (entryPath: string): boolean =>
      target.exactFile
        ? entryPath === target.repositoryPath
        : scopes.length === 0 || scopes.some((scope) => entryPath === scope || entryPath.startsWith(`${scope}/`));
    const discoveredMarkdown = safeBlobs
      .filter((entry) => isMarkdownPath(entry.path) && inScope(entry.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const selectedMarkdown = discoveredMarkdown.slice(
      0,
      options.singlePage ? 1 : Math.min(options.maxPages, discoveredMarkdown.length)
    );
    if (selectedMarkdown.length === 0) {
      return yield* Effect.fail(new Error(`No Markdown files found in ${options.url}`));
    }

    const truncated = tree.truncated || selectedMarkdown.length < discoveredMarkdown.length;
    const failures: Array<{ url: string; message: string }> = tree.truncated
      ? [{ url: treeUrl.href, message: 'GitHub truncated the recursive repository tree' }]
      : [];
    const selectedPaths = new Set(selectedMarkdown.map((entry) => entry.path));
    const downloadedMedia = new Set<string>();
    const archiveFiles = new Map<string, ArchiveFile>();

    /**
     * Resolves selected repository Markdown to its mirrored archive path.
     */
    const resolvePageFile = (url: URL): string | undefined => {
      const repositoryPath = repositoryPathFromUrl(url, target, ref);
      return repositoryPath && selectedPaths.has(repositoryPath)
        ? pageDestination(rootDirectory, repositoryPath)
        : undefined;
    };

    /**
     * Resolves repository media to a reserved mirrored subtree and external media by origin.
     */
    const resolveMediaFile = (url: URL): string => {
      const repositoryPath = repositoryPathFromUrl(url, target, ref);
      return repositoryPath
        ? repositoryMediaDestination(rootDirectory, repositoryPath)
        : mediaFilePath(rootDirectory, url);
    };

    /**
     * Downloads and records one unique media reference without sending GitHub credentials to external origins.
     */
    const downloadMedia = (url: URL) =>
      Effect.gen(function* () {
        const repositoryPath = repositoryPathFromUrl(url, target, ref);
        const destination = resolveMediaFile(url);
        const knownSize = repositoryPath ? blobByPath.get(repositoryPath)?.size : undefined;
        if (knownSize !== undefined && knownSize > options.maxMediaBytes) {
          return yield* Effect.fail(new Error(`Media exceeds ${options.maxMediaBytes} byte limit`));
        }
        const requestUrl = repositoryPath
          ? options.githubToken
            ? contentsUrl(config, target, ref, repositoryPath)
            : rawDownloadUrl(config, target, ref, repositoryPath)
          : url;
        const response = yield* HttpClient.get(requestUrl, {
          headers: repositoryPath
            ? options.githubToken
              ? githubHeaders(options.githubToken, 'application/vnd.github.raw+json')
              : { accept: 'image/*,video/*,*/*;q=0.1', 'user-agent': packageUserAgent }
            : { accept: 'image/*,video/*,*/*;q=0.1', 'user-agent': packageUserAgent },
        });
        yield* requireSuccess(response.status, requestUrl);
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
     * Downloads, rewrites, and records one repository Markdown file and its new media references.
     */
    const processPage = (entry: (typeof selectedMarkdown)[number]) =>
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
        const sourceMarkdown = yield* response.text;
        const pageFile = pageDestination(rootDirectory, entry.path);
        const pageUrl = rawFileUrl(target, ref, entry.path);
        const rewritten = rewriteMarkdown(sourceMarkdown, {
          mdx: entry.path.toLowerCase().endsWith('.mdx'),
          pageUrl,
          pageFile,
          resolvePageFile,
          resolveMediaFile,
          isMediaUrl,
          relativePath: markdownRelativePath,
        });
        const newMedia = rewritten.media.filter((mediaUrl) => {
          const destination = resolveMediaFile(mediaUrl);
          if (downloadedMedia.has(destination)) return false;
          downloadedMedia.add(destination);
          return true;
        });
        const mediaResults = yield* Effect.forEach(
          newMedia,
          (mediaUrl) =>
            downloadMedia(mediaUrl).pipe(
              Effect.map(() => true),
              Effect.catch((error) => {
                failures.push({ url: mediaUrl.href, message: error.message });
                return options.verbose
                  ? Console.log(`Skipped media ${mediaUrl.href}: ${error.message}`).pipe(Effect.as(false))
                  : Effect.succeed(false);
              })
            ),
          { concurrency: options.concurrency }
        );
        const title = rewritten.title ?? fallbackTitle(entry.path);
        const sourceUrl = browserFileUrl(config, target, ref, entry.path);
        const document = withGitHubFrontmatter(rewritten.markdown, sourceUrl, title, ref);
        yield* fileSystem.makeDirectory(path.dirname(pageFile), { recursive: true });
        yield* fileSystem.writeFileString(pageFile, document);
        const archiveFile = describeArchiveFile(rootDirectory, pageFile, 'page', sourceUrl.href, document);
        archiveFiles.set(archiveFile.path, archiveFile);
        if (!options.verbose) yield* Console.log(`Downloaded ${entry.path}`);
        return {
          page: { url: sourceUrl.href, title },
          mediaDownloaded: mediaResults.filter(Boolean).length,
        };
      });

    const results = yield* Effect.forEach(
      selectedMarkdown,
      (entry) =>
        processPage(entry).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, url: browserFileUrl(config, target, ref, entry.path), error })
          )
        ),
      { concurrency: options.concurrency }
    );
    const pages: Array<{ url: string; title: string }> = [];
    let mediaDownloaded = 0;
    for (const result of results) {
      if (!result.ok) {
        failures.push({ url: result.url.href, message: result.error.message });
        yield* Console.log(`Failed ${result.url.href}: ${result.error.message}`);
        continue;
      }
      pages.push(result.result.page);
      mediaDownloaded += result.result.mediaDownloaded;
    }
    if (pages.length === 0) {
      return yield* Effect.fail(new Error(`No Markdown files could be downloaded from ${options.url}`));
    }

    const manifest = yield* finalizeManifest(rootDirectory, {
      provider: 'github',
      source: options.url,
      scopePath: target.repositoryPath || '/',
      scopePaths: scopes.length === 0 ? ['/'] : scopes,
      pagesDownloaded: pages.length,
      mediaDownloaded,
      pages,
      strategies: { 'github-raw': pages.length },
      failures,
      files: [...archiveFiles.values()],
      truncated,
      cleanupEnabled: !options.keepStale,
    });

    return {
      provider: 'github',
      rootDirectory,
      pagesDownloaded: pages.length,
      mediaDownloaded,
      filesRemoved: manifest.removed.length,
      filesPreserved: manifest.preserved.length,
      cleanupFailures: manifest.cleanupFailures.length,
      truncated,
      historyManifest: manifest.historyPath,
      pages,
      failures,
    } satisfies DownloadSummary;
  });

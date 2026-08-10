import * as path from 'node:path';

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
   * Whether the URL points at exactly one Markdown blob.
   */
  readonly exactFile: boolean;
}

/**
 * One file or directory from a recursive GitHub tree.
 */
export interface GitHubTreeEntry {
  /**
   * Repository-relative entry path.
   */
  readonly path: string;

  /**
   * Git object type, normally `blob` or `tree`.
   */
  readonly type: string;

  /**
   * Blob size reported by GitHub, when present.
   */
  readonly size?: number | undefined;
}

/**
 * Recursive tree data consumed by snapshot planning.
 */
export interface GitHubTree {
  /**
   * Whether GitHub returned an incomplete recursive tree.
   */
  readonly truncated: boolean;

  /**
   * Tree entries returned by GitHub.
   */
  readonly entries: ReadonlyArray<GitHubTreeEntry>;
}

/**
 * Inputs needed to turn GitHub discovery data into a deterministic snapshot plan.
 */
export interface GitHubSnapshotRequest {
  /**
   * GitHub browser or raw-content URL to archive.
   */
  readonly url: string | URL;

  /**
   * Default repository ref resolved from metadata when the URL omits one.
   */
  readonly defaultRef?: string;

  /**
   * Optional paths selected relative to the URL's tree scope.
   */
  readonly includes?: ReadonlyArray<string>;

  /**
   * Optional maximum number of Markdown files to select.
   */
  readonly maxPages?: number;

  /**
   * Whether to select only the first discovered Markdown file.
   */
  readonly singlePage: boolean;

  /**
   * Recursive repository tree returned by GitHub.
   */
  readonly tree: GitHubTree;
}

/**
 * Deterministic description of the repository content to archive.
 */
export interface GitHubSnapshotPlan {
  /**
   * Parsed repository target.
   */
  readonly target: GitHubTarget;

  /**
   * Ref used for every planned download.
   */
  readonly ref: string;

  /**
   * Normalized repository scopes included in the plan.
   */
  readonly scopes: ReadonlyArray<string>;

  /**
   * Sorted Markdown blobs selected for download.
   */
  readonly markdown: ReadonlyArray<GitHubTreeEntry>;

  /**
   * Whether discovery or page limiting made the plan incomplete.
   */
  readonly truncated: boolean;

  /**
   * Looks up the declared size of a safe repository blob.
   */
  readonly blobSize: (repositoryPath: string) => number | undefined;
}

/**
 * Removes leading and trailing slashes from a repository-relative selection.
 */
const trimPath = (value: string): string => value.replace(/^\/+|\/+$/g, '');

/**
 * Determines whether a path can be safely mirrored below an archive root.
 */
export const isSafeGitHubPath = (value: string): boolean => {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
};

/**
 * Determines whether a repository path names supported Markdown content.
 */
export const isGitHubMarkdownPath = (value: string): boolean => /\.(?:md|mdx|markdown)$/i.test(value);

/**
 * Parses supported GitHub browser and raw-content URLs into one repository model.
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
      const repositoryPath = trimPath(segments.slice(4).join('/'));
      return { owner, repository, ref, repositoryPath, exactFile: mode === 'blob' };
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
    return { owner, repository, ref, repositoryPath, exactFile: isGitHubMarkdownPath(repositoryPath) };
  }
  throw new Error(`Unsupported GitHub URL: ${url.href}`);
};

/**
 * Resolves optional user-selected paths against the directory scope encoded by a GitHub URL.
 */
export const resolveGitHubScopes = (target: GitHubTarget, selections: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (selections.length === 0) return target.repositoryPath ? [target.repositoryPath] : [];
  if (target.exactFile) throw new Error('--include cannot be combined with a GitHub blob URL');
  const scopes = selections.map((selection) => {
    const relativePath = trimPath(selection);
    if (!isSafeGitHubPath(relativePath)) {
      throw new Error(`Invalid GitHub include path: ${JSON.stringify(selection)}`);
    }
    return target.repositoryPath ? `${target.repositoryPath}/${relativePath}` : relativePath;
  });
  return [...new Set(scopes)];
};

/**
 * Builds a deterministic archive plan from a GitHub URL and recursive tree.
 */
export const planGitHubSnapshot = (request: GitHubSnapshotRequest): GitHubSnapshotPlan => {
  if (request.maxPages !== undefined && request.maxPages < 1) throw new Error('--max-pages must be at least 1');
  const target = parseGitHubUrl(request.url);
  const ref = target.ref ?? request.defaultRef;
  if (ref === undefined) throw new Error(`Could not resolve a GitHub ref for ${String(request.url)}`);
  const scopes = resolveGitHubScopes(target, request.includes ?? []);
  const safeBlobs = request.tree.entries.filter((entry) => entry.type === 'blob' && isSafeGitHubPath(entry.path));
  const blobByPath = new Map(safeBlobs.map((entry) => [entry.path, entry]));
  /**
   * Determines whether a discovered path belongs to the selected repository scope.
   */
  const inScope = (entryPath: string): boolean =>
    target.exactFile
      ? entryPath === target.repositoryPath
      : scopes.length === 0 || scopes.some((scope) => entryPath === scope || entryPath.startsWith(`${scope}/`));
  const discovered = safeBlobs
    .filter((entry) => isGitHubMarkdownPath(entry.path) && inScope(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const markdown = discovered.slice(
    0,
    request.singlePage ? 1 : Math.min(request.maxPages ?? discovered.length, discovered.length)
  );
  /**
   * Looks up a safe blob's declared size without exposing the mutable planning index.
   */
  const blobSize = (repositoryPath: string): number | undefined => blobByPath.get(repositoryPath)?.size;
  return {
    target,
    ref,
    scopes,
    markdown,
    truncated: request.tree.truncated || markdown.length < discovered.length,
    blobSize,
  };
};

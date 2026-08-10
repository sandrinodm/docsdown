import type { ArchiveRunSummary } from './archive-run.js';
import { Effect } from 'effect';
import { downloadSite } from './downloader.js';
import { downloadGitHubRepository, githubProviderConfig } from './github.js';
import { normalizeUrl } from './paths.js';

/**
 * Concrete documentation source adapters available to callers.
 */
export type ProviderKind = 'website' | 'github';

/**
 * Acquisition strategies recorded in page frontmatter and manifests.
 */
export type DownloadStrategy = 'markdown-suffix' | 'markdown-content-negotiation' | 'html-conversion' | 'github-raw';

/**
 * CLI-selectable provider policy, including automatic URL-based detection.
 */
export type ProviderSelection = 'auto' | ProviderKind;

/**
 * Provider-neutral crawl limits, output policy, and diagnostics selected by a caller.
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
   * Optional hard page limit; omission allows discovery to exhaust the selected scope.
   */
  readonly maxPages?: number;

  /**
   * Per-media byte limit enforced against declared and actual response sizes.
   */
  readonly maxMediaBytes: number;

  /**
   * Whether to archive only the first selected page.
   */
  readonly singlePage: boolean;

  /**
   * Whether stale owned files should remain after a complete run.
   */
  readonly keepStale: boolean;

  /**
   * Whether request-level progress and media failures should be printed.
   */
  readonly verbose: boolean;
}

/**
 * Stable user-facing outcome produced by either provider adapter.
 */
export type DownloadSummary = ArchiveRunSummary;

/**
 * Shared download options plus provider selection and optional GitHub authentication.
 */
export interface DocumentationDownloadOptions extends DownloadOptions {
  /**
   * Provider override or automatic selection.
   */
  readonly provider: ProviderSelection | string;

  /**
   * GitHub token used only for GitHub REST requests.
   */
  readonly githubToken?: string;

  /**
   * Repository-relative paths selected for a GitHub download.
   */
  readonly githubPaths?: ReadonlyArray<string>;
}

/**
 * Validates provider-neutral limits before either adapter performs filesystem or network work.
 */
const validateDownloadOptions = (options: DownloadOptions): Error | undefined => {
  if (options.concurrency < 1) return new Error('--concurrency must be at least 1');
  if (options.maxPages !== undefined && options.maxPages < 1) return new Error('--max-pages must be at least 1');
  if (options.maxMediaBytes < 1) return new Error('--max-media-mb must be greater than 0');
};

/**
 * Selects a provider explicitly or detects GitHub browser and raw-content URLs.
 */
export const selectProvider = (url: string, selection: ProviderSelection | string): ProviderKind => {
  if (selection === 'website' || selection === 'github') return selection;
  if (selection !== 'auto') throw new Error(`Unknown provider "${selection}"; expected auto, website, or github`);
  const hostname = normalizeUrl(url).hostname.toLowerCase();
  return hostname === 'github.com' || hostname === 'raw.githubusercontent.com' ? 'github' : 'website';
};

/**
 * Downloads documentation through the selected adapter while keeping one stable caller interface.
 */
export const downloadDocumentation = (options: DocumentationDownloadOptions) => {
  const provider = selectProvider(options.url, options.provider);
  if (provider !== 'github' && options.githubPaths && options.githubPaths.length > 0) {
    throw new Error('--include is only supported by the GitHub provider');
  }
  const validationError = validateDownloadOptions(options);
  if (validationError) return Effect.fail(validationError);
  return provider === 'github' ? downloadGitHubRepository(options, githubProviderConfig) : downloadSite(options);
};

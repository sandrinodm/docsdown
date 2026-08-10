import { type DownloadOptions, downloadSite } from './downloader.js';
import { downloadGitHubRepository, githubProviderConfig } from './github.js';
import { normalizeUrl } from './paths.js';

/**
 * Concrete documentation source adapters available to callers.
 */
export type ProviderKind = 'website' | 'github';

/**
 * CLI-selectable provider policy, including automatic URL-based detection.
 */
export type ProviderSelection = 'auto' | ProviderKind;

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
  return provider === 'github' ? downloadGitHubRepository(options, githubProviderConfig) : downloadSite(options);
};

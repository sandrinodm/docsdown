import * as path from 'node:path';
import { Effect, Result, type Redacted } from 'effect';
import { discoverArchiveConfigs, makeArchiveConfig, writeArchiveConfig, type ArchiveConfig } from './config.js';
import { downloadDocumentation, type DocumentationDownloadOptions } from './providers.js';

/**
 * Options controlling a recursive update of managed documentation archives.
 */
export interface UpdateDocumentationOptions {
  /**
   * Parent directory searched recursively for archive configurations.
   */
  readonly outputDirectory: string;

  /**
   * Runtime-only GitHub credential, never persisted in archive configuration.
   */
  readonly githubToken?: Redacted.Redacted<string>;
}

/**
 * One configuration or download failure encountered without stopping other updates.
 */
export interface UpdateFailure {
  /**
   * Configuration path associated with the failure.
   */
  readonly configPath: string;

  /**
   * Human-readable parsing, validation, or download failure.
   */
  readonly message: string;
}

/**
 * Aggregate result after every discovered archive has been attempted.
 */
export interface UpdateDocumentationSummary {
  /**
   * Number of configuration files found, including invalid ones.
   */
  readonly configsFound: number;

  /**
   * Number of archives successfully refreshed.
   */
  readonly archivesUpdated: number;

  /**
   * Failures retained after continuing through all other archives.
   */
  readonly failures: ReadonlyArray<UpdateFailure>;
}

/**
 * Reconstructs active download options from one portable archive configuration.
 */
const optionsFromConfig = (
  config: ArchiveConfig,
  configPath: string,
  options: UpdateDocumentationOptions
): DocumentationDownloadOptions => ({
  url: config.source,
  outputDirectory: path.dirname(configPath),
  provider: config.provider,
  ...config.options,
  ...(options.githubToken ? { githubToken: options.githubToken } : {}),
});

/**
 * Downloads one archive and writes its token-free update configuration after pages have been produced.
 */
export const downloadAndConfigure = Effect.fn('downloadAndConfigure')(function* (
  options: DocumentationDownloadOptions
) {
  const summary = yield* downloadDocumentation(options);
  const config = makeArchiveConfig(options, summary.provider);
  yield* writeArchiveConfig(summary.rootDirectory, config);
  return summary;
});

/**
 * Discovers and sequentially refreshes every managed archive beneath one output directory.
 *
 * Individual invalid configurations and failed downloads are reported after all other archives have been attempted.
 */
export const updateDocumentationArchives = Effect.fn('updateDocumentationArchives')(function* (
  options: UpdateDocumentationOptions
) {
  const discovered = yield* discoverArchiveConfigs(options.outputDirectory);
  const failures: Array<UpdateFailure> = [];
  let archivesUpdated = 0;

  // Archives update one at a time so their individual concurrency limits never multiply.
  for (const entry of discovered) {
    if (!entry.ok) {
      failures.push({ configPath: entry.path, message: entry.message });
      continue;
    }

    const result = yield* Effect.result(downloadAndConfigure(optionsFromConfig(entry.config, entry.path, options)));
    if (Result.isFailure(result)) {
      failures.push({ configPath: entry.path, message: result.failure.message });
      continue;
    }

    const summary = result.success;
    if (summary.truncated || summary.failures.length > 0) {
      failures.push({
        configPath: entry.path,
        message: `Archive remained partial: ${summary.failures.length} failure(s), truncated=${summary.truncated}`,
      });
      continue;
    }

    archivesUpdated += 1;
  }

  return {
    configsFound: discovered.length,
    archivesUpdated,
    failures,
  } satisfies UpdateDocumentationSummary;
});

import * as path from 'node:path';
import { Effect } from 'effect';
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
  readonly githubToken?: string;
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
export const downloadAndConfigure = (options: DocumentationDownloadOptions) =>
  Effect.gen(function* () {
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
export const updateDocumentationArchives = (options: UpdateDocumentationOptions) =>
  Effect.gen(function* () {
    const discovered = yield* discoverArchiveConfigs(options.outputDirectory);
    const failures: Array<UpdateFailure> = discovered.flatMap((entry) =>
      entry.ok ? [] : [{ configPath: entry.path, message: entry.message }]
    );
    const valid = discovered.filter((entry) => entry.ok);
    const results = yield* Effect.forEach(
      valid,
      (entry) =>
        downloadAndConfigure(optionsFromConfig(entry.config, entry.path, options)).pipe(
          Effect.map((summary) => {
            const incompleteCount = Number(summary.truncated) + summary.failures.length;
            if (incompleteCount === 0) return true;
            failures.push({
              configPath: entry.path,
              message: `Archive remained partial: ${summary.failures.length} failure(s), truncated=${summary.truncated}`,
            });
            return false;
          }),
          Effect.catch((error) => {
            failures.push({ configPath: entry.path, message: error.message });
            return Effect.succeed(false);
          })
        ),
      { concurrency: 1 }
    );
    return {
      configsFound: discovered.length,
      archivesUpdated: results.filter(Boolean).length,
      failures,
    } satisfies UpdateDocumentationSummary;
  });

import * as path from 'node:path';
import { Effect, FileSystem, Schema } from 'effect';
import { makeOutputBoundary } from './output-boundary.js';
import type { ProviderKind, DocumentationDownloadOptions } from './providers.js';

/**
 * Reserved per-archive configuration filename discovered by `docsdown update`.
 */
export const archiveConfigFilename = '.docsdown.json';

/**
 * Non-secret crawl settings persisted for repeatable archive updates.
 */
export interface ArchiveDownloadSettings {
  /**
   * Maximum number of simultaneous requests within this archive.
   */
  readonly concurrency: number;

  /**
   * Optional maximum number of Markdown pages selected per run.
   */
  readonly maxPages?: number;

  /**
   * Maximum permitted size for one media response.
   */
  readonly maxMediaBytes: number;

  /**
   * Whether the archive contains only the starting page.
   */
  readonly singlePage: boolean;

  /**
   * Whether successful updates retain stale generated files.
   */
  readonly keepStale: boolean;

  /**
   * Whether request-level progress is printed while updating.
   */
  readonly verbose: boolean;

  /**
   * GitHub paths selected relative to the source URL scope.
   */
  readonly githubPaths: ReadonlyArray<string>;
}

/**
 * Versioned, portable configuration stored at the root of every managed archive.
 */
export interface ArchiveConfig {
  /**
   * Configuration format version.
   */
  readonly schemaVersion: 1;

  /**
   * Starting documentation URL used to recreate the archive.
   */
  readonly source: string;

  /**
   * Provider adapter selected during the original download.
   */
  readonly provider: ProviderKind;

  /**
   * Non-secret options reused by later updates.
   */
  readonly options: ArchiveDownloadSettings;
}

/**
 * One successfully decoded or invalid configuration found during discovery.
 */
export type DiscoveredArchiveConfig =
  | {
      /**
       * Indicates a usable configuration.
       */
      readonly ok: true;

      /**
       * Absolute configuration path.
       */
      readonly path: string;

      /**
       * Validated update configuration.
       */
      readonly config: ArchiveConfig;
    }
  | {
      /**
       * Indicates a configuration that cannot be used.
       */
      readonly ok: false;

      /**
       * Absolute configuration path.
       */
      readonly path: string;

      /**
       * Human-readable parsing or validation error.
       */
      readonly message: string;
    };

/**
 * Runtime decoder for untrusted per-archive JSON configuration.
 */
const ArchiveConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.String,
  provider: Schema.Literals(['website', 'github']),
  options: Schema.Struct({
    concurrency: Schema.Number,
    maxPages: Schema.optionalKey(Schema.Number),
    maxMediaBytes: Schema.Number,
    singlePage: Schema.Boolean,
    keepStale: Schema.Boolean,
    verbose: Schema.Boolean,
    githubPaths: Schema.Array(Schema.String),
  }),
});

/**
 * Parses and validates one untrusted configuration source.
 */
const decodeArchiveConfig = (source: string) =>
  Effect.gen(function* () {
    const json = yield* Effect.try(() => JSON.parse(source) as unknown).pipe(
      Effect.mapError((error) => new Error(`Invalid JSON: ${error.message}`))
    );
    return yield* Schema.decodeUnknownEffect(ArchiveConfigSchema)(json).pipe(
      Effect.mapError((error) => new Error(`Invalid configuration: ${error.message}`))
    );
  });

/**
 * Converts active download options into a token-free portable configuration.
 */
export const makeArchiveConfig = (options: DocumentationDownloadOptions, provider: ProviderKind): ArchiveConfig => ({
  schemaVersion: 1,
  source: options.url,
  provider,
  options: {
    concurrency: options.concurrency,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    maxMediaBytes: options.maxMediaBytes,
    singlePage: options.singlePage,
    keepStale: options.keepStale,
    verbose: options.verbose,
    githubPaths: [...(options.githubPaths ?? [])],
  },
});

/**
 * Writes one deterministic, human-editable archive configuration.
 */
export const writeArchiveConfig = (rootDirectory: string, config: ArchiveConfig) =>
  Effect.gen(function* () {
    const outputBoundary = yield* makeOutputBoundary(rootDirectory);
    yield* outputBoundary.writeFile(
      path.join(rootDirectory, archiveConfigFilename),
      `${JSON.stringify(config, null, 2)}\n`
    );
  });

/**
 * Reads and validates one untrusted archive configuration.
 */
export const readArchiveConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(configPath);
    return yield* decodeArchiveConfig(source);
  });

/**
 * Finds every managed archive configuration beneath an output directory.
 */
export const discoverArchiveConfigs = (outputDirectory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootDirectory = path.resolve(outputDirectory);
    if (!(yield* fileSystem.exists(rootDirectory))) return [];
    const outputBoundary = yield* makeOutputBoundary(rootDirectory);
    const configPaths: Array<string> = [];

    /**
     * Walks verified real directories without allowing recursive discovery to follow symlinks.
     */
    const discover = (directory: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const entries = yield* fileSystem.readDirectory(directory);
        for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
          if (entry === '.manifests') continue;
          const candidate = path.join(directory, entry);
          const safePath = yield* outputBoundary.resolveFile(candidate).pipe(
            Effect.map((resolved) => resolved as string | undefined),
            Effect.catch(() => Effect.succeed(undefined))
          );
          if (!safePath) continue;
          const info = yield* fileSystem.stat(safePath);
          if (info.type === 'Directory') yield* discover(safePath);
          else if (info.type === 'File' && entry === archiveConfigFilename) configPaths.push(safePath);
        }
      });

    yield* discover(rootDirectory);
    return yield* Effect.forEach(
      configPaths,
      (configPath): Effect.Effect<DiscoveredArchiveConfig, never, FileSystem.FileSystem> => {
        return outputBoundary.readFileString(configPath).pipe(
          Effect.flatMap(decodeArchiveConfig),
          Effect.map((config) => ({ ok: true, path: configPath, config }) as const),
          Effect.catch((error) => Effect.succeed({ ok: false, path: configPath, message: error.message } as const))
        );
      }
    );
  });

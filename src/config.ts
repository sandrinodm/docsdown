import * as path from 'node:path';
import { Effect, FileSystem, Option, Schema, type PlatformError } from 'effect';
import { causeMessage, InvalidOptionsError } from './errors.js';
import { makeOutputBoundary } from './output-boundary.js';
import type { ProviderKind, DocumentationDownloadOptions } from './providers.js';

/**
 * Reserved per-archive configuration filename discovered by `docsdown update`.
 */
export const archiveConfigFilename = 'docsdown.json';

/**
 * Hidden configuration filename written by docsdown 0.3 and earlier.
 *
 * It is still discovered so existing archives keep updating, and is replaced by {@link archiveConfigFilename} the next
 * time the archive's configuration is written.
 */
export const legacyArchiveConfigFilename = '.docsdown.json';

/**
 * Every filename that marks a directory as an archive root.
 */
const configFilenames: ReadonlySet<string> = new Set([archiveConfigFilename, legacyArchiveConfigFilename]);

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
 * Whole-number limit that must permit at least one request, page, or byte.
 */
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Runtime decoder for untrusted per-archive JSON configuration.
 */
const ArchiveConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.NonEmptyString,
  provider: Schema.Literals(['website', 'github']),
  options: Schema.Struct({
    concurrency: PositiveInt,
    maxPages: Schema.optionalKey(PositiveInt),
    maxMediaBytes: PositiveInt,
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
    const json = yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      /**
       * Keeps the parser's position-bearing message, which the shorthand `Effect.try` form would discard.
       */
      catch: (cause) => new InvalidOptionsError({ message: `Invalid JSON: ${causeMessage(cause)}` }),
    });

    return yield* Schema.decodeUnknownEffect(ArchiveConfigSchema)(json).pipe(
      Effect.mapError((error) => new InvalidOptionsError({ message: `Invalid configuration: ${error.message}` }))
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
export const writeArchiveConfig = Effect.fn('writeArchiveConfig')(function* (
  rootDirectory: string,
  config: ArchiveConfig
) {
  const outputBoundary = yield* makeOutputBoundary(rootDirectory);
  yield* outputBoundary.writeFile(
    path.join(rootDirectory, archiveConfigFilename),
    `${JSON.stringify(config, null, 2)}\n`
  );

  // Migrates archives created before the configuration file was renamed.
  yield* outputBoundary.removeFile(path.join(rootDirectory, legacyArchiveConfigFilename));
});

/**
 * Reads and validates one untrusted archive configuration.
 */
export const readArchiveConfig = Effect.fn('readArchiveConfig')(function* (configPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFileString(configPath);
  return yield* decodeArchiveConfig(source);
});

/**
 * Archive subdirectories whose files are written from downloaded content.
 */
const generatedDirectories: ReadonlySet<string> = new Set(['content', 'media']);

/**
 * Finds every managed archive configuration beneath an output directory.
 *
 * Discovery does not descend into an archive's generated `content/` and `media/` trees, so remote documentation can
 * never plant a configuration that `docsdown update` would then act on.
 */
export const discoverArchiveConfigs = Effect.fn('discoverArchiveConfigs')(function* (outputDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const rootDirectory = path.resolve(outputDirectory);
  if (!(yield* fileSystem.exists(rootDirectory))) {
    return [];
  }

  const outputBoundary = yield* makeOutputBoundary(rootDirectory);
  const configPaths: Array<string> = [];

  /**
   * Walks verified real directories without allowing recursive discovery to follow symlinks.
   */
  const discover = (directory: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const entries = yield* fileSystem.readDirectory(directory);

      // Inside an archive, everything except the root config was produced from remote content. A downloaded file
      // named `docsdown.json` must never be mistaken for an archive the user configured.
      const isArchiveRoot = entries.some((entry) => configFilenames.has(entry));

      // A not-yet-migrated archive may briefly hold both names; the current one wins.
      const hasCurrentConfig = entries.includes(archiveConfigFilename);

      for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        if (isArchiveRoot && generatedDirectories.has(entry)) {
          continue;
        }

        // Entries that resolve outside the search root, such as escaping symlinks, are skipped silently.
        const safePath = yield* outputBoundary.resolveFile(path.join(directory, entry)).pipe(Effect.option);
        if (Option.isNone(safePath)) {
          continue;
        }

        const info = yield* fileSystem.stat(safePath.value);
        if (info.type === 'Directory') {
          yield* discover(safePath.value);
        } else if (
          info.type === 'File' &&
          (entry === archiveConfigFilename || (entry === legacyArchiveConfigFilename && !hasCurrentConfig))
        ) {
          configPaths.push(safePath.value);
        }
      }
    });

  yield* discover(rootDirectory);

  // Invalid configurations are reported individually instead of stopping discovery.
  return yield* Effect.forEach(configPaths, (configPath) =>
    outputBoundary.readFileString(configPath).pipe(
      Effect.flatMap((source) => decodeArchiveConfig(source)),
      Effect.map((config): DiscoveredArchiveConfig => ({ ok: true, path: configPath, config })),
      Effect.catch((error) =>
        Effect.succeed<DiscoveredArchiveConfig>({ ok: false, path: configPath, message: error.message })
      )
    )
  );
});

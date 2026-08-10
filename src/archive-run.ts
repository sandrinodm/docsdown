import { Data, Effect, Semaphore, type FileSystem } from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as path from 'node:path';
import { describeArchiveFile, finalizeManifest, type ArchiveFile } from './manifest.js';
import { makeOutputBoundary } from './output-boundary.js';
import type { DownloadStrategy, ProviderKind } from './providers.js';

/**
 * Inputs that remain constant throughout one archive attempt.
 */
export interface ArchiveRunOptions {
  /**
   * Provider adapter discovering resources for this run.
   */
  readonly provider: ProviderKind;

  /**
   * Canonical source URL persisted in the manifest.
   */
  readonly source: string;

  /**
   * Primary discovery scope retained for schema compatibility.
   */
  readonly scopePath: string;

  /**
   * Exact scopes represented by the archive.
   */
  readonly scopePaths: ReadonlyArray<string>;

  /**
   * Exact destination directory for the archive.
   */
  readonly outputDirectory: string;

  /**
   * Maximum number of concurrent media requests.
   */
  readonly concurrency: number;

  /**
   * Maximum accepted size for one media resource.
   */
  readonly maxMediaBytes: number;

  /**
   * Whether a complete run may remove stale owned files.
   */
  readonly cleanupEnabled: boolean;

  /**
   * Strategy keys that must remain visible even when no page uses them.
   */
  readonly strategyKeys?: ReadonlyArray<DownloadStrategy>;

  /**
   * Optional progress observer invoked when one media resource fails.
   */
  readonly onMediaFailure?: (failure: ArchiveFailure) => Effect.Effect<void>;
}

/**
 * One normalized page ready to be persisted by the archive module.
 */
export interface ArchivePage {
  /**
   * Provider discovery order retained despite concurrent acquisition.
   */
  readonly order?: number;

  /**
   * Provider-supplied resource key used instead of the destination for duplicate suppression.
   */
  readonly dedupeKey?: string;

  /**
   * Canonical source URL.
   */
  readonly url: string;

  /**
   * Searchable document title.
   */
  readonly title: string;

  /**
   * Acquisition strategy used by the provider.
   */
  readonly strategy: DownloadStrategy;

  /**
   * Absolute path selected beneath the archive root.
   */
  readonly destination: string;

  /**
   * Complete Markdown document to write.
   */
  readonly content: string;
}

/**
 * One remote media resource to fetch beneath the archive root.
 */
export interface ArchiveMedia {
  /**
   * Provider discovery order used to resolve destination collisions deterministically.
   */
  readonly order?: number;

  /**
   * Provider-supplied resource key used instead of the destination for duplicate suppression.
   */
  readonly dedupeKey?: string;

  /**
   * Remote media URL.
   */
  readonly url: string;

  /**
   * Transport URL when the provider reads the resource through a different origin.
   *
   * The canonical `url` remains the only value persisted in manifests and failures.
   */
  readonly requestUrl?: string;

  /**
   * Transport URL appended to HTTP status failures when required by provider diagnostics.
   */
  readonly httpErrorUrl?: string;

  /**
   * Absolute path selected beneath the archive root.
   */
  readonly destination: string;

  /**
   * Caller-supplied request headers, including provider authorization when required.
   */
  readonly headers?: Readonly<Record<string, string>>;

  /**
   * Provider-known size that can reject a request before transfer.
   */
  readonly knownBytes?: number;
}

/**
 * Recoverable provider or resource failure included in a partial manifest.
 */
export interface ArchiveFailure {
  /**
   * Resource that could not be archived.
   */
  readonly url: string;

  /**
   * Human-readable normalized failure reason.
   */
  readonly message: string;
}

/**
 * Provider-facing interface for recording resources without owning archive state.
 */
export interface ArchiveRecorder {
  /**
   * Writes one normalized page unless its destination was already claimed.
   */
  readonly writePage: (page: ArchivePage) => Effect.Effect<boolean, ArchiveRunError, FileSystem.FileSystem>;

  /**
   * Queues one media resource unless its destination was already claimed.
   */
  readonly downloadMedia: (
    media: ArchiveMedia
  ) => Effect.Effect<boolean, ArchiveRunError, FileSystem.FileSystem | HttpClient.HttpClient>;

  /**
   * Records a recoverable provider failure without aborting the archive attempt.
   */
  readonly recordFailure: (failure: ArchiveFailure) => Effect.Effect<void>;
}

/**
 * Completion metadata returned by provider acquisition.
 */
export interface ArchiveAcquisition {
  /**
   * Whether undispatched pages or repository entries remained.
   */
  readonly truncated: boolean;
}

/**
 * Stable user-facing result shared by provider adapters.
 */
export interface ArchiveRunSummary {
  /**
   * Provider adapter that produced this archive.
   */
  readonly provider: ProviderKind;

  /**
   * Absolute archive directory.
   */
  readonly rootDirectory: string;

  /**
   * Number of page files successfully written.
   */
  readonly pagesDownloaded: number;

  /**
   * Number of media files successfully written.
   */
  readonly mediaDownloaded: number;

  /**
   * Number of stale owned files removed.
   */
  readonly filesRemoved: number;

  /**
   * Number of locally modified stale files preserved.
   */
  readonly filesPreserved: number;

  /**
   * Number of stale-file cleanup operations that failed.
   */
  readonly cleanupFailures: number;

  /**
   * Whether the provider left resources undispatched.
   */
  readonly truncated: boolean;

  /**
   * Successful immutable manifest snapshot, absent for partial runs.
   */
  readonly historyManifest: string | undefined;

  /**
   * Search index entries for pages written by this run.
   */
  readonly pages: ReadonlyArray<{ readonly url: string; readonly title: string }>;

  /**
   * Recoverable resource failures that made the run partial.
   */
  readonly failures: ReadonlyArray<{ readonly url: string; readonly message: string }>;
}

/**
 * Typed infrastructure or archive-policy failure that aborts a run.
 */
export class ArchiveRunError extends Data.TaggedError('ArchiveRunError')<{
  /**
   * Operation that could not be completed.
   */
  readonly operation: string;

  /**
   * Human-readable failure reason.
   */
  readonly message: string;

  /**
   * Original failure retained for diagnostics.
   */
  readonly cause: unknown;
}> {}

/**
 * Normalizes recoverable transport and response failures for manifest reporting.
 */
const failureMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Converts an unknown infrastructure failure into the archive module's typed error channel.
 */
const archiveRunError =
  (operation: string) =>
  (cause: unknown): ArchiveRunError =>
    new ArchiveRunError({
      operation,
      message: failureMessage(cause),
      cause,
    });

/**
 * Runs provider acquisition while owning persistence, accounting, cleanup, and manifest finalization.
 */
export const runArchive = <E, R>(
  options: ArchiveRunOptions,
  acquire: (archive: ArchiveRecorder) => Effect.Effect<ArchiveAcquisition, E, R>
) =>
  Effect.gen(function* () {
    const rootDirectory = path.resolve(options.outputDirectory);
    const outputBoundary = yield* makeOutputBoundary(rootDirectory).pipe(
      Effect.mapError(archiveRunError('create archive root'))
    );
    const pages: Array<{
      readonly url: string;
      readonly title: string;
      readonly order: number;
      readonly sequence: number;
    }> = [];
    const files = new Map<string, { readonly file: ArchiveFile; readonly order: number; readonly sequence: number }>();
    const strategies: Record<string, number> = Object.fromEntries(
      (options.strategyKeys ?? []).map((strategy) => [strategy, 0])
    );
    const claimedResources = new Set<string>();
    const destinationSemaphores = new Map<string, Semaphore.Semaphore>();
    const failures: Array<ArchiveFailure> = [];
    let mediaDownloaded = 0;
    let pageSequence = 0;
    let resourceSequence = 0;
    const mediaSemaphore = yield* Semaphore.make(options.concurrency);

    /**
     * Returns the per-destination permit that serializes ownership checks and writes.
     */
    const destinationSemaphore = (destination: string): Semaphore.Semaphore => {
      const existing = destinationSemaphores.get(destination);
      if (existing) return existing;
      const created = Semaphore.makeUnsafe(1);
      destinationSemaphores.set(destination, created);
      return created;
    };

    /**
     * Validates, deduplicates, and allocates deterministic ordering for one provider resource.
     *
     * Validation intentionally precedes duplicate suppression so an invalid destination can never be hidden by a
     * previously claimed provider key.
     */
    const claimResource = (candidate: string, providerKey: string | undefined, requestedOrder: number | undefined) =>
      Effect.gen(function* () {
        const destination = yield* outputBoundary
          .resolveFile(candidate)
          .pipe(Effect.mapError(archiveRunError('validate destination')));
        const dedupeKey = providerKey === undefined ? `destination:${destination}` : `provider:${providerKey}`;
        if (claimedResources.has(dedupeKey)) return undefined;
        claimedResources.add(dedupeKey);
        const sequence = resourceSequence++;
        return {
          destination,
          sequence,
          order: requestedOrder ?? sequence,
        };
      });

    /**
     * Persists a candidate only when it has deterministic precedence over the current destination owner.
     */
    const writeOwnedFile = (
      destination: string,
      file: ArchiveFile,
      content: string | Uint8Array,
      order: number,
      sequence: number
    ) =>
      destinationSemaphore(destination).withPermit(
        Effect.gen(function* () {
          const existing = files.get(file.path);
          if (existing && (existing.order > order || (existing.order === order && existing.sequence > sequence))) {
            return;
          }
          yield* outputBoundary.writeFile(destination, content);
          files.set(file.path, { file, order, sequence });
        })
      );

    const recorder: ArchiveRecorder = {
      /**
       * Claims and persists one normalized Markdown page.
       */
      writePage: (page) =>
        Effect.gen(function* () {
          const claim = yield* claimResource(page.destination, page.dedupeKey, page.order);
          if (!claim) return false;
          const { destination, order, sequence } = claim;
          const file = describeArchiveFile(rootDirectory, destination, 'page', page.url, page.content);
          yield* writeOwnedFile(destination, file, page.content, order, sequence).pipe(
            Effect.mapError(archiveRunError('write page'))
          );
          const stableSequence = pageSequence++;
          pages.push({
            url: page.url,
            title: page.title,
            order: page.order ?? stableSequence,
            sequence: stableSequence,
          });
          strategies[page.strategy] = (strategies[page.strategy] ?? 0) + 1;
          return true;
        }),
      /**
       * Claims and downloads one media request under the run concurrency limit.
       */
      downloadMedia: (media) =>
        Effect.gen(function* () {
          const claim = yield* claimResource(media.destination, media.dedupeKey, media.order);
          if (!claim) return false;
          const { destination, order, sequence } = claim;
          return yield* mediaSemaphore.withPermit(
            Effect.gen(function* () {
              if (media.knownBytes !== undefined && media.knownBytes > options.maxMediaBytes) {
                return yield* Effect.fail(new Error(`Media exceeds ${options.maxMediaBytes} byte limit`));
              }
              const response = yield* HttpClient.get(media.requestUrl ?? media.url, { headers: media.headers });
              if (response.status < 200 || response.status >= 300) {
                return yield* Effect.fail(
                  new Error(`HTTP ${response.status}${media.httpErrorUrl ? ` for ${media.httpErrorUrl}` : ''}`)
                );
              }
              const declaredBytes = Number(response.headers['content-length'] ?? '0');
              if (declaredBytes > options.maxMediaBytes) {
                return yield* Effect.fail(new Error(`Media exceeds ${options.maxMediaBytes} byte limit`));
              }
              const content = new Uint8Array(yield* response.arrayBuffer);
              if (content.byteLength > options.maxMediaBytes) {
                return yield* Effect.fail(new Error(`Media exceeds ${options.maxMediaBytes} byte limit`));
              }
              const file = describeArchiveFile(rootDirectory, destination, 'media', media.url, content);
              yield* writeOwnedFile(destination, file, content, order, sequence);
              mediaDownloaded += 1;
              return true;
            }).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const failure = { url: media.url, message: failureMessage(cause) };
                  failures.push(failure);
                  if (options.onMediaFailure) yield* options.onMediaFailure(failure);
                  return false;
                })
              )
            )
          );
        }),
      /**
       * Adds one provider-reported failure to the ordered run ledger.
       */
      recordFailure: (failure) =>
        Effect.sync(() => {
          failures.push(failure);
        }),
    };

    const acquisition = yield* acquire(recorder);
    const orderedPages = [...pages]
      .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
      .map(({ url, title }) => ({ url, title }));
    const manifest = yield* finalizeManifest(rootDirectory, {
      provider: options.provider,
      source: options.source,
      scopePath: options.scopePath,
      scopePaths: options.scopePaths,
      pagesDownloaded: orderedPages.length,
      mediaDownloaded,
      pages: orderedPages,
      strategies,
      failures,
      files: [...files.values()].map(({ file }) => file),
      truncated: acquisition.truncated,
      cleanupEnabled: options.cleanupEnabled,
    }).pipe(Effect.mapError(archiveRunError('finalize manifest')));

    return {
      provider: options.provider,
      rootDirectory,
      pagesDownloaded: orderedPages.length,
      mediaDownloaded,
      filesRemoved: manifest.removed.length,
      filesPreserved: manifest.preserved.length,
      cleanupFailures: manifest.cleanupFailures.length,
      truncated: acquisition.truncated,
      historyManifest: manifest.historyPath,
      pages: orderedPages,
      failures,
    } satisfies ArchiveRunSummary;
  });

import { Data, Effect, Semaphore, Stream, type FileSystem } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as path from 'node:path';
import { causeMessage, DownloadError } from './errors.js';
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
 * One optional site-supplied discovery index preserved verbatim in the archive.
 */
export interface ArchiveIndex {
  /**
   * Provider discovery order used to resolve destination collisions deterministically.
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
   * Absolute path selected beneath the archive root.
   */
  readonly destination: string;

  /**
   * Unmodified index content supplied by the documentation site.
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
   * Writes one site-supplied discovery index unless its destination was already claimed.
   */
  readonly writeIndex: (index: ArchiveIndex) => Effect.Effect<boolean, ArchiveRunError, FileSystem.FileSystem>;

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
   * Number of optional site-supplied discovery indexes successfully written.
   */
  readonly indexesDownloaded: number;

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
 * Converts an unknown infrastructure failure into the archive module's typed error channel.
 */
const archiveRunError =
  (operation: string) =>
  (cause: unknown): ArchiveRunError =>
    new ArchiveRunError({
      operation,
      message: causeMessage(cause),
      cause,
    });

/**
 * Describes a media resource rejected by the per-file size limit.
 */
const mediaTooLarge = (url: string, maxBytes: number): DownloadError =>
  new DownloadError({ url, message: `Media exceeds ${maxBytes} byte limit` });

/**
 * Collects a response body while enforcing a byte ceiling as chunks arrive.
 *
 * Stopping at the first chunk that crosses the limit bounds memory use even when a server omits or misreports
 * `content-length`, and interrupting the stream releases the underlying connection.
 */
const readBoundedBody = <E>(url: string, body: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let received = 0;
    yield* Stream.runForEach(body, (chunk) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        return Effect.fail(mediaTooLarge(url, maxBytes));
      }

      chunks.push(chunk);
      return Effect.void;
    });
    return Buffer.concat(chunks, received);
  });

/**
 * Fetches one media resource and returns its bytes, enforcing the size limit before, during, and after transfer.
 *
 * The provider-known size rejects a file without any request; the declared `content-length` rejects it before the body
 * is read; the streamed byte count catches servers that omit or understate the length.
 */
const fetchMedia = (media: ArchiveMedia, maxBytes: number) =>
  Effect.gen(function* () {
    if (media.knownBytes !== undefined && media.knownBytes > maxBytes) {
      return yield* mediaTooLarge(media.url, maxBytes);
    }

    const response = yield* HttpClient.get(media.requestUrl ?? media.url, { headers: media.headers });
    if (response.status < 200 || response.status >= 300) {
      return yield* new DownloadError({
        url: media.url,
        message: `HTTP ${response.status}${media.httpErrorUrl ? ` for ${media.httpErrorUrl}` : ''}`,
      });
    }

    const declaredBytes = Number(response.headers['content-length'] ?? '0');
    if (declaredBytes > maxBytes) {
      return yield* mediaTooLarge(media.url, maxBytes);
    }

    return yield* readBoundedBody(media.url, response.stream, maxBytes);
  });

/**
 * Position of a resource in the provider's discovery order, used to decide which resource owns a contested file.
 */
interface ResourceRank {
  /**
   * Provider-supplied discovery order.
   */
  readonly order: number;

  /**
   * Claim sequence that breaks ties between resources with the same order.
   */
  readonly sequence: number;
}

/**
 * Whether `incumbent` keeps a destination that `challenger` also wants.
 *
 * The later discovery order wins, with the later claim breaking ties, so the file on disk matches what a sequential run
 * would leave behind no matter which concurrent write finishes first.
 */
const outranks = (incumbent: ResourceRank, challenger: ResourceRank): boolean =>
  incumbent.order > challenger.order ||
  (incumbent.order === challenger.order && incumbent.sequence > challenger.sequence);

/**
 * Runs provider acquisition while owning persistence, accounting, cleanup, and manifest finalization.
 */
export const runArchive = Effect.fn('runArchive')(function* <E, R>(
  options: ArchiveRunOptions,
  acquire: (archive: ArchiveRecorder) => Effect.Effect<ArchiveAcquisition, E, R>
) {
  const rootDirectory = path.resolve(options.outputDirectory);
  const outputBoundary = yield* makeOutputBoundary(rootDirectory).pipe(
    Effect.mapError(archiveRunError('create archive root'))
  );

  // What this run has produced, reported in the manifest and summary.
  const pages: Array<{ readonly url: string; readonly title: string } & ResourceRank> = [];
  const files = new Map<string, { readonly file: ArchiveFile } & ResourceRank>();
  const failures: Array<ArchiveFailure> = [];
  const strategies: Record<string, number> = Object.fromEntries(
    (options.strategyKeys ?? []).map((strategy) => [strategy, 0])
  );
  let mediaDownloaded = 0;
  let indexesDownloaded = 0;

  // Claim bookkeeping that keeps concurrent providers deterministic.
  const claimedResources = new Set<string>();
  const destinationSemaphores = new Map<string, Semaphore.Semaphore>();
  const mediaSemaphore = yield* Semaphore.make(options.concurrency);
  let resourceSequence = 0;

  /**
   * Returns the per-destination permit that serializes ownership checks and writes.
   */
  const destinationSemaphore = (destination: string): Semaphore.Semaphore => {
    const existing = destinationSemaphores.get(destination);
    if (existing) {
      return existing;
    }

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
      if (claimedResources.has(dedupeKey)) {
        return undefined;
      }

      claimedResources.add(dedupeKey);

      const sequence = resourceSequence++;
      return { destination, sequence, order: requestedOrder ?? sequence };
    });

  /**
   * Persists a candidate unless a higher-ranked resource already owns the destination.
   */
  const writeOwnedFile = (destination: string, file: ArchiveFile, content: string | Uint8Array, rank: ResourceRank) =>
    destinationSemaphore(destination).withPermit(
      Effect.gen(function* () {
        const existing = files.get(file.path);
        if (existing && outranks(existing, rank)) {
          return;
        }

        yield* outputBoundary.writeFile(destination, content);
        files.set(file.path, { file, ...rank });
      })
    );

  const recorder: ArchiveRecorder = {
    /**
     * Claims and persists one normalized Markdown page.
     */
    writePage: (page) =>
      Effect.gen(function* () {
        const claim = yield* claimResource(page.destination, page.dedupeKey, page.order);
        if (!claim) {
          return false;
        }

        const file = describeArchiveFile(rootDirectory, claim.destination, 'page', page.url, page.content);
        yield* writeOwnedFile(claim.destination, file, page.content, claim).pipe(
          Effect.mapError(archiveRunError('write page'))
        );

        pages.push({ url: page.url, title: page.title, order: claim.order, sequence: claim.sequence });
        strategies[page.strategy] = (strategies[page.strategy] ?? 0) + 1;
        return true;
      }),

    /**
     * Claims and persists one site-supplied discovery index without counting it as a documentation page.
     */
    writeIndex: (index) =>
      Effect.gen(function* () {
        const claim = yield* claimResource(index.destination, index.dedupeKey, index.order);
        if (!claim) {
          return false;
        }

        const file = describeArchiveFile(rootDirectory, claim.destination, 'index', index.url, index.content);
        yield* writeOwnedFile(claim.destination, file, index.content, claim).pipe(
          Effect.mapError(archiveRunError('write index'))
        );

        indexesDownloaded += 1;
        return true;
      }),

    /**
     * Claims and downloads one media request under the run concurrency limit.
     *
     * Media failures are recorded and reported but never abort the run; the page that referenced the media still
     * succeeds and keeps its remote link.
     */
    downloadMedia: (media) =>
      Effect.gen(function* () {
        const claim = yield* claimResource(media.destination, media.dedupeKey, media.order);
        if (!claim) {
          return false;
        }

        const download = Effect.gen(function* () {
          const content = yield* fetchMedia(media, options.maxMediaBytes);
          const file = describeArchiveFile(rootDirectory, claim.destination, 'media', media.url, content);
          yield* writeOwnedFile(claim.destination, file, content, claim);
          mediaDownloaded += 1;
          return true;
        });

        return yield* mediaSemaphore.withPermit(download).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failure = { url: media.url, message: causeMessage(error) };
              failures.push(failure);
              if (options.onMediaFailure) {
                yield* options.onMediaFailure(failure);
              }

              return false;
            })
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
    indexesDownloaded,
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
    indexesDownloaded,
    filesRemoved: manifest.removed.length,
    filesPreserved: manifest.preserved.length,
    cleanupFailures: manifest.cleanupFailures.length,
    truncated: acquisition.truncated,
    pages: orderedPages,
    failures,
  } satisfies ArchiveRunSummary;
});

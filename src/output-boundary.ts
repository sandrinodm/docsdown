import { Data, Effect, FileSystem, Semaphore } from 'effect';
import * as path from 'node:path';

/**
 * Filesystem content accepted by the archive's atomic writer.
 */
export type OutputFileContent = string | Uint8Array;

/**
 * Security failure raised when an archive path is unsafe or cannot be verified.
 */
export class OutputBoundaryError extends Data.TaggedError('OutputBoundaryError')<{
  /** Boundary operation that failed. */
  readonly operation: string;
  /** Untrusted or derived path being checked. */
  readonly filePath: string;
  /** Human-readable failure reason. */
  readonly message: string;
}> {}

/**
 * Canonical output-root policy used by every archive filesystem mutation.
 */
export interface OutputBoundary {
  /**
   * Absolute output directory supplied by the caller.
   */
  readonly rootDirectory: string;

  /**
   * Validates a file destination lexically and against every existing filesystem ancestor.
   */
  readonly resolveFile: (candidate: string) => Effect.Effect<string, OutputBoundaryError>;

  /**
   * Checks whether a verified regular path currently exists.
   */
  readonly exists: (candidate: string) => Effect.Effect<boolean, OutputBoundaryError>;

  /**
   * Reads a verified file without following a path outside the output root.
   */
  readonly readFile: (candidate: string) => Effect.Effect<Uint8Array, OutputBoundaryError>;

  /**
   * Reads a verified UTF-8 file without following a path outside the output root.
   */
  readonly readFileString: (candidate: string) => Effect.Effect<string, OutputBoundaryError>;

  /**
   * Atomically writes a verified file without following a final symlink or hard link.
   */
  readonly writeFile: (candidate: string, content: OutputFileContent) => Effect.Effect<void, OutputBoundaryError>;

  /**
   * Removes a verified file without resolving through an escaping parent symlink.
   */
  readonly removeFile: (candidate: string) => Effect.Effect<void, OutputBoundaryError>;
}

/**
 * Converts unknown platform failures into stable boundary diagnostics.
 */
const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Creates an output-boundary error mapper for one filesystem operation.
 */
const boundaryError = (operation: string, filePath: string) => (cause: unknown) =>
  new OutputBoundaryError({ operation, filePath, message: causeMessage(cause) });

/**
 * Returns whether a resolved path is strictly below a canonical directory.
 */
const isBelow = (rootDirectory: string, candidate: string): boolean => {
  const relative = path.relative(rootDirectory, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * Establishes a canonical, fail-closed filesystem boundary for one output directory.
 *
 * Existing ancestors are resolved before use, newly required directories are created one segment at a time, and file
 * replacement uses a temporary file plus rename so final symlinks and hard links are never followed for writes.
 */
export const makeOutputBoundary = (outputDirectory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootDirectory = path.resolve(outputDirectory);
    yield* fileSystem
      .makeDirectory(rootDirectory, { recursive: true })
      .pipe(Effect.mapError(boundaryError('create output root', rootDirectory)));
    const canonicalRoot = path.resolve(
      yield* fileSystem
        .realPath(rootDirectory)
        .pipe(Effect.mapError(boundaryError('resolve output root', rootDirectory)))
    );
    const rootInfo = yield* fileSystem
      .stat(canonicalRoot)
      .pipe(Effect.mapError(boundaryError('inspect output root', rootDirectory)));
    if (rootInfo.type !== 'Directory') {
      return yield* Effect.fail(
        new OutputBoundaryError({
          operation: 'inspect output root',
          filePath: rootDirectory,
          message: 'Output root must resolve to a directory',
        })
      );
    }
    const directorySemaphore = yield* Semaphore.make(1);

    /**
     * Resolves one candidate into matching lexical and canonical locations below the root.
     */
    const describeCandidate = (candidate: string) =>
      Effect.try({
        /**
         * Produces root-relative lexical and canonical representations without filesystem access.
         */
        try: () => {
          const destination = path.resolve(candidate);
          if (!isBelow(rootDirectory, destination)) {
            throw new Error(`Destination must be a file beneath the output root: ${candidate}`);
          }
          const relative = path.relative(rootDirectory, destination);
          return {
            destination,
            canonicalDestination: path.resolve(canonicalRoot, ...relative.split(path.sep)),
            directorySegments: path
              .dirname(relative)
              .split(path.sep)
              .filter((segment) => segment !== '.'),
          };
        },
        catch: boundaryError('validate destination', candidate),
      });

    /**
     * Verifies existing parents and optionally creates missing directories without recursive traversal.
     */
    const inspectDirectories = (segments: ReadonlyArray<string>, create: boolean) =>
      Effect.gen(function* () {
        let lexicalDirectory = rootDirectory;
        let canonicalDirectory = canonicalRoot;
        for (const segment of segments) {
          lexicalDirectory = path.join(lexicalDirectory, segment);
          canonicalDirectory = path.join(canonicalDirectory, segment);
          const exists = yield* fileSystem
            .exists(lexicalDirectory)
            .pipe(Effect.mapError(boundaryError('inspect output directory', lexicalDirectory)));
          if (!exists && !create) return;
          if (!exists) {
            yield* fileSystem
              .makeDirectory(lexicalDirectory)
              .pipe(Effect.mapError(boundaryError('create output directory', lexicalDirectory)));
          }
          const resolved = path.resolve(
            yield* fileSystem
              .realPath(lexicalDirectory)
              .pipe(Effect.mapError(boundaryError('resolve output directory', lexicalDirectory)))
          );
          if (resolved !== path.resolve(canonicalDirectory)) {
            return yield* Effect.fail(
              new OutputBoundaryError({
                operation: 'resolve output directory',
                filePath: lexicalDirectory,
                message: 'Resolved directory escaped or redirected within the output root',
              })
            );
          }
          const info = yield* fileSystem
            .stat(resolved)
            .pipe(Effect.mapError(boundaryError('inspect output directory', lexicalDirectory)));
          if (info.type !== 'Directory') {
            return yield* Effect.fail(
              new OutputBoundaryError({
                operation: 'inspect output directory',
                filePath: lexicalDirectory,
                message: 'Output path ancestor must be a directory',
              })
            );
          }
        }
      });

    /**
     * Serializes directory creation so concurrent resources cannot race on a shared missing parent.
     */
    const verifyDirectories = (segments: ReadonlyArray<string>, create: boolean) =>
      create ? directorySemaphore.withPermit(inspectDirectories(segments, true)) : inspectDirectories(segments, false);

    /**
     * Rejects an existing final path when canonical resolution changes its destination.
     */
    const verifyFinalPath = (destination: string, canonicalDestination: string) =>
      Effect.gen(function* () {
        const exists = yield* fileSystem
          .exists(destination)
          .pipe(Effect.mapError(boundaryError('inspect output file', destination)));
        if (!exists) return;
        const resolved = path.resolve(
          yield* fileSystem
            .realPath(destination)
            .pipe(Effect.mapError(boundaryError('resolve output file', destination)))
        );
        if (resolved !== canonicalDestination) {
          return yield* Effect.fail(
            new OutputBoundaryError({
              operation: 'resolve output file',
              filePath: destination,
              message: 'Resolved file escaped or redirected within the output root',
            })
          );
        }
      });

    /**
     * Validates one destination without creating its missing parent directories.
     */
    const resolveFile: OutputBoundary['resolveFile'] = (candidate) =>
      Effect.gen(function* () {
        const described = yield* describeCandidate(candidate);
        yield* verifyDirectories(described.directorySegments, false);
        yield* verifyFinalPath(described.destination, described.canonicalDestination);
        return described.destination;
      });

    /**
     * Converts one verified lexical destination into its canonical root-relative location.
     */
    const canonicalFile = (destination: string): string =>
      path.resolve(canonicalRoot, ...path.relative(rootDirectory, destination).split(path.sep));

    /**
     * Checks one destination only after canonical validation.
     */
    const exists: OutputBoundary['exists'] = (candidate) =>
      Effect.gen(function* () {
        const destination = yield* resolveFile(candidate);
        return yield* fileSystem
          .exists(canonicalFile(destination))
          .pipe(Effect.mapError(boundaryError('inspect output file', destination)));
      });

    /**
     * Reads binary content from the canonical root-relative destination.
     */
    const readFile: OutputBoundary['readFile'] = (candidate) =>
      Effect.gen(function* () {
        const destination = yield* resolveFile(candidate);
        return yield* fileSystem
          .readFile(canonicalFile(destination))
          .pipe(Effect.mapError(boundaryError('read output file', destination)));
      });

    /**
     * Reads text content from the canonical root-relative destination.
     */
    const readFileString: OutputBoundary['readFileString'] = (candidate) =>
      Effect.gen(function* () {
        const destination = yield* resolveFile(candidate);
        return yield* fileSystem
          .readFileString(canonicalFile(destination))
          .pipe(Effect.mapError(boundaryError('read output file', destination)));
      });

    /**
     * Creates parents safely and atomically replaces one destination.
     */
    const writeFile: OutputBoundary['writeFile'] = (candidate, content) =>
      Effect.gen(function* () {
        const described = yield* describeCandidate(candidate);
        yield* verifyDirectories(described.directorySegments, true);
        yield* verifyFinalPath(described.destination, described.canonicalDestination);
        const canonicalDirectory = path.dirname(described.canonicalDestination);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temporaryFile = yield* fileSystem
              .makeTempFileScoped({ directory: canonicalDirectory, prefix: '.docsdown-', suffix: '.tmp' })
              .pipe(Effect.mapError(boundaryError('create temporary output file', described.destination)));
            if (typeof content === 'string') {
              yield* fileSystem
                .writeFileString(temporaryFile, content)
                .pipe(Effect.mapError(boundaryError('write temporary output file', described.destination)));
            } else {
              yield* fileSystem
                .writeFile(temporaryFile, content)
                .pipe(Effect.mapError(boundaryError('write temporary output file', described.destination)));
            }
            yield* fileSystem
              .rename(temporaryFile, described.canonicalDestination)
              .pipe(Effect.mapError(boundaryError('replace output file', described.destination)));
          })
        );
      });

    /**
     * Removes one canonical root-relative destination after revalidation.
     */
    const removeFile: OutputBoundary['removeFile'] = (candidate) =>
      Effect.gen(function* () {
        const destination = yield* resolveFile(candidate);
        yield* fileSystem
          .remove(canonicalFile(destination), { force: true })
          .pipe(Effect.mapError(boundaryError('remove output file', destination)));
      });

    return {
      rootDirectory,
      resolveFile,
      exists,
      readFile,
      readFileString,
      writeFile,
      removeFile,
    } satisfies OutputBoundary;
  });

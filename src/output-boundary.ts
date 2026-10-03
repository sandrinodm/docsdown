import { Data, Effect, FileSystem, Semaphore } from 'effect';
import * as path from 'node:path';
import { causeMessage } from './errors.js';

/**
 * Filesystem content accepted by the archive's atomic writer.
 */
export type OutputFileContent = string | Uint8Array;

/**
 * Security failure raised when an archive path is unsafe or cannot be verified.
 */
export class OutputBoundaryError extends Data.TaggedError('OutputBoundaryError')<{
  /**
   * Boundary operation that failed.
   */
  readonly operation: string;

  /**
   * Untrusted or derived path being checked.
   */
  readonly filePath: string;

  /**
   * Human-readable failure reason.
   */
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
 * Runs one filesystem operation, reporting any platform failure as a boundary error for that operation and path.
 */
const attempt = <A, E, R>(operation: string, filePath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(effect, boundaryError(operation, filePath));

/**
 * Describes a path that would leave, or be redirected within, the output root.
 */
const violation = (operation: string, filePath: string, message: string) =>
  new OutputBoundaryError({ operation, filePath, message });

/**
 * Establishes a canonical, fail-closed filesystem boundary for one output directory.
 *
 * Existing ancestors are resolved before use, newly required directories are created one segment at a time, and file
 * replacement uses a temporary file plus rename so final symlinks and hard links are never followed for writes.
 */
export const makeOutputBoundary = Effect.fn('makeOutputBoundary')(function* (outputDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const rootDirectory = path.resolve(outputDirectory);

  // The canonical root is the trust anchor: every later path must resolve beneath it.
  yield* attempt('create output root', rootDirectory, fileSystem.makeDirectory(rootDirectory, { recursive: true }));
  const canonicalRoot = path.resolve(
    yield* attempt('resolve output root', rootDirectory, fileSystem.realPath(rootDirectory))
  );
  const rootInfo = yield* attempt('inspect output root', rootDirectory, fileSystem.stat(canonicalRoot));
  if (rootInfo.type !== 'Directory') {
    return yield* violation('inspect output root', rootDirectory, 'Output root must resolve to a directory');
  }

  const directorySemaphore = yield* Semaphore.make(1);

  /**
   * Resolves one candidate into matching lexical and canonical locations below the root, without filesystem access.
   */
  const describeCandidate = (candidate: string) =>
    Effect.try({
      /**
       * Rejects paths outside the root, then splits the rest into the parent directories to verify.
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
   * Walks the parent directories one segment at a time, optionally creating missing ones.
   *
   * Each existing segment must resolve to exactly where it should be, so a symlinked or redirected parent is rejected
   * before anything is read or written through it.
   */
  const inspectDirectories = (segments: ReadonlyArray<string>, create: boolean) =>
    Effect.gen(function* () {
      let lexicalDirectory = rootDirectory;
      let canonicalDirectory = canonicalRoot;

      for (const segment of segments) {
        lexicalDirectory = path.join(lexicalDirectory, segment);
        canonicalDirectory = path.join(canonicalDirectory, segment);

        const exists = yield* attempt(
          'inspect output directory',
          lexicalDirectory,
          fileSystem.exists(lexicalDirectory)
        );
        if (!exists && !create) {
          return;
        }

        if (!exists) {
          yield* attempt('create output directory', lexicalDirectory, fileSystem.makeDirectory(lexicalDirectory));
        }

        const resolved = path.resolve(
          yield* attempt('resolve output directory', lexicalDirectory, fileSystem.realPath(lexicalDirectory))
        );
        if (resolved !== path.resolve(canonicalDirectory)) {
          return yield* violation(
            'resolve output directory',
            lexicalDirectory,
            'Resolved directory escaped or redirected within the output root'
          );
        }

        const info = yield* attempt('inspect output directory', lexicalDirectory, fileSystem.stat(resolved));
        if (info.type !== 'Directory') {
          return yield* violation(
            'inspect output directory',
            lexicalDirectory,
            'Output path ancestor must be a directory'
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
      const exists = yield* attempt('inspect output file', destination, fileSystem.exists(destination));
      if (!exists) {
        return;
      }

      const resolved = path.resolve(
        yield* attempt('resolve output file', destination, fileSystem.realPath(destination))
      );
      if (resolved !== canonicalDestination) {
        return yield* violation(
          'resolve output file',
          destination,
          'Resolved file escaped or redirected within the output root'
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
      return yield* attempt('inspect output file', destination, fileSystem.exists(canonicalFile(destination)));
    });

  /**
   * Reads binary content from the canonical root-relative destination.
   */
  const readFile: OutputBoundary['readFile'] = (candidate) =>
    Effect.gen(function* () {
      const destination = yield* resolveFile(candidate);
      return yield* attempt('read output file', destination, fileSystem.readFile(canonicalFile(destination)));
    });

  /**
   * Reads text content from the canonical root-relative destination.
   */
  const readFileString: OutputBoundary['readFileString'] = (candidate) =>
    Effect.gen(function* () {
      const destination = yield* resolveFile(candidate);
      return yield* attempt('read output file', destination, fileSystem.readFileString(canonicalFile(destination)));
    });

  /**
   * Creates parents safely and atomically replaces one destination.
   *
   * Content goes to a temporary file in the same directory first and is then renamed over the destination, so readers
   * never see a partial file and an existing symlink or hard link at the destination is replaced rather than followed.
   */
  const writeFile: OutputBoundary['writeFile'] = (candidate, content) =>
    Effect.gen(function* () {
      const { destination, canonicalDestination, directorySegments } = yield* describeCandidate(candidate);
      yield* verifyDirectories(directorySegments, true);
      yield* verifyFinalPath(destination, canonicalDestination);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryFile = yield* attempt(
            'create temporary output file',
            destination,
            fileSystem.makeTempFileScoped({
              directory: path.dirname(canonicalDestination),
              prefix: '.docsdown-',
              suffix: '.tmp',
            })
          );

          const write =
            typeof content === 'string'
              ? fileSystem.writeFileString(temporaryFile, content)
              : fileSystem.writeFile(temporaryFile, content);
          yield* attempt('write temporary output file', destination, write);

          yield* attempt('replace output file', destination, fileSystem.rename(temporaryFile, canonicalDestination));
        })
      );
    });

  /**
   * Removes one canonical root-relative destination after revalidation.
   */
  const removeFile: OutputBoundary['removeFile'] = (candidate) =>
    Effect.gen(function* () {
      const destination = yield* resolveFile(candidate);
      yield* attempt('remove output file', destination, fileSystem.remove(canonicalFile(destination), { force: true }));
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

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeOutputBoundary, OutputBoundaryError } from './output-boundary.js';

/**
 * Temporary roots removed after each boundary test.
 */
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('output boundary', () => {
  it('rejects a filesystem adapter whose created output root is not a directory', async () => {
    const nonDirectoryFileSystem = {
      /** Simulates successful root creation. */
      makeDirectory: () => Effect.void,
      /** Returns the requested path as its canonical location. */
      realPath: (filePath: string) => Effect.succeed(filePath),
      /** Reports an invalid non-directory output root. */
      stat: () => Effect.succeed({ type: 'File' } as FileSystem.File.Info),
    } as unknown as FileSystem.FileSystem;

    const error = await makeOutputBoundary('/virtual-output').pipe(
      Effect.provideService(FileSystem.FileSystem, nonDirectoryFileSystem),
      Effect.flip,
      Effect.runPromise
    );

    expect(error).toBeInstanceOf(OutputBoundaryError);
    expect(error).toMatchObject({
      operation: 'inspect output root',
      message: 'Output root must resolve to a directory',
    });
  });

  it('rejects a regular file where a destination requires a parent directory', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-output-boundary-test-'));
    temporaryDirectories.push(rootDirectory);
    const blockedParent = path.join(rootDirectory, 'blocked');
    await writeFile(blockedParent, 'not a directory');

    const error = await makeOutputBoundary(rootDirectory).pipe(
      Effect.flatMap((boundary) => boundary.writeFile(path.join(blockedParent, 'page.md'), '# Unsafe\n')),
      Effect.provide(NodeServices.layer),
      Effect.flip,
      Effect.runPromise
    );

    expect(error).toBeInstanceOf(OutputBoundaryError);
    expect(error).toMatchObject({ operation: 'inspect output directory' });
  });
});

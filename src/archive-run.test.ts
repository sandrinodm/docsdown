import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer } from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveRunError, runArchive } from './archive-run.js';

/**
 * Production filesystem and fetch-backed HTTP adapters used at the public seam.
 */
const TestLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);

/**
 * Temporary roots removed after each test.
 */
const temporaryDirectories: Array<string> = [];

/**
 * Starts a loopback HTTP fixture and returns its origin and deterministic close operation.
 */
const listen = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    /**
     * Closes active connections and then stops the fixture server.
     */
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('archive run', () => {
  it('writes a page and finalizes the archive through one public run', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);

    const summary = await runArchive(
      {
        provider: 'website',
        source: 'https://example.com/docs',
        scopePath: '/docs',
        scopePaths: ['/docs'],
        outputDirectory: rootDirectory,
        concurrency: 2,
        maxMediaBytes: 1_000,
        cleanupEnabled: true,
        strategyKeys: ['markdown-suffix', 'html-conversion'],
      },
      (archive) =>
        Effect.gen(function* () {
          yield* archive.writePage({
            url: 'https://example.com/docs',
            title: 'Example docs',
            strategy: 'markdown-suffix',
            destination: path.join(rootDirectory, 'index.md'),
            content: '# Example docs\n',
          });
          const duplicate = yield* archive.writePage({
            url: 'https://example.com/docs/duplicate',
            title: 'Duplicate',
            strategy: 'html-conversion',
            destination: path.join(rootDirectory, 'index.md'),
            content: '# Duplicate\n',
          });
          expect(duplicate).toBe(false);
          return { truncated: false };
        })
    ).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(summary).toMatchObject({
      provider: 'website',
      rootDirectory: path.resolve(rootDirectory),
      pagesDownloaded: 1,
      mediaDownloaded: 0,
      pages: [{ url: 'https://example.com/docs', title: 'Example docs' }],
      failures: [],
      truncated: false,
    });
    expect(await readFile(path.join(rootDirectory, 'index.md'), 'utf8')).toBe('# Example docs\n');
    const manifest = JSON.parse(await readFile(path.join(rootDirectory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      pagesDownloaded: 1,
      mediaDownloaded: 0,
      strategies: { 'markdown-suffix': 1, 'html-conversion': 0 },
      files: [{ path: 'index.md', kind: 'page', url: 'https://example.com/docs' }],
      cleanup: { enabled: true, eligible: true },
    });
  });

  it('retains provider page order when concurrent writes finish out of order', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);

    const summary = await runArchive(
      {
        provider: 'github',
        source: 'https://github.com/example/docs',
        scopePath: '/',
        scopePaths: ['/'],
        outputDirectory: rootDirectory,
        concurrency: 2,
        maxMediaBytes: 1_000,
        cleanupEnabled: true,
      },
      (archive) =>
        Effect.forEach(
          [
            { order: 0, delay: '20 millis', name: 'first' },
            { order: 1, delay: '0 millis', name: 'second' },
            { order: 1, delay: '10 millis', name: 'third' },
          ] as const,
          ({ order, delay, name }) =>
            Effect.sleep(delay).pipe(
              Effect.andThen(
                archive.writePage({
                  order,
                  url: `https://github.com/example/docs/blob/main/${name}.md`,
                  title: name,
                  strategy: 'github-raw',
                  destination: path.join(rootDirectory, `${name}.md`),
                  content: `# ${name}\n`,
                })
              )
            ),
          { concurrency: 'unbounded' }
        ).pipe(Effect.as({ truncated: false }))
    ).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(summary.pages.map((page) => page.title)).toEqual(['first', 'second', 'third']);
    const manifest = JSON.parse(await readFile(path.join(rootDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.pages.map((page: { readonly title: string }) => page.title)).toEqual(['first', 'second', 'third']);
  });

  it('downloads caller-authorized media once per destination without persisting headers', async () => {
    let requests = 0;
    const server = await listen((request, response) => {
      requests += 1;
      expect(request.headers.authorization).toBe('Bearer secret-token');
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
      response.end(new Uint8Array([1, 2, 3, 4]));
    });
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);
    try {
      const destination = path.join(rootDirectory, 'media', 'logo.png');
      const summary = await runArchive(
        {
          provider: 'github',
          source: 'https://github.com/example/docs',
          scopePath: '',
          scopePaths: ['docs'],
          outputDirectory: rootDirectory,
          concurrency: 2,
          maxMediaBytes: 1_000,
          cleanupEnabled: true,
        },
        (archive) =>
          Effect.gen(function* () {
            yield* archive.writePage({
              url: 'https://github.com/example/docs/blob/main/docs/index.md',
              title: 'GitHub docs',
              strategy: 'github-raw',
              destination: path.join(rootDirectory, 'docs', 'index.md'),
              content: '# GitHub docs\n',
            });
            yield* archive.downloadMedia({
              url: 'https://github.com/example/docs/blob/main/media/logo.png',
              requestUrl: `${server.origin}/first.png`,
              destination,
              headers: { authorization: 'Bearer secret-token' },
            });
            yield* archive.downloadMedia({
              url: 'https://github.com/example/docs/blob/main/media/duplicate.png',
              requestUrl: `${server.origin}/duplicate.png`,
              destination,
              headers: { authorization: 'Bearer secret-token' },
            });
            return { truncated: false };
          })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(requests).toBe(1);
      expect(summary.mediaDownloaded).toBe(1);
      expect(Array.from(await readFile(destination))).toEqual([1, 2, 3, 4]);
      const manifestSource = await readFile(path.join(rootDirectory, 'manifest.json'), 'utf8');
      expect(manifestSource).not.toContain('secret-token');
      expect(JSON.parse(manifestSource).files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'media/logo.png',
            kind: 'media',
            url: 'https://github.com/example/docs/blob/main/media/logo.png',
            bytes: 4,
          }),
        ])
      );
    } finally {
      await server.close();
    }
  });

  it('keeps the deterministic media owner when colliding requests finish out of order', async () => {
    const server = await listen((request, response) => {
      const slow = request.url?.includes('slow') ?? false;
      const content = request.url?.includes('fast') ? new Uint8Array([2]) : new Uint8Array([1]);
      /**
       * Completes one delayed or immediate collision response.
       */
      const complete = () => {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1' });
        response.end(content);
      };
      if (slow) setTimeout(complete, 20);
      else complete();
    });
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);
    try {
      const orderedDestination = path.join(rootDirectory, 'media', 'ordered.bin');
      const sequencedDestination = path.join(rootDirectory, 'media', 'sequenced.bin');
      const summary = await runArchive(
        {
          provider: 'website',
          source: 'https://example.com/docs',
          scopePath: '/docs',
          scopePaths: ['/docs'],
          outputDirectory: rootDirectory,
          concurrency: 4,
          maxMediaBytes: 1_000,
          cleanupEnabled: true,
        },
        (archive) =>
          Effect.forEach(
            [
              { url: `${server.origin}/ordered-slow`, destination: orderedDestination, order: 0 },
              { url: `${server.origin}/ordered-fast`, destination: orderedDestination, order: 1 },
              { url: `${server.origin}/sequenced-slow`, destination: sequencedDestination, order: 2 },
              { url: `${server.origin}/sequenced-fast`, destination: sequencedDestination, order: 2 },
            ],
            (media) => archive.downloadMedia({ ...media, dedupeKey: media.url }),
            { concurrency: 'unbounded' }
          ).pipe(Effect.as({ truncated: false }))
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(summary.mediaDownloaded).toBe(4);
      expect(Array.from(await readFile(orderedDestination))).toEqual([2]);
      expect(Array.from(await readFile(sequencedDestination))).toEqual([2]);
      const manifest = JSON.parse(await readFile(path.join(rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'media/ordered.bin', url: `${server.origin}/ordered-fast` }),
          expect.objectContaining({ path: 'media/sequenced.bin', url: `${server.origin}/sequenced-fast` }),
        ])
      );
    } finally {
      await server.close();
    }
  });

  it('records provider and known, declared, and actual media failures as a partial run', async () => {
    let knownSizeRequests = 0;
    const observedMediaFailures: Array<{ readonly url: string; readonly message: string }> = [];
    const server = await listen((request, response) => {
      if (request.url === '/known.png') knownSizeRequests += 1;
      if (request.url?.startsWith('/missing')) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.url === '/declared.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '5' });
        response.end(new Uint8Array([1, 2, 3, 4, 5]));
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
      response.write(new Uint8Array([1, 2, 3]));
      response.end(new Uint8Array([4, 5]));
    });
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);
    try {
      const summary = await runArchive(
        {
          provider: 'github',
          source: 'https://github.com/example/docs',
          scopePath: '',
          scopePaths: ['docs'],
          outputDirectory: rootDirectory,
          concurrency: 2,
          maxMediaBytes: 4,
          cleanupEnabled: true,
          /**
           * Captures the same recoverable media failures returned in the summary.
           */
          onMediaFailure: (failure) =>
            Effect.sync(() => {
              observedMediaFailures.push(failure);
            }),
        },
        (archive) =>
          Effect.gen(function* () {
            yield* archive.writePage({
              url: 'https://github.com/example/docs/blob/main/docs/index.md',
              title: 'GitHub docs',
              strategy: 'github-raw',
              destination: path.join(rootDirectory, 'docs', 'index.md'),
              content: '# GitHub docs\n',
            });
            yield* archive.recordFailure({
              url: 'https://github.com/example/docs/blob/main/docs/missing.md',
              message: 'HTTP 404',
            });
            yield* archive.downloadMedia({
              url: `${server.origin}/known.png`,
              destination: path.join(rootDirectory, 'media', 'known.png'),
              knownBytes: 5,
            });
            yield* archive.downloadMedia({
              url: `${server.origin}/declared.png`,
              destination: path.join(rootDirectory, 'media', 'declared.png'),
            });
            yield* archive.downloadMedia({
              url: `${server.origin}/actual.png`,
              destination: path.join(rootDirectory, 'media', 'actual.png'),
            });
            yield* archive.downloadMedia({
              url: 'https://github.com/example/docs/blob/main/media/missing.png',
              requestUrl: `${server.origin}/missing.png`,
              httpErrorUrl: `${server.origin}/missing.png`,
              destination: path.join(rootDirectory, 'media', 'missing.png'),
            });
            yield* archive.downloadMedia({
              url: `${server.origin}/missing-no-context.png`,
              destination: path.join(rootDirectory, 'media', 'missing-no-context.png'),
            });
            return { truncated: false };
          })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(knownSizeRequests).toBe(0);
      expect(summary.mediaDownloaded).toBe(0);
      expect(summary.failures).toEqual([
        { url: 'https://github.com/example/docs/blob/main/docs/missing.md', message: 'HTTP 404' },
        { url: `${server.origin}/known.png`, message: 'Media exceeds 4 byte limit' },
        { url: `${server.origin}/declared.png`, message: 'Media exceeds 4 byte limit' },
        { url: `${server.origin}/actual.png`, message: 'Media exceeds 4 byte limit' },
        {
          url: 'https://github.com/example/docs/blob/main/media/missing.png',
          message: `HTTP 404 for ${server.origin}/missing.png`,
        },
        { url: `${server.origin}/missing-no-context.png`, message: 'HTTP 404' },
      ]);
      expect(observedMediaFailures).toEqual(summary.failures.slice(1));
      expect(summary.historyManifest).toBeUndefined();
      const manifest = JSON.parse(await readFile(path.join(rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.status).toBe('partial');
      expect(manifest.cleanup.eligible).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('fails through the typed channel before writing a destination outside the archive root', async () => {
    const parentDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(parentDirectory);
    const rootDirectory = path.join(parentDirectory, 'archive');
    const outsideDestination = path.join(parentDirectory, 'outside.md');

    const error = await runArchive(
      {
        provider: 'website',
        source: 'https://example.com/docs',
        scopePath: '/docs',
        scopePaths: ['/docs'],
        outputDirectory: rootDirectory,
        concurrency: 1,
        maxMediaBytes: 1_000,
        cleanupEnabled: true,
      },
      (archive) =>
        Effect.gen(function* () {
          yield* archive.writePage({
            url: 'https://example.com/docs',
            title: 'Escaping page',
            strategy: 'markdown-suffix',
            destination: outsideDestination,
            content: '# Must not be written\n',
          });
          return { truncated: false };
        })
    ).pipe(Effect.flip, Effect.provide(TestLayer), Effect.runPromise);

    expect(error).toBeInstanceOf(ArchiveRunError);
    expect(error).toMatchObject({ _tag: 'ArchiveRunError', operation: 'validate destination' });
    await expect(readFile(outsideDestination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a destination whose parent symlink escapes the archive root', async () => {
    const parentDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(parentDirectory);
    const rootDirectory = path.join(parentDirectory, 'archive');
    const outsideDirectory = path.join(parentDirectory, 'outside');
    await mkdir(rootDirectory);
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(rootDirectory, 'escaped'), 'junction');
    const outsideDestination = path.join(outsideDirectory, 'page.md');

    const error = await runArchive(
      {
        provider: 'website',
        source: 'https://example.com/docs',
        scopePath: '/docs',
        scopePaths: ['/docs'],
        outputDirectory: rootDirectory,
        concurrency: 1,
        maxMediaBytes: 1_000,
        cleanupEnabled: true,
      },
      (archive) =>
        archive
          .writePage({
            url: 'https://example.com/docs/escaped',
            title: 'Escaping page',
            strategy: 'markdown-suffix',
            destination: path.join(rootDirectory, 'escaped', 'page.md'),
            content: '# Must not be written\n',
          })
          .pipe(Effect.as({ truncated: false }))
    ).pipe(Effect.flip, Effect.provide(TestLayer), Effect.runPromise);

    expect(error).toBeInstanceOf(ArchiveRunError);
    expect(error).toMatchObject({ _tag: 'ArchiveRunError', operation: 'validate destination' });
    await expect(readFile(outsideDestination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('normalizes non-Error filesystem failures through the typed error channel', async () => {
    const failingFileSystem = {
      /**
       * Simulates a non-Error failure from the Effect filesystem adapter.
       */
      makeDirectory: () => Effect.fail('filesystem unavailable'),
    } as unknown as FileSystem.FileSystem;

    const error = await runArchive(
      {
        provider: 'website',
        source: 'https://example.com/docs',
        scopePath: '/docs',
        scopePaths: ['/docs'],
        outputDirectory: '/unused',
        concurrency: 1,
        maxMediaBytes: 1_000,
        cleanupEnabled: true,
      },
      () => Effect.succeed({ truncated: false })
    ).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip, Effect.runPromise);

    expect(error).toMatchObject({ _tag: 'ArchiveRunError', message: 'filesystem unavailable' });
  });

  it('normalizes non-Error media transport failures without aborting a successful page', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);
    const failingClient = HttpClient.makeWith(
      () => Effect.fail('transport unavailable'),
      (request) => Effect.succeed(request)
    ) as unknown as HttpClient.HttpClient;
    const FailingHttpLayer = Layer.mergeAll(NodeServices.layer, Layer.succeed(HttpClient.HttpClient, failingClient));

    const summary = await runArchive(
      {
        provider: 'website',
        source: 'https://example.com/docs',
        scopePath: '/docs',
        scopePaths: ['/docs'],
        outputDirectory: rootDirectory,
        concurrency: 1,
        maxMediaBytes: 1_000,
        cleanupEnabled: true,
      },
      (archive) =>
        Effect.gen(function* () {
          yield* archive.writePage({
            url: 'https://example.com/docs',
            title: 'Example',
            strategy: 'markdown-suffix',
            destination: path.join(rootDirectory, 'index.md'),
            content: '# Example\n',
          });
          yield* archive.downloadMedia({
            url: 'https://example.com/logo.png',
            destination: path.join(rootDirectory, 'media', 'logo.png'),
          });
          return { truncated: false };
        })
    ).pipe(Effect.provide(FailingHttpLayer), Effect.runPromise);

    expect(summary.pagesDownloaded).toBe(1);
    expect(summary.mediaDownloaded).toBe(0);
    expect(summary.failures).toEqual([{ url: 'https://example.com/logo.png', message: 'transport unavailable' }]);
  });

  it('uses bounded media concurrency and removes only stale files owned by a complete prior run', async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const server = await listen((_request, response) => {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      setTimeout(() => {
        activeRequests -= 1;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(new Uint8Array([1]));
      }, 20);
    });
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-archive-run-test-'));
    temporaryDirectories.push(rootDirectory);
    const oldPage = path.join(rootDirectory, 'old.md');
    try {
      await runArchive(
        {
          provider: 'website',
          source: 'https://example.com/docs',
          scopePath: '/docs',
          scopePaths: ['/docs'],
          outputDirectory: rootDirectory,
          concurrency: 2,
          maxMediaBytes: 4,
          cleanupEnabled: true,
        },
        (archive) =>
          Effect.gen(function* () {
            yield* archive.writePage({
              url: 'https://example.com/docs/old',
              title: 'Old',
              strategy: 'markdown-suffix',
              destination: oldPage,
              content: '# Old\n',
            });
            return { truncated: false };
          })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      const summary = await runArchive(
        {
          provider: 'website',
          source: 'https://example.com/docs',
          scopePath: '/docs',
          scopePaths: ['/docs'],
          outputDirectory: rootDirectory,
          concurrency: 2,
          maxMediaBytes: 4,
          cleanupEnabled: true,
        },
        (archive) =>
          Effect.gen(function* () {
            yield* archive.writePage({
              url: 'https://example.com/docs/new',
              title: 'New',
              strategy: 'markdown-content-negotiation',
              destination: path.join(rootDirectory, 'new.md'),
              content: '# New\n',
            });
            yield* Effect.forEach(
              [0, 1, 2, 3],
              (index) =>
                archive.downloadMedia({
                  url: `${server.origin}/${index}.png`,
                  destination: path.join(rootDirectory, 'media', `${index}.png`),
                  knownBytes: 1,
                }),
              { concurrency: 'unbounded' }
            );
            return { truncated: false };
          })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(peakRequests).toBe(2);
      expect(summary).toMatchObject({ mediaDownloaded: 4, filesRemoved: 1, filesPreserved: 0, cleanupFailures: 0 });
      await expect(access(oldPage)).rejects.toMatchObject({ code: 'ENOENT' });

      const retainedPage = path.join(rootDirectory, 'retained.md');
      await writeFile(retainedPage, '# Retained\n');
      const currentManifest = JSON.parse(await readFile(path.join(rootDirectory, 'manifest.json'), 'utf8'));
      currentManifest.ownedFiles.push({
        path: 'retained.md',
        kind: 'page',
        url: 'https://example.com/docs/retained',
        sha256: '0db6dfb6a7610ca66301c1e38059c092c93f36b1c2b3e2d4b1e0cc3d603a81e7',
        bytes: 11,
      });
      await writeFile(path.join(rootDirectory, 'manifest.json'), JSON.stringify(currentManifest));
      const truncated = await runArchive(
        {
          provider: 'website',
          source: 'https://example.com/docs',
          scopePath: '/docs',
          scopePaths: ['/docs'],
          outputDirectory: rootDirectory,
          concurrency: 1,
          maxMediaBytes: 4,
          cleanupEnabled: true,
        },
        (archive) =>
          archive
            .writePage({
              url: 'https://example.com/docs/new',
              title: 'New',
              strategy: 'markdown-content-negotiation',
              destination: path.join(rootDirectory, 'new.md'),
              content: '# New\n',
            })
            .pipe(Effect.as({ truncated: true }))
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(truncated.truncated).toBe(true);
      expect(truncated.filesRemoved).toBe(0);
      await expect(access(retainedPage)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

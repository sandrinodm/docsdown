import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveConfigFilename, makeArchiveConfig, writeArchiveConfig } from './config.js';
import type { DocumentationDownloadOptions } from './providers.js';
import { downloadAndConfigure, updateDocumentationArchives } from './update.js';

const TestLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};

describe('managed archive updates', () => {
  it('writes configs, updates every valid archive, and retains individual failures', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Managed docs\n');
        return;
      }
      response.writeHead(404).end('missing');
    });
    const partialServer = await listen((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Partial docs\n\n![Missing](/missing.png)\n');
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-update-test-'));
    temporaryDirectories.push(outputDirectory);
    const downloadOptions: DocumentationDownloadOptions = {
      url: `${server.origin}/docs`,
      outputDirectory,
      concurrency: 1,
      maxPages: 5,
      maxMediaBytes: 1024,
      singlePage: true,
      keepStale: false,
      verbose: false,
      provider: 'website',
    };
    try {
      const initial = await downloadAndConfigure(downloadOptions).pipe(Effect.provide(TestLayer), Effect.runPromise);
      expect(initial.rootDirectory).toBe(path.resolve(outputDirectory));
      const storedConfig = await readFile(path.join(initial.rootDirectory, archiveConfigFilename), 'utf8');
      expect(storedConfig).toContain(`"source": "${server.origin}/docs"`);

      const firstUpdate = await updateDocumentationArchives({ outputDirectory }).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );
      expect(firstUpdate).toEqual({ configsFound: 1, archivesUpdated: 1, failures: [] });

      const failedRoot = path.join(outputDirectory, 'failed');
      await mkdir(failedRoot);
      await writeArchiveConfig(
        failedRoot,
        makeArchiveConfig({ ...downloadOptions, url: `${server.origin}/unavailable` }, 'website')
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);
      const invalidRoot = path.join(outputDirectory, 'invalid');
      await mkdir(invalidRoot);
      await writeFile(path.join(invalidRoot, archiveConfigFilename), '{invalid');

      const partialRoot = path.join(outputDirectory, 'partial');
      await mkdir(partialRoot);
      await writeArchiveConfig(
        partialRoot,
        makeArchiveConfig({ ...downloadOptions, url: `${partialServer.origin}/docs` }, 'website')
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      const authenticated = await updateDocumentationArchives({
        outputDirectory,
        githubToken: 'runtime-only-token',
      }).pipe(Effect.provide(TestLayer), Effect.runPromise);
      expect(authenticated).toMatchObject({ configsFound: 4, archivesUpdated: 1 });
      expect(authenticated.failures).toHaveLength(3);
      expect(authenticated.failures.map((failure) => failure.message).join('\n')).toContain('Archive remained partial');
      expect(await readFile(path.join(initial.rootDirectory, archiveConfigFilename), 'utf8')).not.toContain(
        'runtime-only-token'
      );

      const empty = path.join(outputDirectory, 'empty');
      await mkdir(empty);
      await expect(
        updateDocumentationArchives({ outputDirectory: empty }).pipe(Effect.provide(TestLayer), Effect.runPromise)
      ).resolves.toEqual({ configsFound: 0, archivesUpdated: 0, failures: [] });
    } finally {
      await server.close();
      await partialServer.close();
    }
  });
});

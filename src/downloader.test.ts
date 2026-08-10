import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadSite } from './downloader.js';

const TestLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);
const temporaryDirectories: Array<string> = [];

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

const options = (url: string, outputDirectory: string, overrides = {}) => ({
  url,
  outputDirectory,
  concurrency: 2,
  maxPages: 10,
  maxMediaBytes: 1_000_000,
  singlePage: false,
  keepStale: false,
  verbose: false,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('documentation download', () => {
  it.each([
    ['concurrency', { concurrency: 0 }, '--concurrency must be at least 1'],
    ['page limit', { maxPages: 0 }, '--max-pages must be at least 1'],
    ['media limit', { maxMediaBytes: 0 }, '--max-media-mb must be greater than 0'],
  ])('rejects an invalid %s', async (_, override, message) => {
    await expect(
      downloadSite(options('https://example.com/docs', '/unused', override)).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      )
    ).rejects.toThrow(message);
  });

  it('converts HTML after both Markdown probes reject their responses', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/html.md') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html><body>Not Markdown</body></html>');
        return;
      }
      if (request.url === '/html' && request.headers.accept === 'text/markdown') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html><body>Still HTML</body></html>');
        return;
      }
      if (request.url === '/html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><head><title>HTML Docs</title></head><body><main><p>Converted page.</p><a href="/html/next">Next</a></main></body></html>'
        );
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadSite(
        options(`${server.origin}/html`, outputDirectory, { maxPages: 1, verbose: true })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(summary.rootDirectory).toBe(path.resolve(outputDirectory));
      expect(summary.truncated).toBe(true);
      expect(summary.historyManifest).toBeUndefined();
      const page = await readFile(path.join(summary.rootDirectory, 'html.md'), 'utf8');
      expect(page).toContain('download_strategy: "html-conversion"');
      expect(page).toContain('title: "HTML Docs"');
    } finally {
      await server.close();
    }
  });

  it('accepts a plain HTML-fallback response as negotiated Markdown and derives a title', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/plain.md' || request.headers.accept === 'text/markdown') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html><body>Probe response</body></html>');
        return;
      }
      response.writeHead(200);
      response.end('Plain fallback body.');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadSite(options(`${server.origin}/plain`, outputDirectory, { singlePage: true })).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );

      expect(summary.pages).toEqual([{ url: `${server.origin}/plain`, title: 'plain' }]);
      const page = await readFile(path.join(summary.rootDirectory, 'plain.md'), 'utf8');
      expect(page).toContain('content_type: "unknown"');
      expect(page).toContain('download_strategy: "markdown-content-negotiation"');
    } finally {
      await server.close();
    }
  });

  it('derives root and empty-segment titles and quietly records a media failure', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/index.md') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('Root body.\n\n![Missing](/missing.png)');
        return;
      }
      if (request.url === '/.md.md') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('Extension-only body.');
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const root = await downloadSite(options(`${server.origin}/`, outputDirectory, { singlePage: true })).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );
      const extensionOnly = await downloadSite(
        options(`${server.origin}/.md`, outputDirectory, { singlePage: true })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(root.pages[0]?.title).toBe('127.0.0.1');
      expect(root.failures).toEqual([{ url: `${server.origin}/missing.png`, message: 'HTTP 404' }]);
      expect(extensionOnly.pages[0]?.title).toBe(`${server.origin}/.md`);
    } finally {
      await server.close();
    }
  });

  it('records page and every kind of media failure while deduplicating shared media', async () => {
    const body = (heading: string, links = '') =>
      `# ${heading}\n\n${links}\n\n![Shared](/media/shared.png)\n![HTTP](/media/missing.png)\n![Declared](/media/declared.png)\n![Actual](/media/actual.png)\n`;
    const server = await listen((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(body('Root', '[Child](/docs/child) [Broken](/docs/broken) [Outside](/elsewhere)'));
        return;
      }
      if (request.url === '/docs/child.md') {
        response.writeHead(200, { 'content-type': 'application/x-markdown' });
        response.end(body('Child', '[Root](/docs)'));
        return;
      }
      if (request.url === '/media/shared.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
        response.end(new Uint8Array([1, 2, 3, 4]));
        return;
      }
      if (request.url === '/media/declared.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '5' });
        response.end(new Uint8Array([1, 2, 3, 4, 5]));
        return;
      }
      if (request.url === '/media/actual.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
        response.write(new Uint8Array([1, 2, 3]));
        response.end(new Uint8Array([4, 5]));
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadSite(
        options(`${server.origin}/docs`, outputDirectory, {
          concurrency: 1,
          maxMediaBytes: 4,
          verbose: true,
        })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(summary.pagesDownloaded).toBe(2);
      expect(summary.mediaDownloaded).toBe(1);
      expect(summary.failures).toHaveLength(4);
      expect(summary.historyManifest).toBeUndefined();
      expect(summary.failures.some((failure) => failure.url === `${server.origin}/docs/broken`)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('reports a complete transport failure as an empty crawl', async () => {
    const server = await listen((request) => request.socket.destroy());
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      await expect(
        downloadSite(options(`${server.origin}/offline`, outputDirectory)).pipe(
          Effect.provide(TestLayer),
          Effect.runPromise
        )
      ).rejects.toThrow(`No pages could be downloaded from ${server.origin}/offline`);
    } finally {
      await server.close();
    }
  });

  it('negotiates Markdown, probes .md pages, crawls, and localizes media', async () => {
    const image = new Uint8Array([137, 80, 78, 71]);
    let includeLinkedContent = true;
    const server = createServer((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(404).end('missing');
        return;
      }
      if (request.url === '/docs' && request.headers.accept === 'text/markdown') {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        response.end(
          includeLinkedContent
            ? '# Documentation\n\n[Guide](/docs/guide)\n\n![Diagram](/media/diagram.png)\n'
            : '# Documentation\n\nThe old guide and diagram are gone.\n'
        );
        return;
      }
      if (request.url === '/docs/guide.md') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('# Guide\n\nThis came from the suffix endpoint.\n');
        return;
      }
      if (request.url === '/media/diagram.png') {
        response.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(image.byteLength),
        });
        response.end(image);
        return;
      }
      response.writeHead(404).end('missing');
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
      temporaryDirectories.push(outputDirectory);
      const origin = `http://127.0.0.1:${address.port}`;

      const summary = await downloadSite({
        url: `${origin}/docs`,
        outputDirectory,
        concurrency: 2,
        maxPages: 10,
        maxMediaBytes: 1_000_000,
        singlePage: false,
        keepStale: false,
        verbose: false,
      }).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(summary.pagesDownloaded).toBe(2);
      expect(summary.mediaDownloaded).toBe(1);
      expect(summary.failures).toEqual([]);

      const rootPage = await readFile(path.join(summary.rootDirectory, 'docs.md'), 'utf8');
      const guidePage = await readFile(path.join(summary.rootDirectory, 'docs', 'guide.md'), 'utf8');
      const manifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));

      expect(rootPage).toContain('download_strategy: "markdown-content-negotiation"');
      expect(rootPage).toContain('[Guide](./docs/guide.md)');
      expect(rootPage).toContain(`_media/127.0.0.1-${address.port}/media/diagram.png`);
      expect(guidePage).toContain('download_strategy: "markdown-suffix"');
      expect(manifest.strategies).toMatchObject({
        'markdown-content-negotiation': 1,
        'markdown-suffix': 1,
      });
      expect(manifest.pages).toEqual([
        { url: `${origin}/docs`, title: 'Documentation' },
        { url: `${origin}/docs/guide`, title: 'Guide' },
      ]);

      includeLinkedContent = false;
      const updated = await downloadSite({
        url: `${origin}/docs`,
        outputDirectory,
        concurrency: 2,
        maxPages: 10,
        maxMediaBytes: 1_000_000,
        singlePage: false,
        keepStale: false,
        verbose: false,
      }).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(updated.filesRemoved).toBe(2);
      await expect(access(path.join(summary.rootDirectory, 'docs', 'guide.md'))).rejects.toThrow();
      await expect(
        access(path.join(summary.rootDirectory, `_media/127.0.0.1-${address.port}/media/diagram.png`))
      ).rejects.toThrow();
      expect(await readdir(path.join(summary.rootDirectory, '.manifests'))).toHaveLength(2);

      const updatedManifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));
      expect(updatedManifest.status).toBe('success');
      expect(updatedManifest.cleanup.removed).toEqual([
        `_media/127.0.0.1-${address.port}/media/diagram.png`,
        'docs/guide.md',
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

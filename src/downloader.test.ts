import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('merges HTML navigation with links from preferred Markdown', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Documentation\n\n[Content page](/docs/content.md)\n');
        return;
      }
      if (request.url === '/docs' && request.headers.accept?.startsWith('text/html')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><body><nav><a href="/docs/content">Content</a><a href="/docs/child">Child</a><a href="/docs/cdn-cgi/l/email-protection#abc">Email</a></nav><main>Documentation</main></body></html>'
        );
        return;
      }
      if (request.url === '/docs/child.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Child\n');
        return;
      }
      if (request.url === '/docs/content.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Content\n');
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadSite(options(`${server.origin}/docs`, outputDirectory)).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );

      expect(summary.pages).toEqual([
        { url: `${server.origin}/docs`, title: 'Documentation' },
        { url: `${server.origin}/docs/content`, title: 'Content' },
        { url: `${server.origin}/docs/child`, title: 'Child' },
      ]);
      expect(summary.failures).toEqual([]);
      expect(await readFile(path.join(summary.rootDirectory, 'docs.md'), 'utf8')).not.toContain('[Child]');
    } finally {
      await server.close();
    }
  });

  it('falls back to HTML when native Markdown contains unresolved image placeholders', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/docs.md' || request.headers.accept === 'text/markdown') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Documentation\n\n<img src={__img0} />\n');
        return;
      }
      if (request.url === '/docs') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html><body><main><h1>Documentation</h1><img src="/diagram.png"></main></body></html>');
        return;
      }
      if (request.url === '/diagram.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '1' });
        response.end(new Uint8Array([1]));
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadSite(options(`${server.origin}/docs`, outputDirectory, { singlePage: true })).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );

      expect(summary.mediaDownloaded).toBe(1);
      expect(await readFile(path.join(summary.rootDirectory, 'docs.md'), 'utf8')).toContain('diagram.png');
      const manifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.strategies).toMatchObject({ 'html-conversion': 1, 'markdown-suffix': 0 });
    } finally {
      await server.close();
    }
  });

  it('follows a same-origin HTML meta refresh while retaining the requested archive page', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/en.md' || request.headers.accept === 'text/markdown') {
        response.writeHead(404).end('missing');
        return;
      }
      if (request.url === '/en/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><meta http-equiv="refresh" content="0;url=/en/start/">');
        return;
      }
      if (request.url === '/en/start.md') {
        response.writeHead(404).end('missing');
        return;
      }
      if (request.url === '/en/start/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><body><main><h1>Start</h1><a href="/en/guide">Guide</a><a href="/en/broken/">Broken refresh</a><a href="/en/external/">External refresh</a><a href="/en/ftp/">FTP refresh</a><a href="mailto:docs@example.com">Email</a></main></body></html>'
        );
        return;
      }
      if (request.url === '/en/guide.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Guide\n');
        return;
      }
      if (request.url === '/en/broken/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><head><meta http-equiv="refresh" content="0;url=http://["></head><body><main><h1>Broken refresh</h1></main></body></html>'
        );
        return;
      }
      if (request.url === '/en/external/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><head><meta http-equiv="refresh" content="0;url=https://example.com/"></head><body><main><h1>External refresh</h1></main></body></html>'
        );
        return;
      }
      if (request.url === '/en/ftp/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><head><meta http-equiv="refresh" content="0;url=ftp://example.com/"></head><body><main><h1>FTP refresh</h1></main></body></html>'
        );
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadSite(options(`${server.origin}/en/`, outputDirectory)).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );

      expect(summary.pages).toEqual([
        { url: `${server.origin}/en/`, title: 'Start' },
        { url: `${server.origin}/en/guide`, title: 'Guide' },
        { url: `${server.origin}/en/broken/`, title: 'Broken refresh' },
        { url: `${server.origin}/en/external/`, title: 'External refresh' },
        { url: `${server.origin}/en/ftp/`, title: 'FTP refresh' },
      ]);
      expect(await readFile(path.join(summary.rootDirectory, 'en', 'index.md'), 'utf8')).toContain('# Start');
    } finally {
      await server.close();
    }
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
      const manifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.strategies).toEqual({
        'markdown-suffix': 0,
        'markdown-content-negotiation': 0,
        'html-conversion': 1,
      });
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
      expect(summary.failures).toEqual([
        { url: `${server.origin}/media/missing.png`, message: 'HTTP 404' },
        { url: `${server.origin}/media/declared.png`, message: 'Media exceeds 4 byte limit' },
        { url: `${server.origin}/media/actual.png`, message: 'Media exceeds 4 byte limit' },
        {
          url: `${server.origin}/docs/broken`,
          message: `Unable to download ${server.origin}/docs/broken (HTTP 404, 404, 404)`,
        },
      ]);
      expect(summary.historyManifest).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('deduplicates website resources by URL rather than colliding destination', async () => {
    const mediaRequests = new Map<string, number>();
    const server = await listen((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(
          '# Root\n\n[Colon](/docs/a:b) [Dash](/docs/a-b)\n\n![Missing](/media/a:b.png) ![Saved](/media/a-b.png) ![Saved again](/media/a-b.png)\n'
        );
        return;
      }
      if (request.url === '/docs/a:b.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        setTimeout(() => response.end('# Colon\n'), 20);
        return;
      }
      if (request.url === '/docs/a-b.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Dash\n');
        return;
      }
      if (request.url === '/media/a:b.png' || request.url === '/media/a-b.png') {
        mediaRequests.set(request.url, (mediaRequests.get(request.url) ?? 0) + 1);
        if (request.url === '/media/a:b.png') {
          response.writeHead(404).end('missing');
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '1' });
        response.end(new Uint8Array([2]));
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-test-'));
    temporaryDirectories.push(outputDirectory);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const summary = await downloadSite(
        options(`${server.origin}/docs`, outputDirectory, { concurrency: 2, verbose: true })
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(summary.pagesDownloaded).toBe(3);
      expect(summary.mediaDownloaded).toBe(1);
      expect(summary.pages).toEqual([
        { url: `${server.origin}/docs`, title: 'Root' },
        { url: `${server.origin}/docs/a:b`, title: 'Colon' },
        { url: `${server.origin}/docs/a-b`, title: 'Dash' },
      ]);
      expect(summary.failures).toEqual([{ url: `${server.origin}/media/a:b.png`, message: 'HTTP 404' }]);
      expect(mediaRequests).toEqual(
        new Map([
          ['/media/a:b.png', 1],
          ['/media/a-b.png', 1],
        ])
      );
      expect(log).toHaveBeenCalledWith(`Skipped media ${server.origin}/media/a:b.png: HTTP 404`);

      const manifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.pages).toEqual([
        { url: `${server.origin}/docs`, title: 'Root' },
        { url: `${server.origin}/docs/a-b`, title: 'Dash' },
        { url: `${server.origin}/docs/a:b`, title: 'Colon' },
      ]);
      expect(manifest.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'docs/a-b.md', url: `${server.origin}/docs/a-b` }),
          expect.objectContaining({
            path: expect.stringMatching(/_media\/[^/]+\/media\/a-b\.png$/),
            url: `${server.origin}/media/a-b.png`,
          }),
        ])
      );
      expect(await readFile(path.join(summary.rootDirectory, 'docs', 'a-b.md'), 'utf8')).toContain('# Dash');
    } finally {
      log.mockRestore();
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

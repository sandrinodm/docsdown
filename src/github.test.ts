import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadGitHubRepository, type GitHubProviderConfig } from './github.js';

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
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    config: {
      apiBaseUrl: origin,
      webBaseUrl: 'https://github.com',
      rawBaseUrl: `${origin}/raw`,
    } satisfies GitHubProviderConfig,
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
  maxPages: 20,
  maxMediaBytes: 4,
  singlePage: false,
  keepStale: false,
  verbose: true,
  githubToken: 'secret-test-token',
  ...overrides,
});

describe('GitHub repository downloads', () => {
  it('downloads several selected folders while excluding other repository Markdown', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/repos/acme/mono') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ default_branch: 'main' }));
        return;
      }
      if (request.url === '/repos/acme/mono/git/trees/main?recursive=1') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'docs/guide.md', type: 'blob', size: 10 },
              { path: 'packages/sdk/docs/api.mdx', type: 'blob', size: 10 },
              { path: 'src/internal.md', type: 'blob', size: 10 },
            ],
          })
        );
        return;
      }
      if (request.url === '/raw/acme/mono/main/docs/guide.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Guide\n');
        return;
      }
      if (request.url === '/raw/acme/mono/main/packages/sdk/docs/api.mdx') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# SDK API\n');
        return;
      }
      response.writeHead(404).end('not selected');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-github-folders-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const summary = await downloadGitHubRepository(
        options('https://github.com/acme/mono', outputDirectory, {
          githubToken: undefined,
          githubPaths: ['docs', 'packages/sdk/docs'],
        }),
        server.config
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);

      expect(summary.rootDirectory).toBe(path.resolve(outputDirectory));
      expect(summary.pages.map((page) => page.title)).toEqual(['Guide', 'SDK API']);
      await expect(access(path.join(summary.rootDirectory, 'src', 'internal.md'))).rejects.toThrow();
      const manifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.scopePath).toBe('/');
      expect(manifest.scopePaths).toEqual(['docs', 'packages/sdk/docs']);
    } finally {
      await server.close();
    }
  });

  it('downloads repository Markdown, rewrites links, localizes assets, and records partial failures', async () => {
    let treeTruncated = false;
    let emptyTree = false;
    let extensionOnly = false;
    const server = await listen((request, response) => {
      if (request.url?.startsWith('/repos/')) {
        expect(request.headers['x-github-api-version']).toBe('2022-11-28');
      }
      if (request.url === '/repos/acme/docs') {
        expect(request.headers.authorization).toBe('Bearer secret-test-token');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ default_branch: 'main' }));
        return;
      }
      if (request.url === '/repos/acme/docs/git/trees/main?recursive=1') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            truncated: treeTruncated,
            tree: emptyTree
              ? [{ path: 'package.json', type: 'blob', size: 2 }]
              : extensionOnly
                ? [
                    { path: '', type: 'blob', size: 1 },
                    { path: '.md', type: 'blob', size: 10 },
                  ]
                : [
                    { path: '', type: 'blob', size: 1 },
                    { path: 'README.md', type: 'blob', size: 200 },
                    { path: 'docs/guide.md', type: 'blob', size: 100 },
                    { path: 'docs/component.mdx', type: 'blob', size: 100 },
                    { path: 'docs/broken.md', type: 'blob', size: 10 },
                    { path: 'assets/logo.png', type: 'blob', size: 4 },
                    { path: 'assets/huge.png', type: 'blob', size: 5 },
                    { path: 'assets/declared.png', type: 'blob', size: 2 },
                    { path: 'assets/actual.png', type: 'blob' },
                    { path: '../unsafe.md', type: 'blob', size: 1 },
                    { path: 'docs', type: 'tree' },
                  ],
          })
        );
        return;
      }
      if (request.url === '/repos/acme/docs/contents/README.md?ref=main') {
        expect(request.headers.accept).toBe('application/vnd.github.raw+json');
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(
          `# Repository\n\n[Guide](docs/guide.md) [Missing](missing.md)\n\n![Logo](assets/logo.png)\n![Huge](assets/huge.png)\n![Declared](assets/declared.png)\n![Actual](assets/actual.png)\n![External](${server.origin}/external.png)\n`
        );
        return;
      }
      if (request.url === '/raw/acme/docs/main/README.md') {
        expect(request.headers.authorization).toBeUndefined();
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(
          '# Repository\n\n[Guide](docs/guide.md)\n\n![Logo](assets/logo.png)\n![Missing](assets/missing.png)\n'
        );
        return;
      }
      if (request.url === '/repos/acme/docs/contents/docs/guide.md?ref=main') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(
          'Guide body.\n\n[Root](https://github.com/acme/docs/blob/main/README.md)\n\n![Logo](../assets/logo.png)\n![Blob](https://github.com/acme/docs/blob/main/assets/logo.png)\n'
        );
        return;
      }
      if (request.url === '/repos/acme/docs/contents/docs/component.mdx?ref=main') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(
          '---\ntitle: Component\ndescription: Returns { value, ...rest } safely.\n---\n\n# Component\n\n<Callout>MDX content</Callout>\n'
        );
        return;
      }
      if (request.url === '/repos/acme/docs/contents/docs/broken.md?ref=main') {
        response.writeHead(500).end('broken');
        return;
      }
      if (request.url === '/repos/acme/docs/contents/.md?ref=main') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('Extension-only document.');
        return;
      }
      if (request.url === '/repos/acme/docs/contents/assets/logo.png?ref=main') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
        response.end(new Uint8Array([1, 2, 3, 4]));
        return;
      }
      if (request.url === '/raw/acme/docs/main/assets/logo.png') {
        expect(request.headers.authorization).toBeUndefined();
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' });
        response.end(new Uint8Array([1, 2, 3, 4]));
        return;
      }
      if (request.url === '/repos/acme/docs/contents/assets/declared.png?ref=main') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '5' });
        response.end(new Uint8Array([1, 2, 3, 4, 5]));
        return;
      }
      if (request.url === '/repos/acme/docs/contents/assets/actual.png?ref=main') {
        response.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
        response.write(new Uint8Array([1, 2, 3]));
        response.end(new Uint8Array([4, 5]));
        return;
      }
      if (request.url === '/external.png') {
        expect(request.headers.authorization).toBeUndefined();
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(new Uint8Array([5, 6]));
        return;
      }
      response.writeHead(404).end('missing');
    });
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-github-test-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const { maxPages: _maxPages, ...unlimitedOptions } = options('https://github.com/acme/docs', outputDirectory);
      const summary = await downloadGitHubRepository(unlimitedOptions, server.config).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      );

      expect(summary).toMatchObject({ provider: 'github', pagesDownloaded: 3, mediaDownloaded: 2, truncated: false });
      expect(summary.failures).toHaveLength(4);
      expect(summary.historyManifest).toBeUndefined();
      const readme = await readFile(path.join(summary.rootDirectory, 'README.md'), 'utf8');
      const guide = await readFile(path.join(summary.rootDirectory, 'docs', 'guide.md'), 'utf8');
      const component = await readFile(path.join(summary.rootDirectory, 'docs', 'component.mdx'), 'utf8');
      expect(readme).toContain('[Guide](./docs/guide.md)');
      expect(readme).toContain('./media/repository/assets/logo.png');
      expect(guide).toContain('title: "guide"');
      expect(component).toContain('<Callout>MDX content</Callout>');
      expect(component).toContain('description: Returns { value, ...rest } safely.');
      await expect(
        access(path.join(summary.rootDirectory, 'media', 'repository', 'assets', 'logo.png'))
      ).resolves.toBeUndefined();
      const manifest = JSON.parse(await readFile(path.join(summary.rootDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.provider).toBe('github');
      expect(manifest.strategies).toEqual({ 'github-raw': 3 });

      treeTruncated = true;
      const truncated = await downloadGitHubRepository(
        options('https://github.com/acme/docs/blob/main/README.md', outputDirectory, {
          singlePage: true,
          verbose: false,
          maxMediaBytes: 10,
          githubToken: undefined,
        }),
        server.config
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);
      expect(truncated.truncated).toBe(true);
      expect(truncated.failures[0]?.message).toContain('truncated');
      expect(truncated.failures).toContainEqual({
        url: 'https://raw.githubusercontent.com/acme/docs/main/assets/missing.png',
        message: `HTTP 404 for ${server.origin}/raw/acme/docs/main/assets/missing.png`,
      });

      treeTruncated = false;
      const exactTree = await downloadGitHubRepository(
        options('https://github.com/acme/docs/tree/main/docs/guide.md', outputDirectory, {
          verbose: false,
          maxMediaBytes: 10,
        }),
        server.config
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);
      expect(exactTree.pages).toHaveLength(1);

      await expect(
        downloadGitHubRepository(
          options('https://github.com/acme/docs/blob/main/docs/broken.md', outputDirectory),
          server.config
        ).pipe(Effect.provide(TestLayer), Effect.runPromise)
      ).rejects.toThrow('No Markdown files could be downloaded');

      extensionOnly = true;
      const extension = await downloadGitHubRepository(
        options('https://github.com/acme/docs/blob/main/.md', outputDirectory),
        server.config
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);
      expect(extension.pages[0]?.title).toBe('.md');

      extensionOnly = false;
      emptyTree = true;
      await expect(
        downloadGitHubRepository(
          options('https://github.com/acme/docs/tree/main/docs', outputDirectory),
          server.config
        ).pipe(Effect.provide(TestLayer), Effect.runPromise)
      ).rejects.toThrow('No Markdown files found');
    } finally {
      await server.close();
    }
  });
});

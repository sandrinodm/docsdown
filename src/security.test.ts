import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, Exit, Layer } from 'effect';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { archiveConfigFilename, discoverArchiveConfigs, makeArchiveConfig, writeArchiveConfig } from './config.js';
import { downloadSite } from './downloader.js';
import { downloadGitHubRepository } from './github.js';
import { finalizeManifest } from './manifest.js';

const TestLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);

/**
 * Sandboxes removed after each test.
 */
const sandboxes: Array<string> = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const listen = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * Creates `sandbox/archive` plus an `outside` directory that an archive symlink points at.
 */
const makeSandbox = async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'docsdown-security-test-'));
  sandboxes.push(sandbox);

  const archive = path.join(sandbox, 'archive');
  const outside = path.join(sandbox, 'outside');
  await mkdir(path.join(archive, 'content'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(archive, 'content', 'redirected'));

  return { sandbox, archive, outside };
};

/**
 * Lists every regular file beneath a directory, relative to it, without following symlinks.
 */
const listFiles = async (directory: string): Promise<Array<string>> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)));
};

/**
 * Path payloads that try to leave the archive through literal, encoded, double-encoded, Unicode, backslash, and
 * symlinked segments.
 */
const traversalPaths = [
  '/docs/../../escape-literal',
  '/docs/%2e%2e/%2e%2e/escape-encoded',
  '/docs/..%2f..%2fescape-encoded-slash',
  '/docs/%252e%252e/%252e%252e/escape-double-encoded',
  '/docs/%E2%80%A4%E2%80%A4/%E2%80%A4%E2%80%A4/escape-unicode',
  '/docs/..%5c..%5cescape-backslash',
  '/docs/%00escape-null',
  '/docs/redirected/escape-through-symlink',
];

describe('archive filesystem boundary against hostile sources', () => {
  it('keeps every website page, index, and media file inside the archive', async () => {
    const markdownLinks = traversalPaths.map((target) => `- [link](${target})`).join('\n');
    const imageLinks = traversalPaths.map((target) => `![image](${target}.png)`).join('\n');
    const server = await listen((request, response) => {
      const url = request.url ?? '/';
      if (url === '/llms.txt' || url === '/docs/llms.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`# Index\n\n${markdownLinks}\n`);
        return;
      }

      if (url.endsWith('.png')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('png');
        return;
      }

      if (url.endsWith('.md')) {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(`# Page\n\n${markdownLinks}\n\n${imageLinks}\n`);
        return;
      }

      response.writeHead(404).end('missing');
    });
    const { sandbox, archive, outside } = await makeSandbox();

    try {
      await downloadSite({
        url: `${server.origin}/docs`,
        outputDirectory: archive,
        concurrency: 4,
        maxMediaBytes: 1_000,
        singlePage: false,
        keepStale: false,
        verbose: false,
      }).pipe(Effect.provide(TestLayer), Effect.runPromise);
    } finally {
      await server.close();
    }

    expect(await listFiles(outside)).toEqual([]);
    for (const file of await listFiles(sandbox)) {
      expect(file.startsWith(`archive${path.sep}`)).toBe(true);
    }

    expect(await listFiles(archive)).toContain(path.join('content', 'docs.md'));
  });

  it('keeps every GitHub page and media file inside the archive', async () => {
    const hostileEntries = [
      '../escape-parent.md',
      'docs/../../escape-nested.md',
      '/escape-absolute.md',
      'docs\\..\\..\\escape-backslash.md',
      'redirected/escape-through-symlink.md',
    ];
    const repositoryImages = [
      '../../../../escape-relative.png',
      'https://raw.githubusercontent.com/acme/docs/main/%2e%2e%2f%2e%2e%2fescape-encoded.png',
      'https://github.com/acme/docs/blob/main/..%2f..%2fescape-blob.png',
      'https://github.com/acme/docs/blob/main/%E0%A4%A-malformed.png',
    ];
    const server = await listen((request, response) => {
      const url = request.url ?? '/';
      if (url === '/repos/acme/docs/git/trees/main?recursive=1') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'docs/guide.md', type: 'blob', size: 10 },
              ...hostileEntries.map((entry) => ({ path: entry, type: 'blob' })),
            ],
          })
        );
        return;
      }

      if (url.endsWith('.md')) {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(`# Guide\n\n${repositoryImages.map((image) => `![image](${image})`).join('\n')}\n`);
        return;
      }

      response.writeHead(200, { 'content-type': 'image/png' });
      response.end('png');
    });
    const { sandbox, archive, outside } = await makeSandbox();

    try {
      await downloadGitHubRepository(
        {
          url: 'https://github.com/acme/docs/tree/main',
          outputDirectory: archive,
          concurrency: 4,
          maxMediaBytes: 1_000,
          singlePage: false,
          keepStale: false,
          verbose: false,
        },
        { apiBaseUrl: server.origin, webBaseUrl: 'https://github.com', rawBaseUrl: `${server.origin}/raw` }
      ).pipe(Effect.provide(TestLayer), Effect.runPromise);
    } finally {
      await server.close();
    }

    expect(await listFiles(outside)).toEqual([]);
    for (const file of await listFiles(sandbox)) {
      expect(file.startsWith(`archive${path.sep}`)).toBe(true);
    }

    expect(await listFiles(archive)).toContain(path.join('content', 'docs', 'guide.md'));
  });

  it('reports malformed percent-encoding in links instead of crashing the run', async () => {
    const server = await listen((request, response) => {
      const url = request.url ?? '/';
      if (url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('# Docs\n\n[bad](/docs/%E0%A4%A)\n');
        return;
      }

      if (url.endsWith('.md')) {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end('No heading, so the title comes from the URL.\n');
        return;
      }

      response.writeHead(404).end('missing');
    });
    const { archive } = await makeSandbox();

    const exit = await downloadSite({
      url: `${server.origin}/docs`,
      outputDirectory: archive,
      concurrency: 1,
      maxMediaBytes: 1_000,
      singlePage: false,
      keepStale: false,
      verbose: false,
    }).pipe(Effect.provide(TestLayer), Effect.runPromiseExit);
    await server.close();

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('never treats downloaded content as an update configuration', async () => {
    const plantedConfig = JSON.stringify({
      schemaVersion: 1,
      source: 'https://attacker.example/docs',
      provider: 'website',
      options: {
        concurrency: 1,
        maxMediaBytes: 1,
        singlePage: true,
        keepStale: false,
        verbose: false,
        githubPaths: [],
      },
    });
    const server = await listen((request, response) => {
      if (request.url === '/docs.md') {
        response.writeHead(200, { 'content-type': 'text/markdown' });
        response.end(`# Docs\n\n![config](/assets/${archiveConfigFilename})\n`);
        return;
      }

      if (request.url === `/assets/${archiveConfigFilename}`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(plantedConfig);
        return;
      }

      response.writeHead(404).end('missing');
    });
    const { sandbox, archive } = await makeSandbox();
    const options = {
      url: `${server.origin}/docs`,
      outputDirectory: archive,
      concurrency: 1,
      maxMediaBytes: 1_000,
      singlePage: false,
      keepStale: false,
      verbose: false,
      provider: 'website',
    };

    try {
      await downloadSite(options).pipe(
        Effect.andThen(writeArchiveConfig(archive, makeArchiveConfig(options, 'website'))),
        Effect.provide(TestLayer),
        Effect.runPromise
      );
    } finally {
      await server.close();
    }

    const media = (await listFiles(archive)).filter((file) => file.startsWith(`media${path.sep}`));
    expect(media.some((file) => file.endsWith(archiveConfigFilename))).toBe(true);

    const discovered = await discoverArchiveConfigs(sandbox).pipe(Effect.provide(TestLayer), Effect.runPromise);
    expect(discovered.map((entry) => entry.path)).toEqual([path.join(archive, archiveConfigFilename)]);
  });

  it('never deletes bookkeeping files listed as owned by a tampered manifest', async () => {
    const { archive } = await makeSandbox();
    const configContent = '{}\n';
    await writeFile(path.join(archive, archiveConfigFilename), configContent);
    const sha256 = createHash('sha256').update(configContent).digest('hex');
    await writeFile(
      path.join(archive, 'manifest.json'),
      JSON.stringify({
        ownedFiles: [{ path: archiveConfigFilename, kind: 'page', url: 'https://example.com', sha256, bytes: 3 }],
      })
    );

    const result = await finalizeManifest(archive, {
      provider: 'website',
      source: 'https://example.com/docs',
      scopePath: '/docs',
      scopePaths: ['/docs'],
      pagesDownloaded: 0,
      mediaDownloaded: 0,
      indexesDownloaded: 0,
      pages: [],
      strategies: {},
      failures: [],
      files: [],
      truncated: false,
      cleanupEnabled: true,
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.removed).toEqual([]);
    await access(path.join(archive, archiveConfigFilename));
  });
});

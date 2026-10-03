import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const execute = promisify(execFile);
const temporaryDirectories: Array<string> = [];
const cliPath = path.join(import.meta.dirname, 'cli.ts');

const runCli = (...args: Array<string>) =>
  execute(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, GITHUB_TOKEN: '' },
    timeout: 15_000,
  });

const fixture = async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'docsdown-cli-test-'));
  temporaryDirectories.push(outputDirectory);
  let revision = 1;
  const server = createServer((request, response) => {
    if (request.url === '/docs.md') {
      response.writeHead(200, { 'content-type': 'text/markdown' });
      response.end(`# Documentation ${revision}\n\n[Guide](/docs/guide)\n`);
      return;
    }

    if (request.url === '/docs/guide.md') {
      response.writeHead(200, { 'content-type': 'text/markdown' });
      response.end('# Guide\n');
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
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing CLI fixture address');
  }

  return {
    url: `http://127.0.0.1:${address.port}/docs`,
    outputDirectory,
    changeContent: () => {
      revision = 2;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CLI migration compatibility', () => {
  it('downloads and updates with omitted boolean flags and default numeric options', { timeout: 20_000 }, async () => {
    const server = await fixture();
    try {
      const initial = await runCli(server.url, '-o', server.outputDirectory);
      expect(initial.stdout).toContain('Saved 2 page(s)');
      const config = JSON.parse(await readFile(path.join(server.outputDirectory, 'docsdown.json'), 'utf8'));
      expect(config.options).toMatchObject({
        concurrency: 2,
        maxMediaBytes: 100 * 1024 * 1024,
        singlePage: false,
        keepStale: false,
        verbose: false,
        githubPaths: [],
      });
      expect(config.options).not.toHaveProperty('maxPages');

      server.changeContent();
      const updated = await runCli('update', '--output', server.outputDirectory);
      expect(updated.stdout).toContain('Updated 1 of 1 configured archive(s).');
      expect(await readFile(path.join(server.outputDirectory, 'content', 'docs.md'), 'utf8')).toContain(
        '# Documentation 2'
      );
    } finally {
      await server.close();
    }
  });

  it('honors explicit booleans, integer options, and provider selection', { timeout: 20_000 }, async () => {
    const server = await fixture();
    try {
      const downloaded = await runCli(
        server.url,
        '--output',
        server.outputDirectory,
        '--single-page',
        '--keep-stale',
        '--verbose',
        '--concurrency',
        '1',
        '--max-pages',
        '3',
        '--max-media-mb',
        '1',
        '--provider',
        'website'
      );
      expect(downloaded.stdout).toContain('Saved 1 page(s)');
      const config = JSON.parse(await readFile(path.join(server.outputDirectory, 'docsdown.json'), 'utf8'));
      expect(config.provider).toBe('website');
      expect(config.options).toMatchObject({
        concurrency: 1,
        maxPages: 3,
        maxMediaBytes: 1024 * 1024,
        singlePage: true,
        keepStale: true,
        verbose: true,
      });
    } finally {
      await server.close();
    }
  });

  it('rejects missing destinations and invalid request limits', { timeout: 20_000 }, async () => {
    const server = await fixture();
    try {
      await expect(runCli(server.url)).rejects.toMatchObject({ code: 1 });
      await expect(runCli(server.url, '--output', server.outputDirectory, '--concurrency', '0')).rejects.toMatchObject({
        code: 1,
      });
      await expect(readFile(path.join(server.outputDirectory, 'docsdown.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await server.close();
    }
  });
});

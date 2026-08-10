import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeArchiveFile, finalizeManifest, type ManifestRun } from './manifest.js';

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const makeRun = (overrides: Partial<ManifestRun> = {}): ManifestRun => ({
  provider: 'website',
  source: 'https://example.com/docs',
  scopePath: '/docs',
  scopePaths: ['/docs'],
  pagesDownloaded: 1,
  mediaDownloaded: 0,
  pages: [{ url: 'https://example.com/docs', title: 'Docs' }],
  strategies: { 'markdown-suffix': 1 },
  failures: [],
  files: [],
  truncated: false,
  cleanupEnabled: true,
  ...overrides,
});

const finalize = (rootDirectory: string, run: ManifestRun) =>
  finalizeManifest(rootDirectory, run).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

describe('archive manifests', () => {
  it('describes text and binary files with portable ownership metadata', () => {
    const text = describeArchiveFile('/archive', '/archive/docs.md', 'page', 'https://example.com/docs', '€');
    const binary = describeArchiveFile(
      '/archive',
      '/archive/media/logo.png',
      'media',
      'https://example.com/logo.png',
      new Uint8Array([1, 2])
    );

    expect(text).toMatchObject({ path: 'docs.md', bytes: 3, kind: 'page' });
    expect(binary).toMatchObject({ path: 'media/logo.png', bytes: 2, kind: 'media' });
  });

  it('ignores malformed, unsafe, and incomplete previous ownership records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    const valid = describeArchiveFile(
      root,
      path.join(root, 'missing.md'),
      'page',
      'https://example.com/missing',
      'old'
    );
    const invalidRecords = [
      null,
      {},
      { ...valid, path: '' },
      { ...valid, path: 'bad\\path.md' },
      { ...valid, path: '/absolute.md' },
      { ...valid, path: 'a/../normalized.md' },
      { ...valid, path: '.' },
      { ...valid, path: '..' },
      { ...valid, path: '../outside.md' },
      { ...valid, path: 'manifest.json' },
      { ...valid, path: '.manifests/old.json' },
      { ...valid, kind: 'other' },
      { ...valid, url: 42 },
      { ...valid, sha256: 42 },
      { ...valid, sha256: 'bad' },
      { ...valid, bytes: '3' },
    ];
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ files: [...invalidRecords, valid] }));

    const result = await finalize(root, makeRun());

    expect(result.removed).toEqual(['missing.md']);
    expect(result.status).toBe('success');
  });

  it('handles invalid and schema-less prior manifests without authorizing cleanup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, 'manifest.json'), '{invalid');
    await finalize(root, makeRun());
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ unrelated: [] }));

    const result = await finalize(root, makeRun());

    expect(result.removed).toEqual([]);
    expect(result.status).toBe('success');
  });

  it('falls back to legacy files only when ownedFiles is not an array', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    const stalePath = path.join(root, 'legacy.md');
    await writeFile(stalePath, 'legacy');
    const stale = describeArchiveFile(root, stalePath, 'page', 'https://example.com/legacy', 'legacy');

    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ ownedFiles: 'invalid', files: [{ ...stale, ignored: true }] })
    );
    const legacyResult = await finalize(root, makeRun());
    expect(legacyResult.removed).toEqual(['legacy.md']);

    await writeFile(stalePath, 'legacy');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ownedFiles: [], files: [stale] }));
    const currentResult = await finalize(root, makeRun());
    expect(currentResult.removed).toEqual([]);
    await expect(access(stalePath)).resolves.toBeUndefined();
  });

  it('keeps stale ownership when cleanup is disabled and normalizes current files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    const stalePath = path.join(root, 'stale.md');
    await writeFile(stalePath, 'stale');
    const stale = describeArchiveFile(root, stalePath, 'page', 'https://example.com/stale', 'stale');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ownedFiles: [stale] }));
    const first = describeArchiveFile(root, path.join(root, 'same.md'), 'page', 'https://example.com/first', 'first');
    const newest = describeArchiveFile(root, path.join(root, 'same.md'), 'page', 'https://example.com/new', 'new');
    const unsafe = { ...newest, path: '../outside.md' };

    const result = await finalize(root, makeRun({ cleanupEnabled: false, files: [first, unsafe, newest], pages: [] }));

    expect(result.removed).toEqual([]);
    await expect(access(stalePath)).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.files).toEqual([newest]);
    expect(manifest.ownedFiles.map((file: { path: string }) => file.path)).toEqual(['same.md', 'stale.md']);
  });

  it('records cleanup filesystem failures and retains their ownership', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    const directoryPath = path.join(root, 'not-a-file.md');
    await mkdir(directoryPath);
    const stale = describeArchiveFile(root, directoryPath, 'page', 'https://example.com/old', 'expected file');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ownedFiles: [stale] }));

    const result = await finalize(root, makeRun());

    expect(result.status).toBe('partial');
    expect(result.cleanupFailures).toHaveLength(1);
    expect(result.historyPath).toBeUndefined();
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.ownedFiles).toEqual([stale]);
  });

  it('preserves stale files whose contents changed locally', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    const pagePath = path.join(root, 'docs.md');
    const original = '# Original\n';
    await writeFile(pagePath, original);

    await finalize(
      root,
      makeRun({
        files: [describeArchiveFile(root, pagePath, 'page', 'https://example.com/docs', original)],
      })
    );
    await writeFile(pagePath, '# Edited locally\n');

    const result = await finalize(root, makeRun({ pagesDownloaded: 0, pages: [], files: [] }));

    expect(result.status).toBe('success');
    expect(result.preserved).toEqual(['docs.md']);
    await expect(access(pagePath)).resolves.toBeUndefined();
    expect(await readdir(path.join(root, '.manifests'))).toHaveLength(2);
  });

  it('does not clean stale files after a partial crawl', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-manifest-test-'));
    temporaryDirectories.push(root);
    const pagePath = path.join(root, 'old.md');
    const original = '# Old\n';
    await writeFile(pagePath, original);

    await finalize(
      root,
      makeRun({
        files: [describeArchiveFile(root, pagePath, 'page', 'https://example.com/docs/old', original)],
      })
    );
    const result = await finalize(
      root,
      makeRun({
        pagesDownloaded: 0,
        pages: [],
        files: [],
        failures: [{ url: 'https://example.com/docs', message: 'HTTP 503' }],
      })
    );

    expect(result.status).toBe('partial');
    expect(result.removed).toEqual([]);
    await expect(access(pagePath)).resolves.toBeUndefined();
    expect(await readdir(path.join(root, '.manifests'))).toHaveLength(1);
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.ownedFiles.map((file: { path: string }) => file.path)).toEqual(['old.md']);
  });
});

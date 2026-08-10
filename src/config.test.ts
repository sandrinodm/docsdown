import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveConfigFilename,
  discoverArchiveConfigs,
  makeArchiveConfig,
  readArchiveConfig,
  writeArchiveConfig,
} from './config.js';
import type { DocumentationDownloadOptions } from './providers.js';

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const options: DocumentationDownloadOptions = {
  url: 'https://github.com/acme/docs',
  outputDirectory: '/archive',
  concurrency: 3,
  maxPages: 40,
  maxMediaBytes: 1024,
  singlePage: false,
  keepStale: true,
  verbose: false,
  provider: 'github',
  githubToken: 'must-not-be-stored',
};

const run = <A>(effect: Effect.Effect<A, unknown, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

describe('archive update configuration', () => {
  it('creates, writes, reads, and discovers token-free configuration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-config-test-'));
    temporaryDirectories.push(root);
    const archiveRoot = path.join(root, 'github.com', 'acme', 'docs');
    await mkdir(archiveRoot, { recursive: true });
    const config = makeArchiveConfig(options, 'github');

    expect(config.options.githubPaths).toEqual([]);
    await run(writeArchiveConfig(archiveRoot, config));
    const configPath = path.join(archiveRoot, archiveConfigFilename);
    const serialized = await readFile(configPath, 'utf8');
    expect(serialized).not.toContain('must-not-be-stored');
    await expect(run(readArchiveConfig(configPath))).resolves.toEqual(config);
    await expect(run(discoverArchiveConfigs(root))).resolves.toEqual([{ ok: true, path: configPath, config }]);

    const selected = makeArchiveConfig({ ...options, githubPaths: ['docs', 'reference'] }, 'github');
    expect(selected.options.githubPaths).toEqual(['docs', 'reference']);

    const { maxPages: _maxPages, ...unlimitedOptions } = options;
    const unlimited = makeArchiveConfig(unlimitedOptions, 'github');
    expect(unlimited.options).not.toHaveProperty('maxPages');
  });

  it('reports malformed and schema-invalid configs and tolerates a missing output directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docsdown-config-test-'));
    temporaryDirectories.push(root);
    const invalidJson = path.join(root, 'invalid-json', archiveConfigFilename);
    const invalidSchema = path.join(root, 'invalid-schema', archiveConfigFilename);
    await mkdir(path.dirname(invalidJson), { recursive: true });
    await mkdir(path.dirname(invalidSchema), { recursive: true });
    await writeFile(invalidJson, '{invalid');
    await writeFile(invalidSchema, JSON.stringify({ schemaVersion: 2 }));

    const discovered = await run(discoverArchiveConfigs(root));

    expect(discovered).toHaveLength(2);
    expect(discovered.every((entry) => !entry.ok)).toBe(true);
    expect(discovered.map((entry) => (entry.ok ? '' : entry.message)).join('\n')).toContain('Invalid JSON');
    expect(discovered.map((entry) => (entry.ok ? '' : entry.message)).join('\n')).toContain('Invalid configuration');
    await expect(run(discoverArchiveConfigs(path.join(root, 'missing')))).resolves.toEqual([]);
  });

  it('does not overwrite a configuration target outside the archive through a hard link', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'docsdown-config-test-'));
    temporaryDirectories.push(parent);
    const archiveRoot = path.join(parent, 'archive');
    const outsideConfig = path.join(parent, 'outside.json');
    await mkdir(archiveRoot);
    await writeFile(outsideConfig, 'outside sentinel');
    await link(outsideConfig, path.join(archiveRoot, archiveConfigFilename));

    await expect(run(writeArchiveConfig(archiveRoot, makeArchiveConfig(options, 'github')))).resolves.toBeUndefined();
    await expect(readFile(outsideConfig, 'utf8')).resolves.toBe('outside sentinel');
    await expect(readFile(path.join(archiveRoot, archiveConfigFilename), 'utf8')).resolves.toContain(
      '"schemaVersion": 1'
    );
  });

  it('does not discover an update configuration through a directory symlink outside the search root', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'docsdown-config-test-'));
    temporaryDirectories.push(parent);
    const searchRoot = path.join(parent, 'search');
    const outsideArchive = path.join(parent, 'outside');
    await mkdir(searchRoot);
    await mkdir(outsideArchive);
    await writeFile(
      path.join(outsideArchive, archiveConfigFilename),
      JSON.stringify(makeArchiveConfig(options, 'github'))
    );
    await symlink(outsideArchive, path.join(searchRoot, 'linked'), 'junction');

    const discovered = await run(discoverArchiveConfigs(searchRoot));

    expect(discovered.filter((entry) => entry.ok)).toEqual([]);
  });
});

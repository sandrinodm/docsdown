import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { downloadDocumentation, selectProvider } from './providers.js';

const TestLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);

const options = {
  url: 'https://example.com/docs',
  outputDirectory: '/unused',
  concurrency: 1,
  maxPages: 1,
  maxMediaBytes: 1,
  singlePage: false,
  keepStale: false,
  verbose: false,
};

describe('provider selection', () => {
  it('honors explicit adapters and detects GitHub URL variants', () => {
    expect(selectProvider('https://example.com/docs', 'website')).toBe('website');
    expect(selectProvider('https://example.com/docs', 'github')).toBe('github');
    expect(selectProvider('https://github.com/acme/docs', 'auto')).toBe('github');
    expect(selectProvider('https://raw.githubusercontent.com/acme/docs/main/README.md', 'auto')).toBe('github');
    expect(selectProvider('example.com/docs', 'auto')).toBe('website');
  });

  it('rejects unknown provider names', () => {
    expect(() => selectProvider('https://example.com', 'other')).toThrow(
      'Unknown provider "other"; expected auto, website, or github'
    );
  });

  it('validates provider selection and shared limits before adapter work', async () => {
    const includeError = await downloadDocumentation({ ...options, provider: 'website', githubPaths: ['docs'] }).pipe(
      Effect.flip,
      Effect.provide(TestLayer),
      Effect.runPromise
    );
    expect(includeError).toMatchObject({
      _tag: 'InvalidOptionsError',
      message: '--include is only supported by the GitHub provider',
    });
    await expect(
      downloadDocumentation({ ...options, provider: 'other' }).pipe(Effect.provide(TestLayer), Effect.runPromise)
    ).rejects.toThrow('Unknown provider "other"; expected auto, website, or github');
    await expect(
      downloadDocumentation({ ...options, provider: 'auto', url: 'http://[invalid' }).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      )
    ).rejects.toThrow('Invalid URL');
    await expect(
      downloadDocumentation({ ...options, provider: 'website', concurrency: 0 }).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      )
    ).rejects.toThrow('--concurrency must be an integer of at least 1');
    await expect(
      downloadDocumentation({
        ...options,
        provider: 'github',
        url: 'https://github.com/acme/docs',
        maxPages: 0,
        githubPaths: ['docs'],
      }).pipe(Effect.provide(TestLayer), Effect.runPromise)
    ).rejects.toThrow('--max-pages must be an integer of at least 1');
    await expect(
      downloadDocumentation({ ...options, provider: 'website', maxMediaBytes: 0 }).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      )
    ).rejects.toThrow('--max-media-mb must be greater than 0');
    await expect(
      downloadDocumentation({ ...options, provider: 'website', concurrency: 1.5 }).pipe(
        Effect.provide(TestLayer),
        Effect.runPromise
      )
    ).rejects.toThrow('--concurrency must be an integer of at least 1');
  });

  it('dispatches GitHub URLs through the GitHub adapter', async () => {
    await expect(
      downloadDocumentation({
        ...options,
        provider: 'github',
        url: 'https://github.com/acme',
      }).pipe(Effect.provide(TestLayer), Effect.runPromise)
    ).rejects.toThrow('GitHub URLs must include an owner and repository');
    const error = await downloadDocumentation({ ...options, provider: 'github', url: 'https://github.com/acme' }).pipe(
      Effect.flip,
      Effect.provide(TestLayer),
      Effect.runPromise
    );
    expect(error._tag).toBe('InvalidOptionsError');
  });
});

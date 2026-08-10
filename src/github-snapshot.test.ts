import { describe, expect, it } from 'vitest';
import { parseGitHubUrl, planGitHubSnapshot, resolveGitHubScopes } from './github-snapshot.js';

describe('GitHub URL interpretation', () => {
  it('parses repositories, trees, blobs, raw files, and .git suffixes', () => {
    expect(parseGitHubUrl('https://github.com/acme/docs.git')).toEqual({
      owner: 'acme',
      repository: 'docs',
      ref: undefined,
      repositoryPath: '',
      exactFile: false,
    });
    expect(parseGitHubUrl('https://github.com/acme/docs/tree/v2/guides/start')).toMatchObject({
      ref: 'v2',
      repositoryPath: 'guides/start',
      exactFile: false,
    });
    expect(parseGitHubUrl('https://github.com/acme/docs/blob/main/README.md')).toMatchObject({
      ref: 'main',
      repositoryPath: 'README.md',
      exactFile: true,
    });
    expect(parseGitHubUrl(new URL('https://raw.githubusercontent.com/acme/docs/main/README.md'))).toMatchObject({
      ref: 'main',
      repositoryPath: 'README.md',
      exactFile: true,
    });
    expect(parseGitHubUrl('https://raw.githubusercontent.com/acme/docs/main/assets/logo.png')).toMatchObject({
      repositoryPath: 'assets/logo.png',
      exactFile: false,
    });
    expect(parseGitHubUrl('https://raw.githubusercontent.com/acme/docs/main/docs/component.mdx')).toMatchObject({
      repositoryPath: 'docs/component.mdx',
      exactFile: true,
    });
  });

  it('rejects unsupported and incomplete GitHub URLs', () => {
    expect(() => parseGitHubUrl('https://github.com/acme')).toThrow('owner and repository');
    expect(() => parseGitHubUrl('https://github.com/acme/docs/tree')).toThrow('must include a branch');
    expect(() => parseGitHubUrl('https://raw.githubusercontent.com/acme/docs')).toThrow('owner, repository, ref');
    expect(() => parseGitHubUrl('https://gitlab.com/acme/docs')).toThrow('Unsupported GitHub URL');
  });

  it('resolves, validates, and deduplicates explicit repository scopes', () => {
    const repository = parseGitHubUrl('https://github.com/acme/docs');
    const tree = parseGitHubUrl('https://github.com/acme/docs/tree/main/documentation');
    const blob = parseGitHubUrl('https://github.com/acme/docs/blob/main/README.md');

    expect(resolveGitHubScopes(repository, [])).toEqual([]);
    expect(resolveGitHubScopes(tree, [])).toEqual(['documentation']);
    expect(resolveGitHubScopes(repository, ['/docs/', 'packages/sdk/docs', 'docs'])).toEqual([
      'docs',
      'packages/sdk/docs',
    ]);
    expect(resolveGitHubScopes(tree, ['guides'])).toEqual(['documentation/guides']);
    expect(() => resolveGitHubScopes(blob, ['docs'])).toThrow('cannot be combined with a GitHub blob URL');
    for (const selection of ['', '.', '..', '../private', 'docs/../private', 'docs\\private']) {
      expect(() => resolveGitHubScopes(repository, [selection])).toThrow('Invalid GitHub include path');
    }
  });
});

describe('GitHub snapshot planning', () => {
  it('interprets the source and selects sorted Markdown inside the requested scopes', () => {
    const plan = planGitHubSnapshot({
      url: 'https://github.com/acme/mono',
      defaultRef: 'main',
      includes: ['/docs/', 'packages/sdk/docs', 'docs'],
      maxPages: 20,
      singlePage: false,
      tree: {
        truncated: false,
        entries: [
          { path: 'packages/sdk/docs/api.mdx', type: 'blob', size: 12 },
          { path: 'src/internal.md', type: 'blob', size: 3 },
          { path: 'docs/start.md', type: 'blob', size: 8 },
          { path: 'docs', type: 'tree' },
        ],
      },
    });

    expect(plan.target).toEqual({
      owner: 'acme',
      repository: 'mono',
      ref: undefined,
      repositoryPath: '',
      exactFile: false,
    });
    expect(plan.ref).toBe('main');
    expect(plan.scopes).toEqual(['docs', 'packages/sdk/docs']);
    expect(plan.markdown.map((entry) => entry.path)).toEqual(['docs/start.md', 'packages/sdk/docs/api.mdx']);
    expect(plan.blobSize('docs/start.md')).toBe(8);
    expect(plan.truncated).toBe(false);
  });

  it('rejects invalid page limits before selecting content', () => {
    expect(() =>
      planGitHubSnapshot({
        url: 'https://github.com/acme/docs',
        defaultRef: 'main',
        maxPages: 0,
        singlePage: false,
        tree: { truncated: false, entries: [{ path: 'README.md', type: 'blob', size: 1 }] },
      })
    ).toThrow('--max-pages must be at least 1');
  });

  it('uses an explicit ref, exact blob selection, and recursive-tree truncation', () => {
    const plan = planGitHubSnapshot({
      url: 'https://github.com/acme/docs/blob/v2/docs/guide.md',
      maxPages: 10,
      singlePage: false,
      tree: {
        truncated: true,
        entries: [
          { path: 'README.md', type: 'blob', size: 2 },
          { path: 'docs/guide.md', type: 'blob' },
          { path: 'docs/other.md', type: 'blob', size: 9 },
          { path: '../unsafe.md', type: 'blob', size: 1 },
        ],
      },
    });

    expect(plan.ref).toBe('v2');
    expect(plan.scopes).toEqual(['docs/guide.md']);
    expect(plan.markdown.map((entry) => entry.path)).toEqual(['docs/guide.md']);
    expect(plan.blobSize('docs/guide.md')).toBeUndefined();
    expect(plan.blobSize('../unsafe.md')).toBeUndefined();
    expect(plan.truncated).toBe(true);
  });

  it('marks snapshots truncated when page or single-page limits omit Markdown', () => {
    const request = {
      url: 'https://github.com/acme/docs',
      defaultRef: 'main',
      tree: {
        truncated: false,
        entries: [
          { path: 'a.md', type: 'blob', size: 1 },
          { path: 'b.md', type: 'blob', size: 1 },
        ],
      },
    } as const;

    expect(planGitHubSnapshot({ ...request, maxPages: 1, singlePage: false }).markdown).toHaveLength(1);
    expect(planGitHubSnapshot({ ...request, maxPages: 2, singlePage: true })).toMatchObject({ truncated: true });
    expect(planGitHubSnapshot({ ...request, singlePage: false })).toMatchObject({
      markdown: request.tree.entries,
      truncated: false,
    });
  });

  it('requires a resolved ref when the URL does not include one', () => {
    expect(() =>
      planGitHubSnapshot({
        url: 'https://github.com/acme/docs',
        maxPages: 10,
        singlePage: false,
        tree: { truncated: false, entries: [] },
      })
    ).toThrow('Could not resolve a GitHub ref for https://github.com/acme/docs');
  });
});

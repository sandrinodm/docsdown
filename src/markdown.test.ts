import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, rewriteMarkdown } from './markdown.js';

describe('HTML conversion', () => {
  it('selects main content, removes navigation, and preserves media', () => {
    const result = htmlToMarkdown(
      `
      <html><head><title>Fallback title</title></head><body>
        <nav>Skip me</nav>
        <main><header><h1>Install</h1></header><p>Read the guide.</p>
          <a href="https://example.com/source"><i class="icon"></i>Source</a>
          <img data-src="/images/setup.png">
          <video><source src="/video/demo.mp4"></video>
          <table><thead><tr><th>Option</th><th>Value</th></tr></thead>
            <tbody><tr><td><code>mode</code></td><td><del>legacy</del></td></tr></tbody></table>
        </main>
      </body></html>
    `,
      new URL('https://example.com/docs/install')
    );

    expect(result.title).toBe('Install');
    expect(result.markdown).toContain('# Install');
    expect(result.markdown).not.toContain('Skip me');
    expect(result.markdown).toContain('[Source](https://example.com/source)');
    expect(result.markdown).toContain('https://example.com/images/setup.png');
    expect(result.markdown).toContain('https://example.com/video/demo.mp4');
    expect(result.markdown).toContain('| Option | Value');
    expect(result.markdown).toContain('| `mode` | ~~legacy~~ |');
  });

  it('falls back to body content and ignores malformed or non-HTTP resources', () => {
    const result = htmlToMarkdown(
      `
      <html><head><title>Body fallback</title></head><body>
        <article></article>
        <p><a href="mailto:team@example.com">Email</a></p>
        <p><a href="http://[invalid">Broken</a></p>
        <img srcset="/images/first.webp 1x, /images/second.webp 2x">
        <img src="data:image/png;base64,AAAA">
        <img>
        <video poster="/poster.jpg" srcset="/video/demo.webm 1x"></video>
        <video poster=""></video>
        <i></i>
      </body></html>
    `,
      new URL('https://example.com/docs/page')
    );

    expect(result.title).toBe('Body fallback');
    expect(result.markdown).toContain('[Email](mailto:team@example.com)');
    expect(result.markdown).toContain('[Broken](http://\\[invalid)');
    expect(result.markdown).toContain('https://example.com/images/first.webp');
    expect(result.markdown).toContain('data:image/png;base64,AAAA');
    expect(result.markdown).toContain('https://example.com/poster.jpg');
    expect(result.markdown).toContain('https://example.com/video/demo.webm');
  });

  it('uses the full HTML fragment when no preferred container or title exists', () => {
    const result = htmlToMarkdown(
      '<section><p>Loose documentation.</p></section>',
      new URL('https://example.com/docs')
    );

    expect(result.title).toBeUndefined();
    expect(result.markdown).toContain('Loose documentation.');
  });

  it('selects a preferred container that has no title', () => {
    const result = htmlToMarkdown('<main><p>Untitled documentation.</p></main>', new URL('https://example.com/docs'));

    expect(result.title).toBeUndefined();
    expect(result.markdown).toBe('Untitled documentation.');
  });
});

describe('Markdown rewriting', () => {
  it('rewrites page and media URLs but leaves code examples alone', () => {
    const root = path.resolve('/tmp/site');
    const pageFile = path.join(root, 'docs', 'intro.md');
    const result = rewriteMarkdown(
      `
# Intro

[Install](./install#requirements)
![Logo](/images/logo.svg)

\`\`\`md
[Example](./do-not-rewrite)
\`\`\`
`,
      {
        pageUrl: new URL('https://example.com/docs/intro'),
        pageFile,
        resolvePageFile: (url) =>
          url.pathname.startsWith('/docs/') ? path.join(root, `${url.pathname}.md`) : undefined,
        resolveMediaFile: (url) => path.join(root, '_media', url.host, url.pathname),
        isMediaUrl: (url) => /\.(?:png|svg)$/.test(url.pathname),
        relativePath: (from, to) => path.relative(path.dirname(from), to).split(path.sep).join('/'),
      }
    );

    expect(result.markdown).toContain('[Install](install.md#requirements)');
    expect(result.markdown).toContain('![Logo](../_media/example.com/images/logo.svg)');
    expect(result.markdown).toContain('[Example](./do-not-rewrite)');
    expect(result.links.map((url) => url.href)).toContain('https://example.com/docs/install#requirements');
    expect(result.media.map((url) => url.href)).toContain('https://example.com/images/logo.svg');
  });

  it('rewrites definitions, media links, and embedded HTML while deduplicating discoveries', () => {
    const root = path.resolve('/tmp/site');
    const pageFile = path.join(root, 'docs', 'advanced.md');
    const context = {
      pageUrl: new URL('https://example.com/docs/advanced'),
      pageFile,
      resolvePageFile: (url: URL) => (url.pathname === '/docs/local' ? path.join(root, 'docs', 'local.md') : undefined),
      resolveMediaFile: (url: URL) =>
        url.pathname.includes('unmapped') ? undefined : path.join(root, '_media', url.host, url.pathname),
      isMediaUrl: (url: URL) => /\.(?:png|mp4)$/.test(url.pathname),
      relativePath: (from: string, to: string) => path.relative(path.dirname(from), to).split(path.sep).join('/'),
    };
    const result = rewriteMarkdown(
      `
# Advanced \`API\`

[Local][local]
[Local again](/docs/local)
[External](https://other.example/docs)
[Email](mailto:team@example.com)
[FTP](ftp://example.com/archive)
[Video](/media/demo.mp4)
![Unmapped](/media/unmapped.png)
![Ignored](mailto:image@example.com)
![Duplicate](/media/demo.png)
![Duplicate again](/media/demo.png)

[local]: /docs/local#part

<a href="/docs/local#html">HTML local</a>
<a href="https://other.example/raw">HTML external</a>
<a href="javascript:alert(1)">Ignored</a>
<img data-lazy-src="/media/lazy.png">
<img srcset="/media/srcset.png 1x, /media/large.png 2x">
<img src="/media/unmapped-raw.png">
<img src="mailto:nobody@example.com">
<video poster="/media/poster.png"><source src="/media/demo.mp4"></video>
<video poster="/media/unmapped-poster.png"></video>
<video poster="mailto:nobody@example.com"></video>
`,
      context
    );

    expect(result.title).toBe('Advanced API');
    expect(result.markdown).toContain('[Local][local]');
    expect(result.markdown).toContain('[local]: local.md#part');
    expect(result.markdown).toContain('[Video](../_media/example.com/media/demo.mp4)');
    expect(result.markdown).toContain('![Unmapped](/media/unmapped.png)');
    expect(result.markdown).toContain('href="local.md#html"');
    expect(result.links.filter((url) => url.pathname === '/docs/local')).toHaveLength(3);
    expect(result.media.filter((url) => url.pathname === '/media/demo.png')).toHaveLength(1);
    expect(result.media.map((url) => url.pathname)).toEqual(
      expect.arrayContaining([
        '/media/demo.mp4',
        '/media/unmapped.png',
        '/media/lazy.png',
        '/media/srcset.png',
        '/media/poster.png',
      ])
    );
  });

  it('returns no title or resources for Markdown without headings or links', () => {
    const result = rewriteMarkdown('Plain text only.\n', {
      pageUrl: new URL('https://example.com/docs/plain'),
      pageFile: '/tmp/plain.md',
      resolvePageFile: () => undefined,
      resolveMediaFile: () => undefined,
      isMediaUrl: () => false,
      relativePath: () => './unused',
    });

    expect(result).toMatchObject({ title: undefined, links: [], media: [] });
  });

  it('does not derive a title from a heading containing only an image', () => {
    const result = rewriteMarkdown('# ![Logo](mailto:logo@example.com)\n', {
      pageUrl: new URL('https://example.com/docs/plain'),
      pageFile: '/tmp/plain.md',
      resolvePageFile: () => undefined,
      resolveMediaFile: () => undefined,
      isMediaUrl: () => false,
      relativePath: () => './unused',
    });

    expect(result.title).toBeUndefined();
    expect(result.media).toEqual([]);
  });
});

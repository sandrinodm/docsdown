import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isInScope,
  isMediaUrl,
  markdownRelativePath,
  markdownSuffixUrl,
  mediaFilePath,
  normalizeUrl,
  pageFilePath,
  sanitizeSegment,
  scopePathFor,
} from './paths.js';

describe('archive paths', () => {
  const root = path.resolve('/tmp/archive/example.com');

  it('mirrors page paths without allowing URLs to choose filesystem segments', () => {
    expect(pageFilePath(root, new URL('https://example.com/docs/getting-started'))).toBe(
      path.join(root, 'docs', 'getting-started.md')
    );
    expect(pageFilePath(root, new URL('https://example.com/docs/guides/'))).toBe(
      path.join(root, 'docs', 'guides', 'index.md')
    );
    expect(pageFilePath(root, new URL('https://example.com/'))).toBe(path.join(root, 'index.md'));
    expect(pageFilePath(root, new URL('https://example.com/reference.html?locale=en'))).toMatch(
      /reference-[a-f0-9]{10}\.md$/
    );
  });

  it('keeps media grouped by its source host', () => {
    expect(mediaFilePath(root, new URL('https://cdn.example.net/img/hero.png?v=2'))).toMatch(
      /_media\/cdn\.example\.net\/img\/hero-[a-f0-9]{10}\.png$/
    );
    expect(mediaFilePath(root, new URL('https://cdn.example.net/?v=2'))).toMatch(
      /_media\/cdn\.example\.net\/index-[a-f0-9]{10}$/
    );
  });

  it('creates portable relative Markdown links', () => {
    const from = path.join(root, 'docs', 'intro.md');
    const to = path.join(root, '_media', 'example.com', 'logo.svg');
    expect(markdownRelativePath(from, to)).toBe('../_media/example.com/logo.svg');
    expect(markdownRelativePath(from, path.join(root, 'docs', 'next.md'))).toBe('./next.md');
  });

  it('sanitizes malformed and non-portable URL segments', () => {
    expect(sanitizeSegment('%E0%A4%A')).toBe('%E0%A4%A');
    expect(sanitizeSegment('  bad<> name  ')).toBe('bad---name');
    expect(sanitizeSegment('...')).toBe('_');
    expect(sanitizeSegment('***')).toBe('_');
  });

  it('normalizes bare and parsed URLs', () => {
    expect(normalizeUrl(' example.com/docs#intro ').href).toBe('https://example.com/docs');
    const parsed = new URL('http://example.com/docs?q=1#intro');
    expect(normalizeUrl(parsed).href).toBe('http://example.com/docs?q=1');
  });
});

describe('crawl scope', () => {
  it('uses the starting path as a strict subtree', () => {
    const start = new URL('https://example.com/docs');
    const scope = scopePathFor(start);
    expect(isInScope(new URL('https://example.com/docs/install'), start, scope)).toBe(true);
    expect(isInScope(new URL('https://example.com/docs'), start, scope)).toBe(true);
    expect(isInScope(new URL('https://example.com/docs-v2'), start, scope)).toBe(false);
    expect(isInScope(new URL('https://other.example.com/docs'), start, scope)).toBe(false);
    expect(isInScope(new URL('ftp://example.com/docs'), new URL('ftp://example.com/docs'), '/')).toBe(false);
    expect(isInScope(new URL('https://example.com/anything'), new URL('https://example.com/'), '/')).toBe(true);
  });

  it('probes a normalized .md suffix', () => {
    expect(markdownSuffixUrl(new URL('https://example.com/docs/start/?x=1')).href).toBe(
      'https://example.com/docs/start.md'
    );
    expect(markdownSuffixUrl(new URL('https://example.com/')).href).toBe('https://example.com/index.md');
  });

  it('derives scope from roots, directories, page files, and extensionless paths', () => {
    expect(scopePathFor(new URL('https://example.com/'))).toBe('/');
    expect(scopePathFor(new URL('https://example.com/docs/'))).toBe('/docs');
    expect(scopePathFor(new URL('https://example.com////'))).toBe('/');
    expect(scopePathFor(new URL('https://example.com/docs/page.html'))).toBe('/docs');
    expect(scopePathFor(new URL('https://example.com/docs'))).toBe('/docs');
  });

  it('recognizes media extensions case-insensitively', () => {
    expect(isMediaUrl(new URL('https://example.com/demo.MP4'))).toBe(true);
    expect(isMediaUrl(new URL('https://example.com/docs/intro'))).toBe(false);
  });
});

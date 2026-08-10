import { describe, expect, it } from 'vitest';
import { extractLlmsIndexLinks, llmsIndexCandidates, looksLikeLlmsIndex } from './llms-index.js';

describe('LLM discovery indexes', () => {
  it('probes root and selected-scope conventions without duplicates', () => {
    expect(llmsIndexCandidates(new URL('https://example.com/docs/start'), '/docs')).toEqual([
      { filename: 'llms.txt', url: new URL('https://example.com/llms.txt') },
      { filename: 'llms-full.txt', url: new URL('https://example.com/llms-full.txt') },
      { filename: 'llms.txt', url: new URL('https://example.com/docs/llms.txt') },
      { filename: 'llms-full.txt', url: new URL('https://example.com/docs/llms-full.txt') },
    ]);
    expect(llmsIndexCandidates(new URL('https://example.com/'), '/')).toHaveLength(2);
  });

  it('requires an initial H1 so HTML and plain-text soft 404s are ignored', () => {
    expect(looksLikeLlmsIndex('# Example\n')).toBe(true);
    expect(looksLikeLlmsIndex('\uFEFF# Example\n')).toBe(true);
    expect(looksLikeLlmsIndex('<html><h1>Missing</h1></html>')).toBe(false);
    expect(looksLikeLlmsIndex('Not found')).toBe(false);
  });

  it('extracts file-list links from llms.txt without treating prose links as crawl directives', () => {
    const links = extractLlmsIndexLinks(
      '# Example\n\n[Prose](./ignored)\n\n## Docs\n- [Start](./start): Intro\n* [API](<https://example.com/docs/api>)\n+ [Start again](./start)\n- [Email](mailto:docs@example.com)\n- Plain text\n',
      new URL('https://example.com/docs/llms.txt'),
      'llms.txt'
    );

    expect(links).toEqual([new URL('https://example.com/docs/start'), new URL('https://example.com/docs/api')]);
  });

  it('resolves every absolute and relative llms.txt URL form against the index directory', () => {
    const links = extractLlmsIndexLinks(
      `# Example

## Docs
- [Absolute](https://other.example/reference)
- [Protocol relative](//example.com/docs/protocol-relative)
- [Root relative](/docs/root-relative)
- [Path relative](path-relative)
- [Dot relative](./dot-relative)
- [Parent relative](../parent-relative)
- [Query and fragment](./query?version=1#install)
- [Balanced parentheses](./function_(input))
- [Only first link](./first-link) and [not this one](./second-link)
`,
      new URL('https://example.com/docs/llms.txt'),
      'llms.txt'
    );

    expect(links).toEqual([
      new URL('https://other.example/reference'),
      new URL('https://example.com/docs/protocol-relative'),
      new URL('https://example.com/docs/root-relative'),
      new URL('https://example.com/docs/path-relative'),
      new URL('https://example.com/docs/dot-relative'),
      new URL('https://example.com/parent-relative'),
      new URL('https://example.com/docs/query?version=1#install'),
      new URL('https://example.com/docs/function_(input)'),
      new URL('https://example.com/docs/first-link'),
    ]);
  });

  it('extracts source boundaries from llms-full.txt without following content links', () => {
    const links = extractLlmsIndexLinks(
      '# First\nSource: https://example.com/docs/first\n\n[Related](/docs/ignored)\n# Second\nsource: </docs/second>\nSource: https://example.com/docs/first\n',
      new URL('https://example.com/docs/llms-full.txt'),
      'llms-full.txt'
    );

    expect(links).toEqual([new URL('https://example.com/docs/first'), new URL('https://example.com/docs/second')]);
  });

  it('resolves every absolute and relative llms-full.txt source form against the index directory', () => {
    const links = extractLlmsIndexLinks(
      `# Full index
Source: https://other.example/reference
Source: //example.com/docs/protocol-relative
Source: /docs/root-relative
Source: path-relative
Source: ./dot-relative
Source: ../parent-relative
Source: <./query?version=1#install>
Source: ./function_(input)
Source: mailto:docs@example.com
Source: http://[
`,
      new URL('https://example.com/docs/llms-full.txt'),
      'llms-full.txt'
    );

    expect(links).toEqual([
      new URL('https://other.example/reference'),
      new URL('https://example.com/docs/protocol-relative'),
      new URL('https://example.com/docs/root-relative'),
      new URL('https://example.com/docs/path-relative'),
      new URL('https://example.com/docs/dot-relative'),
      new URL('https://example.com/parent-relative'),
      new URL('https://example.com/docs/query?version=1#install'),
      new URL('https://example.com/docs/function_(input)'),
    ]);
  });
});

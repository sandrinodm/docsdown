import type { Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { resolveStandardHttpReference } from './markdown.js';

/**
 * Conventional site-supplied indexes supported by website discovery.
 */
export type LlmsIndexFilename = 'llms.txt' | 'llms-full.txt';

/**
 * One location to probe for an optional LLM discovery index.
 */
export interface LlmsIndexCandidate {
  /**
   * Conventional index filename, which also determines its parsing rules.
   */
  readonly filename: LlmsIndexFilename;

  /**
   * Absolute same-origin probe URL.
   */
  readonly url: URL;
}

/**
 * Recognizes an index body while rejecting common HTML soft-404 responses.
 *
 * Both the proposal and common `llms-full.txt` generators require the content to begin with an H1.
 */
export const looksLikeLlmsIndex = (source: string): boolean => /^(?:\uFEFF)?#[ \t]+\S/u.test(source);

/**
 * Returns root and selected-scope index locations in stable priority order.
 */
export const llmsIndexCandidates = (startUrl: URL, scopePath: string): ReadonlyArray<LlmsIndexCandidate> => {
  const directories = ['/', scopePath === '/' ? '/' : `${scopePath.replace(/\/+$/u, '')}/`];
  const seen = new Set<string>();
  const candidates: Array<LlmsIndexCandidate> = [];
  for (const directory of directories) {
    for (const filename of ['llms.txt', 'llms-full.txt'] as const) {
      const url = new URL(filename, new URL(directory, startUrl));
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      candidates.push({ filename, url });
    }
  }
  return candidates;
};

/**
 * Extracts the first semantic Markdown link from every `llms.txt` file-list item.
 */
const extractLlmsTxtReferences = (source: string): ReadonlyArray<string> => {
  const tree = unified().use(remarkParse).parse(source) as Root;
  const references: Array<string> = [];
  visit(tree, 'listItem', (listItem) => {
    let reference: string | undefined;
    visit(listItem, 'link', (link) => {
      reference ??= link.url;
    });
    if (reference !== undefined) references.push(reference);
  });
  return references;
};

/**
 * Extracts generator-defined source boundaries from a combined `llms-full.txt` document.
 */
const extractLlmsFullReferences = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/^[ \t]*Source:[ \t]*(?:<([^>\r\n]+)>|(\S+))[ \t]*$/gimu)].map(
    (match) => match[1] ?? (match[2] as string)
  );

/**
 * Extracts the structured page references used by conventional LLM indexes.
 *
 * `llms.txt` contributes specification-defined Markdown file-list entries. `llms-full.txt` contributes the `Source:`
 * boundaries emitted by common documentation generators. Parsing only those structural lines avoids treating links in
 * examples or prose from a full documentation dump as crawl directives.
 */
export const extractLlmsIndexLinks = (
  source: string,
  baseUrl: URL,
  filename: LlmsIndexFilename
): ReadonlyArray<URL> => {
  const references = filename === 'llms.txt' ? extractLlmsTxtReferences(source) : extractLlmsFullReferences(source);
  const seen = new Set<string>();
  const links: Array<URL> = [];
  for (const reference of references) {
    const url = resolveStandardHttpReference(reference, baseUrl);
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push(url);
  }
  return links;
};

import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Extensions that identify page resources and are replaced with `.md` in the archive.
 */
const pageExtensions = new Set(['.htm', '.html', '.md', '.markdown']);

/**
 * Media extensions that are downloaded as binary assets instead of crawled as pages.
 */
export const mediaExtensions = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.m4v',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.ogg',
  '.ogv',
  '.png',
  '.svg',
  '.webm',
  '.webp',
]);

/**
 * Produces a stable short discriminator for query-specific archive filenames.
 *
 * The hash prevents two URLs with the same path and different queries from overwriting each other.
 */
const shortHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 10);

/**
 * Decodes a URL segment without allowing malformed percent escapes to abort an archive run.
 */
const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Converts an untrusted URL path segment into a portable, non-empty filesystem segment.
 *
 * Reserved filename characters, ASCII control characters, whitespace, and dot-only names are normalized.
 */
export const sanitizeSegment = (value: string): string => {
  const sanitized = safeDecode(value)
    .normalize('NFKC')
    // oxlint-disable-next-line eslint/no-control-regex -- Portable filenames cannot contain ASCII control characters.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+$/, '_')
    .replace(/^-+|-+$/g, '');
  return sanitized || '_';
};

/**
 * Parses a user-supplied URL, assuming HTTPS when no scheme is present, and removes fragments.
 *
 * Query parameters are preserved because they can identify distinct documentation pages.
 */
export const normalizeUrl = (value: string | URL): URL => {
  const raw = value instanceof URL ? value.href : value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  url.hash = '';
  return url;
};

/**
 * Converts a URL pathname into sanitized archive path segments.
 */
const pathnameSegments = (url: URL): Array<string> => url.pathname.split('/').filter(Boolean).map(sanitizeSegment);

/**
 * Adds a stable query hash before a filename extension when the URL contains search parameters.
 */
const withQueryHash = (filename: string, url: URL): string => {
  if (!url.search) return filename;
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem}-${shortHash(url.search)}${extension}`;
};

/**
 * Maps a page URL to its Markdown destination while preserving the site's path hierarchy.
 *
 * Directory URLs become `index.md`; known page extensions are replaced rather than appended.
 */
export const pageFilePath = (root: string, url: URL): string => {
  const segments = pathnameSegments(url);
  if (segments.length === 0) return path.join(root, withQueryHash('index.md', url));

  if (url.pathname.endsWith('/')) {
    return path.join(root, ...segments, withQueryHash('index.md', url));
  }

  const last = segments[segments.length - 1] as string;
  const extension = path.extname(last).toLowerCase();
  const filename = pageExtensions.has(extension) ? `${last.slice(0, -extension.length)}.md` : `${last}.md`;
  return path.join(root, ...segments.slice(0, -1), withQueryHash(filename, url));
};

/**
 * Maps a media URL beneath `media/<host>` so assets from different origins cannot collide.
 */
export const mediaFilePath = (root: string, url: URL): string => {
  const segments = pathnameSegments(url);
  const rawName = segments.at(-1) ?? 'index';
  const filename = withQueryHash(rawName, url);
  return path.join(root, 'media', sanitizeSegment(url.host), ...segments.slice(0, -1), filename);
};

/**
 * Produces a portable Markdown link between two local archive files.
 */
export const markdownRelativePath = (fromFile: string, toFile: string): string => {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
};

/**
 * Builds the first-choice Markdown probe URL by replacing a trailing slash and appending `.md`.
 *
 * Search parameters and fragments are intentionally removed from the probe.
 */
export const markdownSuffixUrl = (url: URL): URL => {
  const candidate = new URL(url);
  candidate.search = '';
  candidate.hash = '';
  const withoutSlash = candidate.pathname.replace(/\/+$/, '');
  candidate.pathname = `${withoutSlash || '/index'}.md`;
  return candidate;
};

/**
 * Determines the strict pathname subtree that a crawl may follow from its starting URL.
 */
export const scopePathFor = (url: URL): string => {
  if (url.pathname === '/') return '/';
  if (url.pathname.endsWith('/')) return url.pathname.replace(/\/+$/, '') || '/';
  const extension = path.posix.extname(url.pathname).toLowerCase();
  if (extension) return path.posix.dirname(url.pathname);
  return url.pathname;
};

/**
 * Checks whether an HTTP(S) candidate stays on the starting origin and inside the crawl subtree.
 */
export const isInScope = (candidate: URL, start: URL, scopePath: string): boolean => {
  if (candidate.origin !== start.origin) return false;
  if (!['http:', 'https:'].includes(candidate.protocol)) return false;
  if (scopePath === '/') return true;
  return candidate.pathname === scopePath || candidate.pathname.startsWith(`${scopePath}/`);
};

/**
 * Identifies media URLs by their pathname extension.
 */
export const isMediaUrl = (url: URL): boolean => mediaExtensions.has(path.posix.extname(url.pathname).toLowerCase());

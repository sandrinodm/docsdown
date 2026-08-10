import { readFileSync } from 'node:fs';

/**
 * Minimal package metadata consumed at runtime.
 *
 * Keeping this shape narrow prevents application code from depending on unrelated package fields.
 */
interface PackageMetadata {
  /**
   * Version surfaced by the CLI and HTTP user agent.
   */
  readonly version: string;
}

/**
 * Runtime package metadata loaded relative to both the source and compiled entry points.
 */
const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as PackageMetadata;

/**
 * Version declared by the package being executed.
 */
export const packageVersion = packageMetadata.version;

/**
 * HTTP user agent used for documentation and media requests.
 */
export const packageUserAgent = `docsdown/${packageVersion} (+https://github.com/sandrinodm/docsdown)`;

import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

const sourceRoot = path.resolve('src');
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const diagnostics = [];

const checkDirectory = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(filePath);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) continue;

    const source = await readFile(filePath, 'utf8');
    for (const match of source.matchAll(/\/\*\*[^\r\n]*\*\//gu)) {
      const line = source.slice(0, match.index).split(/\r?\n/u).length;
      diagnostics.push(`${path.relative(process.cwd(), filePath)}:${line}`);
    }
  }
};

await checkDirectory(sourceRoot);

if (diagnostics.length > 0) {
  console.error('Single-line JSDoc blocks are not allowed:');
  for (const diagnostic of diagnostics) console.error(`  ${diagnostic}`);
  process.exitCode = 1;
} else {
  console.log('All JSDoc blocks are multiline.');
}

<p align="center">
  <img src="./assets/docsdown-banner.webp" alt="docsdown: archive documentation as local Markdown" width="1086">
</p>

# docsdown

[![CI](https://github.com/sandrinodm/docsdown/actions/workflows/ci.yml/badge.svg)](https://github.com/sandrinodm/docsdown/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](package.json)

Archive documentation websites and GitHub repositories as searchable, offline Markdown, including referenced images and videos.

`docsdown` prefers first-party Markdown, converts HTML only when necessary, preserves the source hierarchy, rewrites links for local navigation, and records every page in a machine-readable manifest. Each archive is reproducible and can be refreshed later with one command.

## Why docsdown?

Documentation is often optimized for browsers, not for local search, editor navigation, offline use, or indexing by developer tools. `docsdown` turns a documentation subtree into a predictable directory of Markdown and media without requiring a site-specific adapter.

- **Best available source:** Tries a `.md` URL and Markdown content negotiation before converting HTML.
- **LLM-aware discovery:** Preserves optional `llms.txt` and `llms-full.txt` files and uses their structured references to find missing pages.
- **Website and GitHub providers:** Crawls documentation sites or reads Markdown and MDX directly from repositories.
- **Offline navigation:** Rewrites links between downloaded pages and localizes referenced media.
- **Focused archives:** Downloads one page, one GitHub folder, or several selected repository folders.
- **Repeatable updates:** Writes `.docsdown.json` automatically and refreshes every configured archive with `pnpx docsdown update`.
- **Auditable output:** Records page titles, source URLs, strategies, failures, and file digests in `manifest.json`.
- **Conservative cleanup:** Removes stale generated files only after a complete run and preserves locally edited files.

## Quick start

Run without installing:

```bash
pnpx docsdown https://orpc.unnoq.com/docs --output ./docs/orpc
```

`--output` is the exact archive directory. The archive is written directly to `./docs/orpc`:

```text
docs/
└── orpc/
    ├── docs.md
    ├── docs/
    ├── media/
    ├── .docsdown.json
    ├── .manifests/
    └── manifest.json
```

Search it with any local tool:

```bash
rg -n "middleware" docs/orpc
```

Refresh it later together with every other configured archive beneath `./docs`:

```bash
pnpx docsdown update
```

There is no separate configuration step. A successful initial download creates `.docsdown.json` automatically.

## Installation

`docsdown` requires Node.js 24 or newer.

Use it without installation:

```bash
pnpx docsdown <url> --output ./docs/library-name
```

Or install the CLI globally:

```bash
pnpm add --global docsdown
docsdown <url> --output ./docs/library-name
```

## Usage

```text
pnpx docsdown <url> --output <directory> [options]
pnpx docsdown update [--output <directory>]
```

### Download a documentation website

The starting path defines the crawl boundary. This downloads `/docs` and pages beneath it, but not the rest of the site:

```bash
pnpx docsdown https://tanstack.com/query/latest/docs --output ./docs/tanstack-query
```

Website crawls also probe for `llms.txt` and `llms-full.txt` at both the origin root and the selected crawl scope. Files
that exist are preserved verbatim at their corresponding archive paths. File-list links from `llms.txt` and `Source:`
page boundaries from `llms-full.txt` supplement ordinary link discovery; the normal same-origin and path-scope rules
still decide which pages enter the crawl. Absolute, protocol-relative, root-relative, and document-relative references
are resolved against the index URL. References outside the allowed origin or path are skipped with a warning, deduplicated
by resolved URL. Discovery indexes do not count against `--max-pages`.

`--output` is required and names the archive itself. docsdown does not append a hostname or repository name. Use a distinct child directory such as `./docs/orpc` for each library when maintaining several archives.

### Download one page

Use `--single-page` when you need one page and its referenced media without following page links:

```bash
pnpx docsdown https://example.com/docs/getting-started \
  --single-page \
  --output ./docs/example-getting-started
```

Single-page downloads do not probe or follow LLM discovery indexes.

### Download a large documentation site

docsdown follows the complete selected documentation scope by default. Reduce request concurrency when a large site is rate-sensitive:

```bash
pnpx docsdown https://example.com/docs \
  --concurrency 3 \
  --output ./docs/example
```

Use `--max-pages` only when you intentionally want to stop after a fixed number of pages. Limited runs are marked as truncated and do not remove stale files.

### Download a complete GitHub repository

GitHub URLs automatically select the GitHub provider. Markdown and MDX files retain their repository-relative paths.

```bash
pnpx docsdown https://github.com/sindresorhus/p-map --output ./docs/p-map
```

Repository, tree, blob, and `raw.githubusercontent.com` URLs are supported.

### Download one GitHub folder

Point to a GitHub tree URL:

```bash
pnpx docsdown https://github.com/owner/repository/tree/main/docs --output ./docs/repository
```

Only Markdown and MDX beneath `docs` are selected. Referenced assets can still be downloaded from elsewhere in the repository.

### Download several GitHub folders

Repeat `--include` to create one focused archive without downloading every Markdown file in the repository:

```bash
pnpx docsdown https://github.com/owner/repository \
  --include docs \
  --include packages/sdk/docs \
  --include examples/guides \
  --output ./docs/repository
```

When the URL already selects a tree, include paths are relative to that tree:

```bash
pnpx docsdown https://github.com/owner/repository/tree/main/docs \
  --include guides \
  --include reference \
  --output ./docs/repository
```

The complete include list describes the desired archive. On a later successful run, previously generated pages outside that selection are eligible for stale-file cleanup. Use `--keep-stale` when intentionally merging multiple runs.

### Download one GitHub Markdown file

A blob URL selects exactly one file and its referenced media:

```bash
pnpx docsdown https://github.com/owner/repository/blob/main/README.md --output ./docs/repository-readme
```

Raw-content URLs work as well:

```bash
pnpx docsdown https://raw.githubusercontent.com/owner/repository/main/README.md --output ./docs/repository-readme
```

### Download a private GitHub repository

Provide a token at runtime:

```bash
GITHUB_TOKEN=github_pat_... pnpx docsdown https://github.com/owner/private-repository \
  --output ./docs/private-repository
```

The token is sent only to GitHub API requests. It is never sent to external media hosts, written to Markdown, or persisted in `.docsdown.json`.

Providing a token is also useful for higher GitHub API rate limits when archiving public repositories.

### Force a provider

Provider selection defaults to `auto`. Override it when a URL is routed through a proxy or needs non-standard handling:

```bash
pnpx docsdown https://github.com/owner/repository --provider github --output ./docs/repository
pnpx docsdown https://github.com/owner/repository/tree/main/docs \
  --provider website \
  --output ./docs/rendered-repository
```

Valid values are `auto`, `website`, and `github`. The GitHub provider still requires a supported GitHub URL, and GitHub `--include` paths are rejected by the website provider.

### Limit media downloads

Images and videos are downloaded only when referenced by selected content. Skip individual files larger than a chosen size:

```bash
pnpx docsdown https://example.com/docs --max-media-mb 25 --output ./docs/example
```

The limit is checked against both the declared response size and the bytes actually received.

### Inspect request-level progress

Normal output reports completed pages. Use `--verbose` to see probes, page requests, and skipped media:

```bash
pnpx docsdown https://example.com/docs --verbose --output ./docs/example
```

## Updating archives

Every completed download writes a token-free `.docsdown.json` beside `manifest.json`. It contains everything needed to reproduce the archive:

```json
{
  "schemaVersion": 1,
  "source": "https://github.com/owner/repository",
  "provider": "github",
  "options": {
    "concurrency": 2,
    "maxMediaBytes": 104857600,
    "singlePage": false,
    "keepStale": false,
    "verbose": false,
    "githubPaths": ["docs", "packages/sdk/docs"]
  }
}
```

Refresh all configured archives beneath `./docs`:

```bash
pnpx docsdown update
```

Refresh archives beneath another parent directory:

```bash
pnpx docsdown update --output ./reference
```

Configuration files are discovered recursively. Archives update sequentially so their individual concurrency limits do not multiply unexpectedly. Invalid configs and failed or partial downloads are reported after every other archive has been attempted, and the command exits unsuccessfully when any update remains incomplete.

Private repositories still require a runtime token:

```bash
GITHUB_TOKEN=github_pat_... pnpx docsdown update
```

## How content is acquired

The website provider tries three strategies in order for every page:

1. **Markdown suffix:** Requests the page path with `.md` appended and accepts Markdown or non-HTML plain text.
2. **Markdown content negotiation:** Requests the original URL with `Accept: text/markdown` and requires a Markdown content type.
3. **HTML conversion:** Extracts the likely documentation content and converts it through the unified/remark pipeline.

This ordering preserves first-party Markdown whenever a site exposes it, including the Markdown content-negotiation convention pioneered by Cloudflare. HTML conversion remains the broad compatibility fallback.

The GitHub provider uses the recursive Git Trees API to discover Markdown and MDX, then downloads raw file contents. Relative Markdown links are rewritten when their targets are part of the selection. Referenced repository media is stored beneath `media/repository`; external media is grouped by host.

## Output structure

Website archives mirror URL paths directly beneath the exact output directory:

When the site exposes LLM discovery indexes, their remote root or scope placement is preserved alongside the pages:

```text
docs/
└── example/
    ├── llms.txt
    ├── llms-full.txt
    ├── docs.md
    ├── docs/
    │   ├── installation.md
    │   ├── llms.txt
    │   ├── llms-full.txt
    │   └── guides/
    │       └── routing.md
    ├── media/
    │   ├── example.com/images/logo.svg
    │   └── cdn.example.net/videos/demo.mp4
    ├── .docsdown.json
    ├── .manifests/
    │   └── 2026-08-09T10-00-00.000Z-a1b2c3d4.json
    └── manifest.json
```

GitHub archives preserve repository paths directly beneath their chosen output directory:

```text
docs/
└── repository/
    ├── README.md
    ├── docs/
    │   └── installation.md
    ├── media/
    │   └── repository/images/logo.svg
    ├── .docsdown.json
    ├── .manifests/
    └── manifest.json
```

Every generated documentation page begins with provenance frontmatter. Preserved `llms.txt` and `llms-full.txt`
indexes remain byte-for-byte identical to their remote sources:

```yaml
---
source: 'https://example.com/docs/installation'
title: 'Installation'
downloaded_at: '2026-08-09T10:00:00.000Z'
content_type: 'text/markdown'
download_strategy: 'markdown-content-negotiation'
---
```

Query strings are represented by stable hash suffixes so distinct URLs cannot overwrite each other.

## Manifests

`manifest.json` is both the latest run report and the ownership registry used for safe cleanup. It includes:

- Run status, timestamp, provider, source, and selected scopes.
- Page, discovery index, and media totals; indexes remain separate from the page count.
- The source URL and resolved title of every downloaded page.
- Counts for each acquisition strategy.
- Page, media, transport, and cleanup failures.
- Every generated file's relative path, source URL, byte size, kind (`page`, `index`, or `media`), and SHA-256 digest.

A shortened example:

```json
{
  "schemaVersion": 1,
  "status": "success",
  "provider": "website",
  "source": "https://example.com/docs",
  "scopePaths": ["/docs"],
  "pagesDownloaded": 2,
  "indexesDownloaded": 2,
  "mediaDownloaded": 1,
  "pages": [
    {
      "url": "https://example.com/docs",
      "title": "Documentation"
    },
    {
      "url": "https://example.com/docs/installation",
      "title": "Installation"
    }
  ],
  "strategies": {
    "markdown-suffix": 1,
    "markdown-content-negotiation": 0,
    "html-conversion": 1
  },
  "failures": [],
  "truncated": false
}
```

Every fully successful run is also copied to `.manifests/<run-id>.json`. These immutable snapshots provide a history that can be compared or indexed independently. Partial attempts update `manifest.json` but do not create a successful history snapshot.

## Safe stale-file cleanup

After a complete update, files owned by the previous archive but absent from the new result become stale. Cleanup is intentionally conservative:

| Situation                  | Behavior                                                        |
| -------------------------- | --------------------------------------------------------------- |
| Complete, failure-free run | Removes stale files whose recorded digest still matches.        |
| Page or media failure      | Records a partial run and removes nothing.                      |
| `--max-pages` reached      | Records a truncated run and removes nothing.                    |
| Stale file edited locally  | Preserves the file and records it in the manifest.              |
| `--keep-stale` used        | Retains stale files while preserving ownership for a later run. |
| File absent already        | Treats it as safely removed.                                    |

Only paths previously recorded by docsdown with a valid digest are cleanup candidates. `.docsdown.json`, `manifest.json`, and `.manifests/` are never cleanup targets.

## CLI reference

### Download options

| Option                     |  Default | Description                                                                                |
| -------------------------- | -------: | ------------------------------------------------------------------------------------------ |
| `--output, -o <directory>` | required | Exact destination directory for this archive.                                              |
| `--concurrency, -c <n>`    |      `2` | Maximum simultaneous page, discovery index, or media requests within one archive.          |
| `--max-pages <n>`          |     none | Optional ceiling for selected or crawled Markdown pages; omitted downloads the full scope. |
| `--max-media-mb <n>`       |    `100` | Maximum size of one referenced media file.                                                 |
| `--single-page`            |      off | Stops after one selected page; use a GitHub blob URL to select an exact repository file.   |
| `--keep-stale`             |      off | Disables stale-file deletion for this archive while retaining ownership metadata.          |
| `--verbose`                |      off | Prints probes, requests, and skipped media.                                                |
| `--provider <provider>`    |   `auto` | Selects `auto`, `website`, or `github`.                                                    |
| `--include <path>`         |     none | Adds a GitHub path to the selection; repeat the flag for multiple paths.                   |

### Update options

| Option                     |  Default | Description                                                |
| -------------------------- | -------: | ---------------------------------------------------------- |
| `--output, -o <directory>` | `./docs` | Directory searched recursively for `.docsdown.json` files. |

The Effect CLI runtime also supplies `--help`, `--version`, shell completions, log-level selection, and interactive wizard mode. Run `pnpx docsdown --help` or `pnpx docsdown update --help` for generated help.

## Scope and limitations

- Website crawling stays on the starting origin and within the starting path subtree. Referenced media may come from external origins.
- Root and selected-scope LLM indexes may be preserved from outside that subtree, but only their in-scope page references are crawled.
- JavaScript-rendered content that is absent from the server response is not rendered in a browser.
- Images and videos are downloaded only when referenced by selected Markdown or converted content.
- GitHub branch names containing `/` are ambiguous in browser tree URLs. Prefer a commit SHA, a tag without slashes, or a raw-content URL.
- GitHub recursive tree responses are limited by GitHub to 100,000 entries and 7 MB. A truncated response creates a partial manifest and never triggers cleanup.
- Cross-scope links remain remote when their target page is not part of the archive.
- Sites may block or rate-limit automated requests. Reduce `--concurrency` when appropriate and respect the site's terms and robots policy.
- `docsdown` is currently pre-1.0 and uses Effect 4's experimental CLI API.

## Development

Use Node.js 24 or newer and pnpm for local development.

```bash
pnpm install
pnpm run check
pnpm run test:coverage
pnpm run build
```

Run the CLI directly from source:

```bash
pnpm run dev -- https://example.com/docs --output ./docs/example
```

Oxfmt owns formatting, Oxlint owns static analysis, `jsdoc-lint` validates declaration documentation, and TypeScript runs in strict mode. Tests enforce 100% statement, branch, function, and line coverage.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete contribution and release workflow.

## Security

Remote documentation is treated as untrusted input. Page URLs, GitHub tree entries, media references, manifest records,
and update configurations cannot select a file outside the chosen archive root.

Every filesystem mutation passes through one canonical output boundary:

- Literal, percent-encoded, double-encoded, and Unicode dot segments cannot escape the archive.
- Existing parent directories are resolved before use. A symlink or redirected parent that leaves the archive is
  rejected.
- Page, media, manifest, history, and configuration writes use a temporary file followed by an atomic rename. Final
  symlinks and hard links are not followed for writes.
- Stale cleanup resolves and revalidates owned files before reading or removing them.
- `pnpx docsdown update` does not accept configurations reached through a directory symlink outside its search root.

The path passed to `--output` is the trust anchor. If that path is itself a symlink, its canonical target becomes the
archive root. The boundary protects against remote path input and pre-existing redirected paths. As with other portable
filesystem tools, the output tree should not be concurrently mutated by an untrusted local process while a run is in
progress.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

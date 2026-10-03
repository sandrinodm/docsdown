# docsdown internals

This page describes the archive bookkeeping and filesystem guarantees behind docsdown. See the [README](../README.md) for installation and usage.

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

Each run replaces `manifest.json`; docsdown keeps no history of earlier runs.

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

Only paths previously recorded by docsdown with a valid digest are cleanup candidates. `docsdown.json` and `manifest.json` are never cleanup targets.

## Filesystem safety

Remote documentation is treated as untrusted input. Page URLs, GitHub tree entries, media references, manifest records, and update configurations cannot select a file outside the chosen archive root.

Every filesystem mutation passes through one canonical output boundary:

- Literal, percent-encoded, double-encoded, and Unicode dot segments cannot escape the archive.
- Existing parent directories are resolved before use. A symlink or redirected parent that leaves the archive is rejected.
- Page, media, manifest, and configuration writes use a temporary file followed by an atomic rename. Final symlinks and hard links are not followed for writes.
- Stale cleanup resolves and revalidates owned files before reading or removing them.
- `docsdown update` does not accept configurations reached through a directory symlink outside its search root.
- `docsdown update` ignores `docsdown.json` files inside an archive's `content/` and `media/` trees, so downloaded content can never act as an update configuration.
- Malformed percent-encoding in remote links is tolerated; it cannot abort a run.

The path passed to `--output` is the trust anchor. If that path is itself a symlink, its canonical target becomes the archive root. The boundary protects against remote path input and pre-existing redirected paths. As with other portable filesystem tools, the output tree should not be concurrently mutated by an untrusted local process while a run is in progress.

Please report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).

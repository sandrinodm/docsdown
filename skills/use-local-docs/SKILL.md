---
name: use-local-docs
description: Use locally downloaded docsdown documentation for library-dependent development, debugging, configuration, tests, and code reviews. Applies when a project contains documentation archives in docs/libraries, downloaded-docs, or another directory with docsdown.json files.
---

# Use local docs

Use locally downloaded library documentation as a working reference when developing in a project with docsdown archives. Read the matching pages before relying on remembered APIs, configuration, or integration patterns.

## Find the archives

Start with the project's instructions and documentation index, often `docs/libraries/README.md`. Use the configured location when one is documented. Otherwise, discover archives from the project root:

```sh
rg --files --no-ignore -g 'docsdown.json' -g '!**/node_modules/**' -g '!**/.git/**'
```

The directory containing `docsdown.json` is an archive root. Its configuration identifies the original source and download scope; `manifest.json` indexes downloaded pages, file paths, timestamps, and failures. Website archives and GitHub archives have different layouts, so use the manifest to locate pages when filenames are unclear.

Choose the archive that matches the project's dependency and runtime. Check installed versions in package manifests and lockfiles against the documentation's version or scope. A download timestamp identifies a snapshot, not the installed library version; a source containing `latest` can change between refreshes.

## Read the relevant pages

Search the selected archive for the API symbol, error, or concept involved in the task:

```sh
rg -n --glob '*.md' --glob '*.mdx' 'symbol|concept' path/to/archive
```

Read matching pages and the linked guides needed to understand the API's constraints and examples. Include supplemental archives in the search when present. Keep the lookup focused on the libraries involved in the change.

Before concluding that documentation or an API is absent, check the archive's scope, `truncated`, and `failures` in its manifest. An archive of one product's URL subtree can exclude related products. A partial archive can still contain useful reference pages. Follow archive notes to recovered copies when filename collisions or download gaps are documented, and check page provenance and titles to distinguish similarly named functions and types.

## Use the documentation during development

Use the reference to choose supported APIs and adapt examples to the project's installed versions, runtime, and existing conventions. Validate the resulting implementation with the project's appropriate checks.

When the archive is missing, incompatible, ambiguous, or too old for the question, verify the relevant official source through the project's documentation lookup workflow. Page frontmatter and manifests retain the original URLs for that purpose.

When an explanation benefits from evidence, cite the specific local page and its original source URL. State material coverage or version uncertainty. Refresh or extend archives when documentation maintenance is within the task's scope.

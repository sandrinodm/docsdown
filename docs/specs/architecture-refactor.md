# Architecture refactor specification

## Objective

Deepen the modules responsible for provider selection, archive ownership, Markdown localization, GitHub snapshot planning, and bounded media acquisition without changing observable behavior.

## Confirmed test seams

1. `downloadDocumentation`: provider selection and complete website and GitHub behavior.
2. `runArchive`: ownership, writes, counters, failures, cleanup, manifests, and bounded media.
3. `localizeDocument`: HTML, Markdown, MDX, links, media, paths, and fragments.
4. `planGitHubSnapshot`: GitHub refs, scopes, safe paths, ordering, limits, and truncation.
5. `updateDocumentationArchives`: configuration discovery, persistence, and partial updates.

Website and GitHub remain the two source adapters. Bounded media acquisition stays inside `runArchive`. Pure localization and snapshot planning do not introduce hypothetical adapters.

## Required behavior

- Preserve all CLI flags, defaults, output, errors, and provider selection behavior.
- Preserve website acquisition order: `.md` suffix, Markdown content negotiation, then HTML conversion.
- Preserve GitHub browser and raw URL parsing, repository folder selection, exact-file behavior, authentication, and default-branch discovery.
- Never send a GitHub token to an external media origin.
- Preserve HTML, Markdown, and MDX conversion, title extraction, link rewriting, fragment preservation, media localization, and source hierarchy.
- Preserve concurrency and page limits, single-page behavior, deduplication, and truncation reporting.
- Enforce known, declared, and actual media byte limits before an archive owns a media file.
- Preserve `manifest.json`, successful `.manifests` snapshots, page titles and URLs, strategies, failures, file digests, and cleanup results.
- Clean stale files only after a complete successful run. Preserve locally modified files and unsafe or failed cleanup records.
- Preserve `.docsdown.json` compatibility and token-free updates.
- Continue updating other configured archives after one archive fails.

## Effect v4 requirements

- Keep filesystem and HTTP requirements in the Effect environment.
- Compose production adapters with layers at the CLI edge.
- Use `Effect.gen` for orchestration and `Effect.forEach` for bounded concurrency.
- Preserve expected failures in the typed error channel.
- Use Effect Schema decoding for untrusted JSON.
- Do not create custom filesystem or HTTP abstractions when Effect already supplies the required seam and adapters.

## Validation

- Write behavior tests before each production slice.
- Test through the confirmed seams, not private helpers.
- Replace superseded shallow tests instead of layering duplicates.
- Maintain 100% statement, branch, function, and line coverage.
- Pass formatting, Oxlint, JSDoc validation, type checking, the complete test suite, the production build, and package validation.

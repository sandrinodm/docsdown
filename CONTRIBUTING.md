# Contributing

Thanks for helping improve docsdown.

## Setup

Use Node.js 24.15 or newer and the npm version declared in `package.json`.

```bash
npm install --global npm@12.2.0
npm install
npm run check
npm test
npm run test:coverage
npm run build
```

Run `npm pack --dry-run` before changing package metadata or published files. Run the CLI from source with `npm run dev -- <url>`.

The `allowScripts` policy in `package.json` permits the esbuild and fsevents install scripts required by development
tooling. npm 12 blocks unapproved dependency install scripts by default.

## Quality standards

- Keep changes focused and add tests for behavior changes.
- Place each `*.test.ts` beside the module it exercises.
- Vite+ (`vp`) runs formatting (Oxfmt), type-aware linting (Oxlint), tests (Vitest), and the package build (tsdown). Configure them in `vite.config.ts`.
- Do not hand-format around `vp fmt`. TypeScript strict mode runs as a separate correctness check.
- Document exported declarations and meaningful internal helpers with concise multiline JSDoc. Describe behavior and invariants rather than repeating TypeScript types.
- Keep network tests deterministic. Use a local server or explicit fixtures instead of depending on a public website.
- Do not commit downloaded documentation, coverage output, build output, or package tarballs.

Before opening a pull request, run:

```bash
npm run check
npm run test:coverage
npm run build
npm pack --dry-run
```

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/) with a concise, imperative subject:

```text
<type>[optional scope]: <description>
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, and `chore`.

Maintainers create releases through the GitHub Actions release workflow. It updates the npm version, creates a `v<version>` tag and GitHub release, then dispatches the npm trusted-publishing workflow from that exact tag.

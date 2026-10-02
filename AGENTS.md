# docsdown

docsdown is a Node.js CLI that archives a documentation website subtree or GitHub repository scope as local Markdown and media. The website provider prefers native Markdown responses and falls back to HTML conversion; the GitHub provider mirrors repository Markdown and referenced assets. Both rewrite links and write `manifest.json` as the archive index.

## Validation

Run `npm run check`, `npm run test:coverage`, and `npm run build` before committing. Vite+ (`vp`) owns formatting, linting, tests, and builds; its Oxfmt, Oxlint, Vitest, and tsdown settings live in `vite.config.ts`. Do not introduce Biome, ESLint, Prettier, or standalone tool configuration alongside it.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>[optional scope]: <description>
```

Keep the description concise and imperative.

# docsdown

docsdown is a Node.js CLI that archives a documentation website subtree or GitHub repository scope as local Markdown and media. The website provider prefers native Markdown responses and falls back to HTML conversion; the GitHub provider mirrors repository Markdown and referenced assets. Both rewrite links and write `manifest.json` as the archive index.

## Validation

Run `npm run check`, `npm run test:coverage`, and `npm run build` before committing. Oxfmt owns formatting and Oxlint owns linting. Do not introduce Biome, ESLint, or Prettier configuration alongside them.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>[optional scope]: <description>
```

Keep the description concise and imperative.

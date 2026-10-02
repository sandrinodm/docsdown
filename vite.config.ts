import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/cli.ts'],
    format: 'esm',
    platform: 'node',
    dts: false,
    fixedExtension: false,
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
  fmt: {
    ignorePatterns: ['coverage', 'dist', 'downloaded-docs', 'src/html-to-markdown-PROTOTYPE.html'],
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: true,
    trailingComma: 'es5',
    sortImports: false,
    sortPackageJson: false,
    proseWrap: 'preserve',
  },
  lint: {
    categories: {
      correctness: 'error',
    },
    plugins: ['oxc', 'typescript', 'unicorn'],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: 'error',
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'eslint/no-unused-vars': 'error',
      'typescript/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      'typescript/no-non-null-assertion': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: [
      {
        files: ['src/**/*.test.ts'],
        rules: {
          'typescript/no-non-null-assertion': 'off',
        },
      },
    ],
    ignorePatterns: ['coverage/**', 'dist/**', 'downloaded-docs/**', 'src/html-to-markdown-PROTOTYPE.html'],
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
});

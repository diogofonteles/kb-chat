import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import boundaries from 'eslint-plugin-boundaries';
import prettierConfig from 'eslint-config-prettier';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/.angular/**',
    '.nx/**',
    '**/test-results/**',
    '**/playwright-report/**',
  ]),
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strict,
      tseslint.configs.stylistic,
    ],
    rules: {
      // Size limits from the harness standard (TS-11, TS-12, TS-13).
      'max-lines-per-function': [
        'error',
        { max: 30, skipBlankLines: true, skipComments: true },
      ],
      'max-params': ['error', 3],
      'max-depth': ['error', 2],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'SwitchStatement',
          message: 'Prefer object maps or if/else over switch (TS-13).',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  {
    files: ['apps/web/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      // An Angular component is a decorated class; the root shell legitimately has no members.
      '@typescript-eslint/no-extraneous-class': [
        'error',
        { allowWithDecorator: true },
      ],
    },
  },
  {
    files: ['apps/web/**/*.html'],
    extends: [
      angular.configs.templateRecommended,
      angular.configs.templateAccessibility,
    ],
  },
  {
    // docs/architecture/overview.md: modules talk through their barrel; modules never
    // import adapters (only the composition root wires them).
    files: ['apps/api/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': import.meta.dirname,
      'boundaries/elements': [
        {
          type: 'module',
          pattern: ['apps/api/src/modules/*'],
          capture: ['moduleName'],
        },
        { type: 'adapter', pattern: ['apps/api/src/adapters/*'] },
      ],
      'import/resolver': {
        typescript: {
          project: [
            `${import.meta.dirname}/apps/api/tsconfig.json`,
            `${import.meta.dirname}/libs/contracts/tsconfig.json`,
          ],
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              to: {
                element: { type: 'module', fileInternalPath: '!index.{ts,js}' },
              },
              disallow: { from: { element: { type: 'module' } } },
              message:
                'Import another module through its barrel (index.ts), never its internals.',
            },
            {
              to: { element: { type: 'adapter' } },
              disallow: { from: { element: { type: 'module' } } },
              message:
                'Modules depend on ports; only the composition root imports adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'e2e/**/*.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
  prettierConfig,
);

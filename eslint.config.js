import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Allowed package dependency direction (implementation plan §2). A package may import only the
 * packages listed for it; anything else is an architecture violation. Add new packages here.
 */
const PACKAGE_LAYERS = {
  'core-types': [],
  metrics: [],
  'assets-runtime': [],
  formats: ['core-types'],
  nav: ['core-types', 'formats'],
  buildings: ['core-types', 'formats', 'nav'],
  render: ['core-types', 'metrics', 'assets-runtime'],
  sim: ['core-types', 'formats', 'nav'],
  'sim-worker': ['core-types', 'formats', 'nav', 'sim', 'buildings'],
  traffic: ['formats'],
  city: [
    'core-types',
    'formats',
    'nav',
    'metrics',
    'assets-runtime',
    'render',
    'sim',
    'sim-worker',
    'buildings',
    'traffic',
  ],
  'sim-bench': ['core-types', 'formats', 'nav', 'sim', 'buildings'],
  'bench-runner': [],
  'osm-pipeline': ['core-types', 'formats', 'nav'],
  'auto-rig': [],
};

const PACKAGE_DIRS = {
  'core-types': 'packages/core-types',
  metrics: 'packages/metrics',
  'assets-runtime': 'packages/assets-runtime',
  formats: 'packages/formats',
  nav: 'packages/nav',
  buildings: 'packages/buildings',
  render: 'packages/render',
  sim: 'packages/sim',
  'sim-worker': 'packages/sim-worker',
  traffic: 'packages/traffic',
  'sim-bench': 'tools/sim-bench',
  'bench-runner': 'tools/bench-runner',
  'osm-pipeline': 'tools/osm-pipeline',
  'auto-rig': 'tools/auto-rig',
  city: 'apps/city',
};

export default defineConfig(
  globalIgnores([
    '**/dist',
    '**/.tsbuild',
    '.yarn',
    'data',
    '.vercel',
    'apps/city/public/draco',
    'apps/city/public/basis',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Numbers in template literals are routine in labels, metrics and error messages.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },

  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['apps/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },

  {
    files: ['packages/**/*.ts', 'apps/**/*.{ts,tsx}', 'tools/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json', 'tools/*/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        },
      },
      'boundaries/elements': Object.entries(PACKAGE_DIRS).map(([type, pattern]) => ({
        type,
        pattern,
      })),
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: Object.entries(PACKAGE_LAYERS)
            .filter(([, allowed]) => allowed.length > 0)
            .map(([type, allowed]) => ({
              from: { element: { type } },
              allow: { to: { element: { types: { anyOf: allowed } } } },
            })),
        },
      ],
    },
  },

  prettier,
);

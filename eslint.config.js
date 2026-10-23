import { readdirSync } from 'node:fs';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Every eslint-rules/*.js registers itself: it exports the rule as default and the
// globs it applies to as `files`. Adding a rule needs no edit here.
const ruleFiles = readdirSync(new URL('./eslint-rules/', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .sort();

const localRules = await Promise.all(
  ruleFiles.map(async (file) => {
    const mod = await import(`./eslint-rules/${file}`);
    const name = file.replace(/\.js$/, '');
    if (!Array.isArray(mod.files) || mod.files.length === 0) {
      throw new Error(`eslint-rules/${file} must export a non-empty files array`);
    }
    return { name, rule: mod.default, files: mod.files };
  }),
);
const local = { rules: Object.fromEntries(localRules.map((r) => [r.name, r.rule])) };

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'eslint-rules/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Globals are checked by tsc; the isomorphism rule decides which ones shared code may use.
      'no-undef': 'off',
    },
  },
  { plugins: { local } },
  ...localRules.map((r) => ({ files: r.files, rules: { [`local/${r.name}`]: 'error' } })),
  // eval and the Function constructor run code neither local rule can see, so shared code
  // may not evaluate strings at all. no-implied-eval checks setTimeout and setInterval only
  // when they are declared globals, and the TypeScript scope declares the ES lib alone.
  {
    files: localRules.find((r) => r.name === 'isomorphic-imports').files,
    languageOptions: { globals: { setTimeout: 'readonly', setInterval: 'readonly' } },
    rules: { 'no-eval': 'error', 'no-new-func': 'error', 'no-implied-eval': 'error' },
  },
);

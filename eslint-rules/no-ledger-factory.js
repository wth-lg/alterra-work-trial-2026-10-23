// createLedger meters through whatever store it is given, and admitStore makes that store's
// grants pass assertGrant. Only an environment adapter, which owns the env that chose the
// store, may call them: cli/adapters/** in Node and apps/web/src/adapters/** in the browser.
// Tests build in-memory ledgers too. Anywhere else, importing either is an error.

import { dirname, relative, resolve, sep } from 'node:path';

export const files = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'];

const LEDGER = 'packages/core/ledger';
const FACTORY = new Set(['admitStore', 'createLedger']);
const ALLOWED = [/^cli\/adapters\//, /^apps\/web\/src\/adapters\//, /\.test\.ts$/, /(^|\/)test\//, /^packages\/core\/ledger\.ts$/];

const posix = (p) => p.split(sep).join('/');

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only environment adapters and tests import createLedger and admitStore' },
    schema: [],
    messages: {
      factory:
        "'{{name}}' builds or admits a ledger store; only cli/adapters/** and apps/web/src/adapters/** may. Open the ledger through the adapter (openNodeLedger in Node).",
    },
  },
  create(context) {
    const file = posix(relative(context.cwd, context.physicalFilename));
    if (ALLOWED.some((re) => re.test(file))) return {};
    const fromLedger = (source) =>
      typeof source?.value === 'string' &&
      source.value.startsWith('.') &&
      posix(relative(context.cwd, resolve(dirname(context.physicalFilename), source.value))).replace(/\.[cm]?[jt]sx?$/, '') === LEDGER;
    const nameOf = (n) => (n?.type === 'Identifier' ? n.name : n?.type === 'Literal' ? String(n.value) : undefined);
    const report = (node, name) => context.report({ node, messageId: 'factory', data: { name } });
    const namespaces = new Set();
    return {
      ImportDeclaration(node) {
        if (!fromLedger(node.source)) return;
        for (const s of node.specifiers) {
          if (s.type === 'ImportNamespaceSpecifier') namespaces.add(s.local.name);
          else if (s.type === 'ImportSpecifier' && FACTORY.has(nameOf(s.imported))) report(s, nameOf(s.imported));
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !fromLedger(node.source)) return;
        for (const s of node.specifiers) if (FACTORY.has(nameOf(s.local))) report(s, nameOf(s.local));
      },
      ExportAllDeclaration(node) {
        if (fromLedger(node.source)) report(node, '*');
      },
      ImportExpression(node) {
        if (fromLedger(node.source)) report(node, 'import()');
      },
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && namespaces.has(node.object.name) && FACTORY.has(nameOf(node.property))) report(node, nameOf(node.property));
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init?.type !== 'Identifier' || !namespaces.has(node.init.name)) return;
        for (const p of node.id.properties) if (p.type === 'Property' && FACTORY.has(nameOf(p.key))) report(p, nameOf(p.key));
      },
    };
  },
};

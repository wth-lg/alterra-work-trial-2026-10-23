// createLedger meters through whatever store it is given, and admitStore makes that store's
// grants pass assertGrant. Only an environment adapter, which owns the env that chose the
// store, may call them: cli/adapters/** in Node and apps/web/src/adapters/** in the browser.
// Test files (*.test.ts) build in-memory ledgers too. Anywhere else, importing either is an
// error, by name, through a namespace or by import(). Nothing but ledger.ts may re-export
// them, adapters and tests included, so neither can be laundered to a file this rule forbids.

import { dirname, relative, resolve, sep } from 'node:path';

// Every file ESLint parses as code: .ts, .tsx, .mts, .cts, .js, .jsx, .mjs and .cjs.
export const files = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

const LEDGER = 'packages/core/ledger';
const FACTORY = new Set(['admitStore', 'createLedger']);
const ALLOWED = [/^cli\/adapters\//, /^apps\/web\/src\/adapters\//, /\.test\.ts$/];

const posix = (p) => p.split(sep).join('/');

// The string an import source names: a literal or an expression-free template.
const sourceText = (source) =>
  source?.type === 'Literal' ? source.value : source?.type === 'TemplateLiteral' && source.expressions.length === 0 ? source.quasis[0].value.cooked : undefined;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only environment adapters and tests import createLedger and admitStore; only ledger.ts exports them' },
    schema: [],
    messages: {
      factory:
        "'{{name}}' builds or admits a ledger store; only cli/adapters/** and apps/web/src/adapters/** may. Open the ledger through the adapter (openNodeLedger in Node).",
      reexport: "Re-exporting '{{name}}' hands the ledger factory to files no-ledger-factory forbids. Import it from packages/core/ledger.ts where it is used.",
    },
  },
  create(context) {
    const file = posix(relative(context.cwd, context.physicalFilename));
    if (file === `${LEDGER}.ts`) return {};
    const allowed = ALLOWED.some((re) => re.test(file));
    const fromLedger = (source) => {
      const text = sourceText(source);
      return typeof text === 'string' && text.startsWith('.') && posix(relative(context.cwd, resolve(dirname(context.physicalFilename), text))).replace(/\.[cm]?[jt]sx?$/, '') === LEDGER;
    };
    const nameOf = (n) => (n?.type === 'Identifier' ? n.name : n?.type === 'Literal' ? String(n.value) : undefined);
    const report = (node, name) => !allowed && context.report({ node, messageId: 'factory', data: { name } });
    const reexport = (node, name) => context.report({ node, messageId: 'reexport', data: { name } });
    const namespaces = new Set();
    // Local names bound to a factory import: import { createLedger as c } binds c.
    const bound = new Map();
    return {
      ImportDeclaration(node) {
        if (!fromLedger(node.source)) return;
        for (const s of node.specifiers) {
          if (s.type === 'ImportNamespaceSpecifier') namespaces.add(s.local.name);
          else if (s.type === 'ImportSpecifier' && FACTORY.has(nameOf(s.imported))) {
            bound.set(s.local.name, nameOf(s.imported));
            report(s, nameOf(s.imported));
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && fromLedger(node.source)) {
          for (const s of node.specifiers) if (FACTORY.has(nameOf(s.local))) reexport(s, nameOf(s.local));
        } else if (!node.source) {
          for (const s of node.specifiers) if (bound.has(nameOf(s.local))) reexport(s, bound.get(nameOf(s.local)));
        }
      },
      ExportDefaultDeclaration(node) {
        if (node.declaration.type === 'Identifier' && bound.has(node.declaration.name)) reexport(node, bound.get(node.declaration.name));
      },
      ExportAllDeclaration(node) {
        if (fromLedger(node.source)) reexport(node, '*');
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

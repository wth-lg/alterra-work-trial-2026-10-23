// A BatchGrant is a runtime capability: only batchStart in packages/core/ledger.ts mints one,
// and assertGrant rejects any other object. A type assertion to BatchGrant, or an object
// literal annotated as one, is how code would pretend otherwise, so outside ledger.ts both
// are errors, including through a local type alias of BatchGrant and through an indexed access
// type whose key is 'grant' (ClientOptions['grant']), the field every grant-taking options type
// uses. packages/core/test/anthropic.test.ts forges grants on purpose to prove the client
// constructor throws, and is the one test file exempt by name.

import { relative, sep } from 'node:path';

// Every file ESLint parses as code: .ts, .tsx, .mts, .cts, .js, .mjs and .cjs.
export const files = ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'];

const EXEMPT = new Set(['packages/core/ledger.ts', 'packages/core/test/anthropic.test.ts']);
const ASSERTIONS = new Set(['TSAsExpression', 'TSTypeAssertion']);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Ban forging a BatchGrant by type assertion or annotated literal' },
    schema: [],
    messages: {
      cast: 'A type assertion to BatchGrant forges a grant, and assertGrant rejects it at runtime. Get the grant from ledger.batchStart(projection).',
      literal: 'An object built and typed as BatchGrant is not a grant: assertGrant rejects it. Get the grant from ledger.batchStart(projection).',
    },
  },
  create(context) {
    if (EXEMPT.has(relative(context.cwd, context.physicalFilename).split(sep).join('/'))) return {};
    const names = new Set(['BatchGrant']);
    // Whether a type node names BatchGrant anywhere: BatchGrant[], Readonly<BatchGrant>, L.BatchGrant,
    // an alias of it, or X['grant'].
    const mentions = (t) => {
      if (!t || typeof t !== 'object') return false;
      if (t.type === 'TSTypeReference') {
        const n = t.typeName;
        if ((n.type === 'Identifier' && names.has(n.name)) || (n.type === 'TSQualifiedName' && n.right.name === 'BatchGrant')) return true;
      }
      if (t.type === 'TSIndexedAccessType' && t.indexType.type === 'TSLiteralType' && t.indexType.literal.value === 'grant') return true;
      return Object.entries(t).some(([k, v]) => k !== 'parent' && (Array.isArray(v) ? v.some(mentions) : v && typeof v.type === 'string' && mentions(v)));
    };
    // Every type alias in the file, so an alias of an alias declared after its use is found too.
    const aliases = [];
    const collect = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'TSTypeAliasDeclaration') aliases.push(n);
      for (const [k, v] of Object.entries(n)) {
        if (k === 'parent') continue;
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v.type === 'string') collect(v);
      }
    };
    const unwrap = (e) => (e?.type === 'TSSatisfiesExpression' || e?.type === 'TSNonNullExpression' ? unwrap(e.expression) : e);
    const built = (e) => {
      const x = unwrap(e);
      return x !== undefined && x !== null && (x.type === 'ObjectExpression' || ASSERTIONS.has(x.type));
    };
    const fnReturnsGrant = (fn) => fn && mentions(fn.returnType?.typeAnnotation);
    return {
      Program(node) {
        for (const d of node.body) {
          if (d.type !== 'ImportDeclaration') continue;
          for (const sp of d.specifiers) if (sp.type === 'ImportSpecifier' && (sp.imported.name ?? sp.imported.value) === 'BatchGrant') names.add(sp.local.name);
        }
        collect(node);
        for (let grew = true; grew; ) {
          grew = false;
          for (const a of aliases) {
            if (!names.has(a.id.name) && mentions(a.typeAnnotation)) {
              names.add(a.id.name);
              grew = true;
            }
          }
        }
      },
      ImportSpecifier(node) {
        const imported = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
        if (imported === 'BatchGrant') names.add(node.local.name);
      },
      TSAsExpression(node) {
        if (mentions(node.typeAnnotation)) context.report({ node, messageId: 'cast' });
      },
      TSTypeAssertion(node) {
        if (mentions(node.typeAnnotation)) context.report({ node, messageId: 'cast' });
      },
      VariableDeclarator(node) {
        if (mentions(node.id.typeAnnotation?.typeAnnotation) && built(node.init) && !mentions(unwrap(node.init).typeAnnotation)) {
          context.report({ node, messageId: 'literal' });
        }
      },
      ArrowFunctionExpression(node) {
        if (fnReturnsGrant(node) && node.body.type !== 'BlockStatement' && built(node.body)) context.report({ node, messageId: 'literal' });
      },
      ReturnStatement(node) {
        let fn = node.parent;
        while (fn && !/Function/.test(fn.type)) fn = fn.parent;
        if (fnReturnsGrant(fn) && built(node.argument)) context.report({ node, messageId: 'literal' });
      },
    };
  },
};

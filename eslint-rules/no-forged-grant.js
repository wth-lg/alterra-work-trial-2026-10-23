// A BatchGrant is a runtime capability: only batchStart in packages/core/ledger.ts mints one,
// and assertGrant rejects any other object. A type assertion to BatchGrant, or an object
// literal annotated as one, is how code would pretend otherwise, so outside ledger.ts both
// are errors. packages/core/test/anthropic.test.ts forges grants on purpose to prove the
// client constructor throws, and is the one test file exempt by name.

import { relative, sep } from 'node:path';

export const files = ['**/*.ts', '**/*.tsx'];

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
    // Whether a type node names BatchGrant anywhere: BatchGrant[], Readonly<BatchGrant>, L.BatchGrant.
    const mentions = (t) => {
      if (!t || typeof t !== 'object') return false;
      if (t.type === 'TSTypeReference') {
        const n = t.typeName;
        if ((n.type === 'Identifier' && names.has(n.name)) || (n.type === 'TSQualifiedName' && n.right.name === 'BatchGrant')) return true;
      }
      return Object.entries(t).some(([k, v]) => k !== 'parent' && (Array.isArray(v) ? v.some(mentions) : v && typeof v.type === 'string' && mentions(v)));
    };
    const unwrap = (e) => (e?.type === 'TSSatisfiesExpression' || e?.type === 'TSNonNullExpression' ? unwrap(e.expression) : e);
    const built = (e) => {
      const x = unwrap(e);
      return x !== undefined && x !== null && (x.type === 'ObjectExpression' || ASSERTIONS.has(x.type));
    };
    const fnReturnsGrant = (fn) => fn && mentions(fn.returnType?.typeAnnotation);
    return {
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

// policy.ts derives the expected end state by applying the task's policy to the initial world;
// expected.ts writes it by hand; the matrix's double derivation fails when they differ (design
// section 4, "Double derivation"). That check means something only while the two are derived
// independently, so policy.ts may not import expected.ts or an overlay module (the constants the
// task's fixture overlay plants), whether by import, re-export or dynamic import. Type-only
// imports carry no values and are allowed.
export const files = ['tasks/**/policy.ts'];

const BANNED = /^(expected|overlay)(\.[cm]?[jt]sx?)?$/;

const basename = (source) => source.split('?')[0].split('/').pop();

function staticSource(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'policy.ts does not import expected.ts or overlay constants' },
    schema: [],
    messages: {
      banned: "policy.ts must not import '{{source}}': derive it from the initial world, so the double derivation can disagree with expected.ts",
    },
  },
  create(context) {
    const check = (node, source) => {
      if (source !== null && BANNED.test(basename(source))) context.report({ node, messageId: 'banned', data: { source } });
    };
    return {
      ImportDeclaration(node) {
        if (node.importKind !== 'type') check(node, staticSource(node.source));
      },
      ExportNamedDeclaration(node) {
        if (node.source && node.exportKind !== 'type') check(node, staticSource(node.source));
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type') check(node, staticSource(node.source));
      },
      ImportExpression(node) {
        check(node, staticSource(node.source));
      },
    };
  },
};

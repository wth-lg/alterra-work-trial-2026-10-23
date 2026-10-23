// Only packages/core/anthropic.ts talks to the Messages API: it pins the version, the model
// and the request rules, and meters every call through a BatchGrant. It exports no URL,
// header or body builder, so code elsewhere that wants to reach the API has to name the host
// itself, and anywhere else a string naming the API host (so any fetch to it) is an error,
// whether written as one literal, a template or a concatenation of literals. The CSP metas in
// apps/web/*.html list the host too; ESLint does not lint .html.

import { relative, sep } from 'node:path';

// Every file ESLint parses as code: .ts, .tsx, .mts, .cts, .js, .mjs and .cjs.
export const files = ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'];

// Built, not written, so this file holds no literal the rule would flag.
const HOST = ['api', 'anthropic', 'com'].join('.');
const CLIENT = 'packages/core/anthropic.ts';

const posix = (p) => p.split(sep).join('/');

// The text of a string literal, an expression-free template, or a + chain of them; else undefined.
function staticText(node) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0 ? node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('') : undefined;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = staticText(node.left);
    const r = staticText(node.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  return undefined;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only packages/core/anthropic.ts names the Anthropic API host' },
    schema: [],
    messages: {
      host: "'{{text}}' names the Anthropic API host. Send through MessagesClient from packages/core/anthropic.ts, the only metered way to call the API.",
    },
  },
  create(context) {
    if (posix(relative(context.cwd, context.physicalFilename)) === CLIENT) return {};
    const checkText = (node, text) => {
      if (text === undefined || !text.toLowerCase().includes(HOST)) return;
      context.report({ node, messageId: 'host', data: { text: text.length > 60 ? `${text.slice(0, 57)}...` : text } });
    };
    const quasis = (node) => node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
    // Inside a + chain only the whole chain is checked, so a split host is caught once.
    const inChain = (node) => node.parent?.type === 'BinaryExpression' && node.parent.operator === '+';
    const leaves = (node) => (node.type === 'BinaryExpression' && node.operator === '+' ? [...leaves(node.left), ...leaves(node.right)] : [node]);
    return {
      Literal(node) {
        if (typeof node.value === 'string' && !inChain(node)) checkText(node, node.value);
      },
      TemplateLiteral(node) {
        if (!inChain(node)) checkText(node, quasis(node));
      },
      BinaryExpression(node) {
        if (node.operator !== '+' || inChain(node)) return;
        const whole = staticText(node);
        if (whole !== undefined) return checkText(node, whole);
        // A chain with a non-literal part: check each literal part on its own.
        for (const leaf of leaves(node)) {
          if (leaf.type === 'Literal' && typeof leaf.value === 'string') checkText(leaf, leaf.value);
          else if (leaf.type === 'TemplateLiteral') checkText(leaf, quasis(leaf));
        }
      },
    };
  },
};

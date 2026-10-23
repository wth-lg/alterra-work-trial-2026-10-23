// Only packages/core/anthropic.ts talks to the Messages API: it pins the version, the model
// and the request rules, and meters every call through a BatchGrant. Anywhere else, a string
// naming the API host (so any fetch to it) is an error, and so is importing probeOnce, the
// one unmetered send, outside the probe page whose Node spec meters it, and tests.
// A Content-Security-Policy string that lists the host in connect-src is not a request.

import { dirname, relative, resolve, sep } from 'node:path';

export const files = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'];

// Built, not written, so this file holds no literal the rule would flag.
const HOST = ['api', 'anthropic', 'com'].join('.');
const CLIENT = 'packages/core/anthropic';
const PROBE_ALLOWED = [/^apps\/web\/src\/probe\//, /\.test\.ts$/];

const posix = (p) => p.split(sep).join('/');

// The repo path an import source names, without its extension.
function target(context, source) {
  if (typeof source !== 'string' || !source.startsWith('.')) return undefined;
  return posix(relative(context.cwd, resolve(dirname(context.physicalFilename), source))).replace(/\.[cm]?[jt]sx?$/, '');
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only packages/core/anthropic.ts names the Anthropic API host or sends unmetered' },
    schema: [],
    messages: {
      host: "'{{text}}' names the Anthropic API host. Send through MessagesClient from packages/core/anthropic.ts (import API_ORIGIN for a URL check).",
      probe: 'probeOnce sends without a BatchGrant; only apps/web/src/probe/** (metered by its Node spec) and tests may import it. Use MessagesClient.',
    },
  },
  create(context) {
    const file = posix(relative(context.cwd, context.physicalFilename));
    if (file === `${CLIENT}.ts`) return {};
    const probeAllowed = PROBE_ALLOWED.some((re) => re.test(file));
    const checkText = (node, text) => {
      if (!text.toLowerCase().includes(HOST) || /connect-src/.test(text)) return;
      context.report({ node, messageId: 'host', data: { text: text.length > 60 ? `${text.slice(0, 57)}...` : text } });
    };
    const namespaces = new Set();
    const fromClient = (node) => target(context, node.source?.value) === CLIENT;
    const nameOf = (n) => (n?.type === 'Identifier' ? n.name : n?.type === 'Literal' ? String(n.value) : undefined);
    const reportProbe = (node) => !probeAllowed && context.report({ node, messageId: 'probe' });
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      TemplateLiteral(node) {
        checkText(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(''));
      },
      ImportDeclaration(node) {
        if (!fromClient(node)) return;
        for (const s of node.specifiers) {
          if (s.type === 'ImportNamespaceSpecifier') namespaces.add(s.local.name);
          else if (s.type === 'ImportSpecifier' && nameOf(s.imported) === 'probeOnce') reportProbe(s);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && fromClient(node) && node.specifiers.some((s) => nameOf(s.local) === 'probeOnce')) reportProbe(node);
      },
      ExportAllDeclaration(node) {
        if (fromClient(node)) reportProbe(node);
      },
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && namespaces.has(node.object.name) && nameOf(node.property) === 'probeOnce') reportProbe(node);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init?.type !== 'Identifier' || !namespaces.has(node.init.name)) return;
        if (node.id.properties.some((p) => p.type === 'Property' && nameOf(p.key) === 'probeOnce')) reportProbe(node);
      },
    };
  },
};

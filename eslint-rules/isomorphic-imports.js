// Isomorphism rule (design section 1): code that runs in both the browser Worker and Node
// must not import Node-only modules, or touch process or DOM globals, including through
// globalThis, window, self or global. IO goes through the ResultSink and FixtureSource
// adapters that only cli/ and apps/web pick.

import { builtinModules } from 'node:module';
import { destructuredKeys, GLOBAL_OBJECTS, globalUses, inType, propertyName } from './lib/globals.js';

export const files = ['packages/env/**', 'packages/core/**', 'packages/grader/**', 'tasks/**'];

// Every builtin of the Node running ESLint, so a module added in a later release is banned
// without an edit here. Entries such as node:test exist only in the node: form.
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

// Any node: specifier names a builtin. A bare one is banned when it, or its first path
// segment, is a builtin: fs, fs/promises, timers/promises.
function isBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
}

const NODE_GLOBALS = new Set([
  'process',
  'global',
  'Buffer',
  'setImmediate',
  'clearImmediate',
  '__dirname',
  '__filename',
  'require',
]);
const BANNED_GLOBALS = new Set([
  ...NODE_GLOBALS,
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'HTMLElement',
  'XMLHttpRequest',
  'MutationObserver',
  'requestAnimationFrame',
]);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Ban Node-only modules, process and DOM APIs in code shared by the browser and Node' },
    schema: [],
    messages: {
      module: "'{{name}}' is not available in both runtimes. Take IO through the ResultSink or FixtureSource adapter instead.",
      global: "'{{name}}' is a {{kind}} global. Shared code must not touch it; pass the value in from cli/ or apps/web.",
      globalObject:
        "'{{name}}' is used as a value, which hides which globals are read from this rule. Access its members by static name.",
    },
  },
  create(context) {
    // Static specifiers only: 'fs' or `fs`. A computed import() source is left to review.
    function checkSpecifier(source) {
      const name =
        source?.type === 'Literal' && typeof source.value === 'string'
          ? source.value
          : source?.type === 'TemplateLiteral' && source.expressions.length === 0
            ? source.quasis[0].value.cooked
            : undefined;
      if (name !== undefined && isBuiltin(name)) context.report({ node: source, messageId: 'module', data: { name } });
    }
    const checkSource = (node) => checkSpecifier(node.source);
    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkSource,
      // import fs = require('fs')
      TSExternalModuleReference: (node) => checkSpecifier(node.expression),
      'Program:exit'(program) {
        const report = (node, name) =>
          context.report({ node, messageId: 'global', data: { name, kind: NODE_GLOBALS.has(name) ? 'Node' : 'DOM' } });
        for (const { names, node, identifier } of globalUses(context, program)) {
          const banned = names.find((n) => BANNED_GLOBALS.has(n));
          if (banned) {
            report(identifier, banned);
            continue;
          }
          // What is left is a global object reached by itself, e.g. `self` or `globalThis`.
          const name = names.at(-1);
          if (!GLOBAL_OBJECTS.has(name) || inType(node)) continue;
          const parent = node.parent;
          if (parent.type === 'MemberExpression' && parent.object === node && propertyName(parent) !== undefined) continue;
          const keys = destructuredKeys(node);
          const hit = keys?.find((k) => k !== undefined && BANNED_GLOBALS.has(k));
          if (hit) report(identifier, hit);
          else if (!keys || keys.includes(undefined)) context.report({ node, messageId: 'globalObject', data: { name } });
        }
      },
    };
  },
};

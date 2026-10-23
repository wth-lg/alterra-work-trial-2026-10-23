// Isomorphism rule (design section 1): code that runs in both the browser Worker and Node
// must not import fs or process, or touch process or DOM globals. IO goes through the
// ResultSink and FixtureSource adapters that only cli/ and apps/web pick.

export const files = ['packages/env/**', 'packages/core/**', 'packages/grader/**', 'tasks/**'];

const BANNED_MODULE = /^(node:)?(fs|process)(\/.*)?$/;

const BANNED_GLOBALS = new Set([
  'process',
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
    docs: { description: 'Ban fs, process and DOM APIs in code shared by the browser and Node' },
    schema: [],
    messages: {
      module: "'{{name}}' is not available in both runtimes. Take IO through the ResultSink or FixtureSource adapter instead.",
      global: "'{{name}}' is a {{kind}} global. Shared code must not touch it; pass the value in from cli/ or apps/web.",
    },
  },
  create(context) {
    function checkSource(node) {
      const source = node.source;
      if (source && source.type === 'Literal' && typeof source.value === 'string' && BANNED_MODULE.test(source.value)) {
        context.report({ node: source, messageId: 'module', data: { name: source.value } });
      }
    }
    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkSource,
      'Program:exit'(program) {
        const scope = context.sourceCode.getScope(program);
        for (const ref of scope.through) {
          const name = ref.identifier.name;
          if (BANNED_GLOBALS.has(name)) {
            const kind = name === 'process' ? 'Node' : 'DOM';
            context.report({ node: ref.identifier, messageId: 'global', data: { name, kind } });
          }
        }
      },
    };
  },
};

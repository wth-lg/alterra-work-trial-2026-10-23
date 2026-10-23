// Determinism rule (design section 2): the environment, the loop and the grader read time
// only from the pinned clock and never draw randomness, so a trial replays byte for byte.

import { destructuredKeys, globalUses, inType, propertyName } from './lib/globals.js';

export const files = ['packages/env/**', 'packages/core/loop.ts', 'packages/grader/**', 'tasks/**'];

// Global -> members that read the clock or draw randomness, with the message for each.
const BANNED = {
  Date: { members: new Set(['now']), messageId: 'dateNow' },
  Math: { members: new Set(['random']), messageId: 'random' },
  performance: { members: new Set(['now']), messageId: 'performanceNow' },
  crypto: { members: new Set(['getRandomValues', 'randomUUID']), messageId: 'cryptoRandom' },
};

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Ban wall-clock reads and randomness in deterministic code' },
    schema: [],
    messages: {
      dateNow: 'Date.now() reads the wall clock. Read time from the pinned clock passed in.',
      newDate: 'new Date() with no argument reads the wall clock. Pass an explicit instant from the pinned clock.',
      dateCall: 'Date() called as a function returns the wall-clock time. Read time from the pinned clock passed in.',
      random: 'Math.random() is not replayable. Derive values from the task seed or the tool-call log.',
      performanceNow: 'performance.now() reads a clock. Read time from the pinned clock passed in.',
      cryptoRandom: 'crypto randomness is not replayable. Derive values from the task seed or the tool-call log.',
      computed: '{{name}}[...] with a computed key can reach a clock or randomness. Use a static member name.',
      alias:
        '{{name}} is used as a value, which hides a later clock or randomness read from this rule. Call its members directly.',
    },
  },
  create(context) {
    return {
      'Program:exit'(program) {
        for (const { names, node } of globalUses(context, program)) {
          const name = names.at(-1);
          const banned = Object.hasOwn(BANNED, name) ? BANNED[name] : undefined;
          if (!banned || inType(node)) continue;
          const parent = node.parent;
          if (parent.type === 'MemberExpression' && parent.object === node) {
            const member = propertyName(parent);
            if (member === undefined) context.report({ node: parent, messageId: 'computed', data: { name } });
            else if (banned.members.has(member)) context.report({ node: parent, messageId: banned.messageId });
            continue;
          }
          if (name === 'Date' && parent.type === 'NewExpression' && parent.callee === node) {
            if (parent.arguments.length === 0) context.report({ node: parent, messageId: 'newDate' });
            continue;
          }
          if (name === 'Date' && parent.type === 'CallExpression' && parent.callee === node) {
            context.report({ node: parent, messageId: 'dateCall' });
            continue;
          }
          if (parent.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === node) continue;
          const keys = destructuredKeys(node);
          if (keys && keys.every((k) => k !== undefined && !banned.members.has(k))) continue;
          context.report({ node, messageId: 'alias', data: { name } });
        }
      },
    };
  },
};

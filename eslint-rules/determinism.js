// Determinism rule (design section 2): the environment, the loop and the grader read time
// only from the pinned clock and never draw randomness, so a trial replays byte for byte.

import { destructuredKeys, globalUses, inType, outer, propertyName } from './lib/globals.js';

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
      newDate:
        'new Date() with no argument, or a spread one, reads the wall clock. Pass an explicit instant from the pinned clock.',
      intlNow:
        'Intl.DateTimeFormat {{method}}() with no date formats the wall-clock time. Pass an explicit instant from the pinned clock.',
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
    const report = (node, messageId, data) => context.report({ node, messageId, data });

    // format() and formatToParts() with no date format Date.now(). Every other use of a
    // formatter is a static method call or hands it on, which hides that call from this rule.
    function checkFormatUse(member) {
      const method = propertyName(member);
      if (method === undefined) return report(member, 'computed', { name: 'Intl.DateTimeFormat' });
      if (method !== 'format' && method !== 'formatToParts') return;
      const callee = outer(member);
      const call = callee.parent;
      if (call.type !== 'CallExpression' || call.callee !== callee) {
        return report(member, 'alias', { name: `Intl.DateTimeFormat ${method}` });
      }
      const [date] = call.arguments;
      if (!date || date.type === 'SpreadElement' || (date.type === 'Identifier' && date.name === 'undefined')) {
        report(call, 'intlNow', { method });
      }
    }

    // formatter is a `new Intl.DateTimeFormat(...)` or `Intl.DateTimeFormat(...)` expression.
    function checkFormatter(formatter) {
      const parent = formatter.parent;
      if (parent.type === 'MemberExpression' && parent.object === formatter) return checkFormatUse(parent);
      if (parent.type === 'VariableDeclarator' && parent.init === formatter && parent.id.type === 'Identifier') {
        for (const ref of context.sourceCode.getDeclaredVariables(parent)[0].references) {
          if (ref.init) continue;
          const use = outer(ref.identifier);
          if (use.parent.type === 'MemberExpression' && use.parent.object === use) checkFormatUse(use.parent);
          else report(use, 'alias', { name: 'An Intl.DateTimeFormat' });
        }
        return;
      }
      report(formatter, 'alias', { name: 'An Intl.DateTimeFormat' });
    }

    // node is the expression for the Intl global.
    function checkIntl(node) {
      const parent = node.parent;
      if (parent.type !== 'MemberExpression' || parent.object !== node) {
        const keys = destructuredKeys(node);
        if (!keys || keys.some((k) => k === undefined || k === 'DateTimeFormat')) report(node, 'alias', { name: 'Intl' });
        return;
      }
      const member = propertyName(parent);
      if (member === undefined) return report(parent, 'computed', { name: 'Intl' });
      if (member !== 'DateTimeFormat') return;
      const ctor = outer(parent);
      const use = ctor.parent;
      if ((use.type === 'NewExpression' || use.type === 'CallExpression') && use.callee === ctor) return checkFormatter(outer(use));
      // Static methods such as supportedLocalesOf read no clock; the prototype reaches format.
      if (use.type === 'MemberExpression' && use.object === ctor && !['prototype', undefined].includes(propertyName(use))) return;
      report(ctor, 'alias', { name: 'Intl.DateTimeFormat' });
    }

    return {
      'Program:exit'(program) {
        for (const { names, node } of globalUses(context, program)) {
          const name = names.at(-1);
          if (name === 'Intl') {
            if (!inType(node)) checkIntl(node);
            continue;
          }
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
            const [first] = parent.arguments;
            if (!first || first.type === 'SpreadElement') context.report({ node: parent, messageId: 'newDate' });
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

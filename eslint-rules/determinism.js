// Determinism rule (design section 2): the environment, the loop and the grader read time
// only from the pinned clock and never draw randomness, so a trial replays byte for byte.

export const files = ['packages/env/**', 'packages/core/loop.ts', 'packages/grader/**', 'tasks/**'];

function isMember(node, object, property) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === object &&
    node.property.type === 'Identifier' &&
    node.property.name === property
  );
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Ban wall-clock reads and Math.random in deterministic code' },
    schema: [],
    messages: {
      dateNow: 'Date.now() reads the wall clock. Read time from the pinned clock passed in.',
      newDate: 'new Date() with no argument reads the wall clock. Pass an explicit instant from the pinned clock.',
      random: 'Math.random() is not replayable. Derive values from the task seed or the tool-call log.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isMember(node.callee, 'Date', 'now')) context.report({ node, messageId: 'dateNow' });
        if (isMember(node.callee, 'Math', 'random')) context.report({ node, messageId: 'random' });
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) {
          context.report({ node, messageId: 'newDate' });
        }
      },
    };
  },
};

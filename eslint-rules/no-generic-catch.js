// No generic catch in the tool layer (plan phase P5). A tool reports the model's faults by
// throwing ToolError; any other exception is an environment bug that must reach the loop as
// INTERNAL and flag the trial ENV_ERROR (packages/env/tools/errors.ts). A catch that can
// finish without rethrowing would turn such a bug into an ordinary result, and the fuzz that
// counts INTERNAL would never see it.
//
// A catch clause in tools/ must bind the error, and every way out of it must be `throw <e>`,
// except inside `if (<e> instanceof ToolError)`, where anything goes, and inside
// `if (<e> instanceof SearchError)`, which must throw a new ToolError (the search module's
// typed input error, converted for the model). Promise .catch() and two-argument .then() are
// banned outright. Tests under a test/ directory are exempt.

export const files = ['packages/env/tools/**'];

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement']);

// The class an `if` test narrows the caught error to, or undefined.
function narrowsTo(test, name) {
  return test.type === 'BinaryExpression' &&
    test.operator === 'instanceof' &&
    test.left.type === 'Identifier' &&
    test.left.name === name &&
    test.right.type === 'Identifier'
    ? test.right.name
    : undefined;
}

const isRethrow = (node, name) => node.type === 'ThrowStatement' && node.argument.type === 'Identifier' && node.argument.name === name;
const isNewToolError = (node) =>
  node.type === 'ThrowStatement' && node.argument.type === 'NewExpression' && node.argument.callee.type === 'Identifier' && node.argument.callee.name === 'ToolError';

// Whether a statement, run last in the catch, always leaves it by rethrowing.
function endsInRethrow(node, name) {
  if (!node) return false;
  if (node.type === 'BlockStatement') return endsInRethrow(node.body.at(-1), name);
  if (node.type === 'IfStatement') {
    const cls = narrowsTo(node.test, name);
    if (cls === 'ToolError') return endsInRethrow(node.alternate, name);
    if (cls === 'SearchError') return endsInToolError(node.consequent) && endsInRethrow(node.alternate, name);
    return endsInRethrow(node.consequent, name) && endsInRethrow(node.alternate, name);
  }
  return isRethrow(node, name);
}
const endsInToolError = (node) => (node.type === 'BlockStatement' ? node.body.length > 0 && endsInToolError(node.body.at(-1)) : isNewToolError(node));

// The first statement that leaves the catch some other way than rethrowing: a return, a
// break or continue out of it, or a throw of something else.
function firstEscape(node, name, inLoop = false) {
  if (!node || typeof node.type !== 'string' || FUNCTIONS.has(node.type)) return undefined;
  switch (node.type) {
    case 'ReturnStatement':
      return node;
    case 'BreakStatement':
    case 'ContinueStatement':
      return inLoop && !node.label ? undefined : node;
    case 'ThrowStatement':
      return isRethrow(node, name) ? undefined : node;
    case 'IfStatement': {
      const cls = narrowsTo(node.test, name);
      if (cls === 'ToolError') return firstEscape(node.alternate, name, inLoop);
      if (cls === 'SearchError') {
        // The branch must end in `throw new ToolError(...)` with no other way out before it.
        const inner = node.consequent.type === 'BlockStatement' ? node.consequent.body : [node.consequent];
        if (!endsInToolError(node.consequent) || inner.slice(0, -1).some((s) => firstEscape(s, name, inLoop))) return node;
        return firstEscape(node.alternate, name, inLoop);
      }
      break;
    }
  }
  const loop = inLoop || LOOPS.has(node.type);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child.type === 'string') {
        const hit = firstEscape(child, name, loop);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Ban catch blocks in the tool layer that can swallow an error instead of rethrowing it' },
    schema: [],
    messages: {
      noBinding:
        'A catch in tools/ must bind the error as a plain name and rethrow it, or narrow it with `instanceof ToolError`. Otherwise an environment bug never surfaces as INTERNAL.',
      escape:
        "This catch can finish without rethrowing '{{name}}'. End it with `throw {{name}};` and handle only the `if ({{name}} instanceof ToolError)` case, so environment bugs surface as INTERNAL.",
      searchError: "Inside `if ({{name}} instanceof SearchError)`, end with `throw new ToolError(...)`: the model's fault becomes a typed error, never a quiet result.",
      promise: 'A promise rejection handler catches every error. In tools/, use try/catch that rethrows unless the error is a ToolError.',
    },
  },
  create(context) {
    if (/[\\/]tools[\\/](?:.*[\\/])?test[\\/]/.test(context.filename)) return {};
    return {
      CatchClause(node) {
        if (!node.param || node.param.type !== 'Identifier') {
          context.report({ node, messageId: 'noBinding' });
          return;
        }
        const name = node.param.name;
        const escape = firstEscape(node.body, name);
        if (escape) {
          const inSearchBranch = escape.type === 'IfStatement';
          context.report({ node: escape, messageId: inSearchBranch ? 'searchError' : 'escape', data: { name } });
        } else if (!endsInRethrow(node.body, name)) {
          context.report({ node, messageId: 'escape', data: { name } });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        const method = callee.property.name;
        if (method === 'catch' || (method === 'then' && node.arguments.length >= 2)) context.report({ node, messageId: 'promise' });
      },
    };
  },
};

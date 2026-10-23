// No generic catch in the tool layer (plan phase P5). A tool reports the model's faults by
// throwing ToolError; any other exception is an environment bug that must reach the loop as
// INTERNAL and flag the trial ENV_ERROR (packages/env/tools/errors.ts). A catch that can
// finish without rethrowing would turn such a bug into an ordinary result, and the fuzz that
// counts INTERNAL would never see it.
//
// A catch clause in tools/ must bind the error, and every way out of it must be `throw <e>`,
// except inside `if (<e> instanceof ToolError)` and after `if (!(<e> instanceof ToolError))
// throw <e>;`, where anything goes, and inside `if (<e> instanceof SearchError)`, which must
// throw a new ToolError (the search module's typed input error, converted for the model).
// ToolError and SearchError count only as the classes imported from their modules, so a local
// alias does not narrow. Promise .catch(), two-argument .then() and Promise.allSettled() are
// banned outright. Tests under a test/ directory are exempt.
import { dirname, relative, resolve, sep } from 'node:path';
import { propertyName } from './lib/globals.js';

export const files = ['packages/env/tools/**'];

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// An unlabeled continue targets the nearest loop; an unlabeled break, the nearest loop or switch.
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

// The module each error class must be imported from, relative to the repo root, without extension.
const ERROR_MODULES = { ToolError: 'packages/env/tools/errors', SearchError: 'packages/env/search' };

// The rule's analysis of one file: `classOf` names the error class an identifier binds to.
function analysis(classOf) {
  // The class an `if` test narrows the caught error to, or undefined.
  const narrowsTo = (test, name) =>
    test.type === 'BinaryExpression' && test.operator === 'instanceof' && test.left.type === 'Identifier' && test.left.name === name
      ? classOf(test.right)
      : undefined;

  const isRethrow = (node, name) => node.type === 'ThrowStatement' && node.argument.type === 'Identifier' && node.argument.name === name;
  const isNewToolError = (node) => node.type === 'ThrowStatement' && node.argument.type === 'NewExpression' && classOf(node.argument.callee) === 'ToolError';

  // `if (!(<e> instanceof ToolError)) throw <e>;`: past it, the error is a ToolError.
  const isGuard = (node, name) =>
    node.type === 'IfStatement' &&
    !node.alternate &&
    node.test.type === 'UnaryExpression' &&
    node.test.operator === '!' &&
    narrowsTo(node.test.argument, name) === 'ToolError' &&
    !firstEscape(node.consequent, name) &&
    endsInRethrow(node.consequent, name);

  // Whether a statement, run last in the catch, always leaves it by rethrowing.
  function endsInRethrow(node, name) {
    if (!node) return false;
    if (node.type === 'BlockStatement') return node.body.some((s) => isGuard(s, name)) || endsInRethrow(node.body.at(-1), name);
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
  // break or continue out of it, or a throw of something else. inLoop: an unlabeled continue
  // stays inside the catch; inBreakable: an unlabeled break does.
  function firstEscape(node, name, inLoop = false, inBreakable = false) {
    if (!node || typeof node.type !== 'string' || FUNCTIONS.has(node.type)) return undefined;
    switch (node.type) {
      case 'ReturnStatement':
        return node;
      case 'BreakStatement':
        return inBreakable && !node.label ? undefined : node;
      case 'ContinueStatement':
        return inLoop && !node.label ? undefined : node;
      case 'ThrowStatement':
        return isRethrow(node, name) ? undefined : node;
      case 'BlockStatement': {
        // Statements after a guard handle a ToolError only.
        for (const s of node.body) {
          if (isGuard(s, name)) return undefined;
          const hit = firstEscape(s, name, inLoop, inBreakable);
          if (hit) return hit;
        }
        return undefined;
      }
      case 'IfStatement': {
        const cls = narrowsTo(node.test, name);
        if (cls === 'ToolError') return firstEscape(node.alternate, name, inLoop, inBreakable);
        if (cls === 'SearchError') {
          // The branch must end in `throw new ToolError(...)` with no other way out before it.
          const inner = node.consequent.type === 'BlockStatement' ? node.consequent.body : [node.consequent];
          if (!endsInToolError(node.consequent) || inner.slice(0, -1).some((s) => firstEscape(s, name, inLoop, inBreakable))) return node;
          return firstEscape(node.alternate, name, inLoop, inBreakable);
        }
        break;
      }
    }
    const loop = inLoop || LOOPS.has(node.type);
    const breakable = inBreakable || loop || node.type === 'SwitchStatement';
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child.type === 'string') {
          const hit = firstEscape(child, name, loop, breakable);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  }

  return { firstEscape, endsInRethrow };
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
      allSettled: 'Promise.allSettled turns every rejection into a value. In tools/, use Promise.all, so an error that is not a ToolError surfaces as INTERNAL.',
    },
  },
  create(context) {
    const filename = context.physicalFilename;
    // Repo-relative, so directories above the checkout cannot match the test exemption.
    const inRepo = (file) => relative(context.cwd, file).split(sep).join('/');
    if (/^packages\/env\/tools\/(?:.+\/)?test\//.test(inRepo(filename))) return {};

    // The error class an identifier binds to: an import of ToolError or SearchError from its
    // own module, or undefined.
    const classOf = (node) => {
      if (node.type !== 'Identifier') return undefined;
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (!variable) continue;
        const [def] = variable.defs;
        if (variable.defs.length !== 1 || def.type !== 'ImportBinding' || def.node.type !== 'ImportSpecifier') return undefined;
        const imported = def.node.imported.type === 'Identifier' ? def.node.imported.name : def.node.imported.value;
        if (!Object.hasOwn(ERROR_MODULES, imported)) return undefined;
        const from = inRepo(resolve(dirname(filename), def.parent.source.value)).replace(/\.(?:ts|js)$/, '');
        return from === ERROR_MODULES[imported] ? imported : undefined;
      }
      return undefined;
    };
    const { firstEscape, endsInRethrow } = analysis(classOf);

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
        if (callee.type !== 'MemberExpression') return;
        const method = propertyName(callee);
        if (method === 'catch' || (method === 'then' && node.arguments.length >= 2)) context.report({ node, messageId: 'promise' });
        else if (method === 'allSettled') context.report({ node, messageId: 'allSettled' });
      },
    };
  },
};

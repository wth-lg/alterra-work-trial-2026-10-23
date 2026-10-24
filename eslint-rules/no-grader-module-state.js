// No module state in graders (plan phase P9). Checks run in one process trial after trial, so a
// module-level binding a check writes outlives the trial: a rubric item could record what it saw
// and a gate of a later trial read it, and a pass would depend on the trial before. Gates run
// before rubric items within a trial (packages/grader/grade.ts); this rule closes the
// cross-trial route.
//
// In a task's grader and rubric, and in the grader's check helpers, it bans:
//   - any module-level let or var;
//   - a module-level array, object, Map, Set, WeakMap or WeakSet that code inside a function
//     changes: assigns or deletes a member, calls a mutating method (push, set, add, clear, ...)
//     or passes it to Object.assign / Object.defineProperty / Reflect.set.
// A table built at load time and only read afterwards is fine; so is any state a check keeps in
// its own locals.
export const files = [
  'tasks/*/tests/grader.ts',
  'tasks/*/tests/rubric.ts',
  'packages/grader/check.ts',
  'packages/grader/normalize.ts',
  'packages/grader/exposure.ts',
  'packages/grader/diff.ts',
  'packages/grader/gate-view.ts',
];

const CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object']);
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
const WRITERS = [['Object', 'assign'], ['Object', 'defineProperty'], ['Object', 'defineProperties'], ['Object', 'setPrototypeOf'], ['Reflect', 'set'], ['Reflect', 'defineProperty'], ['Reflect', 'deleteProperty']];

const unwrap = (node) => (node && (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') ? unwrap(node.expression) : node);

function isContainer(init) {
  const node = unwrap(init);
  if (!node) return false;
  if (node.type === 'ArrayExpression' || node.type === 'ObjectExpression') return true;
  return node.type === 'NewExpression' && node.callee.type === 'Identifier' && CONTAINERS.has(node.callee.name);
}

const propertyName = (member) => (member.computed ? (member.property.type === 'Literal' ? String(member.property.value) : null) : member.property.name);

// Whether this reference changes the value the identifier holds.
function mutates(id) {
  let node = id;
  // Walk up member chains whose object is the value: xs[0].a = 1 changes xs.
  while (node.parent.type === 'MemberExpression' && node.parent.object === node) {
    const member = node.parent;
    const up = member.parent;
    if (up.type === 'AssignmentExpression' && up.left === member) return true;
    if (up.type === 'UpdateExpression' && up.argument === member) return true;
    if (up.type === 'UnaryExpression' && up.operator === 'delete' && up.argument === member) return true;
    if (up.type === 'CallExpression' && up.callee === member && MUTATORS.has(propertyName(member))) return true;
    node = member;
  }
  const call = id.parent;
  if (call.type === 'CallExpression' && call.arguments[0] === id && call.callee.type === 'MemberExpression' && call.callee.object.type === 'Identifier') {
    const [obj, prop] = [call.callee.object.name, propertyName(call.callee)];
    return WRITERS.some(([o, p]) => o === obj && p === prop);
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Graders keep no module state that outlives a trial' },
    schema: [],
    messages: {
      binding: "module-level {{kind}} '{{name}}' outlives the trial: keep check state inside the check; gates must not read rubric data",
      mutated: "module-level '{{name}}' is changed inside a function, so it carries data from one trial to the next: keep check state inside the check; gates must not read rubric data",
    },
  },
  create(context) {
    return {
      'Program:exit'(program) {
        let scope = context.sourceCode.getScope(program);
        if (scope.type === 'global' && scope.childScopes[0]?.type === 'module') scope = scope.childScopes[0];
        for (const variable of scope.variables) {
          const def = variable.defs[0];
          if (!def || def.type !== 'Variable') continue;
          const kind = def.parent.kind;
          if (kind === 'let' || kind === 'var') {
            context.report({ node: def.node, messageId: 'binding', data: { kind, name: variable.name } });
            continue;
          }
          if (!isContainer(def.node.init)) continue;
          const ref = variable.references.find((r) => r.from.variableScope.type === 'function' && mutates(r.identifier));
          if (ref) context.report({ node: ref.identifier, messageId: 'mutated', data: { name: variable.name } });
        }
      },
    };
  },
};

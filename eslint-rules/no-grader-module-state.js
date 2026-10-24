// No module state in graders (plan phase P9). Checks run in one process trial after trial, so
// state a check writes outside its own call outlives the trial: a rubric item could record what
// it saw and a gate of a later trial read it, and a pass would depend on the trial before.
//
// This rule is the cheap first layer. The real guard is the matrix isolation check of the grader
// validation matrix (packages/grader/matrix/matrix.ts): it grades every case in one process in
// an interleaved order and again in a fresh process, and fails on any difference, whatever
// syntax carried the state. Static lint cannot follow every alias, closure or helper module; this rule
// catches the common forms early.
//
// In a task's tests/ (grader, rubric and any helper module) and in packages/grader (its test
// directories excepted), it bans:
//   - any module-level let or var;
//   - code inside a function changing a module-level binding's value, whatever the binding
//     holds or where it came from (a literal, an alias, Object.create, Array.of, a call, an
//     import): assigning or deleting a member, calling a mutating method (push, set, add,
//     clear, ...), or passing it to Object.assign / Object.defineProperty / Reflect.set;
//   - a class static field, unless it is readonly and holds a literal;
//   - any write to globalThis (or self, window, global).
// A table built at load time and only read afterwards is fine; so is any state a check keeps in
// its own locals.
export const files = ['tasks/*/tests/**/*.{ts,tsx,mts,cts,js,mjs,cjs}', 'packages/grader/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'];

// packages/grader's own tests keep spies and fixtures at module level on purpose.
const EXEMPT = /[\\/]packages[\\/]grader[\\/](.*[\\/])?test[\\/]/;

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
const WRITERS = [['Object', 'assign'], ['Object', 'defineProperty'], ['Object', 'defineProperties'], ['Object', 'setPrototypeOf'], ['Reflect', 'set'], ['Reflect', 'defineProperty'], ['Reflect', 'deleteProperty']];
const GLOBALS = new Set(['globalThis', 'self', 'window', 'global']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

const unwrap = (node) => (node && WRAPPERS.has(node.type) ? unwrap(node.expression) : node);
// The node itself, or the outermost type assertion wrapping it: (x as T).a reads x.
const outer = (node) => (WRAPPERS.has(node.parent.type) && node.parent.expression === node ? outer(node.parent) : node);

const propertyName = (member) => (member.computed ? (member.property.type === 'Literal' ? String(member.property.value) : null) : member.property.name);

// Whether this expression's value is changed where it stands.
function mutates(start) {
  let node = outer(start);
  // Walk up member chains whose object is the value: xs[0].a = 1 changes xs.
  while (node.parent.type === 'MemberExpression' && node.parent.object === node) {
    const member = node.parent;
    const up = outer(member).parent;
    const at = outer(member);
    if (up.type === 'AssignmentExpression' && up.left === at) return true;
    if (up.type === 'UpdateExpression' && up.argument === at) return true;
    if (up.type === 'UnaryExpression' && up.operator === 'delete' && up.argument === at) return true;
    if (up.type === 'CallExpression' && up.callee === at && MUTATORS.has(propertyName(member))) return true;
    node = at;
  }
  const call = node.parent;
  if (call.type === 'CallExpression' && call.arguments[0] === node && call.callee.type === 'MemberExpression' && call.callee.object.type === 'Identifier') {
    const [obj, prop] = [call.callee.object.name, propertyName(call.callee)];
    return WRITERS.some(([o, p]) => o === obj && p === prop);
  }
  return false;
}

const literal = (node) => {
  const n = unwrap(node);
  return n && (n.type === 'Literal' || (n.type === 'TemplateLiteral' && n.expressions.length === 0) || (n.type === 'UnaryExpression' && n.argument.type === 'Literal'));
};

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Graders keep no module state that outlives a trial' },
    schema: [],
    messages: {
      binding: "module-level {{kind}} '{{name}}' outlives the trial: keep check state inside the check; gates must not read rubric data",
      mutated: "module-level '{{name}}' is changed inside a function, so it carries data from one trial to the next: keep check state inside the check; gates must not read rubric data",
      static: "class static field '{{name}}' outlives the trial: keep check state inside the check; gates must not read rubric data",
      global: "a write to {{name}} outlives the trial: keep check state inside the check; gates must not read rubric data",
    },
  },
  create(context) {
    if (EXEMPT.test(context.filename)) return {};
    return {
      'PropertyDefinition[static=true]'(node) {
        if (node.readonly && literal(node.value)) return;
        context.report({ node, messageId: 'static', data: { name: node.key.name ?? propertyName({ computed: node.computed, property: node.key }) ?? '?' } });
      },
      StaticBlock(node) {
        context.report({ node, messageId: 'static', data: { name: 'static block' } });
      },
      Identifier(node) {
        if (!GLOBALS.has(node.name)) return;
        const scope = context.sourceCode.getScope(node);
        const ref = scope.references.find((r) => r.identifier === node);
        // A local of the same name is not the global.
        if (ref && ref.resolved !== null && ref.resolved.scope.type !== 'global') return;
        if (mutates(node)) context.report({ node, messageId: 'global', data: { name: node.name } });
      },
      'Program:exit'(program) {
        let scope = context.sourceCode.getScope(program);
        if (scope.type === 'global' && scope.childScopes[0]?.type === 'module') scope = scope.childScopes[0];
        for (const variable of scope.variables) {
          const def = variable.defs[0];
          if (!def) continue;
          if (def.type === 'Variable' && (def.parent.kind === 'let' || def.parent.kind === 'var')) {
            context.report({ node: def.node, messageId: 'binding', data: { kind: def.parent.kind, name: variable.name } });
            continue;
          }
          const ref = variable.references.find((r) => r.from.variableScope.type === 'function' && mutates(r.identifier));
          if (ref) context.report({ node: ref.identifier, messageId: 'mutated', data: { name: variable.name } });
        }
      },
    };
  },
};

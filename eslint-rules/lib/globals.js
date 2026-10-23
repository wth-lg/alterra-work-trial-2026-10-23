// Finds every place a file reaches a global value, whatever the spelling: a bare name,
// a global-object prefix (globalThis., window., self., global.), a string-keyed member
// (Date['now']) or a TypeScript cast around any of them. The rules match on the global,
// not on the syntax used to reach it.

export const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ChainExpression']);

// The outermost node that still evaluates to the same value as node.
function outer(node) {
  while (node.parent && WRAPPERS.has(node.parent.type) && node.parent.expression === node) node = node.parent;
  return node;
}

// The static name of a.b, a['b'] or a[`b`]; undefined when the name is computed at runtime.
export function propertyName(member) {
  const p = member.property;
  if (!member.computed) return p.type === 'Identifier' ? p.name : undefined;
  if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
  if (p.type === 'TemplateLiteral' && p.expressions.length === 0) return p.quasis[0].value.cooked;
  return undefined;
}

// For `const { a, b: c } = node` (or the same as an assignment), the keys taken from node,
// with undefined for a computed key or a rest element. Null when node is not destructured.
export function destructuredKeys(node) {
  const parent = node.parent;
  const pattern =
    parent.type === 'VariableDeclarator' && parent.init === node
      ? parent.id
      : parent.type === 'AssignmentExpression' && parent.right === node
        ? parent.left
        : undefined;
  if (pattern?.type !== 'ObjectPattern') return null;
  return pattern.properties.map((p) => {
    if (p.type !== 'Property') return undefined;
    if (!p.computed && p.key.type === 'Identifier') return p.key.name;
    return p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : undefined;
  });
}

// True when node sits in a type position (`typeof Date`), which reads no value at runtime.
export function inType(node) {
  return node.parent.type === 'TSTypeQuery' || node.parent.type === 'TSQualifiedName';
}

// Yields { names, node, identifier } per value reference to a global. names is the chain of
// global names walked through global objects (['globalThis', 'Date'] for globalThis.Date),
// node the outermost expression for the last name. A local that shadows a global is skipped.
// typescript-eslint declares the ES lib globals (Date, Math, globalThis) as global-scope
// variables with no definition, so their references resolve and never reach scope.through.
export function* globalUses(context, program) {
  const scope = context.sourceCode.getScope(program);
  const implicit = scope.variables.filter((v) => v.defs.length === 0).flatMap((v) => v.references);
  for (const ref of [...scope.through, ...implicit]) {
    if (ref.isValueReference === false) continue;
    const names = [ref.identifier.name];
    let node = outer(ref.identifier);
    while (GLOBAL_OBJECTS.has(names.at(-1))) {
      const parent = node.parent;
      if (parent?.type !== 'MemberExpression' || parent.object !== node) break;
      const name = propertyName(parent);
      if (name === undefined) break;
      names.push(name);
      node = outer(parent);
    }
    yield { names, node, identifier: ref.identifier };
  }
}

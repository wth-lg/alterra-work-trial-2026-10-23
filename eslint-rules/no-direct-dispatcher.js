// Node's fetch sends through undici's global dispatcher, which undici keeps on globalThis under
// the registry symbols undici.globalDispatcher.1 and .2. Called directly, that dispatcher (its
// request(), dispatch() or connect()) sends below the egress guard and the ledger, so only
// packages/core/egress.ts, which captures it at install, may read it. Anywhere else these are
// errors:
//   - a string whose static text starts with 'undici.' (a literal, a template's first part, the
//     first part of a + chain), the prefix of every undici registry key
//   - Symbol.for with an argument that is not one static string, and Symbol or Symbol.for used
//     other than as a direct call or a static member, since an alias or a computed key hides the
//     argument; Symbol counts when read off any object (globalThis.Symbol) or destructured
//   - reading the global symbol keys: getOwnPropertySymbols, Reflect.ownKeys and
//     getOwnPropertyDescriptors, by any static name or destructured
//   - an import, export, require or other call naming 'undici' or 'node:undici' (or a subpath)
//   - getBuiltinModule, which loads node:https and the other socket modules without an import
//   - a computed member of Symbol, Object, Reflect or process whose key is not static
// This rule is the second layer. What it cannot see (a name built at runtime, eval, new
// Function, node:vm) still finds only the guarded dispatcher that installEgressGuard() locks
// into both slots; the routes that stay open are listed in packages/core/anthropic.ts.

import { relative, sep } from 'node:path';

// Every file ESLint parses as code: .ts, .tsx, .mts, .cts, .js, .jsx, .mjs and .cjs.
export const files = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

const EXEMPT = 'packages/core/egress.ts';
// Built, not written, so this file holds no literal the rule would flag.
const PREFIX = ['undici', ''].join('.');
const UNDICI = /^(node:)?undici(\/|$)/;
const BANNED_NAMES = new Set(['getOwnPropertySymbols', 'ownKeys', 'getOwnPropertyDescriptors', 'getBuiltinModule']);
const COMPUTED_GUARDED = new Set(['Symbol', 'Object', 'Reflect', 'process']);

const posix = (p) => p.split(sep).join('/');

// The text of a string literal, a template whose expressions are all static, or a + chain of
// them; else undefined.
function staticText(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type === 'TemplateLiteral') {
    const parts = node.expressions.map(staticText);
    if (parts.some((p) => p === undefined)) return undefined;
    return node.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) + (parts[i] ?? '')).join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = staticText(node.left);
    const r = staticText(node.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  return undefined;
}

// The static start of a string expression: all of it when static, else a template's first part
// or the static start of a + chain's left side.
function staticPrefix(node) {
  const whole = staticText(node);
  if (whole !== undefined) return whole;
  if (node.type === 'TemplateLiteral') return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  if (node.type === 'BinaryExpression' && node.operator === '+') return staticPrefix(node.left);
  return undefined;
}

// A member's property name when static: obj.name, obj['name'], obj['na' + 'me'].
const propName = (m) => (m.computed ? staticText(m.property) : m.property.type === 'Identifier' ? m.property.name : undefined);
const keyName = (p) => (p.computed ? staticText(p.key) : p.key.type === 'Identifier' ? p.key.name : staticText(p.key));

export default {
  meta: {
    type: 'problem',
    docs: { description: "Only packages/core/egress.ts reaches undici's global dispatcher" },
    schema: [],
    messages: {
      banned:
        "{{what}} can reach undici's global dispatcher or a raw socket below the egress guard and the ledger; send through MessagesClient (packages/core/anthropic.ts).",
    },
  },
  create(context) {
    if (posix(relative(context.cwd, context.physicalFilename)) === EXEMPT) return {};
    const report = (node, what) => context.report({ node, messageId: 'banned', data: { what } });
    const inChain = (node) => node.parent?.type === 'BinaryExpression' && node.parent.operator === '+';
    const checkString = (node) => {
      if (inChain(node)) return;
      const p = staticPrefix(node);
      if (p !== undefined && p.startsWith(PREFIX)) report(node, `A string starting with '${PREFIX}'`);
    };
    // Unwraps TypeScript-only wrappers, so (Symbol as any).for is still Symbol.for.
    const TS_WRAPPERS = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression']);
    const outer = (n) => (TS_WRAPPERS.has(n.parent?.type) || n.parent?.type === 'ChainExpression' ? outer(n.parent) : n);
    const inner = (n) => (TS_WRAPPERS.has(n.type) ? inner(n.expression) : n);

    // How a reference to Symbol is used: as a call, a static member, or for Symbol.for, a direct
    // call with one static string. Anything else hides what it reads.
    const checkSymbol = (node) => {
      const at = outer(node);
      const parent = at.parent;
      if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.callee === at) return;
      if ((parent.type === 'UnaryExpression' && parent.operator === 'typeof') || parent.type === 'TSTypeQuery') return;
      if (parent.type === 'MemberExpression' && parent.object === at) {
        const name = propName(parent);
        if (name === undefined) return report(parent, 'A computed member of Symbol');
        if (name !== 'for') return;
        const call = outer(parent).parent;
        if (call.type !== 'CallExpression' || outer(call.callee) !== outer(parent)) return report(parent, 'Symbol.for used other than as a direct call');
        if (call.arguments.length !== 1 || staticText(call.arguments[0]) === undefined) report(call, 'Symbol.for with an argument that is not one static string');
        return;
      }
      report(at, 'Symbol used as a value');
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkString(node);
      },
      TemplateLiteral: checkString,
      BinaryExpression(node) {
        if (node.operator === '+') checkString(node);
      },
      'ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression'(node) {
        const s = node.source ? staticText(node.source) : undefined;
        if (s !== undefined && UNDICI.test(s)) report(node, `Importing '${s}'`);
      },
      TSExternalModuleReference(node) {
        const s = staticText(node.expression);
        if (s !== undefined && UNDICI.test(s)) report(node, `Requiring '${s}'`);
      },
      CallExpression(node) {
        const s = staticText(node.arguments[0]);
        if (s !== undefined && UNDICI.test(s)) report(node, `Loading '${s}'`);
      },
      MemberExpression(node) {
        const name = propName(node);
        if (name === 'Symbol') checkSymbol(node);
        else if (BANNED_NAMES.has(name)) report(node, name);
        else if (name === undefined) {
          const o = inner(node.object);
          // Symbol's computed members are checked with its other uses.
          if (o.type === 'Identifier' && o.name !== 'Symbol' && COMPUTED_GUARDED.has(o.name)) report(node, `A computed member of ${o.name}`);
        }
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') return;
        const name = keyName(node);
        if (name === 'Symbol' || BANNED_NAMES.has(name)) report(node, `Destructuring ${name}`);
      },
      // Value references to the global Symbol (not a local of that name, not a type position).
      'Program:exit'() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const ref of scope.references) {
            if (ref.identifier.name !== 'Symbol' || ref.isValueReference === false) continue;
            if (ref.resolved && ref.resolved.defs.length > 0) continue;
            checkSymbol(ref.identifier);
          }
        }
      },
    };
  },
};

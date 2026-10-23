// calculate (design section 3): arithmetic only, parsed and evaluated here; no eval and no
// clinical formulas. Grammar, loosest binding first:
//   expr    = term (('+' | '-') term)*
//   term    = unary (('*' | '/') unary)*
//   unary   = ('+' | '-') unary | power
//   power   = primary ('^' unary)?          right-associative; -2^2 = -4
//   primary = number | name '(' expr (',' expr)* ')' | '(' expr ')'
import { ToolError } from '../errors.ts';
import type { Tool } from '../registry.ts';
import type { ReadContext } from './context.ts';

type Token = { kind: 'num'; value: number; at: number } | { kind: 'name' | 'op'; text: string; at: number };

const fail = (message: string) => new ToolError('INVALID_INPUT', message, 'expression');

function lex(src: string): Token[] {
  const out: Token[] = [];
  const re = /\s+|(\d+(?:\.\d+)?|\.\d+)|([a-z]+)|([-+*/^(),])/y;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) throw fail(`unexpected character '${src[at]}' at position ${at + 1}`);
    if (m[1] !== undefined) out.push({ kind: 'num', value: Number(m[1]), at });
    else if (m[2] !== undefined) out.push({ kind: 'name', text: m[2], at });
    else if (m[3] !== undefined) out.push({ kind: 'op', text: m[3], at });
  }
  return out;
}

const finite = (x: number, what: string) => {
  if (!Number.isFinite(x)) throw fail(`${what} is not a finite number`);
  return x;
};

// Half away from zero, after removing binary noise: round(1.005, 2) is 1.01, round(-2.5) is -3.
function round(x: number, digits: number): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) throw fail('round digits must be an integer from 0 to 12');
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(15)))) / f;
}

const FUNCTIONS: Record<string, { min: number; max: number; f: (...a: number[]) => number }> = {
  ln: { min: 1, max: 1, f: Math.log },
  log: { min: 1, max: 1, f: Math.log10 },
  exp: { min: 1, max: 1, f: Math.exp },
  sqrt: { min: 1, max: 1, f: Math.sqrt },
  abs: { min: 1, max: 1, f: Math.abs },
  min: { min: 1, max: Infinity, f: Math.min },
  max: { min: 1, max: Infinity, f: Math.max },
  round: { min: 1, max: 2, f: (x, d = 0) => round(x, d) },
};

export function evaluate(src: string): number {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t: Token | undefined, text: string) => t !== undefined && t.kind === 'op' && t.text === text;
  const where = (t: Token | undefined) => (t === undefined ? 'at the end' : `at position ${t.at + 1}`);
  const expect = (text: string) => {
    if (!isOp(peek(), text)) throw fail(`expected '${text}' ${where(peek())}`);
    i++;
  };

  function expr(): number {
    let x = term();
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const op = (toks[i++] as { text: string }).text;
      const y = term();
      x = finite(op === '+' ? x + y : x - y, 'a sum');
    }
    return x;
  }
  function term(): number {
    let x = unary();
    while (isOp(peek(), '*') || isOp(peek(), '/')) {
      const op = (toks[i++] as { text: string }).text;
      const y = unary();
      if (op === '/' && y === 0) throw fail('division by zero');
      x = finite(op === '*' ? x * y : x / y, 'a product');
    }
    return x;
  }
  function unary(): number {
    if (isOp(peek(), '-')) {
      i++;
      return -unary();
    }
    if (isOp(peek(), '+')) {
      i++;
      return unary();
    }
    return power();
  }
  function power(): number {
    const x = primary();
    if (!isOp(peek(), '^')) return x;
    i++;
    return finite(x ** unary(), 'a power');
  }
  function primary(): number {
    const t = peek();
    if (t === undefined) throw fail('expression ends early');
    i++;
    if (t.kind === 'num') return finite(t.value, 'a number');
    if (isOp(t, '(')) {
      const x = expr();
      expect(')');
      return x;
    }
    if (t.kind === 'name') {
      const fn = Object.hasOwn(FUNCTIONS, t.text) ? FUNCTIONS[t.text]! : undefined;
      if (!fn) throw fail(`unknown function '${t.text}'; functions: ${Object.keys(FUNCTIONS).join(', ')}`);
      expect('(');
      const args = [expr()];
      while (isOp(peek(), ',')) {
        i++;
        args.push(expr());
      }
      expect(')');
      if (args.length < fn.min || args.length > fn.max) throw fail(`${t.text} takes ${fn.min === fn.max ? fn.min : `${fn.min}${fn.max === Infinity ? ' or more' : `-${fn.max}`}`} argument(s)`);
      return finite(fn.f(...args), `${t.text}(...)`);
    }
    throw fail(`unexpected '${t.text}' ${where(t)}`);
  }

  const x = expr();
  if (i < toks.length) throw fail(`unexpected '${(toks[i] as { text?: string }).text ?? (toks[i] as { value: number }).value}' ${where(toks[i])}`);
  return x;
}

export const calculate: Tool<ReadContext> = {
  name: 'calculate',
  description:
    'Evaluate an arithmetic expression: numbers, + - * / ^ and parentheses, and the functions ln, log (base 10), exp, sqrt, min, max, abs, ' +
    'round(x) and round(x, digits). No variables and no clinical formulas. The result has 12 significant digits.',
  inputSchema: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'e.g. (140 - 80) * 70 / (72 * 1.1)', minLength: 1, maxLength: 500 } },
    required: ['expression'],
    additionalProperties: false,
  },
  run(input: { expression: string }) {
    const x = Number(evaluate(input.expression).toPrecision(12));
    // JSON has no -0.
    return { result: x === 0 ? 0 : x };
  },
};

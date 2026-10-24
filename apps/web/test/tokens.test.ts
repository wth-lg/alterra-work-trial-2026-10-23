// Pins decision (5): Tailwind stone neutrals plus one blue near #5C85FB, no logos, no licensed
// fonts. Every --color-* token declared in apps/web/src is either the one accent or a stone
// value copied from Tailwind's own theme (white too: cards are white on a stone-50 page, as in
// the reference design); the theme resets Tailwind's palette, so only tokens make colour
// utilities, and no source file names a raw palette class or an arbitrary colour. Text tokens
// reach 4.5:1 and control borders and the focus ring 3:1 on both backgrounds, light and dark.
// public/ holds only the self-hosted OFL fonts and their licence, and every font file's family
// (read from its name table) is named in OFL.txt.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseHealth, STATIC_HEALTH } from '../../../packages/core/runner-api.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCENT = '#5C85FB';
const MAX_DELTA_E = 3;
// Stone's highest OKLCH chroma is 0.013; a token above this is chromatic.
const CHROMATIC = 0.02;

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

// --- colour maths: hex and oklch to CIE Lab (D65), then CIEDE2000 ---------------------------

type Lab = [number, number, number];
type Rgb = [number, number, number];

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hexToLinear(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => linear(parseInt(full.slice(i, i + 2), 16) / 255)) as Rgb;
}

function oklchToLinear(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const [L, a, b] = [l, c * Math.cos(h), c * Math.sin(h)];
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearToLab([r, g, b]: Rgb): Lab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

interface Parsed {
  lab: Lab;
  chroma: number; // OKLCH chroma
}

function parseColor(value: string): Parsed {
  const v = value.trim().toLowerCase();
  const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (ok) return { lab: linearToLab(oklchToLinear(Number(ok[1]) / 100, Number(ok[2]), Number(ok[3]))), chroma: Number(ok[2]) };
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) {
    const lin = hexToLinear(v);
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { lab: linearToLab(lin), chroma: Math.hypot(a, b) };
  }
  throw new Error(`token value ${value} is neither oklch(L% C H) nor a hex colour`);
}

// CIEDE2000 (Sharma, Wu and Dalal 2005), kL = kC = kH = 1.
function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (a: number, b: number) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const h1p = hp(a1p, b1);
  const h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) dhp = Math.abs(h2p - h1p) <= 180 ? h2p - h1p : h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) hbarp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbarp - 30) * rad) + 0.24 * Math.cos(2 * hbarp * rad) + 0.32 * Math.cos((3 * hbarp + 6) * rad) - 0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// --- tokens -------------------------------------------------------------------------------

const declarations = (css: string) => [...css.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => ({ name: m[1]!, value: m[2]!.trim() }));

const tailwindTheme = readFileSync(join(webRoot, 'node_modules/tailwindcss/theme.css'), 'utf8');
const STONE = new Set(declarations(tailwindTheme).filter((d) => /^--color-stone-\d+$/.test(d.name)).map((d) => d.value));
const WHITE = declarations(tailwindTheme).find((d) => d.name === '--color-white')!.value;
const NEUTRAL = new Set([...STONE, WHITE]);

const cssFiles = files(join(webRoot, 'src')).filter((f) => f.endsWith('.css'));
const tokens = cssFiles.flatMap((f) => declarations(readFileSync(f, 'utf8')).map((d) => ({ ...d, file: relative(webRoot, f) })));

describe('colour tokens', () => {
  it('reads Tailwind stone and finds tokens in apps/web/src', () => {
    expect(STONE.size).toBe(11);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('checks its own colour maths against the Sharma et al. reference pair and stone', () => {
    // Pair 1 of the CIEDE2000 test data: ΔE00 = 2.0425.
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(deltaE2000(parseColor('#5c85fb').lab, parseColor(ACCENT).lab)).toBe(0);
    for (const v of STONE) expect(parseColor(v).chroma).toBeLessThan(CHROMATIC);
  });

  it('declares exactly one chromatic token, within ΔE2000 3 of #5C85FB, the same value wherever it is set', () => {
    const chromatic = tokens.filter((t) => parseColor(t.value).chroma >= CHROMATIC);
    expect([...new Set(chromatic.map((t) => t.name))]).toEqual(['--color-accent']);
    const accent = parseColor(ACCENT).lab;
    for (const t of chromatic) expect(deltaE2000(parseColor(t.value).lab, accent), `${t.file} ${t.value}`).toBeLessThanOrEqual(MAX_DELTA_E);
  });

  it('sets every other token to a Tailwind stone value or Tailwind white', () => {
    expect(WHITE).toBe('#fff');
    for (const t of tokens.filter((x) => x.name !== '--color-accent')) expect(NEUTRAL.has(t.value), `${t.file} ${t.name}: ${t.value}`).toBe(true);
  });
});

// --- contrast (WCAG 2.2 relative luminance) -------------------------------------------------

const tokensCss = readFileSync(join(webRoot, 'src/styles/tokens.css'), 'utf8');
const themeBlock = /@theme\s*{([^}]*)}/.exec(tokensCss)?.[1] ?? '';
const darkBlock = /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/.exec(tokensCss)?.[1] ?? '';
const scheme = (css: string) => Object.fromEntries(declarations(css).map((d) => [d.name.replace('--color-', ''), d.value]));
const LIGHT = scheme(themeBlock);
const DARK = { ...LIGHT, ...scheme(darkBlock) };

function luminance(value: string): number {
  const v = value.trim().toLowerCase();
  const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  const lin = ok ? oklchToLinear(Number(ok[1]) / 100, Number(ok[2]), Number(ok[3])) : hexToLinear(v);
  const [r, g, b] = lin.map((c) => Math.min(1, Math.max(0, c))) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('contrast', () => {
  it('checks its own maths: black on white is 21:1, stone-500 on stone-100 is about 4.39:1', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    const stone = (n: number) => declarations(tailwindTheme).find((d) => d.name === `--color-stone-${n}`)!.value;
    expect(contrast(stone(500), stone(100))).toBeCloseTo(4.39, 1);
  });

  for (const [name, s] of [['light', LIGHT], ['dark', DARK]] as const) {
    it(`${name}: text 4.5:1, control borders and the focus ring 3:1, on the page and on cards`, () => {
      for (const bg of ['canvas', 'surface']) {
        for (const fg of ['ink', 'ink-muted']) expect(contrast(s[fg]!, s[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const fg of ['line-strong', 'accent']) expect(contrast(s[fg]!, s[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(s['on-primary']!, s.primary!), 'on-primary on primary').toBeGreaterThanOrEqual(4.5);
    });
  }
});

// --- no colour outside the tokens --------------------------------------------------------------

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white';
const UTILITY = 'text|bg|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|from|via|to|accent|caret|decoration|divide|placeholder|shadow|inset-shadow';
// A raw palette class (text-red-500, bg-stone-300/80, hover:bg-white) or an arbitrary colour
// (text-[#123456], bg-[rgb(1,2,3)], border-[oklch(...)]).
const RAW_COLOUR = new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:(?:${PALETTE})(?:-\\d{2,3})?(?:\\/\\d+)?(?![\\w-])|\\[(?:#|rgb|hsl|oklch|oklab|lab|lch|color)[^\\]]*\\])`, 'g');
const rawColours = (text: string) => [...text.matchAll(RAW_COLOUR)].map((m) => m[0]);

describe('colour utilities', () => {
  it('Tailwind\'s default palette is reset in the theme, so only tokens generate colour utilities', () => {
    expect(themeBlock).toMatch(/--color-\*\s*:\s*initial\s*;/);
  });

  it('the raw-colour scan catches planted palette classes and arbitrary colours, and passes token classes', () => {
    expect(rawColours('<p className="text-red-500 bg-stone-300/80 hover:bg-white border-x-zinc-200 text-[#ff0000]">')).toEqual([
      'text-red-500', 'bg-stone-300/80', 'bg-white', 'border-x-zinc-200', 'text-[#ff0000]',
    ]);
    expect(rawColours('text-ink text-ink-muted bg-surface bg-line/80 border-line-strong text-xs outline-accent text-[13px] bg-canvas')).toEqual([]);
  });

  it('no file in apps/web/src names a raw palette class or an arbitrary colour', () => {
    const sources = files(join(webRoot, 'src')).filter((f) => /\.(tsx?|css|html)$/.test(f));
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) expect(rawColours(readFileSync(f, 'utf8')), relative(webRoot, f)).toEqual([]);
  });
});

// --- public/ and fonts -----------------------------------------------------------------------

const publicDir = join(webRoot, 'public');
// api/health is the static build's answer to surface detection: a 200 that is not
// chartr-runner, so the hosted page is browser-direct without a 404 in the console.
const ALLOWED = [/^fonts\/[\w.-]+\.woff2$/, /^fonts\/OFL\.txt$/, /^api\/health$/];

// WOFF2 (W3C, 2018): the 48-byte header, then the table directory, then one Brotli stream of
// every table in directory order, a transformed table taking its transformLength.
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function woff2Family(buf: Buffer): string {
  expect(buf.toString('latin1', 0, 4)).toBe('wOF2');
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  let at = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const byte = buf[at++]!;
      v = v * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const dir: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++]!;
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = buf.toString('latin1', at, at + 4);
      at += 4;
    }
    const version = flags >> 6;
    const orig = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    dir.push({ tag: tag!, length: transformed ? base128() : orig });
  }
  const tables = brotliDecompressSync(buf.subarray(at, at + compressedSize));
  let offset = 0;
  for (const t of dir) {
    if (t.tag === 'name') return nameTableFamily(tables.subarray(offset, offset + t.length));
    offset += t.length;
  }
  throw new Error('no name table');
}

// The typographic family (name id 16), else the family (id 1), from the Windows Unicode records.
function nameTableFamily(name: Buffer): string {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const [platform, encoding, , id, length, off] = [0, 2, 4, 6, 8, 10].map((o) => name.readUInt16BE(r + o));
    if (platform !== 3 || encoding !== 1 || (id !== 1 && id !== 16) || found.has(id!)) continue;
    found.set(id!, name.subarray(strings + off!, strings + off! + length!).swap16().toString('utf16le'));
  }
  const family = found.get(16) ?? found.get(1);
  if (family === undefined) throw new Error('name table has no family name');
  return family;
}

describe('public/', () => {
  const entries = files(publicDir).map((f) => relative(publicDir, f).split('\\').join('/'));

  it('holds only allowlisted files: fonts/*.woff2, fonts/OFL.txt and api/health', () => {
    expect(entries).toContain('fonts/OFL.txt');
    for (const e of entries) expect(ALLOWED.some((re) => re.test(e)), e).toBe(true);
  });

  it('api/health is the STATIC_HEALTH body, which no runner check accepts', () => {
    expect(JSON.parse(readFileSync(join(publicDir, 'api/health'), 'utf8'))).toEqual(STATIC_HEALTH);
    expect(() => parseHealth(STATIC_HEALTH)).toThrow();
  });

  it('names the family of every font file in OFL.txt, which is the SIL Open Font License', () => {
    const ofl = readFileSync(join(publicDir, 'fonts/OFL.txt'), 'utf8');
    expect(ofl).toContain('SIL Open Font License, Version 1.1');
    const fonts = entries.filter((e) => e.endsWith('.woff2'));
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) {
      const family = woff2Family(readFileSync(join(publicDir, f)));
      expect(new RegExp(`\\b${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(ofl), `${f}: family ${family}`).toBe(true);
    }
  });

  it('every @font-face in apps/web/src loads a file that public/fonts holds, and nothing else', () => {
    const faces = cssFiles.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]!));
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const urls = [...face.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(entries, u).toContain(u.replace(/^\//, ''));
    }
  });
});

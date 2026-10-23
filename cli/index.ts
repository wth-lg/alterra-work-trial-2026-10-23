// pnpm cli <command> [args...] runs cli/<command>.ts. A command registers by existing:
// each file default-exports (args: string[]) => number | void | Promise<number | void>,
// and the number is the exit code.
// Exit 127 means the command is not built yet; scripts/donewhen.ts relies on that code.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Command = (args: string[]) => number | void | Promise<number | void>;

const dir = dirname(fileURLToPath(import.meta.url));
const commands = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts'))
  .map((f) => f.slice(0, -'.ts'.length))
  .sort();

const [name, ...args] = process.argv.slice(2);
if (!name || name === '--help' || name === '-h') {
  process.stdout.write(`usage: pnpm cli <command> [args...]\ncommands: ${commands.join(', ') || '(none yet)'}\n`);
  process.exit(name ? 0 : 2);
}
if (!commands.includes(name)) {
  process.stderr.write(`cli: unknown command '${name}'; available: ${commands.join(', ') || '(none yet)'}\n`);
  process.exit(127);
}
const mod = (await import(pathToFileURL(join(dir, `${name}.ts`)).href)) as { default?: Command };
if (typeof mod.default !== 'function') {
  process.stderr.write(`cli: cli/${name}.ts must default-export a function\n`);
  process.exit(2);
}
process.exitCode = (await mod.default(args)) ?? 0;

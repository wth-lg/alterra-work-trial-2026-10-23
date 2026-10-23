// Stands in for `node cli/index.ts` in the donewhen self-tests.
// DONEWHEN_STUB maps a command name to a file in outputs/ ({exit, stdout}).
// An unmapped command behaves like the real dispatcher for a command that is not built: exit 127.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [command = '', ...args] = process.argv.slice(2);
if (process.env.DONEWHEN_STUB_LOG) appendFileSync(process.env.DONEWHEN_STUB_LOG, `${[command, ...args].join(' ')}\n`);
const map = JSON.parse(process.env.DONEWHEN_STUB ?? '{}') as Record<string, string>;
const name = map[command];
if (!name) {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(127);
}
const out = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'outputs', `${name}.json`), 'utf8')) as {
  exit: number;
  stdout: unknown;
};
process.stdout.write(typeof out.stdout === 'string' ? out.stdout : JSON.stringify(out.stdout));
process.exit(out.exit);

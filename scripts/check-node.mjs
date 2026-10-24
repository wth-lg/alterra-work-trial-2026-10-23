// node scripts/check-node.mjs
// `pnpm start` runs this first, before it installs anything: it exits 1 with a plain message
// when this Node is older than engines.node (">=X.Y") in the package.json of the current
// directory. Plain JavaScript with no imports beyond node:fs, so an old Node can run it; the repo
// itself needs type stripping (Node 22.18 and newer) to run its .ts files.
import { readFileSync } from 'node:fs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let wanted;
try {
  wanted = JSON.parse(readFileSync('package.json', 'utf8')).engines?.node;
} catch (e) {
  fail(`check-node: cannot read package.json here: ${e.message}`);
}
const m = typeof wanted === 'string' ? /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(wanted.trim()) : null;
if (!m) fail(`check-node: package.json engines.node must read ">=X.Y", not ${JSON.stringify(wanted)}`);

const need = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
const have = process.versions.node.split('.').map(Number);
let older = false;
for (let i = 0; i < 3; i++) {
  if (have[i] !== need[i]) {
    older = have[i] < need[i];
    break;
  }
}
if (older) {
  const shown = wanted.trim().slice(2).trim();
  fail(`This project needs Node ${shown} or newer; this is Node ${process.versions.node}. Install a newer Node from https://nodejs.org (or with nvm: nvm install 22), then run pnpm start again.`);
}

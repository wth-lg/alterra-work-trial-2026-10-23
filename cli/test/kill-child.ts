// Child process for cli/test/run.test.ts: `node cli/test/kill-child.ts <marker> <index> <run args...>`
// runs cli/run.ts main() with the toy scenario, except that trial <index>'s second request writes
// <marker> and never answers. The parent SIGKILLs this process once the marker exists, so the
// ledger and the run directory are left as a killed batch leaves them.
import { writeFileSync } from 'node:fs';
import { scenarioTransport } from '../../apps/web/src/harness/scenarios.ts';
import { main } from '../run.ts';

const [marker, index, ...args] = process.argv.slice(2);
const counts = new Map<string, number>();
process.exitCode = await main(args, {
  env: process.env,
  out: () => {},
  fetch: () => Promise.reject(new Error('kill-child makes no live call')),
  mock: (name, trial) => {
    const toy = scenarioTransport(name).transport;
    return async (request) => {
      const n = (counts.get(trial) ?? 0) + 1;
      counts.set(trial, n);
      if (trial.endsWith(`/${index}`) && n === 2) {
        writeFileSync(marker as string, trial);
        setInterval(() => {}, 1000); // keep the process alive until the kill
        return new Promise<Response>(() => {});
      }
      return toy(request);
    };
  },
});

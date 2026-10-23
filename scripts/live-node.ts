// pnpm live:node [--dry-run]: one live Messages call from Node, the probe request that the
// browser check sends (apps/web/src/probe/request.ts), metered through the spend ledger.
//   --dry-run   prints the projection (the call's worst case) and makes no call
// Live: opens the ledger (own-run mode when CHARTR_CANONICAL_LEDGER is set), starts a batch at
// the projection, which refuses past the $450 projected cap, and prints the status, the
// stop reason and the parsed tool_use. Exit 0 only on status 200 with that tool_use.
import { pathToFileURL } from 'node:url';
import { money, usageCostUsd, worstCaseUsd } from '../packages/core/cost.ts';
import { MessagesClient } from '../packages/core/anthropic.ts';
import { redactText } from '../packages/core/redact.ts';
import { openNodeLedger } from '../cli/adapters/ledger-node.ts';
import { PROBE_PARAMS, PROBE_TOOL, probeHistory, probeReserveRequest } from '../apps/web/src/probe/request.ts';

const TRIAL = 'p2:live-node';

export function projection(): number {
  return worstCaseUsd(probeReserveRequest(TRIAL));
}

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
}

const defaults: Deps = { env: process.env, fetch: (input, init) => fetch(input, init), out: (l) => process.stdout.write(`${l}\n`) };

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  const unknown = args.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    deps.out(`live:node: unknown argument ${unknown[0]}; usage: pnpm live:node [--dry-run]`);
    return 2;
  }
  const req = probeReserveRequest(TRIAL);
  const p = projection();
  if (args.includes('--dry-run')) {
    deps.out(`live:node dry run: 1 call, worst case for ${req.bodyBytes} body bytes and max_tokens ${req.maxTokens}`);
    deps.out(`projection ${money(p)}`);
    deps.out(`LIVE_PROJECTION_USD=${p.toFixed(6)}`);
    return 0;
  }
  const key = deps.env.ANTHROPIC_API_KEY ?? '';
  if (key === '') {
    deps.out('live:node: ANTHROPIC_API_KEY is not set');
    return 1;
  }
  try {
    const { ledger, mode, path } = openNodeLedger({ transport: 'live', env: deps.env });
    deps.out(`ledger ${mode} ${path}`);
    const grant = await ledger.batchStart(p);
    try {
      const client = new MessagesClient({ grant, ledger, apiKey: key, fetch: deps.fetch, trial: TRIAL, log: (l) => deps.out(l) });
      const r = await client.send(probeHistory(), PROBE_PARAMS);
      const tool = r.message.content.find((b) => b.type === 'tool_use' && b.name === PROBE_TOOL);
      const cost = usageCostUsd(r.message.usage);
      deps.out(`status ${r.status}`);
      deps.out(`model ${r.message.model}, stop_reason ${r.message.stop_reason}, attempts ${r.attempts}, cost ${cost === null ? 'unpriced' : money(cost)}`);
      deps.out(tool ? `tool_use parsed: ${PROBE_TOOL} ${JSON.stringify(tool.input)}` : 'no tool_use in the response');
      return r.status === 200 && tool ? 0 : 1;
    } finally {
      await grant.close();
    }
  } catch (e) {
    deps.out(`live:node: ${redactText((e as Error).message, [key])}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

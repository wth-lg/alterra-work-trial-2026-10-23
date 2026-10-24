// read_policy (design section 3): the clinic's local policies. One policy comes back whole
// with resourceType 'Policy', so reading it exposes Policy/<id>; the list names policies by
// reference only.
import { ToolError } from '../errors.ts';
import type { Tool } from '../registry.ts';
import type { ReadContext } from './context.ts';
import { page } from './page.ts';
import { count, offset } from './schema.ts';

export const readPolicy: Tool<ReadContext> = {
  name: 'read_policy',
  description:
    'Clinic policy documents. With policy_id, returns that policy with its full text. Without it, lists every policy ' +
    '{policy, title, version, effective, source} in id order.',
  inputSchema: {
    type: 'object',
    properties: {
      policy_id: { type: 'string', description: 'Policy id, e.g. RBC-ABC-01', pattern: '^[A-Za-z0-9-]{1,40}$' },
      count: count(50, 50),
      offset,
    },
    additionalProperties: false,
  },
  run(input: { policy_id?: string; count?: number; offset?: number }, { policies }) {
    if (input.policy_id !== undefined) {
      const id = input.policy_id.toUpperCase();
      const p = policies.find((x) => x.id.toUpperCase() === id);
      if (!p) throw new ToolError('NOT_FOUND', `no policy '${input.policy_id}'; call read_policy without policy_id to list them`, 'policy_id');
      return { resourceType: 'Policy', id: p.id, title: p.title, version: p.version, effective: p.effective, source: p.source, text: p.text };
    }
    const rows = [...policies]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => ({ policy: `Policy/${p.id}`, title: p.title, version: p.version, effective: p.effective, source: p.source }));
    return page(rows, input.offset ?? 0, input.count ?? 50);
  },
};

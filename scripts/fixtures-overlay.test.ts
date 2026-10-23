// Overlay isolation (packages/env/overlay.ts) as fixtures:build applies it: each overlay reads
// the base and setting only, never what another overlay tried to write.
import { describe, expect, it } from 'vitest';
import { applyOverlays, type Overlay, type WorldReader } from '../packages/env/overlay.ts';
import type { Resource } from '../packages/env/store.ts';
import { SETTING, SETTING_LINT } from '../packages/env/world.ts';

describe('overlays', () => {
  const base: Resource[] = [
    { resourceType: 'Patient', id: 'pt-0040', name: [{ family: 'Base' }] },
    ...Object.values({ T1: ['pt-0002', 'pt-0003'], T2: ['pt-0006', 'pt-0007', 'pt-0008', 'pt-0010', 'pt-0013', 'pt-0016', 'pt-0033', 'pt-0053'] })
      .flat()
      .map((id): Resource => ({ resourceType: 'Patient', id })),
    ...['pt-0009', 'pt-0011', 'pt-0014', 'pt-0017', 'pt-0018', 'pt-0019', 'pt-0020', 'pt-0021', 'pt-0022', 'pt-0023', 'pt-0024', 'pt-0025']
      .concat(['pt-0004', 'pt-0005', 'pt-0012', 'pt-0015', 'pt-0026', 'pt-0027', 'pt-0028', 'pt-0029', 'pt-0030', 'pt-0031'])
      .map((id): Resource => ({ resourceType: 'Patient', id })),
  ];

  it('one overlay cannot write into what the next one reads', () => {
    const attempts: string[] = [];
    const t1: Overlay = {
      task: 'T1',
      build(world) {
        const sneak: Resource = { resourceType: 'Communication', id: 'comm-t1-x', status: 'completed', subject: { reference: 'Patient/pt-0040' } };
        const put = (world as WorldReader & { put?: unknown }).put;
        if (typeof put === 'function') {
          try {
            put.call(world, sneak);
            attempts.push('put ran');
          } catch {
            attempts.push('put threw');
          }
        }
        try {
          (world.get('Patient', 'pt-0040') as { name: unknown }).name = [{ family: 'Changed' }];
          attempts.push('mutation ran');
        } catch {
          attempts.push('mutation threw');
        }
        return {};
      },
    };
    let seen: unknown[] = [];
    const t2: Overlay = {
      task: 'T2',
      build(world) {
        seen = [world.get('Communication', 'comm-t1-x'), (world.get('Patient', 'pt-0040') as { name?: unknown } | undefined)?.name, world.size];
        return {};
      },
    };
    applyOverlays(base, SETTING, SETTING_LINT, [t1, t2]);
    expect(attempts).not.toContain('put ran');
    expect(attempts).not.toContain('mutation ran');
    expect(seen).toEqual([undefined, [{ family: 'Base' }], base.length + SETTING.length]);
  });
});

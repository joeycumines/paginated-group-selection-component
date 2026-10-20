import { runPropertyTest } from '../src/engine/propertyTest';
import { DEFAULT_SPECS, generateDataset } from '../src/server/mockServer';
import type { GroupInfo } from '../src/engine/types';

const seeds = [1, 2, 3, 7, 42, 1337];
let allOk = true;
for (const [n, specs] of [
  [4000, DEFAULT_SPECS],
  [60, DEFAULT_SPECS.map((s) => ({ ...s, size: Math.max(1, Math.round(s.size / 60)) }))],
  [300, DEFAULT_SPECS.map((s) => ({ ...s, size: Math.max(2, Math.round(s.size / 12)) }))],
] as const) {
  const items = generateDataset(99, n, specs as typeof DEFAULT_SPECS);
  const groups: GroupInfo[] = specs.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    total: items.filter((i) => i.groups.includes(s.id)).length,
  }));
  for (const seed of seeds) {
    const res = runPropertyTest(items, groups, { steps: n <= 300 ? 600 : 250, seed, knownCap: n <= 300 ? 40 : 100, pageSize: 20 });
    allOk &&= res.ok;
    console.log(
      `N=${n} seed=${seed} ok=${res.ok} maxBytes=${res.maxBytes} naiveMax=${res.naiveMaxBytes} maxOverrides=${res.maxOverrides} consolidations=${res.consolidations} ${Math.round(res.durationMs)}ms`,
    );
    for (const f of res.failures) console.log('   ✗', f);
  }
}
console.log(allOk ? 'ALL PASS' : 'FAILURES');
process.exit(allOk ? 0 : 1);

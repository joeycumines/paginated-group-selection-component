import { runPropertyTest } from '../src/engine/propertyTest';
import { DEFAULT_SPECS, generateDataset } from '../src/server/mockServer';
import type { GroupInfo } from '../src/engine/types';

const seeds = [1, 2, 3, 7, 42, 1337];
const configs = [
  { n: 4000, specs: DEFAULT_SPECS, caps: [0, 100], steps: 250 },
  { n: 60, specs: DEFAULT_SPECS.map((s) => ({ ...s, size: Math.max(1, Math.round(s.size / 60)) })), caps: [0, 40], steps: 600 },
  { n: 300, specs: DEFAULT_SPECS.map((s) => ({ ...s, size: Math.max(2, Math.round(s.size / 12)) })), caps: [0, 40], steps: 600 },
];
const reconcileProbabilities = [1, 0.5];
let allOk = true;
for (const cfg of configs) {
  const items = generateDataset(99, cfg.n, cfg.specs);
  const groups: GroupInfo[] = cfg.specs.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    total: items.filter((i) => i.groups.includes(s.id)).length,
  }));
  for (const knownCap of cfg.caps) {
    for (const reconcileProbability of reconcileProbabilities) {
      for (const seed of seeds) {
        const res = runPropertyTest(items, groups, { steps: cfg.steps, seed, knownCap, pageSize: 20, reconcileProbability });
        allOk &&= res.ok;
        console.log(
          `N=${cfg.n} cap=${knownCap} recon=${reconcileProbability} seed=${seed} ok=${res.ok} maxBytes=${res.maxBytes} naiveMax=${res.naiveMaxBytes} maxOverrides=${res.maxOverrides} consolidations=${res.consolidations} ${Math.round(res.durationMs)}ms`,
        );
        for (const f of res.failures) console.log('   ✗', f);
      }
    }
  }
}
console.log(allOk ? 'ALL PASS' : 'FAILURES');
process.exit(allOk ? 0 : 1);

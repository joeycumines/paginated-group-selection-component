import { SelectionEngine } from '../src/engine/SelectionEngine';
import { DEFAULT_SPECS, generateDataset } from '../src/server/mockServer';
import { UNGROUPED, type GroupInfo } from '../src/engine/types';

const items = generateDataset(99, 4000, DEFAULT_SPECS);
const groups: GroupInfo[] = DEFAULT_SPECS.map((s) => ({ id: s.id, name: s.name, color: s.color, total: items.filter((i) => i.groups.includes(s.id)).length }));
const ung = items.filter((i) => i.groups.length === 0).length;
const mk = () => new SelectionEngine(groups, ung, items.length, { knownCap: 100 });
const show = (e: SelectionEngine, label: string) => console.log(label.padEnd(44), '→', JSON.stringify(e.compile().text), `| L=${e.enc.precedence.map(r=>(r.op==='INCLUDE'?'+':'-')+r.group).join(',')} β=${e.enc.base} |E|=${e.enc.exceptions.size}`);

// 1. overlap trap
let e = mk();
e.toggleGroup('eng', 'INCLUDE'); show(e, 'select eng');
e.toggleGroup('support', 'EXCLUDE'); show(e, 'deselect support');
const x = items.find(i => i.groups.includes('eng') && i.groups.includes('support'))!;
e.toggleItem(x, true); show(e, `re-select ${x.id} ∈ eng∩support`);
console.log('   stale buckets:', e.staleBuckets().join(','));

// 2. saturation collapse
e = mk();
const pilot = items.filter(i => i.groups.includes('pilot'));
e.observe(pilot);
pilot.forEach((p, i) => { e.toggleItem(p, true); if (i >= pilot.length - 2 || i === 0) show(e, `pilot click #${i+1}/${pilot.length}`); });

// 3. polarity flip (group known)
e = mk();
const beta = items.filter(i => i.groups.includes('beta'));
e.observe(beta);
beta.forEach((p, i) => { e.toggleItem(p, true); show(e, `beta click #${i+1}/${beta.length}`); });

// 4. full coverage absorption
e = mk();
for (const g of groups) { e.toggleGroup(g.id, 'INCLUDE'); }
show(e, 'all 8 groups selected');
e.toggleGroup(UNGROUPED, 'INCLUDE'); show(e, '+ ungrouped (full coverage)');
e.toggleGroup('legal', 'EXCLUDE'); show(e, 'deselect legal');

// 5. ungrouped floating
e = mk();
e.toggleGroup(UNGROUPED, 'INCLUDE'); e.toggleGroup('legal', 'EXCLUDE'); e.toggleGroup('eng', 'INCLUDE');
show(e, 'ung+, legal-, eng+');
e = mk(); e.selectAll(); e.toggleGroup(UNGROUPED, 'EXCLUDE'); show(e, 'all except ungrouped');

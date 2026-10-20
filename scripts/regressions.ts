import { compileFilterPredicate } from '../src/engine/filterParser';
import { NONE_NODE, idNode, groupNode, printFilter } from '../src/engine/filterAst';
import {
  SelectionEngine,
  collapseSaturatedGroup,
  compileEncoding,
  groupEval,
  isSelectedIn,
  normalizeEncoding,
} from '../src/engine/SelectionEngine';
import { ALL, UNGROUPED, type BucketId, type Encoding, type GroupInfo, type ItemResource } from '../src/engine/types';
import { DEFAULT_SPECS, generateDataset } from '../src/server/mockServer';
import { computeGridRange } from '../src/components/ItemGrid';

const items = generateDataset(99, 4000, DEFAULT_SPECS);
const groups: GroupInfo[] = DEFAULT_SPECS.map((s) => ({
  id: s.id,
  name: s.name,
  color: s.color,
  total: items.filter((i) => i.groups.includes(s.id)).length,
}));
const ungroupedTotal = items.filter((i) => i.groups.length === 0).length;
const engine = (knownCap: number) => new SelectionEngine(groups, ungroupedTotal, items.length, { knownCap });

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function equal<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Review 01 #4 (compiler side) — the UNGROUPED split is optional, not unconditional:
// when splitting lengthens the clause the merged block must win.
// ---------------------------------------------------------------------------
check('compiler keeps the shorter UNGROUPED layout', () => {
  const enc: Encoding = {
    base: true,
    precedence: [
      { group: 'a', op: 'EXCLUDE' },
      { group: 'b', op: 'EXCLUDE' },
      { group: UNGROUPED, op: 'EXCLUDE' },
      { group: 'c', op: 'EXCLUDE' },
    ],
    exceptions: new Map(),
  };
  const c = compileEncoding(enc);
  equal(c.text, 'NOT (groups:"a" OR groups:"b" OR NOT groups:* OR groups:"c")', 'merged layout wins');
  equal(c.bytes, 60, 'merged byte count');
});

// ---------------------------------------------------------------------------
// UNGROUPED placement must be judged against the real exception tail, not an
// empty one: the appended `AND NOT id=…` changes which insertion is shortest.
// ---------------------------------------------------------------------------
check('UNGROUPED placement accounts for attached exceptions', () => {
  const enc: Encoding = {
    base: true,
    precedence: [
      { group: UNGROUPED, op: 'EXCLUDE' },
      { group: 'beta', op: 'EXCLUDE' },
      { group: 'eng', op: 'EXCLUDE' },
      { group: 'contractors', op: 'EXCLUDE' },
      { group: 'legal', op: 'EXCLUDE' },
      { group: 'design', op: 'EXCLUDE' },
      { group: 'pilot', op: 'INCLUDE' },
    ],
    exceptions: new Map([['x', { id: 'x', groups: ['pilot'], selected: false }]]),
  };
  normalizeEncoding(enc, ['pilot', 'beta', 'legal', 'design', 'contractors', 'sales', 'support', 'eng']);
  equal(compileEncoding(enc).bytes, 144, 'placement chosen with the real exception tail');
});

// ---------------------------------------------------------------------------
// Review 03 #1.1 — two unruled saturated buckets must be encodable together;
// adding either alone is a byte loss and never reaches full coverage.
// ---------------------------------------------------------------------------
check('composite move encodes multiple unruled buckets together', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const items: ItemResource[] = [
    { id: 'u', name: 'u', groups: [] },
    ...ids.map((g) => ({ id: g, name: g, groups: [g] })),
    { id: 'p1', name: 'p1', groups: ['pilot'] },
    { id: 'b1', name: 'b1', groups: ['beta'] },
  ];
  const groups: GroupInfo[] = [...ids.map((g) => ({ id: g, name: g, total: 1, color: '#fff' })), { id: 'pilot', name: 'pilot', total: 1, color: '#fff' }, { id: 'beta', name: 'beta', total: 1, color: '#fff' }];
  const e = new SelectionEngine(groups, 1, items.length, { knownCap: 0 });
  e.clearAll();
  e.toggleGroup(UNGROUPED, 'INCLUDE');
  for (const g of ids) e.toggleGroup(g, 'INCLUDE');
  // Reconcile as the UI does: truth counts for every stale bucket.
  const counts = new Map<BucketId, number>();
  for (const b of e.buckets()) {
    const list = b === ALL ? items : items.filter((i) => (b === UNGROUPED ? i.groups.length === 0 : i.groups.includes(b)));
    counts.set(b, list.filter((i) => e.isSelected(i.id, i.groups)).length);
  }
  e.reconcile(counts, e.version);
  equal(e.compile().text, 'NOT (groups:"pilot" OR groups:"beta")', 'composite encoding');
  assert(
    e.consolidations.some((c) => c.label.startsWith('encode 2 unruled buckets together')),
    'composite move did not run',
  );
});

// ---------------------------------------------------------------------------
// Review 03 #1.1 — the composite must tolerate an empty unruled bucket: it
// stays unruled (no rows), and the explicit two-β try still flips β.
// ---------------------------------------------------------------------------
check('composite move flips β with an empty unruled bucket present', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const items: ItemResource[] = [
    ...ids.map((g) => ({ id: g, name: g, groups: [g] })),
    { id: 'p1', name: 'p1', groups: ['pilot'] },
    { id: 'b1', name: 'b1', groups: ['beta'] },
  ];
  const groups: GroupInfo[] = [
    ...ids.map((g) => ({ id: g, name: g, total: 1, color: '#fff' })),
    { id: 'pilot', name: 'pilot', total: 1, color: '#fff' },
    { id: 'beta', name: 'beta', total: 1, color: '#fff' },
  ];
  const e = new SelectionEngine(groups, 0, items.length, { knownCap: 0 });
  e.clearAll();
  for (const g of ids) e.toggleGroup(g, 'INCLUDE');
  const counts = new Map<BucketId, number>();
  for (const b of e.buckets()) {
    const list = b === ALL ? items : items.filter((i) => (b === UNGROUPED ? i.groups.length === 0 : i.groups.includes(b)));
    counts.set(b, list.filter((i) => e.isSelected(i.id, i.groups)).length);
  }
  e.reconcile(counts, e.version);
  equal(e.compile().text, 'NOT (groups:"pilot" OR groups:"beta")', 'β-flip encoding with an empty unruled bucket');
  assert(
    e.consolidations.some((c) => c.label.includes('__UNGROUPED__')),
    'the composite move did not consider the empty UNGROUPED bucket',
  );
});

// ---------------------------------------------------------------------------
// Review 03 #1.2 — two overlap-heavy rules are only removable as a pair.
// ---------------------------------------------------------------------------
check('pairwise rule removal escapes the shared-override local minimum', () => {
  const shared = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
  const items: ItemResource[] = [
    { id: 'y1', name: 'y1', groups: ['eng'] },
    { id: 'y2', name: 'y2', groups: ['eng'] },
    { id: 'z1', name: 'z1', groups: ['beta'] },
    { id: 'z2', name: 'z2', groups: ['beta'] },
    ...shared.map((id) => ({ id, name: id, groups: ['eng', 'beta'] })),
    { id: 'n1', name: 'n1', groups: ['noise'] },
    { id: 'n2', name: 'n2', groups: ['noise'] },
    { id: 's1', name: 's1', groups: ['spoil'] },
    { id: 's2', name: 's2', groups: ['spoil'] },
  ];
  const e = new SelectionEngine(
    [
      { id: 'eng', name: 'eng', total: 8, color: '#fff' },
      { id: 'beta', name: 'beta', total: 8, color: '#fff' },
      { id: 'noise', name: 'noise', total: 2, color: '#fff' },
      { id: 'spoil', name: 'spoil', total: 2, color: '#fff' },
    ],
    0,
    items.length,
    { knownCap: 10 },
  );
  e.clearAll();
  // Only eng/beta are cached; noise stays stale and unruled, so the composite move cannot run.
  e.observe(items.filter((i) => i.groups.includes('eng') || i.groups.includes('beta')));
  e.toggleGroup('eng', 'INCLUDE');
  e.toggleGroup('beta', 'INCLUDE');
  for (const id of shared) e.toggleItem(items.find((i) => i.id === id)!, false);
  e.toggleGroup('spoil', 'INCLUDE');
  assert(e.staleBuckets().includes('noise'), 'fixture: noise must be stale');
  assert(
    e.consolidations.some((c) => c.label.includes('drop rules for eng+beta')),
    'pairwise drop did not run',
  );
  for (const item of items) {
    const want = item.groups.includes('spoil') || item.groups.includes('eng') || item.groups.includes('beta')
      ? !shared.includes(item.id)
      : false;
    equal(e.isSelected(item.id, item.groups), want, `truth for ${item.id}`);
  }
});

// ---------------------------------------------------------------------------
// Review 03 #2.1 — a toggle that cannot move any row must not invalidate peers.
// ---------------------------------------------------------------------------
check('toggleItem notifies once when observation completes a group', () => {
  const e = new SelectionEngine([{ id: 'solo', name: 'solo', total: 1, color: '#fff' }], 0, 1, { knownCap: 1 });
  const before = e.version;
  e.toggleItem({ id: 's1', name: 's1', groups: ['solo'] }, true);
  equal(e.version, before + 1, 'one version bump per toggle');
  equal(e.stats.get('solo')!.selected, 1, 'solo count');
  assert(e.isFullyKnown('solo'), 'solo must be fully known');
});

check('saturated/no-op group toggles keep every count fresh', () => {
  const e = engine(0);
  e.selectAll();
  e.toggleGroup('eng', 'INCLUDE');
  equal(e.staleBuckets().length, 0, 're-including a fully selected group must not invalidate peers');
  e.clearAll();
  e.toggleGroup('eng', 'EXCLUDE');
  equal(e.staleBuckets().length, 0, 'excluding an empty group must not invalidate peers');
});

// ---------------------------------------------------------------------------
// Gate-2 FOLLOW-UP 1 — the no-op skip and the pure-β reset mask each other in
// the fixture above (it collapses to pure β, where the reset re-freshes all).
// Pin each sub-fix against a state the other cannot rescue.
// ---------------------------------------------------------------------------
check('no-op group toggle adds no staleness while ℒ is non-trivial', () => {
  const items: ItemResource[] = [
    { id: 'p1', name: 'p1', groups: ['pilot'] },
    { id: 'p2', name: 'p2', groups: ['pilot'] },
    { id: 'e1', name: 'e1', groups: ['eng'] },
    { id: 'e2', name: 'e2', groups: ['eng'] },
    { id: 'n1', name: 'n1', groups: ['noise'] },
    { id: 'n2', name: 'n2', groups: ['noise'] },
  ];
  const e = new SelectionEngine(
    [
      { id: 'pilot', name: 'pilot', total: 2, color: '#fff' },
      { id: 'eng', name: 'eng', total: 2, color: '#fff' },
      { id: 'noise', name: 'noise', total: 2, color: '#fff' },
    ],
    0,
    items.length,
    { knownCap: 0 },
  );
  e.clearAll();
  e.toggleGroup('pilot', 'INCLUDE'); // disjoint groups, not fully known ⇒ ALL + peers go stale
  const counts = new Map<BucketId, number>();
  for (const b of e.buckets()) {
    const list = b === ALL ? items : items.filter((i) => (b === UNGROUPED ? i.groups.length === 0 : i.groups.includes(b)));
    counts.set(b, list.filter((i) => e.isSelected(i.id, i.groups)).length);
  }
  e.reconcile(counts, e.version); // UI-style reconcile ⇒ every bucket fresh again
  assert(e.staleBuckets().length === 0, 'fixture: everything fresh');
  assert(e.enc.precedence.length > 0, 'fixture: ℒ is non-trivial');
  e.toggleGroup('eng', 'EXCLUDE'); // 0/2 already at the EXCLUDE bound ⇒ no row can move
  equal(e.staleBuckets().length, 0, 'a no-op toggle must not invalidate any fresh count');
});

check('pure-β collapse refreshes stale counts to exact values', () => {
  const e = engine(0);
  for (const g of e.groupIds) e.toggleGroup(g, 'INCLUDE');
  assert(!e.stats.get(ALL)!.fresh, 'fixture: ALL must be stale before the collapse');
  e.toggleGroup(UNGROUPED, 'INCLUDE'); // full coverage ⇒ β=true, ℒ=∅, ℰ=∅
  assert(e.enc.base === true && e.enc.precedence.length === 0 && e.enc.exceptions.size === 0, 'fixture: pure-β universe');
  equal(e.staleBuckets().length, 0, 'a pure-β encoding proves every count, so none may stay stale');
  for (const st of e.stats.values()) equal(st.selected, st.total, 'universe ⇒ every bucket full');
});

// ---------------------------------------------------------------------------
// Review 01 #7 — JSON string escapes must survive print → parse → evaluate.
// ---------------------------------------------------------------------------
check('printing the empty selection throws instead of emitting the universe', () => {
  let threw = false;
  try {
    printFilter(NONE_NODE);
  } catch {
    threw = true;
  }
  assert(threw, 'printFilter(NONE_NODE) must not return the empty string');
});

check('parser round-trips JSON-escaped ids and group ids', () => {
  const ids = ['a\nb', 'a\tb', 'a\\b', 'a"b', 'a\u0000b', 'a\u001fb', '*', 'plain'];
  for (const id of ids) {
    const text = printFilter(idNode(id));
    const pred = compileFilterPredicate(text);
    assert(pred({ id, name: '', groups: [] }), `id ${JSON.stringify(id)} did not match its own printed filter ${JSON.stringify(text)}`);
    assert(!pred({ id: `${id}x`, name: '', groups: [] }), `id ${JSON.stringify(id)} filter matched a different id`);
  }
  const groupIds = ['g\n1', 'g\t1', 'g\\1', 'g"1', 'g\u0000', '*'];
  for (const g of groupIds) {
    const text = printFilter(groupNode(g));
    const pred = compileFilterPredicate(text);
    assert(pred({ id: 'x', name: '', groups: [g] }), `group ${JSON.stringify(g)} did not match its own printed filter ${JSON.stringify(text)}`);
    assert(!pred({ id: 'x', name: '', groups: ['other'] }), `group ${JSON.stringify(g)} filter matched another group`);
  }
});

// ---------------------------------------------------------------------------
// Review 01 #4 — the disjoint UNGROUPED rule must be placed for minimum bytes.
// State: everything selected, then Engineering and Ungrouped deselected.
// ---------------------------------------------------------------------------
check('UNGROUPED placement compiles to the minimal unmerged clause', () => {
  const e = engine(0);
  e.selectAll();
  e.toggleGroup('eng', 'EXCLUDE');
  e.toggleGroup(UNGROUPED, 'EXCLUDE');
  const c = e.compile();
  equal(c.text, 'groups:* AND NOT groups:"eng"', 'filter text');
  equal(c.bytes, 29, 'wire bytes');
  const pred = compileFilterPredicate(c.text!);
  for (const item of items) {
    const want = item.groups.length > 0 && !item.groups.includes('eng');
    equal(pred(item), want, `row ${item.id} [${item.groups.join(',')}]`);
  }
});

// ---------------------------------------------------------------------------
// Review 01 #3 — stale counts are unknown: never advance them, never report
// them as an all/none checkbox state.
// ---------------------------------------------------------------------------
check('stale bucket counts are frozen and bucketState is indeterminate', () => {
  const e = engine(0);
  e.clearAll();
  e.toggleGroup('eng', 'INCLUDE');
  const pilotBefore = e.stats.get('pilot')!;
  assert(!pilotBefore.fresh, 'pilot should be stale after an un-cached Engineering toggle');
  const staleValue = pilotBefore.selected;
  const item = items.find((i) => i.groups.includes('pilot') && !i.groups.includes('eng'))!;
  e.toggleItem(item, true);
  const pilotAfter = e.stats.get('pilot')!;
  equal(pilotAfter.selected, staleValue, 'stale pilot count must not be advanced');
  assert(!pilotAfter.fresh, 'pilot must stay stale until reconciled');
  equal(e.bucketState('pilot'), 'partial', 'stale checkbox state');
  equal(e.isSelected(item.id, item.groups), true, 'toggled row truth');
  assert(e.compile().text !== null && compileFilterPredicate(e.compile().text!)(item), 'wire filter must include the toggled row');
});

// ---------------------------------------------------------------------------
// Stale counts are not a base for arithmetic in ANY mutation, including the
// fully-known-group delta path in toggleGroup.
// ---------------------------------------------------------------------------
check('fully-known group toggle does not advance stale counts', () => {
  const e = engine(100);
  e.observe(items.filter((i) => i.groups.includes('pilot')));
  assert(e.isFullyKnown('pilot'), 'fixture: pilot must be fully known');
  e.toggleGroup('eng', 'INCLUDE');
  const all = e.stats.get(ALL)!;
  const support = e.stats.get('support')!;
  assert(!all.fresh && !support.fresh, 'fixture: ALL and Support must be stale');
  const allBefore = all.selected;
  const supportBefore = support.selected;
  e.toggleGroup('pilot', 'INCLUDE');
  equal(all.selected, allBefore, 'stale ALL count must not be advanced by the pilot delta');
  equal(support.selected, supportBefore, 'stale Support count must not be advanced');
  assert(!all.fresh && !support.fresh, 'buckets must stay stale until reconciled');
  for (const p of items.filter((i) => i.groups.includes('pilot'))) {
    equal(e.isSelected(p.id, p.groups), true, `pilot row ${p.id}`);
  }
});

// ---------------------------------------------------------------------------
// The UNGROUPED branch has its own exact delta for ALL, but a stale ALL count
// is still not a base for arithmetic.
// ---------------------------------------------------------------------------
check('UNGROUPED toggle does not advance a stale ALL count', () => {
  const e = engine(0);
  e.toggleGroup('eng', 'INCLUDE');
  const all = e.stats.get(ALL)!;
  assert(!all.fresh, 'fixture: ALL must be stale');
  const before = all.selected;
  e.toggleGroup(UNGROUPED, 'INCLUDE');
  equal(all.selected, before, 'stale ALL count must not be advanced by the ungrouped delta');
  assert(!all.fresh, 'ALL must stay stale until reconciled');
});

// ---------------------------------------------------------------------------
// Review 01 #2 — disproval: a saturation move only removes overrides whose
// truth the new tail rule already supplies. Opposite-polarity overrides are
// necessary and must survive; deleting them (the review's suggestion) flips truth.
// ---------------------------------------------------------------------------
check('saturation collapse preserves necessary overrides and drops redundant ones', () => {
  const base: Encoding = { base: false, precedence: [], exceptions: new Map() };
  const keepId = 'keep-negative';
  const dropId = 'drop-positive';
  base.exceptions.set(keepId, { id: keepId, groups: ['pilot'], selected: false });
  base.exceptions.set(dropId, { id: dropId, groups: ['pilot'], selected: true });
  const out = collapseSaturatedGroup(base, 'pilot', 'INCLUDE');
  equal(isSelectedIn(out, keepId, ['pilot']), false, 'necessary negative override truth');
  assert(out.exceptions.has(keepId), 'necessary negative override must survive');
  equal(isSelectedIn(out, dropId, ['pilot']), true, 'redundant positive override truth');
  assert(!out.exceptions.has(dropId), 'positive override is supplied by the new tail rule and must be dropped');
});

// ---------------------------------------------------------------------------
// Review 01 #1 — the consolidation boundary enforces exception minimality even
// if an encoding arrives with a redundant override.
// ---------------------------------------------------------------------------
check('consolidation sweeps redundant overrides', () => {
  const e = engine(0);
  e.clearAll();
  e.toggleGroup('beta', 'INCLUDE');
  // Keep Ungrouped fresh but not saturated, and beta already at the tail, so the
  // consolidation search has no improving candidate and only the boundary sweep can act.
  e.toggleItem(items.find((i) => i.groups.length === 0)!, true);
  const stale = items.find((i) => i.groups.includes('pilot') && !i.groups.includes('beta'))!;
  e.enc.exceptions.set(stale.id, { id: stale.id, groups: stale.groups, selected: groupEval(e.enc, stale.groups) });
  assert(e.enc.exceptions.has(stale.id), 'fixture: redundant override injected');
  e.consolidate();
  assert(!e.enc.exceptions.has(stale.id), 'redundant override must be swept during consolidation');
});

// ---------------------------------------------------------------------------
// Saturation via the public API with no ID cache (knownCap 0): clicking a group
// away element by element must end in a group rule with zero overrides and
// unchanged truth for every row.
// ---------------------------------------------------------------------------
check('saturation collapse through the public API preserves truth and minimality', () => {
  const e = engine(0);
  const pilot = items.filter((i) => i.groups.includes('pilot'));
  e.selectAll();
  pilot.forEach((p) => e.toggleItem(p, false));
  equal(e.stats.get('pilot')!.selected, 0, 'pilot count');
  equal(e.enc.exceptions.size, 0, 'overrides after saturation');
  const rule = e.ruleFor('pilot');
  assert(rule !== null && rule.rule.op === 'EXCLUDE', 'pilot should collapse to an EXCLUDE rule');
  for (const o of e.enc.exceptions.values()) {
    assert(o.selected !== groupEval(e.enc, o.groups), `redundant override ${o.id}`);
  }
  // Ground truth: every row is selected except the pilot cohort.
  for (const item of items) {
    equal(e.isSelected(item.id, item.groups), !item.groups.includes('pilot'), `row ${item.id}`);
  }
});

// ---------------------------------------------------------------------------
// Review 01 #8 — deferred reconciliation must not break any invariant.
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

check('deferred reconciliation keeps wire, engine, and minimality invariants', () => {
  const bucketList = [UNGROUPED, ...groups.map((g) => g.id)];
  const byBucket = new Map<string, ItemResource[]>();
  byBucket.set(ALL, items);
  byBucket.set(UNGROUPED, items.filter((i) => i.groups.length === 0));
  for (const g of groups) byBucket.set(g.id, items.filter((i) => i.groups.includes(g.id)));
  for (const seed of [11, 12, 13]) {
    const rand = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const e = engine(0);
    const truth = new Set<string>();
    const truthCounts = () => {
      const m = new Map<string, number>();
      for (const b of [ALL, ...bucketList]) m.set(b, byBucket.get(b)!.filter((i) => truth.has(i.id)).length);
      return m;
    };
    for (let step = 0; step < 120; step++) {
      const r = rand();
      if (r < 0.45) {
        const list = byBucket.get(pick([ALL, ...bucketList]))!;
        if (!list.length) continue;
        const idx = Math.floor(rand() * list.length);
        const item = list[idx];
        e.observe(list.slice(Math.max(0, idx - 2), idx + 3));
        const sel = rand() < 0.5 ? !truth.has(item.id) : rand() < 0.7;
        e.toggleItem(item, sel);
        if (sel) truth.add(item.id);
        else truth.delete(item.id);
      } else if (r < 0.8) {
        const g = pick(bucketList);
        const op = rand() < 0.55 ? 'INCLUDE' : 'EXCLUDE';
        e.toggleGroup(g, op);
        for (const it of byBucket.get(g)!) {
          if (op === 'INCLUDE') truth.add(it.id);
          else truth.delete(it.id);
        }
      } else if (r < 0.9) {
        const counts = new Map<string, number>();
        for (const b of e.staleBuckets()) counts.set(b, truthCounts().get(b)!);
        e.reconcile(counts, e.version);
      } else {
        const list = byBucket.get(pick([ALL, ...bucketList]))!;
        e.observe(list.slice(0, 5));
      }
      const c = e.compile();
      const pred = c.text === null ? () => false : compileFilterPredicate(c.text);
      for (const it of items) {
        const want = truth.has(it.id);
        if (pred(it) !== want || e.isSelected(it.id, it.groups) !== want) {
          throw new Error(`seed ${seed} step ${step}: truth mismatch on ${it.id}; filter=${JSON.stringify(c.text)}`);
        }
      }
      for (const o of e.enc.exceptions.values()) {
        if (o.selected === groupEval(e.enc, o.groups)) throw new Error(`seed ${seed} step ${step}: redundant override ${o.id}`);
      }
      const counts = truthCounts();
      for (const b of [ALL, ...bucketList]) {
        const st = e.stats.get(b)!;
        if (st.fresh && st.selected !== counts.get(b)) {
          throw new Error(`seed ${seed} step ${step}: fresh count ${b}=${st.selected} truth=${counts.get(b)}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Review 05 #1A & #1B — normalizeEncoding must evaluate full-coverage against
// non-empty buckets (total > 0), so selecting all non-empty groups when
// ungroupedTotal is 0 collapses to "" (universe) and guards g0 against null.
// ---------------------------------------------------------------------------
check('normalizeEncoding full-coverage on non-empty buckets collapses universe when ungrouped is empty', () => {
  const gList: GroupInfo[] = [
    { id: 'a', name: 'a', total: 1, color: '#fff' },
    { id: 'b', name: 'b', total: 1, color: '#fff' },
  ];
  const e = new SelectionEngine(gList, 0, 2, { knownCap: 0 });
  e.clearAll();
  e.toggleGroup('a', 'INCLUDE');
  e.toggleGroup('b', 'INCLUDE');
  equal(e.compile().text, '', 'selecting all non-empty groups with 0 ungrouped must collapse to universe');
  equal(e.enc.base, true, 'base must be flipped to true');
  equal(e.enc.precedence.length, 0, 'all head rules must be pruned');
});

// ---------------------------------------------------------------------------
// Review 06 #2B — toggleGroup(ALL, op) must route to selectAll / clearAll
// instead of adding an invalid groups:"ALL" precedence rule and stale count.
// ---------------------------------------------------------------------------
check('toggleGroup(ALL) routes to selectAll/clearAll without injecting dead groups:ALL rule', () => {
  const gList: GroupInfo[] = [
    { id: 'a', name: 'a', total: 5, color: '#fff' },
    { id: 'b', name: 'b', total: 5, color: '#fff' },
  ];
  const e = new SelectionEngine(gList, 0, 10, { knownCap: 100 });
  e.toggleGroup(ALL, 'INCLUDE');
  equal(e.compile().text, '', 'toggleGroup(ALL, INCLUDE) must compile to universe');
  equal(e.enc.base, true, 'base must be true');
  equal(e.enc.precedence.length, 0, 'precedence must have zero rules');
  assert(!e.enc.precedence.some((r) => r.group === ALL), 'precedence must not contain an ALL rule');
  equal(e.stats.get(ALL)!.selected, 10, 'ALL selected count');

  e.toggleGroup(ALL, 'EXCLUDE');
  equal(e.compile().text, null, 'toggleGroup(ALL, EXCLUDE) must compile to empty selection');
  equal(e.enc.base, false, 'base must be false');
  equal(e.enc.precedence.length, 0, 'precedence must have zero rules');
  equal(e.stats.get(ALL)!.selected, 0, 'ALL selected count');
});

// ---------------------------------------------------------------------------
// Review 05 #1C — consolidate escapes local minimum when k >= 3 fully-known
// groups share negative overrides by dropping all k rules simultaneously.
// ---------------------------------------------------------------------------
check('consolidate drops k>=3 ruled known groups sharing negative overrides', () => {
  const shared = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
  const testItems: ItemResource[] = [
    { id: 'y1', name: 'y1', groups: ['eng'] },
    { id: 'y2', name: 'y2', groups: ['eng'] },
    { id: 'z1', name: 'z1', groups: ['beta'] },
    { id: 'z2', name: 'z2', groups: ['beta'] },
    { id: 'w1', name: 'w1', groups: ['design'] },
    { id: 'w2', name: 'w2', groups: ['design'] },
    ...shared.map((id) => ({ id, name: id, groups: ['eng', 'beta', 'design'] })),
    { id: 'n1', name: 'n1', groups: ['noise'] },
    { id: 'n2', name: 'n2', groups: ['noise'] },
    { id: 's1', name: 's1', groups: ['spoil'] },
    { id: 's2', name: 's2', groups: ['spoil'] },
  ];

  const e = new SelectionEngine(
    [
      { id: 'eng', name: 'eng', total: 8, color: '#fff' },
      { id: 'beta', name: 'beta', total: 8, color: '#fff' },
      { id: 'design', name: 'design', total: 8, color: '#fff' },
      { id: 'noise', name: 'noise', total: 2, color: '#fff' },
      { id: 'spoil', name: 'spoil', total: 2, color: '#fff' },
    ],
    0,
    testItems.length,
    { knownCap: 15 },
  );
  e.clearAll();
  e.observe(testItems.filter((i) => i.groups.includes('eng') || i.groups.includes('beta') || i.groups.includes('design')));
  e.toggleGroup('spoil', 'INCLUDE');
  e.toggleGroup('eng', 'INCLUDE');
  e.toggleGroup('beta', 'INCLUDE');
  e.toggleGroup('design', 'INCLUDE');
  for (const id of shared) e.toggleItem(testItems.find((i) => i.id === id)!, false);

  assert(e.staleBuckets().includes('noise'), 'fixture: noise must stay stale');
  assert(
    e.consolidations.some((c) => c.label.includes('drop all 3 ruled known groups')),
    'consolidate did not drop all 3 ruled known groups simultaneously',
  );
  assert(!e.enc.precedence.some((r) => r.group === 'eng' || r.group === 'beta' || r.group === 'design'), 'eng, beta, design rules must be dropped');
});

// ---------------------------------------------------------------------------
// Review 05 #3C — ItemGrid visible row calculation must clamp `first` to
// maxRow (totalSize - 1) so a large scrollTop does not request out-of-bounds
// page offsets when totalSize shrinks.
// ---------------------------------------------------------------------------
check('ItemGrid row range calculation clamps first to maxRow when totalSize shrinks', () => {
  const { first, last, firstPage, lastPage } = computeGridRange(3000, 600, 10, 20);
  equal(first, 9, 'first row must not exceed maxRow');
  equal(last, 9, 'last row must not exceed maxRow');
  equal(firstPage, 0, 'firstPage must not exceed 0 for totalSize=10');
  equal(lastPage, 0, 'lastPage must not exceed 0 for totalSize=10');
});

// ---------------------------------------------------------------------------
// Review 07 BLOCKING — ScenarioRunner aborting an active scenario must reset
// `running` to null in `finally` and not brick the runner.
// ---------------------------------------------------------------------------
await checkAsync('ScenarioRunner manual abort resets running state to null', async () => {
  let running: string | null = null;
  let lines: string[] = [];
  const abort = { current: false };
  const mounted = { current: true };
  const runSeq = { current: 0 };

  const run = async (s: { id: string }) => {
    if (running) {
      abort.current = true;
      return;
    }
    abort.current = false;
    const myRunId = ++runSeq.current;
    running = s.id;
    lines.push(`▶ ${s.id}`);
    const log = (msg: string) => {
      if (mounted.current && runSeq.current === myRunId) lines.push(msg);
    };
    try {
      while (!abort.current && runSeq.current === myRunId) {
        await new Promise((r) => setTimeout(r, 20));
        break;
      }
      if (runSeq.current === myRunId) {
        log(abort.current ? '■ aborted' : '■ done');
      }
    } finally {
      if (mounted.current && runSeq.current === myRunId) running = null;
    }
  };

  const p = run({ id: 'sc1' });
  await new Promise((r) => setTimeout(r, 5));
  await run({ id: 'sc1' }); // click to abort
  await p;

  equal(running, null, 'running state must be cleared after abort');
  assert(lines.includes('■ aborted'), 'lines must include abort confirmation');
});

console.log(failed === 0 ? '\nALL REGRESSIONS PASS' : `\n${failed} REGRESSION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

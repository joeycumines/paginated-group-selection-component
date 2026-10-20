import { compileFilterPredicate } from './filterParser';
import { SelectionEngine, groupEval } from './SelectionEngine';
import { ALL, UNGROUPED, type BucketId, type GroupInfo, type ItemResource, type Op } from './types';

export interface PropertyTestOptions {
  steps: number;
  seed: number;
  knownCap: number;
  pageSize: number;
  /** Probability of reconciling stale buckets after a step; < 1 exercises the stale-count paths. */
  reconcileProbability?: number;
  onProgress?: (done: number) => void;
}

export interface PropertyTestResult {
  ok: boolean;
  steps: number;
  failures: string[];
  maxBytes: number;
  maxOverrides: number;
  naiveMaxBytes: number;
  consolidations: number;
  actionCounts: Record<string, number>;
  durationMs: number;
}

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

export function runPropertyTest(
  items: ItemResource[],
  groups: GroupInfo[],
  opts: PropertyTestOptions,
): PropertyTestResult {
  const t0 = performance.now();
  const rand = rng(opts.seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const ungroupedTotal = items.filter((i) => i.groups.length === 0).length;
  const engine = new SelectionEngine(groups, ungroupedTotal, items.length, { knownCap: opts.knownCap });
  const truth = new Set<string>();
  const buckets: BucketId[] = [UNGROUPED, ...groups.map((g) => g.id)];
  const byBucket = new Map<BucketId, ItemResource[]>();
  byBucket.set(ALL, items);
  byBucket.set(UNGROUPED, items.filter((i) => i.groups.length === 0));
  for (const g of groups) byBucket.set(g.id, items.filter((i) => i.groups.includes(g.id)));

  const failures: string[] = [];
  let maxBytes = 0;
  let maxOverrides = 0;
  let naiveMaxBytes = 0;
  const actionCounts: Record<string, number> = {};
  const count = (k: string) => (actionCounts[k] = (actionCounts[k] ?? 0) + 1);

  const truthCounts = () => {
    const c = new Map<BucketId, number>();
    for (const b of [ALL, ...buckets]) c.set(b, byBucket.get(b)!.reduce((a, i) => a + (truth.has(i.id) ? 1 : 0), 0));
    return c;
  };

  const observePage = () => {
    const view = pick([ALL, ...buckets]);
    const list = byBucket.get(view)!;
    if (list.length === 0) return;
    const offset = Math.floor(rand() * list.length);
    engine.observe(list.slice(offset, offset + opts.pageSize));
  };

  for (let step = 0; step < opts.steps; step++) {
    const r = rand();
    if (r < 0.42) {
      const view = pick([ALL, ...buckets]);
      const list = byBucket.get(view)!;
      if (list.length === 0) continue;
      // Emulate the RHS: the page containing the item has been fetched (so S_x is known).
      const idx = Math.floor(rand() * list.length);
      const pageStart = idx - (idx % opts.pageSize);
      engine.observe(list.slice(pageStart, pageStart + opts.pageSize));
      const item = list[idx];
      const sel = rand() < 0.5 ? !truth.has(item.id) : rand() < 0.7;
      count('toggleItem');
      engine.toggleItem(item, sel);
      if (sel) truth.add(item.id);
      else truth.delete(item.id);
    } else if (r < 0.72) {
      const g = pick(buckets);
      const op: Op = rand() < 0.55 ? 'INCLUDE' : 'EXCLUDE';
      count(`toggleGroup:${op}`);
      engine.toggleGroup(g, op);
      for (const it of byBucket.get(g)!) {
        if (op === 'INCLUDE') truth.add(it.id);
        else truth.delete(it.id);
      }
    } else if (r < 0.76) {
      count('selectAll');
      engine.selectAll();
      for (const it of items) truth.add(it.id);
    } else if (r < 0.8) {
      count('clearAll');
      engine.clearAll();
      truth.clear();
    } else {
      count('observePage');
      observePage();
    }

    // Reconcile stale buckets exactly as the UI does, but only sometimes: the UI debounces
    // and awaits the network, so mutations regularly run against stale counts.
    if (engine.staleBuckets().length && rand() < (opts.reconcileProbability ?? 1)) {
      const tc = truthCounts();
      const counts = new Map<BucketId, number>();
      for (const b of engine.staleBuckets()) counts.set(b, tc.get(b)!);
      engine.reconcile(counts, engine.version);
    }

    // ---- Verification ----
    const compiled = engine.compile();
    maxBytes = Math.max(maxBytes, compiled.bytes);
    maxOverrides = Math.max(maxOverrides, engine.enc.exceptions.size);
    naiveMaxBytes = Math.max(naiveMaxBytes, Array.from(truth).reduce((a, id) => a + id.length + 6, 0));

    let pred: (i: ItemResource) => boolean;
    try {
      pred = compiled.text === null ? () => false : compileFilterPredicate(compiled.text);
    } catch (e) {
      failures.push(`step ${step}: filter failed to parse: ${(e as Error).message} :: ${compiled.text}`);
      break;
    }
    let bad = 0;
    for (const it of items) {
      const want = truth.has(it.id);
      if (pred(it) !== want) {
        if (bad++ < 3) failures.push(`step ${step}: wire filter disagrees on ${it.id} [${it.groups.join(',')}] want=${want}`);
      }
      if (engine.isSelected(it.id, it.groups) !== want) {
        if (bad++ < 3) failures.push(`step ${step}: engine.isSelected disagrees on ${it.id} want=${want}`);
      }
    }
    for (const o of engine.enc.exceptions.values()) {
      if (o.selected === groupEval(engine.enc, o.groups)) {
        failures.push(`step ${step}: memory invariant violated — redundant override ${o.id}`);
        bad++;
        break;
      }
    }
    const seen = new Set<string>();
    for (const rule of engine.enc.precedence) {
      if (seen.has(rule.group)) {
        failures.push(`step ${step}: duplicate rule for ${rule.group}`);
        bad++;
      }
      seen.add(rule.group);
    }
    const tc = truthCounts();
    for (const b of [ALL, ...buckets]) {
      const st = engine.stats.get(b)!;
      if (st.fresh && st.selected !== tc.get(b)) {
        failures.push(`step ${step}: fresh count for ${b} is ${st.selected}, truth ${tc.get(b)}`);
        bad++;
      }
      if (!st.fresh && st.total > 0 && engine.bucketState(b) !== 'partial') {
        failures.push(`step ${step}: stale bucket ${b} rendered as ${engine.bucketState(b)}, not partial`);
        bad++;
      }
    }
    if (bad) break;
    opts.onProgress?.(step + 1);
  }

  return {
    ok: failures.length === 0,
    steps: opts.steps,
    failures,
    maxBytes,
    maxOverrides,
    naiveMaxBytes,
    consolidations: engine.consolidations.length,
    actionCounts,
    durationMs: performance.now() - t0,
  };
}

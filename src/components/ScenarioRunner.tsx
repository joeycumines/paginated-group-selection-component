import { useRef, useState } from 'react';
import type { SelectionEngine } from '../engine/SelectionEngine';
import { runPropertyTest, type PropertyTestResult } from '../engine/propertyTest';
import { UNGROUPED, type BucketId, type GroupInfo, type ItemResource } from '../engine/types';
import type { MockServer } from '../server/mockServer';
import { cn } from '../utils/cn';
import { fmt, Spinner } from './ui';

export interface ScenarioCtx {
  engine: SelectionEngine;
  server: MockServer;
  groups: GroupInfo[];
  setView: (b: BucketId) => void;
  log: (msg: string, kind?: LogKind) => void;
  sleep: (ms: number) => Promise<void>;
  waitFresh: () => Promise<void>;
  fetchItems: (filter: string, size: number, purpose: string) => Promise<ItemResource[]>;
  showFilter: () => void;
  aborted: () => boolean;
}
type LogKind = 'info' | 'ok' | 'warn' | 'filter' | 'step';

interface Scenario {
  id: string;
  title: string;
  blurb: string;
  run: (ctx: ScenarioCtx) => Promise<void>;
}

const fmtFilter = (t: string | null) => (t === null ? '∅ (nothing selected)' : t === '' ? '"" (universe)' : t);

const SCENARIOS: Scenario[] = [
  {
    id: 'overlap',
    title: '1 · Multi-group overlap trap on unknown rows',
    blurb: 'Select G_a, deselect overlapping G_b, then re-select one x ∈ G_a∩G_b from the grid. Shows the knowledge gap, server reconciliation, and exact O(|S_x|) count updates.',
    async run(c) {
      c.engine.clearAll();
      c.log('Select Engineering (1600 rows, mostly unfetched).', 'step');
      c.engine.toggleGroup('eng', 'INCLUDE');
      c.showFilter();
      c.log(`Peers overlapping on unknown rows go stale: ${c.engine.staleBuckets().join(', ')} → debounced count queries List(filter=(sel) AND groups:"g", page_size=0).`, 'warn');
      await c.waitFresh();
      if (c.aborted()) return;
      c.log(`Reconciled. Support now ${c.engine.stats.get('support')!.selected}/${c.engine.stats.get('support')!.total} selected (= |eng ∩ support|, unknowable client-side).`, 'ok');
      c.log('Deselect Support → (support, EXCLUDE) appended after (eng, INCLUDE); every unknown row in eng∩support is now deterministically excluded.', 'step');
      c.engine.toggleGroup('support', 'EXCLUDE');
      c.showFilter();
      await c.waitFresh();
      if (c.aborted()) return;
      c.log(`Engineering count dropped to ${c.engine.stats.get('eng')!.selected}/${c.engine.stats.get('eng')!.total} (minus the overlap) with 0 IDs in memory.`, 'ok');
      c.setView('support');
      const [x] = await c.fetchItems('groups:"eng" AND groups:"support"', 1, 'scenario: find x ∈ eng∩support');
      if (!x || c.aborted()) return;
      c.log(`Re-select ${x.id} ∈ [${x.groups.join(', ')}] from the grid. GroupEval = false (support rule wins), desired = true ⇒ one override in ℰ.`, 'step');
      c.engine.toggleItem(x, true);
      c.showFilter();
      c.log(`Support is now Partial (${c.engine.stats.get('support')!.selected}/${c.engine.stats.get('support')!.total}) — exact, no network, because S_x is known from the resource.`, 'ok');
    },
  },
  {
    id: 'saturate',
    title: '2 · Saturation collapse (C_g = N_g ⇒ 0 IDs in memory)',
    blurb: 'Click every row of the 7-row Pilot cohort one by one. Overrides accumulate, then collapse into a single group rule.',
    async run(c) {
      c.engine.clearAll();
      c.setView('pilot');
      const rows = await c.fetchItems('groups:"pilot"', 50, 'scenario: page Pilot cohort');
      c.engine.observe(rows);
      for (let i = 0; i < rows.length; i++) {
        if (c.aborted()) return;
        c.engine.toggleItem(rows[i], true);
        c.log(`click ${i + 1}/${rows.length}: |ℰ| = ${c.engine.enc.exceptions.size}, ℒ = [${c.engine.enc.precedence.map((r) => (r.op === 'INCLUDE' ? '+' : '−') + r.group).join(', ')}]`, 'info');
        c.showFilter();
        await c.sleep(380);
      }
      c.log(`Done: ${rows.length} individual clicks ⇒ ${c.engine.enc.exceptions.size} overrides, ${c.engine.compile().bytes} wire bytes.`, 'ok');
    },
  },
  {
    id: 'flip',
    title: '3 · >50 % polarity flip ("just these" → "all except these")',
    blurb: 'Beta testers has 15 rows, all cached once paged (N ≤ knownCap). Selecting rows one by one flips the encoding when exclusion becomes cheaper, then shrinks to 0 IDs.',
    async run(c) {
      c.engine.clearAll();
      c.setView('beta');
      const rows = await c.fetchItems('groups:"beta"', 50, 'scenario: page Beta testers');
      c.engine.observe(rows);
      c.log(`Group fully known: ${c.engine.isFullyKnown('beta')} (${rows.length} IDs cached).`, 'info');
      for (let i = 0; i < rows.length; i++) {
        if (c.aborted()) return;
        const before = c.engine.compile();
        c.engine.toggleItem(rows[i], true);
        const after = c.engine.compile();
        const flipped = before.tokens.groups === 0 && after.tokens.groups > 0;
        c.log(`click ${i + 1}/${rows.length}: ${after.tokens.ids} id literal(s), ${after.tokens.groups} group literal(s), ${after.bytes} B${flipped ? '  ⇐ FLIPPED: exclusion encoding now cheaper' : ''}`, flipped ? 'ok' : 'info');
        if (flipped || i === rows.length - 1 || i < 2) c.showFilter();
        await c.sleep(flipped ? 900 : 300);
      }
    },
  },
  {
    id: 'coverage',
    title: '4 · Full coverage ⇒ β absorption + head pruning',
    blurb: 'Select every group then Ungrouped. ℒ covers the universe, so β becomes free and the entire chain collapses to the empty filter; a subsequent deselect yields a single NOT clause.',
    async run(c) {
      c.engine.clearAll();
      for (const g of c.groups) {
        if (c.aborted()) return;
        c.engine.toggleGroup(g.id, 'INCLUDE');
        c.log(`+${g.id}: ℒ has ${c.engine.enc.precedence.length} rule(s), β=${c.engine.enc.base}`, 'info');
        await c.sleep(250);
      }
      c.showFilter();
      c.log('All K groups included ⇒ Ungrouped (0/N, disjoint, fresh) collapses to EXCLUDE; full coverage lets β absorb the INCLUDE block ⇒ groups:*', 'ok');
      await c.waitFresh();
      if (c.aborted()) return;
      c.engine.toggleGroup(UNGROUPED, 'INCLUDE');
      c.showFilter();
      c.log('Ungrouped included too ⇒ β=true, ℒ=∅: empty filter (universe).', 'ok');
      await c.sleep(700);
      c.engine.toggleGroup('legal', 'EXCLUDE');
      c.showFilter();
      c.log('Deselect Legal ⇒ single NOT clause. Peers overlapping Legal reconcile from the server.', 'step');
      await c.waitFresh();
      if (c.aborted()) return;
      c.setView('legal');
      const [x] = await c.fetchItems('groups:"legal"', 1, 'scenario: pick a legal row');
      if (!x || c.aborted()) return;
      c.engine.toggleItem(x, true);
      c.showFilter();
      c.log(`Re-selected ${x.id} individually ⇒ NOT groups:"legal" OR id="${x.id}"`, 'ok');
    },
  },
  {
    id: 'carve',
    title: '5 · Select-all, then carve out',
    blurb: '"All except these" root: Select All, deselect Support, deselect two Engineering rows, re-select a Support row.',
    async run(c) {
      c.engine.selectAll();
      c.showFilter();
      await c.sleep(400);
      c.engine.toggleGroup('support', 'EXCLUDE');
      c.showFilter();
      await c.waitFresh();
      if (c.aborted()) return;
      c.setView('eng');
      const rows = await c.fetchItems('groups:"eng" AND NOT groups:"support"', 2, 'scenario: two eng-only rows');
      for (const r of rows) {
        if (c.aborted()) return;
        c.engine.toggleItem(r, false);
        await c.sleep(300);
      }
      c.showFilter();
      c.log('Two negative overrides attach as AND NOT (…).', 'info');
      const [s] = await c.fetchItems('groups:"support"', 1, 'scenario: one support row');
      if (!s || c.aborted()) return;
      c.setView('support');
      c.engine.toggleItem(s, true);
      c.showFilter();
      c.log('One positive override attaches as OR id=… ; Support becomes Partial (1/N).', 'ok');
    },
  },
];

interface LogLine {
  kind: LogKind;
  msg: string;
}

export function ScenarioRunner({
  engine,
  server,
  groups,
  setView,
  knownCap,
  pageSize,
}: {
  engine: SelectionEngine;
  server: MockServer;
  groups: GroupInfo[];
  setView: (b: BucketId) => void;
  knownCap: number;
  pageSize: number;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const abort = useRef(false);
  const [pt, setPt] = useState<PropertyTestResult | null>(null);
  const [ptRunning, setPtRunning] = useState(false);

  const run = async (s: Scenario) => {
    if (running) {
      abort.current = true;
      return;
    }
    abort.current = false;
    setRunning(s.id);
    setLines([{ kind: 'step', msg: `▶ ${s.title}` }]);
    const log = (msg: string, kind: LogKind = 'info') => setLines((l) => [...l, { kind, msg }]);
    const ctx: ScenarioCtx = {
      engine,
      server,
      groups,
      setView,
      log,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      aborted: () => abort.current,
      waitFresh: async () => {
        const t0 = Date.now();
        while (engine.staleBuckets().length && Date.now() - t0 < 8000 && !abort.current) {
          await new Promise((r) => setTimeout(r, 60));
        }
      },
      fetchItems: async (filter, size, purpose) => (await server.listItems({ filter, pageSize: size, offset: 0, purpose })).items,
      showFilter: () => log(fmtFilter(engine.compile().text), 'filter'),
    };
    try {
      await s.run(ctx);
      log(abort.current ? '■ aborted' : '■ done', abort.current ? 'warn' : 'ok');
    } catch (e) {
      log(`error: ${(e as Error).message}`, 'warn');
    } finally {
      setRunning(null);
    }
  };

  const runPt = () => {
    setPtRunning(true);
    setTimeout(() => {
      const res = runPropertyTest(server.items, server.groups, { steps: 400, seed: Date.now() % 100000, knownCap, pageSize });
      setPt(res);
      setPtRunning(false);
    }, 20);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_1fr_300px] gap-3">
      <div className="min-h-0 space-y-1.5 overflow-auto pr-1">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => run(s)}
            className={cn(
              'block w-full rounded-md border px-2.5 py-1.5 text-left transition-colors',
              running === s.id ? 'border-sky-500 bg-sky-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600',
              running && running !== s.id && 'opacity-50',
            )}
          >
            <div className="flex items-center gap-2 text-[12px] font-medium text-slate-100">
              {running === s.id && <Spinner className="text-sky-400" />}
              {s.title}
              {running === s.id && <span className="ml-auto text-[10px] text-slate-400">click to abort</span>}
            </div>
            <div className="mt-0.5 text-[10.5px] leading-snug text-slate-500">{s.blurb}</div>
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-auto rounded-md border border-slate-800 bg-slate-950/60 p-2 font-mono text-[11px] leading-5">
        {lines.length === 0 && <div className="text-slate-600">Pick a scripted walkthrough on the left — it drives the real engine and server; watch the panes update live.</div>}
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap break-all',
              l.kind === 'info' && 'text-slate-400',
              l.kind === 'ok' && 'text-emerald-300',
              l.kind === 'warn' && 'text-amber-300',
              l.kind === 'step' && 'mt-1 text-slate-100',
              l.kind === 'filter' && 'pl-3 text-sky-300 before:mr-1 before:text-slate-600 before:content-["filter:"]',
            )}
          >
            {l.msg}
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-col rounded-md border border-slate-800 bg-slate-900 p-2.5">
        <div className="text-[12px] font-medium text-slate-100">Randomised property test</div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-slate-500">
          400 random item/group/select-all/clear/page-observe ops against a fresh engine over this {fmt(server.items.length)}-row dataset. After <em>every</em> op the compiled filter is parsed and
          evaluated server-side and must equal a naive ground-truth set; also checks the ℰ minimality invariant and exact fresh counts.
        </p>
        <button
          onClick={runPt}
          disabled={ptRunning}
          className="mt-2 rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-[12px] font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
        >
          {ptRunning ? 'running…' : 'Run property test'}
        </button>
        {pt && (
          <div className="mt-2 min-h-0 flex-1 overflow-auto font-mono text-[10.5px] leading-5">
            <div className={cn('text-[12px] font-semibold', pt.ok ? 'text-emerald-400' : 'text-rose-400')}>{pt.ok ? `✓ PASS — ${pt.steps} steps` : `✗ FAIL`}</div>
            <div className="text-slate-400">
              max wire bytes <span className="text-slate-200">{fmt(pt.maxBytes)}</span> vs naive id list <span className="text-slate-200">{fmt(pt.naiveMaxBytes)}</span>
            </div>
            <div className="text-slate-400">
              max |ℰ| <span className="text-slate-200">{pt.maxOverrides}</span> · consolidations <span className="text-slate-200">{pt.consolidations}</span> · {Math.round(pt.durationMs)} ms
            </div>
            <div className="text-slate-500">
              {Object.entries(pt.actionCounts)
                .map(([k, v]) => `${k}×${v}`)
                .join('  ')}
            </div>
            {pt.failures.map((f, i) => (
              <div key={i} className="text-rose-300">
                {f}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


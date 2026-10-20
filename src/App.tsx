import { useEffect, useMemo, useState } from 'react';
import { EnginePanel } from './components/EnginePanel';
import { GroupPane } from './components/GroupPane';
import { ItemGrid } from './components/ItemGrid';
import { NetworkLog } from './components/NetworkLog';
import { ScenarioRunner } from './components/ScenarioRunner';
import { Spinner, fmt } from './components/ui';
import { WirePanel } from './components/WirePanel';
import { countQueryFilter, SelectionEngine } from './engine/SelectionEngine';
import { ALL, type BucketId } from './engine/types';
import { useEngineVersion, useServerLog } from './hooks/useStores';
import { DEFAULT_SPECS, MockServer } from './server/mockServer';
import { cn } from './utils/cn';

const DATASET_SIZE = 4000;

export default function App() {
  const [seed, setSeed] = useState(99);
  const [knownCap, setKnownCap] = useState(100);
  const [pageSize, setPageSize] = useState(20);
  const [latency, setLatency] = useState(150);
  const [autoVerify, setAutoVerify] = useState(true);
  const [view, setView] = useState<BucketId>(ALL);
  const [dock, setDock] = useState<'scenarios' | 'network'>('scenarios');

  const server = useMemo(() => new MockServer(seed, DATASET_SIZE, DEFAULT_SPECS), [seed]);
  useEffect(() => {
    server.latencyRange = [latency * 0.5, latency * 1.5];
  }, [server, latency]);

  // Bootstrap: one ListGroups call gives N_g for every bucket; the engine needs nothing else.
  const [engine, setEngine] = useState<SelectionEngine | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEngine(null);
    setView(ALL);
    server.listGroups().then((res) => {
      if (cancelled) return;
      setEngine(new SelectionEngine(res.groups, res.ungroupedTotal, res.totalSize, { knownCap }));
    });
    return () => {
      cancelled = true;
    };
  }, [server, knownCap]);

  const version = useEngineVersion(engine);
  useServerLog(server);

  // Reconciliation: after a group-level mutation some bucket counts are unknowable client-side.
  // Debounce, then issue List(filter=(selection) AND scope, page_size=0) per stale bucket; drop
  // the response if the state version moved on (the effect re-runs on the new version anyway).
  useEffect(() => {
    if (!engine) return;
    const stale = engine.staleBuckets();
    if (stale.length === 0) return;
    const v = engine.version;
    let cancelled = false;
    const t = setTimeout(async () => {
      const sel = engine.compile().text;
      const results = await Promise.all(
        stale.map(async (b): Promise<[BucketId, number]> => {
          const f = countQueryFilter(sel, b);
          if (f === null) return [b, 0];
          const res = await server.listItems({ filter: f, pageSize: 0, purpose: `reconcile count: ${b}` });
          return [b, res.totalSize];
        }),
      );
      if (cancelled) return;
      engine.reconcile(new Map(results), v);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [engine, version, server]);

  // Oracle (demo-only): evaluate the compiled filter over the full dataset and compare.
  const oracle = useMemo(() => {
    if (!engine || !autoVerify) return null;
    const text = engine.compile().text;
    const set = server.oracleSelected(text);
    const counts = server.countsForSet(set);
    let ok = true;
    for (const [b, n] of counts) {
      const st = engine.stats.get(b)!;
      if (st.fresh && st.selected !== n) ok = false;
    }
    return { set, counts, ok };
  }, [engine, version, autoVerify, server]);

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-200 antialiased">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-slate-800 bg-slate-900/80 px-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[13px] font-semibold tracking-tight text-slate-100">Selection Lattice</h1>
          <span className="text-[11px] text-slate-500">precedence deque · exception table · min-byte AIP-160 synthesis</span>
        </div>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-slate-400">
          <span>
            N = <span className="font-mono text-slate-200">{fmt(server.items.length)}</span> rows · K = <span className="font-mono text-slate-200">{server.groups.length}</span> groups ·
            ungrouped <span className="font-mono text-slate-200">{fmt(server.ungroupedTotal)}</span>
          </span>
          <label className="flex items-center gap-1.5">
            page_size
            <select value={pageSize} onChange={(e) => setPageSize(+e.target.value)} className="rounded border border-slate-700 bg-slate-800 px-1 py-0.5 font-mono text-slate-200">
              {[10, 20, 50].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5" title="Groups with N_g ≤ knownCap keep a full ID cache (bounded memory) enabling polarity flips and offline reconciliation">
            knownCap
            <select value={knownCap} onChange={(e) => setKnownCap(+e.target.value)} className="rounded border border-slate-700 bg-slate-800 px-1 py-0.5 font-mono text-slate-200">
              {[0, 20, 100, 300].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            latency
            <input type="range" min={0} max={600} step={10} value={latency} onChange={(e) => setLatency(+e.target.value)} className="w-20 accent-sky-500" />
            <span className="w-10 font-mono text-slate-200">{latency}ms</span>
          </label>
          <button onClick={() => setSeed((s) => s + 1)} className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-slate-200 hover:border-slate-500">
            new dataset
          </button>
        </div>
      </header>

      {!engine ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-slate-400">
          <Spinner /> ListGroups() — bootstrapping bucket totals…
        </div>
      ) : (
        <>
          <main className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_400px] gap-3 p-3">
            <GroupPane engine={engine} groups={server.groups} view={view} onView={setView} oracleCounts={oracle?.counts ?? null} />
            <ItemGrid key={`${view}:${pageSize}`} engine={engine} server={server} groups={server.groups} view={view} pageSize={pageSize} version={version} oracleSet={oracle?.set ?? null} />
            <div className="grid min-h-0 grid-rows-[minmax(0,1.15fr)_minmax(0,1fr)] gap-3">
              <WirePanel engine={engine} groups={server.groups} oracleOk={oracle ? oracle.ok : null} autoVerify={autoVerify} onAutoVerify={setAutoVerify} />
              <EnginePanel engine={engine} groups={server.groups} />
            </div>
          </main>

          <section className="flex h-[260px] shrink-0 flex-col border-t border-slate-800 bg-slate-900/60">
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-800 px-3">
              {(
                [
                  ['scenarios', 'Walkthroughs & property test'],
                  ['network', `Network log (${server.log.length})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setDock(id)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                    dock === id ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300',
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[10.5px] text-slate-600">
                memory invariant: an untouched or group-aligned row costs 0 bytes · ℒ ≤ K+1 rules · ℰ holds only genuine exceptions
              </span>
            </div>
            <div className="min-h-0 flex-1 p-3">
              {dock === 'scenarios' ? (
                <ScenarioRunner engine={engine} server={server} groups={server.groups} setView={setView} knownCap={knownCap} pageSize={pageSize} />
              ) : (
                <NetworkLog server={server} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

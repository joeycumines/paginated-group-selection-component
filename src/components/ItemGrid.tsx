import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scopeFilter, type SelectionEngine } from '../engine/SelectionEngine';
import { UNGROUPED, type BucketId, type GroupInfo, type ItemResource } from '../engine/types';
import type { MockServer } from '../server/mockServer';
import { cn } from '../utils/cn';
import { bucketLabel, UNGROUPED_COLOR } from './GroupPane';
import { Chip, Panel, TriCheckbox, fmt } from './ui';

const ROW_H = 38;
const OVERSCAN = 4;
const PAGE_CACHE_CAP = 5;

export function computeGridRange(
  scrollTop: number,
  viewportH: number,
  totalSize: number,
  pageSize: number,
  rowH: number = ROW_H,
  overscan: number = OVERSCAN,
): { first: number; last: number; firstPage: number; lastPage: number } {
  if (totalSize <= 0) {
    return { first: 0, last: -1, firstPage: 0, lastPage: 0 };
  }
  const maxRow = totalSize - 1;
  const first = Math.min(maxRow, Math.max(0, Math.floor(scrollTop / rowH) - overscan));
  const last = Math.min(maxRow, Math.ceil((scrollTop + viewportH) / rowH) + overscan);
  const firstPage = Math.floor(first / pageSize);
  const lastPage = Math.max(firstPage, Math.floor(Math.max(last, 0) / pageSize));
  return { first, last, firstPage, lastPage };
}

export function ItemGrid({
  engine,
  server,
  groups,
  view,
  pageSize,
  version,
  oracleSet,
}: {
  engine: SelectionEngine;
  server: MockServer;
  groups: GroupInfo[];
  view: BucketId;
  pageSize: number;
  version: number;
  oracleSet: Set<string> | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  // Page cache lives in a ref (LRU bookkeeping is imperative); `tick` triggers re-render.
  const pagesRef = useRef<Map<number, ItemResource[]>>(new Map());
  const [tick, setTick] = useState(0);
  const pages = pagesRef.current;
  const [totalSize, setTotalSize] = useState<number>(engine.stats.get(view)?.total ?? 0);
  const inflight = useRef(new Set<number>());
  const lru = useRef<number[]>([]);
  const [evicted, setEvicted] = useState(0);
  const epoch = useRef(0);
  const visibleRange = useRef<[number, number]>([0, 0]);

  // Reset when the drill-down view or page size changes.
  useEffect(() => {
    epoch.current++;
    inflight.current.clear();
    lru.current = [];
    pagesRef.current = new Map();
    setTick((t) => t + 1);
    setEvicted(0);
    setTotalSize(engine.stats.get(view)?.total ?? 0);
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [view, pageSize, engine]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const { first, last, firstPage, lastPage } = computeGridRange(scrollTop, viewportH, totalSize, pageSize);
  visibleRange.current = [firstPage, lastPage];

  const fetchPage = useCallback(
    async (p: number) => {
      if (inflight.current.has(p)) return;
      inflight.current.add(p);
      const myEpoch = epoch.current;
      try {
        const res = await server.listItems({
          filter: scopeFilter(view),
          pageSize,
          offset: p * pageSize,
          purpose: `grid page ${p + 1} of ${bucketLabel(view, groups)}`,
        });
        if (myEpoch !== epoch.current) return;
        engine.observe(res.items); // feeds the bounded known-ID cache
        setTotalSize(res.totalSize);
        const cache = pagesRef.current;
        cache.set(p, res.items);
        lru.current = [...lru.current.filter((x) => x !== p), p];
        const [vf, vl] = visibleRange.current;
        let ev = 0;
        // Evict least-recently-used pages that are not currently visible.
        const candidates = lru.current.filter((x) => x < vf || x > vl);
        while (lru.current.length > PAGE_CACHE_CAP && candidates.length) {
          const victim = candidates.shift()!;
          lru.current = lru.current.filter((x) => x !== victim);
          cache.delete(victim);
          ev++;
        }
        if (ev) setEvicted((e) => e + ev);
        setTick((t) => t + 1);
      } finally {
        inflight.current.delete(p);
      }
    },
    [server, view, pageSize, engine, groups],
  );

  useEffect(() => {
    if (totalSize === 0) return;
    for (let p = firstPage; p <= lastPage; p++) {
      if (!pages.has(p)) {
        void fetchPage(p);
        continue;
      }
      // A cache hit is an access: move the page to the MRU end so eviction stays LRU.
      if (lru.current[lru.current.length - 1] !== p) {
        lru.current = [...lru.current.filter((x) => x !== p), p];
      }
    }
  }, [firstPage, lastPage, pages, fetchPage, totalSize, tick]);

  const rows = useMemo(() => {
    const out: { idx: number; item: ItemResource | null }[] = [];
    for (let i = first; i <= last; i++) {
      const page = pages.get(Math.floor(i / pageSize));
      out.push({ idx: i, item: page ? (page[i % pageSize] ?? null) : null });
    }
    return out;
  }, [first, last, pages, pageSize, tick]);

  const colorOf = (g: string) => groups.find((x) => x.id === g)?.color ?? '#fff';
  const st = engine.stats.get(view)!;

  return (
    <Panel
      title={
        <span>
          Items · <span className="normal-case tracking-normal text-slate-200">{bucketLabel(view, groups)}</span>
        </span>
      }
      bodyClassName="p-0 flex flex-col"
      right={
        <>
          <span className="font-mono">
            List(filter=<span className="text-sky-300">{JSON.stringify(scopeFilter(view))}</span>, page_size={pageSize})
          </span>
          <span className="text-slate-600">·</span>
          <span>
            total_size <span className="font-mono text-slate-200">{fmt(totalSize)}</span>
          </span>
          <span className="text-slate-600">·</span>
          <span title="Pages resident in the LRU page cache">
            cached <span className="font-mono text-slate-200">{pages.size}</span>/{PAGE_CACHE_CAP} pages
          </span>
          {evicted > 0 && <span className="text-slate-500">({evicted} evicted)</span>}
        </>
      }
    >
      <div className="grid shrink-0 grid-cols-[28px_72px_1fr_minmax(160px,1.3fr)_150px] items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
        <span />
        <span>id</span>
        <span>name</span>
        <span>groups (from resource)</span>
        <span>why selected?</span>
      </div>
      <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ height: totalSize * ROW_H, position: 'relative' }}>
          {rows.map(({ idx, item }) => {
            if (!item) {
              return (
                <div key={idx} style={{ top: idx * ROW_H, height: ROW_H }} className="absolute left-0 right-0 grid grid-cols-[28px_72px_1fr_minmax(160px,1.3fr)_150px] items-center gap-2 border-b border-slate-800/60 px-3">
                  <span className="h-4 w-4 animate-pulse rounded bg-slate-800" />
                  <span className="h-3 w-12 animate-pulse rounded bg-slate-800" />
                  <span className="h-3 w-32 animate-pulse rounded bg-slate-800" />
                  <span className="h-3 w-24 animate-pulse rounded bg-slate-800" />
                  <span className="font-mono text-[10px] text-slate-600">row {idx + 1} · fetching…</span>
                </div>
              );
            }
            const selected = engine.isSelected(item.id, item.groups);
            const why = engine.explain(item.id, item.groups);
            const oracleSel = oracleSet ? oracleSet.has(item.id) : null;
            const mismatch = oracleSel !== null && oracleSel !== selected;
            return (
              <div
                key={item.id}
                style={{ top: idx * ROW_H, height: ROW_H }}
                onClick={() => engine.toggleItem(item, !selected)}
                className={cn(
                  'absolute left-0 right-0 grid cursor-pointer select-none grid-cols-[28px_72px_1fr_minmax(160px,1.3fr)_150px] items-center gap-2 border-b border-slate-800/60 px-3 transition-colors hover:bg-slate-800/50',
                  selected && 'bg-sky-500/[0.07]',
                  mismatch && 'bg-rose-500/20 ring-1 ring-inset ring-rose-500',
                )}
              >
                <TriCheckbox state={selected ? 'all' : 'none'} onClick={() => engine.toggleItem(item, !selected)} />
                <span className="font-mono text-[11.5px] text-slate-300">{item.id}</span>
                <span className="truncate text-[12px] text-slate-200">{item.name}</span>
                <span className="flex flex-wrap gap-1">
                  {item.groups.length === 0 ? (
                    <Chip color={UNGROUPED_COLOR}>∅ ungrouped</Chip>
                  ) : (
                    item.groups.map((g) => (
                      <Chip key={g} color={colorOf(g)}>
                        {g}
                      </Chip>
                    ))
                  )}
                </span>
                <span className="truncate font-mono text-[10.5px]">
                  {why.kind === 'override' && (
                    <span className={why.selected ? 'text-emerald-300' : 'text-rose-300'} title="Explicit override stored in ℰ (costs memory + wire bytes)">
                      ℰ override {why.selected ? '+' : '−'}
                    </span>
                  )}
                  {why.kind === 'rule' && (
                    <span className={why.rule.op === 'INCLUDE' ? 'text-emerald-400/80' : 'text-rose-400/80'} title="Inherited from the highest-precedence rule in ℒ matching this row's groups (0 bytes)">
                      ℒ#{why.index + 1} {why.rule.op === 'INCLUDE' ? '+' : '−'}
                      {why.rule.group === UNGROUPED ? '∅' : why.rule.group}
                    </span>
                  )}
                  {why.kind === 'base' && (
                    <span className="text-slate-500" title="No rule matches ⇒ falls back to the global baseline β (0 bytes)">
                      β = {String(why.base)}
                    </span>
                  )}
                  {mismatch && <span className="ml-1 text-rose-400">✗ oracle</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-slate-800 bg-slate-900 px-3 py-1 text-[10.5px] text-slate-500">
        <span>
          rows {fmt(Math.min(first + 1, totalSize))}–{fmt(Math.max(0, last + 1))} of {fmt(totalSize)} · virtualised ({rows.length} DOM rows)
        </span>
        <span>
          bucket selection: <span className="font-mono text-slate-300">{st.fresh ? fmt(st.selected) : '?'}</span> / {fmt(st.total)} · v{version}
        </span>
      </div>
    </Panel>
  );
}

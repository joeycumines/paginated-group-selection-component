import type { SelectionEngine } from '../engine/SelectionEngine';
import { ALL, UNGROUPED, type BucketId, type GroupInfo } from '../engine/types';
import { cn } from '../utils/cn';
import { Chip, Panel, Spinner, TriCheckbox, fmt } from './ui';

export const UNGROUPED_COLOR = '#94a3b8';
export const ALL_COLOR = '#e2e8f0';

export function bucketLabel(b: BucketId, groups: GroupInfo[]) {
  if (b === ALL) return 'All items';
  if (b === UNGROUPED) return 'Ungrouped';
  return groups.find((g) => g.id === b)?.name ?? b;
}
export function bucketColor(b: BucketId, groups: GroupInfo[]) {
  if (b === ALL) return ALL_COLOR;
  if (b === UNGROUPED) return UNGROUPED_COLOR;
  return groups.find((g) => g.id === b)?.color ?? '#fff';
}

export function GroupPane({
  engine,
  groups,
  view,
  onView,
  oracleCounts,
}: {
  engine: SelectionEngine;
  groups: GroupInfo[];
  view: BucketId;
  onView: (b: BucketId) => void;
  oracleCounts: Map<BucketId, number> | null;
}) {
  const buckets: BucketId[] = [ALL, UNGROUPED, ...groups.map((g) => g.id)];

  const toggle = (b: BucketId) => {
    const st = engine.bucketState(b);
    if (b === ALL) {
      if (st === 'all') engine.clearAll();
      else engine.selectAll();
      return;
    }
    engine.toggleGroup(b, st === 'all' ? 'EXCLUDE' : 'INCLUDE');
  };

  return (
    <Panel
      title="Groups"
      bodyClassName="p-1.5"
      right={
        <span className="text-slate-500">
          K = {groups.length} · drill-down ▸ <span className="text-slate-300">{bucketLabel(view, groups)}</span>
        </span>
      }
    >
      <ul className="space-y-0.5">
        {buckets.map((b) => {
          const st = engine.stats.get(b)!;
          const state = engine.bucketState(b);
          const color = bucketColor(b, groups);
          const rule = b === ALL ? null : engine.ruleFor(b);
          const known = b !== ALL && engine.isFullyKnown(b);
          const knownSize = b !== ALL ? engine.known.get(b)?.size : undefined;
          const oracle = oracleCounts?.get(b);
          const mismatch = oracle !== undefined && st.fresh && oracle !== st.selected;
          const unknown = !st.fresh;
          const pct = st.total ? (st.selected / st.total) * 100 : 0;
          const active = view === b;
          return (
            <li key={b}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onView(b)}
                onKeyDown={(e) => e.key === 'Enter' && onView(b)}
                className={cn(
                  'group relative flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                  active
                    ? 'border-slate-600 bg-slate-800/80'
                    : 'border-transparent hover:border-slate-800 hover:bg-slate-800/40',
                  b === ALL && 'mb-1 border-b-slate-800',
                )}
              >
                <TriCheckbox
                  state={state}
                  stale={!st.fresh}
                  onClick={() => toggle(b)}
                  title={
                    b === ALL
                      ? state === 'all'
                        ? 'Clear selection (β ← false, ℒ ← ∅, ℰ ← ∅)'
                        : 'Select all (β ← true, ℒ ← ∅, ℰ ← ∅)'
                      : state === 'all'
                        ? `Deselect group → append (${b}, EXCLUDE) to ℒ`
                        : `Select group → append (${b}, INCLUDE) to ℒ`
                  }
                />
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('truncate text-[12.5px]', b === ALL ? 'font-semibold text-slate-100' : 'text-slate-200')}>
                      {bucketLabel(b, groups)}
                    </span>
                    {rule && (
                      <Chip
                        title={`Rule #${rule.index + 1} in ℒ (tail = highest precedence)`}
                        className={rule.rule.op === 'INCLUDE' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}
                      >
                        {rule.rule.op === 'INCLUDE' ? '+' : '−'}
                        <span className="opacity-60">#{rule.index + 1}</span>
                      </Chip>
                    )}
                    {known && (
                      <span title={`All ${st.total} IDs cached (N ≤ knownCap) — polarity flips enabled, zero-network reconciliation`} className="text-[10px] text-teal-300">
                        ◉
                      </span>
                    )}
                    {!known && knownSize !== undefined && knownSize > 0 && (
                      <span title={`${knownSize}/${st.total} IDs cached`} className="text-[10px] text-slate-500">
                        ◎
                      </span>
                    )}
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded bg-slate-800">
                    <div
                      className={cn('h-full rounded transition-all', unknown ? 'w-full animate-pulse bg-amber-400/40' : 'bg-sky-400')}
                      style={unknown ? undefined : { width: `${pct}%` }}
                    />
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end text-right">
                  <span className={cn('font-mono text-[11.5px] tabular-nums', !st.fresh ? 'text-amber-300' : 'text-slate-200')}>
                    {!st.fresh ? '?' : fmt(st.selected)}
                    <span className="text-slate-500"> / {fmt(st.total)}</span>
                  </span>
                  <span className="flex h-3.5 items-center gap-1 text-[10px]">
                    {!st.fresh ? (
                      <span className="flex items-center gap-1 text-amber-400" title="Count unknown until the server answers List(filter=(selection) AND scope, page_size=0)">
                        <Spinner /> reconciling
                      </span>
                    ) : oracle !== undefined ? (
                      mismatch ? (
                        <span className="text-rose-400" title={`Oracle says ${oracle}`}>✗ oracle {oracle}</span>
                      ) : (
                        <span className="text-emerald-500/80" title="Client count equals server-side evaluation of the wire filter">✓ verified</span>
                      )
                    ) : null}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 space-y-1 px-1 text-[10.5px] leading-relaxed text-slate-500">
        <p>
          Click a row to drill the grid into that bucket; click its checkbox to toggle the whole bucket. <span className="text-amber-400">Dashed</span> = count unknown
          (overlap knowledge gap) until reconciled. <span className="text-teal-300">◉</span> = every ID of the group is cached.
        </p>
      </div>
    </Panel>
  );
}

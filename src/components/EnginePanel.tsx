import type { SelectionEngine } from '../engine/SelectionEngine';
import { UNGROUPED, type GroupInfo } from '../engine/types';
import { cn } from '../utils/cn';
import { Chip, Panel } from './ui';

export function EnginePanel({ engine, groups }: { engine: SelectionEngine; groups: GroupInfo[] }) {
  const colorOf = (g: string) => (g === UNGROUPED ? '#94a3b8' : (groups.find((x) => x.id === g)?.color ?? '#fff'));
  const overrides = Array.from(engine.enc.exceptions.values()).sort((a, b) => a.id.localeCompare(b.id));
  const recent = engine.consolidations.slice(-6).reverse();

  return (
    <Panel title="Engine state (β, ℒ, ℰ)" bodyClassName="space-y-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-[10.5px] uppercase tracking-wider text-slate-500">
          <span>ℒ precedence deque · head → tail (last write wins)</span>
          <span>{engine.enc.precedence.length} / {groups.length + 1}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className={cn('rounded px-1.5 py-px font-mono text-[11px]', engine.enc.base ? 'bg-sky-500/20 text-sky-200' : 'bg-slate-800 text-slate-400')} title="Global baseline β: evaluation for rows no rule matches">
            β={engine.enc.base ? 'true' : 'false'}
          </span>
          {engine.enc.precedence.map((r, i) => (
            <span key={r.group} className="flex items-center gap-1">
              <span className="text-slate-700">›</span>
              <Chip color={colorOf(r.group)} title={`#${i + 1}: ${r.op}`}>
                <span className={r.op === 'INCLUDE' ? 'text-emerald-300' : 'text-rose-300'}>{r.op === 'INCLUDE' ? '+' : '−'}</span>
                {r.group === UNGROUPED ? '∅' : r.group}
              </Chip>
            </span>
          ))}
          {engine.enc.precedence.length === 0 && <span className="text-[11px] text-slate-600">› empty</span>}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[10.5px] uppercase tracking-wider text-slate-500">
          <span>ℰ exception table · only rows where selected ≠ GroupEval(S_x)</span>
          <span>{overrides.length}</span>
        </div>
        {overrides.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-800 p-2 text-center text-[11px] text-slate-600">0 bytes — every row is explained by β and ℒ</div>
        ) : (
          <div className="max-h-36 overflow-auto rounded-md border border-slate-800 bg-slate-950/60">
            <table className="w-full text-left font-mono text-[10.5px]">
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id} className="border-b border-slate-800/60 last:border-0">
                    <td className={cn('w-6 px-2 py-0.5 font-bold', o.selected ? 'text-emerald-300' : 'text-rose-300')}>{o.selected ? '+' : '−'}</td>
                    <td className="px-1 py-0.5 text-slate-200">{o.id}</td>
                    <td className="px-1 py-0.5">
                      <span className="flex flex-wrap gap-0.5">
                        {o.groups.length === 0 ? (
                          <Chip color="#94a3b8">∅</Chip>
                        ) : (
                          o.groups.map((g) => (
                            <Chip key={g} color={colorOf(g)}>
                              {g}
                            </Chip>
                          ))
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-wider text-slate-500">Consolidation moves (semantics-preserving, bytes ↓)</div>
        {recent.length === 0 ? (
          <div className="text-[11px] text-slate-600">none yet — click items in a small group to watch ℰ collapse into ℒ</div>
        ) : (
          <ul className="space-y-0.5 font-mono text-[10.5px]">
            {recent.map((c, i) => (
              <li key={`${c.version}-${i}`} className="flex items-center gap-2 text-slate-300">
                <span className="text-slate-600">v{c.version}</span>
                <span className="truncate">{c.label}</span>
                <span className="ml-auto shrink-0 text-emerald-400">
                  {c.before}→{c.after} B
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

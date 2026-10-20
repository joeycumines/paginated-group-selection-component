import type { MockServer } from '../server/mockServer';
import { cn } from '../utils/cn';
import { fmt } from './ui';

export function NetworkLog({ server }: { server: MockServer }) {
  const entries = server.log.slice().reverse();
  const totals = server.log.reduce(
    (a, e) => ({ req: a.req + e.requestBytes, res: a.res + e.responseBytes, n: a.n + 1 }),
    { req: 0, res: 0, n: 0 },
  );
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center gap-3 text-[10.5px] text-slate-500">
        <span>
          {totals.n} requests (last 60) · ↑ {fmt(totals.req)} B · ↓ {fmt(totals.res)} B
        </span>
        <span className="text-slate-600">page_size=0 ⇒ count-only (read total_size)</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-800 bg-slate-950/60">
        <table className="w-full text-left font-mono text-[10.5px]">
          <thead className="sticky top-0 bg-slate-900 text-[9.5px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-2 py-1">#</th>
              <th className="px-2 py-1">method</th>
              <th className="px-2 py-1">filter</th>
              <th className="px-2 py-1 text-right">page_size</th>
              <th className="px-2 py-1 text-right">offset</th>
              <th className="px-2 py-1 text-right">total_size</th>
              <th className="px-2 py-1 text-right">rows</th>
              <th className="px-2 py-1 text-right">ms</th>
              <th className="px-2 py-1 text-right">↓B</th>
              <th className="px-2 py-1">purpose</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.seq} className={cn('border-t border-slate-800/60', e.pageSize === 0 && e.method === 'ListItems' && 'text-amber-200/80')}>
                <td className="px-2 py-0.5 text-slate-500">{e.seq}</td>
                <td className="px-2 py-0.5 text-slate-300">{e.method}</td>
                <td className="max-w-[420px] truncate px-2 py-0.5 text-sky-200" title={e.filter}>
                  {e.filter === '' ? <span className="text-slate-600">""</span> : e.filter}
                </td>
                <td className="px-2 py-0.5 text-right">{e.pageSize}</td>
                <td className="px-2 py-0.5 text-right">{e.offset}</td>
                <td className="px-2 py-0.5 text-right text-slate-200">{fmt(e.totalSize)}</td>
                <td className="px-2 py-0.5 text-right">{e.returned}</td>
                <td className="px-2 py-0.5 text-right text-slate-500">{Math.round(e.latencyMs)}</td>
                <td className="px-2 py-0.5 text-right text-slate-500">{fmt(e.responseBytes)}</td>
                <td className="px-2 py-0.5 text-slate-400">{e.purpose}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-3 text-center text-slate-600">
                  no requests yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

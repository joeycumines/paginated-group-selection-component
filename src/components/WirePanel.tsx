import type { FilterNode } from '../engine/filterAst';
import { type SelectionEngine } from '../engine/SelectionEngine';
import { UNGROUPED, type GroupInfo } from '../engine/types';
import { cn } from '../utils/cn';
import { Chip, Panel, fmt } from './ui';

function AstTree({ node, groups, depth = 0 }: { node: FilterNode; groups: GroupInfo[]; depth?: number }) {
  const pad = { paddingLeft: depth * 12 };
  const colorOf = (g: string) => groups.find((x) => x.id === g)?.color ?? '#94a3b8';
  switch (node.type) {
    case 'all':
      return <div style={pad} className="text-slate-400">⊤ universe (empty filter)</div>;
    case 'none':
      return <div style={pad} className="text-slate-500">⊥ nothing selected</div>;
    case 'group':
      return (
        <div style={pad}>
          <Chip color={colorOf(node.group)}>groups:"{node.group}"</Chip>
        </div>
      );
    case 'ungrouped':
      return (
        <div style={pad}>
          <Chip color="#94a3b8">NOT groups:*</Chip>
        </div>
      );
    case 'id':
      return (
        <div style={pad}>
          <Chip className="bg-slate-800 text-slate-300">id="{node.id}"</Chip>
        </div>
      );
    case 'not':
      return (
        <div>
          <div style={pad} className="text-rose-300">NOT</div>
          <AstTree node={node.child} groups={groups} depth={depth + 1} />
        </div>
      );
    case 'and':
    case 'or':
      return (
        <div>
          <div style={pad} className={node.type === 'and' ? 'text-amber-300' : 'text-emerald-300'}>
            {node.type.toUpperCase()} <span className="text-slate-600">({node.children.length})</span>
          </div>
          {node.children.map((c, i) => (
            <AstTree key={i} node={c} groups={groups} depth={depth + 1} />
          ))}
        </div>
      );
  }
}

export function WirePanel({
  engine,
  groups,
  oracleOk,
  autoVerify,
  onAutoVerify,
}: {
  engine: SelectionEngine;
  groups: GroupInfo[];
  oracleOk: boolean | null;
  autoVerify: boolean;
  onAutoVerify: (v: boolean) => void;
}) {
  const c = engine.compile();
  const mem = engine.memoryFootprint();
  const all = engine.stats.get('ALL')!;
  const naiveBytes = all.fresh ? all.selected * 7 : null;

  return (
    <Panel
      title="Wire filter (AIP-160)"
      right={
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={autoVerify} onChange={(e) => onAutoVerify(e.target.checked)} className="accent-sky-500" />
          oracle verify
        </label>
      }
      bodyClassName="space-y-3"
    >
      <div>
        <div className="mb-1 flex items-center justify-between text-[10.5px] text-slate-500">
          <span>
            filter = {c.text === null ? <span className="text-slate-400">(no selection — nothing to send)</span> : c.text === '' ? <span className="text-slate-400">"" (empty filter ⇒ universe)</span> : null}
          </span>
          {oracleOk !== null && (
            <span className={cn('font-semibold', oracleOk ? 'text-emerald-400' : 'text-rose-400')}>
              {oracleOk ? '✓ server evaluation ≡ client state' : '✗ MISMATCH'}
            </span>
          )}
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-[11.5px] leading-5 text-sky-200">
          {c.text === null ? '∅' : c.text === '' ? '' : c.text}
        </pre>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label="wire bytes" value={fmt(c.bytes)} accent="text-sky-300" />
        <Stat label="group literals" value={String(c.tokens.groups)} />
        <Stat label="id literals" value={String(c.tokens.ids)} />
        <Stat
          label="naive id list"
          value={naiveBytes === null ? '?' : fmt(naiveBytes) + ' B'}
          title="Bytes if the selection were shipped as a flat list of ~7-byte ids"
          accent="text-slate-500"
        />
      </div>

      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-wider text-slate-500">Φ(p) block fold · ℒ coalesced into {c.blocks.length} block{c.blocks.length === 1 ? '' : 's'}</div>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
          <span className={cn('rounded px-1.5 py-px', engine.enc.base ? 'bg-sky-500/20 text-sky-200' : 'bg-slate-800 text-slate-400')}>β = {String(engine.enc.base)}</span>
          {c.blocks.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-slate-600">▸</span>
              <span className={cn('rounded px-1.5 py-px', b.op === 'INCLUDE' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200')}>
                {b.op === 'INCLUDE' ? '∪' : '∖'} {'{'}
                {b.groups.map((g) => (g === UNGROUPED ? '∅' : g)).join(', ')}
                {'}'}
              </span>
            </span>
          ))}
          {c.blocks.length === 0 && <span className="text-slate-600">▸ (no group rules)</span>}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-wider text-slate-500">AST</div>
        <div className="rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-[10.5px] leading-5">
          <AstTree node={c.ast} groups={groups} />
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-wider text-slate-500">Client memory for selection state</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label={`ℒ rules (${engine.enc.precedence.length})`} value={`${mem.rules} B`} />
          <Stat label={`ℰ overrides (${mem.overrideCount})`} value={`${mem.overrides} B`} accent={mem.overrideCount ? 'text-amber-300' : undefined} />
          <Stat label={`known cache (${mem.knownEntries})`} value={`${fmt(mem.knownCache)} B`} title="IDs cached only for groups with N_g ≤ knownCap; bounded, independent of selection size" accent="text-slate-500" />
        </div>
      </div>
    </Panel>
  );
}

function Stat({ label, value, accent, title }: { label: string; value: string; accent?: string; title?: string }) {
  return (
    <div title={title} className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1.5">
      <div className={cn('font-mono text-[13px] tabular-nums text-slate-200', accent)}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

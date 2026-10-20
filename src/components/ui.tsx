import type { ReactNode } from 'react';
import { cn } from '../utils/cn';

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-900/60', className)}>
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</h2>
        {right && <div className="flex items-center gap-2 text-[11px] text-slate-400">{right}</div>}
      </header>
      <div className={cn('min-h-0 flex-1 overflow-auto p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export type TriState = 'none' | 'partial' | 'all' | 'empty';

export function TriCheckbox({
  state,
  stale,
  onClick,
  size = 16,
  title,
}: {
  state: TriState;
  stale?: boolean;
  onClick?: () => void;
  size?: number;
  title?: string;
}) {
  const checked = state === 'all';
  const partial = state === 'partial';
  return (
    <button
      type="button"
      title={title}
      aria-checked={partial ? 'mixed' : checked}
      role="checkbox"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      disabled={state === 'empty'}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[4px] border transition-colors',
        state === 'empty' && 'cursor-not-allowed border-slate-800 bg-slate-900',
        state === 'none' && 'border-slate-500 bg-slate-950 hover:border-sky-400',
        partial && 'border-sky-400 bg-sky-500/20 hover:bg-sky-500/30',
        checked && 'border-sky-400 bg-sky-500 hover:bg-sky-400',
        stale && 'animate-pulse border-dashed border-amber-400',
      )}
      style={{ width: size, height: size }}
    >
      {checked && (
        <svg viewBox="0 0 16 16" className="h-3 w-3 text-slate-950" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {partial && <span className="h-0.5 w-2 rounded bg-sky-300" />}
    </button>
  );
}

export function Chip({
  children,
  color,
  className,
  title,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10.5px] leading-4',
        className,
      )}
      style={color ? { backgroundColor: color + '22', color, boxShadow: `inset 0 0 0 1px ${color}55` } : undefined}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-slate-700 bg-slate-800 px-1 font-mono text-[10px] text-slate-300">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-3 w-3 animate-spin text-amber-400', className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const fmt = (n: number) => n.toLocaleString();

import {
  ALL,
  UNGROUPED,
  effectiveGroups,
  type BucketId,
  type BucketStats,
  type Encoding,
  type GroupId,
  type GroupInfo,
  type ItemResource,
  type Op,
  type Override,
  type Rule,
} from './types';
import {
  ALL_NODE,
  NONE_NODE,
  and,
  countTokens,
  groupNode,
  idNode,
  not,
  or,
  printFilter,
  utf8Bytes,
  type FilterNode,
} from './filterAst';

// ---------------------------------------------------------------------------
// Pure functions over an Encoding (β, ℒ, ℰ)
// ---------------------------------------------------------------------------

export function cloneEncoding(e: Encoding): Encoding {
  return { base: e.base, precedence: e.precedence.slice(), exceptions: new Map(e.exceptions) };
}

/** GroupEval: selection state inherited from the precedence list for ANY row (known or unknown). */
export function groupEval(enc: Encoding, groups: GroupId[]): boolean {
  const eff = effectiveGroups(groups);
  for (let i = enc.precedence.length - 1; i >= 0; i--) {
    const r = enc.precedence[i];
    if (eff.includes(r.group)) return r.op === 'INCLUDE';
  }
  return enc.base;
}

export function isSelectedIn(enc: Encoding, id: string, groups: GroupId[]): boolean {
  const o = enc.exceptions.get(id);
  return o ? o.selected : groupEval(enc, groups);
}

export interface Compiled {
  ast: FilterNode;
  /** null = empty selection (nothing to send). "" = universe (empty AIP filter). */
  text: string | null;
  bytes: number;
  tokens: { groups: number; ids: number };
  blocks: { op: Op; groups: GroupId[] }[];
}

/**
 * Adjacent same-op rules coalesce into one clause. With `splitUngrouped`, the disjoint UNGROUPED
 * EXCLUDE rule stays its own clause: `NOT groups:*` then prints as `groups:*`, which avoids the
 * longer `NOT (… OR NOT groups:*)` nesting when the neighbouring block has the same polarity.
 * `compileEncoding` tries both layouts and keeps the shortest text.
 */
export function coalesce(precedence: Rule[], splitUngrouped = false): { op: Op; groups: GroupId[] }[] {
  const blocks: { op: Op; groups: GroupId[] }[] = [];
  for (const r of precedence) {
    const last = blocks[blocks.length - 1];
    const isolateUngrouped =
      splitUngrouped &&
      r.op === 'EXCLUDE' &&
      (r.group === UNGROUPED || (last?.op === 'EXCLUDE' && last.groups.includes(UNGROUPED)));
    if (last && last.op === r.op && !isolateUngrouped) last.groups.push(r.group);
    else blocks.push({ op: r.op, groups: [r.group] });
  }
  return blocks;
}

/** Φ(p) fold + exception attachment. */
export function compileEncoding(enc: Encoding): Compiled {
  const layouts = [coalesce(enc.precedence)];
  if (enc.precedence.some((r) => r.group === UNGROUPED && r.op === 'EXCLUDE')) {
    layouts.push(coalesce(enc.precedence, true));
  }
  let best: { blocks: { op: Op; groups: GroupId[] }[]; ast: FilterNode; text: string | null; bytes: number } | null = null;
  for (const blocks of layouts) {
    let expr: FilterNode = enc.base ? ALL_NODE : NONE_NODE;
    for (const b of blocks) {
      const clause = or(...b.groups.map(groupNode));
      expr = b.op === 'INCLUDE' ? or(expr, clause) : and(expr, not(clause));
    }
    const pos: string[] = [];
    const neg: string[] = [];
    for (const o of enc.exceptions.values()) (o.selected ? pos : neg).push(o.id);
    pos.sort();
    neg.sort();
    if (pos.length) expr = or(expr, ...pos.map(idNode));
    if (neg.length) expr = and(expr, not(or(...neg.map(idNode))));
    const text = expr.type === 'none' ? null : printFilter(expr);
    const bytes = text ? utf8Bytes(text) : 0;
    if (!best || bytes < best.bytes) best = { blocks, ast: expr, text, bytes };
  }
  return { ast: best!.ast, text: best!.text, bytes: best!.bytes, tokens: countTokens(best!.ast), blocks: best!.blocks };
}

const matchesBase = (r: Rule, base: boolean) => (r.op === 'INCLUDE') === base;

function pruneHead(list: Rule[], base: boolean): Rule[] {
  let i = 0;
  while (i < list.length && matchesBase(list[i], base)) i++;
  return i === 0 ? list : list.slice(i);
}

/**
 * Ungrouped is disjoint from every group, so its rule may float anywhere in ℒ (or vanish into β).
 * Every position is semantically identical; pick the one whose compiled text is shortest.
 */
function placeUngrouped(list: Rule[], g0: Rule | null, base: boolean, exceptions: Map<string, Override>): Rule[] {
  if (!g0 || matchesBase(g0, base)) return list;
  let best: Rule[] = list;
  let bestBytes = Infinity;
  for (let i = 0; i <= list.length; i++) {
    const candidate = [...list.slice(0, i), g0, ...list.slice(i)];
    const bytes = compileEncoding({ base, precedence: candidate, exceptions }).bytes;
    if (bytes < bestBytes) {
      best = candidate;
      bestBytes = bytes;
    }
  }
  return best;
}

/**
 * Canonicalise ℒ against β (mutates, semantics-preserving):
 *  1. drop head rules whose op equals β (lowest precedence ⇒ redundant),
 *  2. under full coverage (every bucket g0..gK ruled) β is unobservable, so pick the β that
 *     absorbs the most expensive head block,
 *  3. float the Ungrouped rule into a same-op block (or into β).
 */
export function normalizeEncoding(enc: Encoding, groupIds: GroupId[], nonZeroBuckets?: Set<BucketId>): void {
  const g0 = enc.precedence.find((r) => r.group === UNGROUPED) ?? null;
  const rest = enc.precedence.filter((r) => r.group !== UNGROUPED);
  const checkUngrouped = nonZeroBuckets ? nonZeroBuckets.has(UNGROUPED) : true;
  const checkGroup = (g: GroupId) => (nonZeroBuckets ? nonZeroBuckets.has(g) : true);
  const fullCoverage =
    (!checkUngrouped || g0 !== null) &&
    groupIds.filter(checkGroup).every((g) => rest.some((r) => r.group === g));
  if (fullCoverage) {
    const candidates = [enc.base, !enc.base];
    let best: { base: boolean; list: Rule[]; bytes: number } | null = null;
    for (const base of candidates) {
      const list = placeUngrouped(pruneHead(rest, base), g0, base, enc.exceptions);
      const bytes = compileEncoding({ base, precedence: list, exceptions: enc.exceptions }).bytes;
      if (!best || bytes < best.bytes) best = { base, list, bytes };
    }
    enc.base = best!.base;
    enc.precedence = best!.list;
  } else {
    enc.precedence = placeUngrouped(pruneHead(rest, enc.base), g0, enc.base, enc.exceptions);
  }
}

// ---------------------------------------------------------------------------
// Semantics-preserving re-encoding moves (the "DP / min-cost synthesis" step)
// ---------------------------------------------------------------------------

/**
 * Move g's rule to the tail with `op` (or remove it when op === null) and re-derive the overrides
 * of every item of g so that no item changes truth value. Legal only when ALL items of g are known.
 */
export function reencodeKnownGroup(
  enc: Encoding,
  g: GroupId,
  op: Op | null,
  knownItems: Map<string, GroupId[]>,
  insertAt?: number,
): Encoding {
  const out = cloneEncoding(enc);
  const truths: [string, GroupId[], boolean][] = [];
  for (const [id, groups] of knownItems) truths.push([id, groups, isSelectedIn(enc, id, groups)]);
  out.precedence = out.precedence.filter((r) => r.group !== g);
  if (op) {
    const at = insertAt === undefined ? out.precedence.length : Math.max(0, Math.min(insertAt, out.precedence.length));
    out.precedence.splice(at, 0, { group: g, op });
  }
  for (const [id, groups, t] of truths) {
    if (groupEval(out, groups) === t) out.exceptions.delete(id);
    else out.exceptions.set(id, { id, groups, selected: t });
  }
  return out;
}

/**
 * Saturation collapse: when C_g == N_g (or 0) we know every row of g is selected (unselected)
 * WITHOUT knowing their IDs, so (g, op) at the tail is semantically neutral and every override in g
 * with that polarity becomes redundant.
 */
export function collapseSaturatedGroup(enc: Encoding, g: GroupId, op: Op): Encoding {
  const out = cloneEncoding(enc);
  const truths: [string, GroupId[], boolean][] = [];
  for (const [id, o] of out.exceptions) {
    if (effectiveGroups(o.groups).includes(g)) truths.push([id, o.groups, o.selected]);
  }
  out.precedence = out.precedence.filter((r) => r.group !== g);
  out.precedence.push({ group: g, op });
  for (const [id, groups, selected] of truths) {
    if (groupEval(out, groups) === selected) out.exceptions.delete(id);
    else out.exceptions.set(id, { id, groups, selected });
  }
  return out;
}

/** Drop overrides that the current β/ℒ already explains. Deleting them cannot change truth. */
function sweepEncoding(enc: Encoding): Encoding {
  for (const [id, o] of enc.exceptions) {
    if (o.selected === groupEval(enc, o.groups)) enc.exceptions.delete(id);
  }
  return enc;
}

// ---------------------------------------------------------------------------
// The engine: encoding + bucket stats + bounded known cache + consolidation
// ---------------------------------------------------------------------------

export type Provenance =
  | { kind: 'override'; selected: boolean }
  | { kind: 'rule'; rule: Rule; index: number }
  | { kind: 'base'; base: boolean };

export interface EngineOptions {
  /** Only groups with N_g ≤ knownCap keep a full ID cache (memory bound for polarity flipping). */
  knownCap: number;
}

export interface ConsolidationEvent {
  version: number;
  label: string;
  before: number;
  after: number;
}

export class SelectionEngine {
  enc: Encoding = { base: false, precedence: [], exceptions: new Map() };
  stats = new Map<BucketId, BucketStats>();
  /** g → (id → groups) for groups small enough to be fully cached. */
  known = new Map<GroupId, Map<string, GroupId[]>>();
  readonly groupIds: GroupId[];
  readonly knownCap: number;
  version = 0;
  consolidations: ConsolidationEvent[] = [];
  private listeners = new Set<() => void>();
  private compiledCache: { version: number; value: Compiled } | null = null;

  constructor(groups: GroupInfo[], ungroupedTotal: number, total: number, opts: EngineOptions) {
    this.knownCap = opts.knownCap;
    this.groupIds = groups.map((g) => g.id);
    this.stats.set(ALL, { total, selected: 0, fresh: true });
    this.stats.set(UNGROUPED, { total: ungroupedTotal, selected: 0, fresh: true });
    if (ungroupedTotal <= opts.knownCap) this.known.set(UNGROUPED, new Map());
    for (const g of groups) {
      this.stats.set(g.id, { total: g.total, selected: 0, fresh: true });
      if (g.total <= opts.knownCap) this.known.set(g.id, new Map());
    }
  }

  // --- subscription -------------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // --- queries ------------------------------------------------------------
  groupEval(groups: GroupId[]) {
    return groupEval(this.enc, groups);
  }
  isSelected(id: string, groups: GroupId[]) {
    return isSelectedIn(this.enc, id, groups);
  }
  explain(id: string, groups: GroupId[]): Provenance {
    const o = this.enc.exceptions.get(id);
    if (o) return { kind: 'override', selected: o.selected };
    const eff = effectiveGroups(groups);
    for (let i = this.enc.precedence.length - 1; i >= 0; i--) {
      const r = this.enc.precedence[i];
      if (eff.includes(r.group)) return { kind: 'rule', rule: r, index: i };
    }
    return { kind: 'base', base: this.enc.base };
  }
  ruleFor(g: GroupId): { rule: Rule; index: number } | null {
    const index = this.enc.precedence.findIndex((r) => r.group === g);
    return index < 0 ? null : { rule: this.enc.precedence[index], index };
  }
  compile(): Compiled {
    if (!this.compiledCache || this.compiledCache.version !== this.version) {
      this.compiledCache = { version: this.version, value: compileEncoding(this.enc) };
    }
    return this.compiledCache.value;
  }
  isFullyKnown(g: GroupId): boolean {
    const k = this.known.get(g);
    const st = this.stats.get(g);
    return !!k && !!st && k.size === st.total;
  }
  buckets(): BucketId[] {
    return [ALL, UNGROUPED, ...this.groupIds];
  }
  staleBuckets(): BucketId[] {
    return this.buckets().filter((b) => !this.stats.get(b)!.fresh);
  }
  bucketState(b: BucketId): 'none' | 'partial' | 'all' | 'empty' {
    const st = this.stats.get(b)!;
    if (st.total === 0) return 'empty';
    if (!st.fresh) return 'partial'; // unknown count must never be presented as all/none
    if (st.selected <= 0) return 'none';
    if (st.selected >= st.total) return 'all';
    return 'partial';
  }
  memoryFootprint() {
    let rules = 0;
    for (const r of this.enc.precedence) rules += r.group.length + 1;
    let overrides = 0;
    for (const o of this.enc.exceptions.values()) {
      overrides += o.id.length + 1 + o.groups.reduce((a, g) => a + g.length, 0);
    }
    let knownCache = 0;
    let knownEntries = 0;
    for (const m of this.known.values()) {
      for (const [id, groups] of m) {
        knownEntries++;
        knownCache += id.length + groups.reduce((a, g) => a + g.length, 0);
      }
    }
    return { rules, overrides, knownCache, knownEntries, overrideCount: this.enc.exceptions.size };
  }

  // --- observation (RHS pages flowing through the client) ------------------
  private recordObserved(items: ItemResource[]): boolean {
    let newlyKnown = false;
    for (const item of items) {
      for (const g of effectiveGroups(item.groups)) {
        const k = this.known.get(g);
        if (k && !k.has(item.id)) {
          k.set(item.id, item.groups);
          if (k.size === this.stats.get(g)!.total) newlyKnown = true;
        }
      }
    }
    return newlyKnown;
  }

  observe(items: ItemResource[]) {
    if (!this.recordObserved(items)) return;
    // A newly fully-known group can both fix a stale count offline and unlock re-encodings.
    this.recomputeKnownBuckets();
    this.consolidate();
    this.bump();
  }

  // --- mutations ----------------------------------------------------------
  /** Action 1: single item toggled in the RHS grid. S_x is fully known ⇒ exact O(|S_x|) updates. */
  toggleItem(item: ItemResource, selected: boolean) {
    const newlyKnown = this.recordObserved([item]);
    const prev = this.isSelected(item.id, item.groups);
    if (prev === selected) {
      if (newlyKnown) {
        this.recomputeKnownBuckets();
        this.consolidate();
        this.bump();
      }
      return;
    }
    const d = selected ? 1 : -1;
    for (const b of [ALL, ...effectiveGroups(item.groups)] as BucketId[]) {
      const st = this.stats.get(b);
      // A stale count is an old server number: it is not a base for arithmetic.
      if (st && st.fresh) st.selected = Math.max(0, Math.min(st.total, st.selected + d));
    }
    const inherited = this.groupEval(item.groups);
    if (selected === inherited) this.enc.exceptions.delete(item.id);
    else this.enc.exceptions.set(item.id, { id: item.id, groups: item.groups, selected });
    if (newlyKnown) this.recomputeKnownBuckets();
    this.consolidate();
    this.bump();
  }

  /** Action 2: whole bucket toggled in the LHS pane. */
  toggleGroup(g: GroupId, op: Op) {
    if (g === ALL) {
      if (op === 'INCLUDE') this.selectAll();
      else this.clearAll();
      return;
    }
    const sg = this.stats.get(g);
    if (!sg || sg.total === 0) return;
    const target = op === 'INCLUDE';
    const kg = this.isFullyKnown(g) ? this.known.get(g)! : null;
    const before = kg
      ? new Map(Array.from(kg, ([id, groups]) => [id, this.isSelected(id, groups)] as const))
      : null;
    const prevSelected = sg.selected;
    const prevFresh = sg.fresh;

    // Phase 1: mutate the encoding (last-write-wins deque + purge overrides inside g).
    this.enc.precedence = this.enc.precedence.filter((r) => r.group !== g);
    this.enc.precedence.push({ group: g, op });
    for (const [id, o] of this.enc.exceptions) {
      if (effectiveGroups(o.groups).includes(g)) this.enc.exceptions.delete(id);
    }

    // Phase 2: bucket counts. g itself is exact. Peers depend on what we know about overlaps.
    sg.selected = target ? sg.total : 0;
    sg.fresh = true;
    if (before) {
      // Every row of g is cached ⇒ exact deltas for ALL and every peer bucket, zero network.
      const deltas = new Map<BucketId, number>();
      for (const [id, groups] of kg!) {
        const was = before.get(id)!;
        if (was === target) continue;
        for (const b of [ALL, ...effectiveGroups(groups)] as BucketId[]) {
          if (b !== g) deltas.set(b, (deltas.get(b) ?? 0) + (target ? 1 : -1));
        }
      }
      for (const [b, d] of deltas) {
        const st = this.stats.get(b)!;
        if (st.fresh) st.selected = Math.max(0, Math.min(st.total, st.selected + d));
      }
    } else if (g === UNGROUPED) {
      // Ungrouped is disjoint from every group: only ALL moves, and by an exactly known delta.
      // A stale ALL count is still not a base for arithmetic.
      const all = this.stats.get(ALL)!;
      if (prevFresh && all.fresh) all.selected += sg.selected - prevSelected;
      else all.fresh = false;
    } else {
      // Knowledge gap: unfetched rows of g may also live in other groups. Rows already at the
      // target bound cannot move, so their peers stay exact; an unchanged g invalidates nothing.
      const noItemChanged = prevFresh && prevSelected === (target ? sg.total : 0);
      if (!noItemChanged) {
        const all = this.stats.get(ALL)!;
        const allAtBound = all.fresh && (target ? all.selected === all.total : all.selected === 0);
        if (!allAtBound) all.fresh = false;
        for (const h of this.groupIds) {
          if (h === g || this.isFullyKnown(h)) continue;
          const sh = this.stats.get(h)!;
          const atBound = sh.fresh && (target ? sh.selected === sh.total : sh.selected === 0);
          if (!atBound) sh.fresh = false;
        }
      }
      // UNGROUPED untouched (disjoint).
    }
    this.recomputeKnownBuckets();
    this.consolidate();
    this.bump();
  }

  selectAll() {
    this.enc = { base: true, precedence: [], exceptions: new Map() };
    for (const st of this.stats.values()) {
      st.selected = st.total;
      st.fresh = true;
    }
    this.bump();
  }

  clearAll() {
    this.enc = { base: false, precedence: [], exceptions: new Map() };
    for (const st of this.stats.values()) {
      st.selected = 0;
      st.fresh = true;
    }
    this.bump();
  }

  /** Apply server-reconciled counts (from `List(filter=(sel) AND scope, page_size=0).total_size`). */
  reconcile(counts: Map<BucketId, number>, requestVersion: number): boolean {
    if (requestVersion !== this.version) return false; // stale response; caller re-queries
    for (const [b, n] of counts) {
      const st = this.stats.get(b);
      if (!st) continue;
      st.selected = n;
      st.fresh = true;
    }
    this.consolidate();
    this.bump();
    return true;
  }

  // --- internals ----------------------------------------------------------
  private recomputeKnownBuckets() {
    for (const [g, k] of this.known) {
      const st = this.stats.get(g)!;
      if (k.size !== st.total) continue;
      let n = 0;
      for (const [id, groups] of k) if (this.isSelected(id, groups)) n++;
      st.selected = n;
      st.fresh = true;
    }
  }

  /** Drop overrides that the current β/ℒ already explains. Deleting them cannot change truth. */
  private sweepRedundant() {
    sweepEncoding(this.enc);
  }

  private get nonZeroBuckets(): Set<BucketId> {
    const s = new Set<BucketId>();
    for (const [b, st] of this.stats) {
      if (b !== ALL && st.total > 0) s.add(b);
    }
    return s;
  }

  /**
   * Local search over semantics-preserving re-encodings, minimising wire bytes.
   * Candidate moves per bucket g:
   *  • fully known g: set rule (g,INCLUDE) / (g,EXCLUDE) at tail, or drop g's rule — re-deriving overrides;
   *  • otherwise, with a fresh count: saturation collapse when C_g == N_g or C_g == 0.
   * Then canonicalise ℒ against β. Terminates because bytes strictly decrease.
   */
  consolidate() {
    const nonZero = this.nonZeroBuckets;
    normalizeEncoding(this.enc, this.groupIds, nonZero);
    this.sweepRedundant();
    for (let iter = 0; iter < 4 * (this.groupIds.length + 2); iter++) {
      const cur = compileEncoding(this.enc).bytes;
      let best: { enc: Encoding; bytes: number; label: string } | null = null;
      const consider = (enc: Encoding, label: string) => {
        normalizeEncoding(enc, this.groupIds, nonZero);
        sweepEncoding(enc);
        const bytes = compileEncoding(enc).bytes;
        if (!best || bytes < best.bytes) best = { enc, bytes, label };
      };
      // Global saturation: C_ALL == N (or 0) with a fresh count ⇒ the whole state is "everything"/"nothing".
      const all = this.stats.get(ALL)!;
      if (all.fresh && all.total > 0 && (all.selected === all.total || all.selected === 0)) {
        const base = all.selected === all.total;
        if (!(this.enc.base === base && this.enc.precedence.length === 0 && this.enc.exceptions.size === 0)) {
          consider({ base, precedence: [], exceptions: new Map() }, `global collapse: ${all.selected}/${all.total} ⇒ β=${base}, ℒ=∅, ℰ=∅`);
        }
      }
      for (const g of [...this.groupIds, UNGROUPED]) {
        const st = this.stats.get(g)!;
        if (st.total === 0) continue;
        const current = this.ruleFor(g);
        const isTail = current ? current.index === this.enc.precedence.length - 1 : false;
        if (this.isFullyKnown(g)) {
          const k = this.known.get(g)!;
          const filtered = this.enc.precedence.filter((r) => r.group !== g);
          for (const op of ['INCLUDE', 'EXCLUDE'] as Op[]) {
            if (!(current && isTail && current.rule.op === op)) {
              consider(reencodeKnownGroup(this.enc, g, op, k), `re-encode ${g} as ${op} (all ${st.total} rows known)`);
            }
            // A rule can also join an earlier same-op block. That changes which rows inherit g's
            // value, so reencodeKnownGroup re-derives the affected overrides before comparing.
            let lastSame = -1;
            for (let i = 0; i < filtered.length; i++) if (filtered[i].op === op) lastSame = i;
            if (lastSame >= 0 && lastSame + 1 !== filtered.length) {
              consider(
                reencodeKnownGroup(this.enc, g, op, k, lastSame + 1),
                `re-encode ${g} as ${op} after the last ${op} block (all rows known)`,
              );
            }
          }
          if (current) consider(reencodeKnownGroup(this.enc, g, null, k), `drop rule for ${g} (all rows known)`);
        } else if (st.fresh) {
          if (st.selected === st.total && !(current && isTail && current.rule.op === 'INCLUDE')) {
            consider(collapseSaturatedGroup(this.enc, g, 'INCLUDE'), `collapse ${g}: ${st.selected}/${st.total} selected → INCLUDE rule`);
          }
          if (st.selected === 0 && !(current && isTail && current.rule.op === 'EXCLUDE')) {
            consider(collapseSaturatedGroup(this.enc, g, 'EXCLUDE'), `collapse ${g}: 0/${st.total} selected → EXCLUDE rule`);
          }
        }
      }

      // Two rules may only be removable together: each drop alone adds more positive overrides
      // than it saves, while dropping both leaves just the small set of exclusive rows.
      const ruledKnown = [...this.groupIds, UNGROUPED].filter(
        (g) => this.stats.get(g)!.total > 0 && this.ruleFor(g) && this.isFullyKnown(g),
      );
      for (let i = 0; i < ruledKnown.length; i++) {
        for (let j = i + 1; j < ruledKnown.length; j++) {
          const a = ruledKnown[i];
          const b = ruledKnown[j];
          let comp = reencodeKnownGroup(this.enc, a, null, this.known.get(a)!);
          comp = reencodeKnownGroup(comp, b, null, this.known.get(b)!);
          consider(comp, `drop rules for ${a}+${b} (all rows known)`);
        }
      }

      // Three or more rules may also be stuck in a mutual-overlap local minimum: dropping any
      // single rule or pair leaves negative overrides for the remaining ruled group(s), while
      // dropping all k ruled known groups simultaneously leaves only positive exclusive overrides.
      if (ruledKnown.length >= 3) {
        let comp = this.enc;
        for (const g of ruledKnown) {
          comp = reencodeKnownGroup(comp, g, null, this.known.get(g)!);
        }
        consider(comp, `drop all ${ruledKnown.length} ruled known groups (${ruledKnown.join('+')})`);
      }

      // With every remaining unruled bucket saturated/small, all of them can be encoded at once.
      // Encoding them one at a time is a local minimum: adding a single e.g. EXCLUDE keeps the
      // state short of full coverage, so flipping β only pays when the whole set lands together.
      // Empty buckets stay unruled — they contain no rows, so none can fall through to β.
      const unruled = [...this.groupIds, UNGROUPED].filter((g) => !this.ruleFor(g));
      if (unruled.length > 1) {
        const encodable = unruled.every((g) => {
          const st = this.stats.get(g)!;
          return st.total === 0 || this.isFullyKnown(g) || (st.fresh && (st.selected === 0 || st.selected === st.total));
        });
        if (encodable) {
          let comp = cloneEncoding(this.enc);
          for (const g of unruled) {
            const st = this.stats.get(g)!;
            if (st.total === 0) continue; // no rows to preserve: leave it unruled
            const op: Op = st.selected === 0 ? 'EXCLUDE' : st.selected === st.total ? 'INCLUDE' : st.selected * 2 >= st.total ? 'INCLUDE' : 'EXCLUDE';
            comp = this.isFullyKnown(g)
              ? reencodeKnownGroup(comp, g, op, this.known.get(g)!)
              : collapseSaturatedGroup(comp, g, op);
          }
          // Once every non-empty bucket has a rule, β no longer decides any real row, so both
          // polarities are semantics-preserving; normalize/pruneHead then drops the longer head.
          for (const base of [comp.base, !comp.base]) {
            const candidate = cloneEncoding(comp);
            candidate.base = base;
            consider(candidate, `encode ${unruled.length} unruled buckets together, β=${base} (${unruled.join(', ')})`);
          }
        }
      }

      const b = best as { enc: Encoding; bytes: number; label: string } | null;
      if (b && b.bytes < cur) {
        this.enc = b.enc;
        this.consolidations.push({ version: this.version + 1, label: b.label, before: cur, after: b.bytes });
        if (this.consolidations.length > 40) this.consolidations.shift();
      } else break;
    }
    // β with no rules and no overrides is exactly the whole universe (or the empty set).
    if (this.enc.precedence.length === 0 && this.enc.exceptions.size === 0) {
      for (const st of this.stats.values()) {
        st.selected = this.enc.base ? st.total : 0;
        st.fresh = true;
      }
    }
  }
}

/** Convenience: the scope restriction for a bucket (used for RHS views and count queries). */
export function scopeFilter(b: BucketId): string {
  if (b === ALL) return '';
  if (b === UNGROUPED) return 'NOT groups:*';
  return `groups:${JSON.stringify(b)}`;
}

/** `(selection) AND scope` — what the client sends to count a bucket after a group-level mutation. */
export function countQueryFilter(selection: string | null, b: BucketId): string | null {
  if (selection === null) return null; // empty selection ⇒ 0, no network
  const scope = scopeFilter(b);
  if (selection === '') return scope; // universe ⇒ N_b (server still answers; client may short-circuit)
  if (scope === '') return selection;
  return `(${selection}) AND ${scope}`;
}

export const overrideKey = (o: Override) => `${o.id}:${o.selected ? '+' : '-'}`;

import { compileFilterPredicate } from '../engine/filterParser';
import { ALL, UNGROUPED, type BucketId, type GroupInfo, type ItemResource } from '../engine/types';

export interface ListRequest {
  filter?: string;
  pageSize: number; // 0 ⇒ count only (read total_size)
  offset?: number;
  pageToken?: string;
  purpose?: string; // demo annotation only
}
export interface ListResponse {
  items: ItemResource[];
  totalSize: number;
  nextPageToken?: string;
}
export interface RequestLogEntry {
  seq: number;
  method: 'ListItems' | 'ListGroups';
  filter: string;
  pageSize: number;
  offset: number;
  totalSize: number;
  returned: number;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  purpose: string;
  at: number;
}

export interface GroupSpec {
  id: string;
  name: string;
  size: number;
  color: string;
}

// mulberry32
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

const ADJ = ['amber', 'brisk', 'calm', 'dusky', 'eager', 'fuzzy', 'gilded', 'hollow', 'ivory', 'jolly', 'keen', 'lucid', 'mossy', 'nimble', 'opal', 'plucky', 'quiet', 'rusty', 'sleek', 'tidy', 'umber', 'vivid', 'witty', 'zesty'];
const NOUN = ['falcon', 'harbor', 'kestrel', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'ridge', 'saffron', 'thistle', 'umbra', 'valley', 'willow', 'yarrow', 'zephyr', 'beacon', 'cinder', 'delta'];

export function generateDataset(seed: number, n: number, specs: GroupSpec[]) {
  const rand = rng(seed);
  const used = new Set<string>();
  const items: ItemResource[] = [];
  for (let i = 0; i < n; i++) {
    let id: string;
    do {
      id = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
    } while (used.has(id));
    used.add(id);
    const name = `${ADJ[Math.floor(rand() * ADJ.length)]}-${NOUN[Math.floor(rand() * NOUN.length)]}-${i}`;
    items.push({ id, name, groups: [] });
  }
  for (const spec of specs) {
    const chosen = new Set<number>();
    while (chosen.size < Math.min(spec.size, n)) chosen.add(Math.floor(rand() * n));
    for (const idx of chosen) items[idx].groups.push(spec.id);
  }
  // Server owns ordering; keep groups in spec order for determinism.
  const order = new Map(specs.map((s, i) => [s.id, i]));
  for (const it of items) it.groups.sort((a, b) => order.get(a)! - order.get(b)!);
  return items;
}

export class MockServer {
  readonly items: ItemResource[];
  readonly groups: GroupInfo[];
  readonly ungroupedTotal: number;
  latencyRange: [number, number] = [60, 220];
  log: RequestLogEntry[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private predicateCache = new Map<string, (i: ItemResource) => boolean>();

  constructor(seed: number, n: number, specs: GroupSpec[]) {
    this.items = generateDataset(seed, n, specs);
    this.groups = specs.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      total: this.items.reduce((a, it) => a + (it.groups.includes(s.id) ? 1 : 0), 0),
    }));
    this.ungroupedTotal = this.items.filter((i) => i.groups.length === 0).length;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private notify() {
    for (const l of this.listeners) l();
  }

  private predicate(filter: string) {
    let p = this.predicateCache.get(filter);
    if (!p) {
      p = compileFilterPredicate(filter);
      if (this.predicateCache.size > 200) this.predicateCache.clear();
      this.predicateCache.set(filter, p);
    }
    return p;
  }

  private async delay() {
    const [lo, hi] = this.latencyRange;
    const ms = lo + Math.random() * Math.max(0, hi - lo);
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  }

  /** Standard AIP-132/160 List: filter + page_size + offset (page_token = encoded offset). */
  async listItems(req: ListRequest): Promise<ListResponse> {
    const filter = req.filter ?? '';
    const offset = req.pageToken ? parseInt(req.pageToken, 10) : (req.offset ?? 0);
    const pred = this.predicate(filter); // parse errors surface to the caller, like a 400
    const latencyMs = await this.delay();
    const matched = this.items.filter(pred);
    const page = req.pageSize > 0 ? matched.slice(offset, offset + req.pageSize) : [];
    const res: ListResponse = { items: page, totalSize: matched.length };
    if (req.pageSize > 0 && offset + req.pageSize < matched.length) res.nextPageToken = String(offset + req.pageSize);
    this.record({
      method: 'ListItems',
      filter,
      pageSize: req.pageSize,
      offset,
      totalSize: matched.length,
      returned: page.length,
      latencyMs,
      requestBytes: new TextEncoder().encode(JSON.stringify({ filter, page_size: req.pageSize, offset })).length,
      responseBytes: new TextEncoder().encode(JSON.stringify(res)).length,
      purpose: req.purpose ?? '',
    });
    return res;
  }

  async listGroups() {
    const latencyMs = await this.delay();
    const res = { groups: this.groups, ungroupedTotal: this.ungroupedTotal, totalSize: this.items.length };
    this.record({
      method: 'ListGroups',
      filter: '',
      pageSize: 0,
      offset: 0,
      totalSize: this.groups.length,
      returned: this.groups.length,
      latencyMs,
      requestBytes: 2,
      responseBytes: new TextEncoder().encode(JSON.stringify(res)).length,
      purpose: 'bootstrap: group list + counts',
    });
    return res;
  }

  private record(e: Omit<RequestLogEntry, 'seq' | 'at'>) {
    this.log.push({ ...e, seq: ++this.seq, at: Date.now() });
    if (this.log.length > 60) this.log.shift();
    this.notify();
  }

  // ---- Offline oracle (test harness only — NOT part of the wire protocol) ----
  /** Evaluate a compiled selection filter against the full dataset. */
  oracleSelected(filter: string | null): Set<string> {
    if (filter === null) return new Set();
    const pred = this.predicate(filter);
    const out = new Set<string>();
    for (const it of this.items) if (pred(it)) out.add(it.id);
    return out;
  }
  oracleCounts(filter: string | null): Map<BucketId, number> {
    return this.countsForSet(this.oracleSelected(filter));
  }
  countsForSet(sel: Set<string>): Map<BucketId, number> {
    const counts = new Map<BucketId, number>();
    counts.set(ALL, sel.size);
    counts.set(UNGROUPED, 0);
    for (const g of this.groups) counts.set(g.id, 0);
    for (const it of this.items) {
      if (!sel.has(it.id)) continue;
      if (it.groups.length === 0) counts.set(UNGROUPED, counts.get(UNGROUPED)! + 1);
      for (const g of it.groups) counts.set(g, counts.get(g)! + 1);
    }
    return counts;
  }
  findItem(pred: (i: ItemResource) => boolean): ItemResource | undefined {
    return this.items.find(pred);
  }
}

export const DEFAULT_SPECS: GroupSpec[] = [
  { id: 'pilot', name: 'Pilot cohort', size: 7, color: '#f472b6' },
  { id: 'beta', name: 'Beta testers', size: 15, color: '#fb923c' },
  { id: 'legal', name: 'Legal', size: 60, color: '#facc15' },
  { id: 'design', name: 'Design', size: 240, color: '#a3e635' },
  { id: 'contractors', name: 'Contractors', size: 420, color: '#2dd4bf' },
  { id: 'sales', name: 'Sales', size: 700, color: '#38bdf8' },
  { id: 'support', name: 'Support', size: 1100, color: '#a78bfa' },
  { id: 'eng', name: 'Engineering', size: 1600, color: '#f87171' },
];

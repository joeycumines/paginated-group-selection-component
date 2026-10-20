# Selection Lattice: Paginated Multi-Group Selection & Min-Byte AIP-160 Filter Synthesis

> **Live Demo**: [https://joeycumines.github.io/paginated-group-selection-component/](https://joeycumines.github.io/paginated-group-selection-component/)

**Selection Lattice** is a reference implementation and interactive workbench for managing multi-group item selection under partial information. It pairs a virtualized React UI with a zero-dependency TypeScript selection engine (`SelectionEngine`) that maintains exact selection state across unfetched server rows, tracks per-group item counts across overlapping groups, and compiles the user's selection into a byte-minimal [Google AIP-160](https://google.aip.dev/160) filter expression.

---

## Problem statement and constraints

Consider a split-pane selection interface backed by a standard [Google AIP-132](https://google.aip.dev/132) / AIP-160 `List` API (`filter`, `page_size`, `offset` / `page_token`, returning `items` and `total_size`):

1. **Multi-group membership with an ungrouped bucket**: Each item resource $x$ in the universe $U$ ($\vert{}U\vert{} = N$) exposes an `id: string` and a group membership list $S_x \subseteq G$, where $G = \{g_1, g_2, \dots, g_K\}$. An item may belong to zero, one, or multiple groups. Items with $S_x = \emptyset$ belong to a synthetic `UNGROUPED` bucket ($g_0$).
2. **Partial client knowledge**: $N$ may be large ($N = 4,000$ in the demo, millions in production). The client only fetches pages of items on demand as the user scrolls the right-hand grid. The client cannot load all item IDs into memory.
3. **Wire and memory consolidation**:
* Untouched items and items whose selection state matches their inherited group rules must consume **0 bytes** of client memory and **0 item literals** on the wire.
* Selecting or deselecting individual items until a group is saturated ($100\%$ or $0\%$ selected) must collapse those item overrides into a group rule in $\mathcal{L}$.
* For groups small enough to have their member IDs cached client-side ($N_g \le \text{knownCap}$), crossing the $50\%$ byte-cost threshold must flip the group between inclusive mode (`id="x1" OR id="x2"`) and exclusive mode (`groups:"g" AND NOT id="x3"`).
* Selecting all buckets (or a majority of buckets) must normalize the global baseline $\beta$ and prune redundant rules so the wire filter emits the complement (`NOT (...)`) or the universe (`""`).


4. **Live per-bucket counts and the overlap knowledge gap**:
* The left-hand group pane must display the selected count $C_b / N_b$ and tri-state checkbox (`all`, `partial`, `none`, `empty`) for `ALL`, `UNGROUPED`, and every group $g_i \in G$.
* Toggling a single item $x$ in the right-hand grid updates every bucket $b \in \{\text{ALL}\} \cup \text{eff}(S_x)$ in $O(\vert{}S_x\vert{})$ time without network calls because $S_x$ is present on the loaded `ItemResource`.
* Toggling an entire group $g_a$ in the left-hand pane mutates unfetched rows on the server. When $g_a$ and $g_b$ overlap on unfetched rows, the intersection size $\vert{}g_a \cap g_b\vert{}$ is unknowable from marginal totals $N_{g_a}$ and $N_{g_b}$ alone. The engine must preserve exact logical truth on the wire while marking affected peer counts stale (`fresh = false`, rendered as indeterminate) until reconciled via count-only queries (`page_size = 0`).



---

## Core invariants

Every state transition, consolidation move, and reconciliation step preserves five invariants (verified after every random step in `src/engine/propertyTest.ts`):

* **I1 (Wire equivalence)**: Evaluating the compiled AIP-160 filter over the full dataset $U$ selects the exact same set of items as `engine.isSelected(x.id, x.groups)`. An empty selection compiles to `text = null` (nothing to send); the full universe compiles to `text = ""` (the standard empty AIP-160 filter).
* **I2 (Exception minimality)**: The exception table $\mathcal{E}$ stores an item $x$ if and only if its desired selection state differs from the state inherited from $(\beta, \mathcal{L})$:

$$\forall (x, o) \in \mathcal{E}, \quad o.\text{selected} \neq \text{groupEval}((\beta, \mathcal{L}), o.\text{groups})$$


* **I3 (Precedence uniqueness and scope)**: The precedence deque $\mathcal{L}$ contains at most one rule per bucket $b \in \{g_0, g_1, \dots, g_K\}$ ($\vert{}\mathcal{L}\vert{} \le K + 1$) and never contains a rule for `ALL`.
* **I4 (Fresh count exactness)**: For every bucket $b \in \{\text{ALL}, g_0, g_1, \dots, g_K\}$, whenever `stats.get(b).fresh === true`, `stats.get(b).selected` equals the true number of selected items in $b$.
* **I5 (Stale count safety)**: Whenever `stats.get(b).fresh === false`, `stats.get(b).selected` is treated as an unverified historical number. Client mutations never apply arithmetic deltas to a stale count, and `engine.bucketState(b)` always returns `'partial'` for non-empty stale buckets so the UI never displays a false `'all'` or `'none'` checkbox state.

---

## State representation

### Effective group mapping and disjointness of `UNGROUPED`

Let $g_0 = \text{UNGROUPED}$ (`"__UNGROUPED__"`). Every item $x$ with resource groups $S_x \subseteq G$ maps to a non-empty effective group list:

$$\text{eff}(S_x) = \begin{cases} \{g_0\} & \text{if } S_x = \emptyset \\ S_x & \text{if } S_x \neq \emptyset \end{cases}$$

Because an item belongs to $g_0$ if and only if $S_x = \emptyset$, $g_0$ is mutually exclusive with every real group: $g_0 \cap g_i = \emptyset$ for all $i \in \{1, \dots, K\}$, and $\{g_0, g_1, \dots, g_K\}$ covers $U$.

### Canonical encoding $(\beta, \mathcal{L}, \mathcal{E})$

The complete logical selection is represented by `Encoding` (`src/engine/types.ts`), requiring $O(K + \vert{}\mathcal{E}\vert{})$ memory:

```ts
export type Op = 'INCLUDE' | 'EXCLUDE';

export interface Rule {
  group: GroupId; // g_0 (UNGROUPED) or g_i in G
  op: Op;
}

export interface Override {
  id: string;
  groups: GroupId[]; // Cached from ItemResource when observed
  selected: boolean;
}

export interface Encoding {
  base: boolean;                    // β: false = "just these", true = "all except these"
  precedence: Rule[];               // ℒ: ordered deque, ≤ 1 rule per bucket, tail = highest precedence
  exceptions: Map<string, Override>; // ℰ: explicit item overrides where selected !== groupEval(groups)
}

```

### Truth evaluation (`groupEval` and `isSelectedIn`)

For any row $x$ (whether resident in browser memory or unfetched on the server), group inheritance scans $\mathcal{L}$ from newest rule (tail) to oldest rule (head):

$$\text{groupEval}((\beta, \mathcal{L}), S_x) = \begin{cases} \text{ true } & \text{if } \text{op}_{i^*} = \text{INCLUDE} \\ \text{ false } & \text{if } \text{op}_{i^*} = \text{EXCLUDE} \\ \beta & \text{if no rule in } \mathcal{L} \text{ matches } \text{eff}(S_x) \end{cases}$$

where $i^* = \max \{ i \in \{0, \dots, \vert{}\mathcal{L}\vert{} - 1\} \mid \mathcal{L}[i].\text{group} \in \text{eff}(S_x) \}$.

Item selection short-circuits on $\mathcal{E}$ before falling back to `groupEval`:

$$\text{isSelectedIn}((\beta, \mathcal{L}, \mathcal{E}), x, S_x) = \begin{cases} \mathcal{E}[x].\text{selected} & \text{if } x \in \mathcal{E} \\ \text{groupEval}((\beta, \mathcal{L}), S_x) & \text{if } x \notin \mathcal{E} \end{cases}$$

### Auxiliary bucket stats and bounded known-ID cache

Alongside `enc: Encoding`, `SelectionEngine` maintains two bounded structures:

1. **`stats: Map<BucketId, BucketStats>`**: Initialized from a single `ListGroups()` bootstrap call returning $N$, $N_{g_0}$, and $N_{g_i}$ for each group. Each entry holds `{ total: number, selected: number, fresh: boolean }`.
2. **`known: Map<GroupId, GroupId[] Map<string,>>`**: Parameterized by `knownCap: number`. Only buckets $b \in \{g_0\} \cup G$ with $N_b \le \text{knownCap}$ are allocated a map in `known`. As pages of items flow through the grid (`engine.observe(items)`) or individual items are clicked, `(item.id, item.groups)` is recorded for eligible buckets. Once `known.get(b).size === stats.get(b).total`, bucket $b$ is **fully known** (`engine.isFullyKnown(b) === true`). Total cached entries across the engine are bounded by $\sum_{b : N_b \le \text{knownCap}} N_b \le (K + 1) \cdot \text{knownCap}$, independent of $N$.

---

## Mutation and freshness semantics

Every user action executes a mutation phase followed by `consolidate()` and a single version increment (`bump()`).

### 1. Toggling a single item (`toggleItem(item, selected)`)

When the user clicks a row in the right-hand grid, its `ItemResource` is already loaded in the current page buffer, so $S_x = \text{item.groups}$ is known:

1. **Observation**: Passes `[item]` to `recordObserved`. If this item completes the cache for any small group (`newlyKnown === true`) even when `prev === selected`, the engine recomputes known bucket counts, runs `consolidate()`, and bumps the version once. If `prev === selected` and `!newlyKnown`, returns immediately without bumping `version`.
2. **Fresh delta propagation**: Let $\Delta = \text{selected} ? +1 : -1$. For each $b \in \{\text{ALL}\} \cup \text{eff}(S_x)$, if `stats.get(b).fresh === true`, updates `selected` by $\Delta$ clamped to $[0, N_b]$. If `stats.get(b).fresh === false`, the count is left untouched (preserving **I5**).
3. **Exception update**: Computes $\text{inherited} = \text{groupEval}(\text{enc}, S_x)$. If $\text{selected} = \text{inherited}$, deletes `item.id` from $\mathcal{E}$; otherwise writes `{ id: item.id, groups: item.groups, selected }` into $\mathcal{E}$ (preserving **I2**).
4. **Consolidation**: If `newlyKnown`, calls `recomputeKnownBuckets()`. Runs `consolidate()` and `bump()`.

### 2. Toggling a bucket (`toggleGroup(g, op)`)

1. **Boundary guards**:
* If `g === ALL`, delegates to `selectAll()` (`op === 'INCLUDE'`) or `clearAll()` (`op === 'EXCLUDE'`). This prevents injecting a dead `groups:"ALL"` rule into $\mathcal{L}$.
* If $g$ is unknown or empty (`stats.get(g).total === 0`), returns immediately.


2. **Encoding update**: Removes any existing entry for $g$ from $\mathcal{L}$, appends `{ group: g, op }` to the tail of $\mathcal{L}$, and deletes every override $o \in \mathcal{E}$ where $g \in \text{eff}(o.\text{groups})$.
3. **Bucket count and freshness transition**:
* Sets $g$'s own count to exact: `sg.selected = target ? sg.total : 0` and `sg.fresh = true`.
* Updates `ALL` and peer groups $h \neq g$ according to three cases:



| Case | Condition | Count & Freshness Behavior | Network Cost |
| --- | --- | --- | --- |
| **A. Fully known group** | `isFullyKnown(g) === true` | Snapshots `isSelected(id, groups)` for all $id \in \text{known.get}(g)$ before the mutation. Accumulates exact $\pm 1$ deltas for `ALL` and every peer $b \in \text{eff}(\text{groups}) \setminus \{g\}$ across items whose truth changed, and applies them to all `fresh` buckets. | $0$ queries |
| **B. Ungrouped bucket** | `g === UNGROUPED` and `!isFullyKnown(g)` | Because $g_0 \cap g_i = \emptyset$, no real group $g_i$ changes. Only `ALL` changes by `sg.selected - prevSelected`. If `prevFresh && all.fresh`, updates `all.selected` in place; otherwise marks `all.fresh = false`. | $0$ queries (or $1$ if `ALL` was stale) |
| **C. Partially known real group** | $g \in G$ and `!isFullyKnown(g)` | **No-op skip**: If `prevFresh && prevSelected === (target ? sg.total : 0)`, zero rows moved, so nothing is invalidated.<br>

<br>**Monotonic bound skip**: Any fresh peer $h$ (or `ALL`) already at the target bound (`selected === total` for `INCLUDE`, `selected === 0` for `EXCLUDE`) cannot move and stays `fresh = true`. Fully known peers are recomputed offline. Only remaining peers and `ALL` are marked `fresh = false`. `UNGROUPED` stays fresh. | $1$ `page_size=0` count query per stale bucket (debounced) |

### 3. Reconciling stale counts (`reconcile(counts, requestVersion)`)

When `engine.staleBuckets()` is non-empty, the client debounces (150 ms in `App.tsx`) and queries the server for each stale bucket $b$ using `countQueryFilter(selection, b)` with `page_size = 0`:

$$\text{filter}_b = \begin{cases} \text{null (short-circuit to } 0\text{, no RPC)} & \text{if } \text{selection} = \text{null} \\ \text{scope}(b) & \text{if } \text{selection} = \text{"" (universe)} \\ \text{selection} & \text{if } b = \text{ALL} \\ \texttt{(}\text{selection}\texttt{) AND }\text{scope}(b) & \text{otherwise} \end{cases}$$

where $\text{scope}(\text{ALL}) = \text{""}$, $\text{scope}(\text{UNGROUPED}) = \texttt{NOT groups:*}$, and $\text{scope}(g) = \texttt{groups:"}g\texttt{"}$.

When the responses return, `engine.reconcile(counts, requestVersion)` checks `requestVersion === engine.version` (discarding the batch if a newer mutation occurred while in flight), updates `selected` and `fresh = true` for each reconciled bucket, and runs `consolidate()` to trigger any saturation or composite collapses unlocked by the newly fresh counts.

---

## Consolidation and min-byte filter synthesis

After every mutation, observation of a newly completed group, or count reconciliation, `consolidate()` searches for semantics-preserving transformations of $(\beta, \mathcal{L}, \mathcal{E})$ that strictly reduce the UTF-8 byte length of the compiled AIP-160 filter.

### Step 1: Canonical normalization (`normalizeEncoding`)

Given any candidate encoding $(\beta, \mathcal{L}, \mathcal{E})$ and the set of non-empty buckets $\mathcal{B}_{+} = \{b \in \{g_0\} \cup G \mid N_b \gt 0\}$, `normalizeEncoding` performs three exact reductions:

1. **Full-coverage $\beta$ absorption**:
Let $g_0\text{-rule}$ be the rule for `UNGROUPED` in $\mathcal{L}$ (if any) and $\mathcal{L}_{\text{rest}} = \mathcal{L} \setminus \{g_0\text{-rule}\}$. Full coverage holds when every non-empty bucket in $\mathcal{B}_{+}$ has an explicit rule in $\mathcal{L}$:

$$\text{fullCoverage} \iff (g_0 \notin \mathcal{B}_{+} \lor g_0\text{-rule} \neq \text{null}) \land \forall g \in (G \cap \mathcal{B}_{+}), \; \exists r \in \mathcal{L}_{\text{rest}} \text{ s.t. } r.\text{group} = g$$



Empty buckets ($N_b = 0$) contain no items and cannot fall through $\mathcal{L}$ to $\beta$, so they do not prevent full coverage. When `fullCoverage` is true, no item in $U$ can ever reach $\beta$. The normalizer tests candidate polarities $\beta \in \{g_0\text{-rule.op} = \text{INCLUDE}, \; \mathcal{L}_{\text{rest}}[0].\text{op} = \text{INCLUDE}\}$ (guarded against null/empty), prunes the head of $\mathcal{L}_{\text{rest}}$ against each candidate $\beta$, places $g_0\text{-rule}$, and selects the $(\beta, \mathcal{L})$ with minimum compiled UTF-8 bytes.
2. **Head pruning (`pruneHead`)**:
Drops the longest contiguous prefix of $\mathcal{L}_{\text{rest}}$ at index $0, 1, \dots$ whose operation matches $\beta$ (`(r.op === 'INCLUDE') === base`), since items falling through to the head of $\mathcal{L}$ would receive the same value from $\beta$.
3. **Byte-minimal `UNGROUPED` placement (`placeUngrouped`)**:
Because $g_0$ is disjoint from all $g_i \in G$, its rule commutes with every rule in $\mathcal{L}_{\text{rest}}$.
* If $g_0\text{-rule}$ matches $\beta$, it is dropped (absorbed into $\beta$ for 0 bytes).
* Otherwise, `placeUngrouped` tests splicing $g_0\text{-rule}$ at every index $i \in \{0, \dots, \vert{}\mathcal{L}_{\text{rest}}\vert{}\}$ **with the actual exception map $\mathcal{E}$ attached**, keeping the position that yields the minimum compiled UTF-8 byte count. Testing with $\mathcal{E}$ attached is required because trailing `OR id="..."` or `AND NOT id="..."` clauses alter parenthesization of the outer group expression.



### Step 2: Steepest-descent local search (`consolidate`)

Following initial normalization and an exception sweep (`sweepEncoding`, which deletes any override $o \in \mathcal{E}$ where $o.\text{selected} = \text{groupEval}(\text{enc}, o.\text{groups})$), `consolidate()` runs a steepest-descent loop for at most $4(K + 2)$ iterations. Each iteration evaluates six families of truth-preserving candidate moves:

| Candidate Move | Precondition | Transformation & Override Re-derivation |
| --- | --- | --- |
| **1. Global saturation collapse** | `all.fresh && all.total > 0` and $C_{\text{ALL}} \in \{0, N\}$ | Replaces encoding with $\beta = (C_{\text{ALL}} = N), \; \mathcal{L} = \emptyset, \; \mathcal{E} = \emptyset$. |
| **2. Known-group tail re-encoding (polarity flip)** | `isFullyKnown(g)` ($N_g \le \text{knownCap}$ and all $N_g$ items cached) | `reencodeKnownGroup(enc, g, op, known.get(g))` for $\text{op} \in \{\text{INCLUDE}, \text{EXCLUDE}\}$ moves $(g, \text{op})$ to the tail of $\mathcal{L}$ and recomputes $\mathcal{E}[x]$ for every $x \in \text{known.get}(g)$ so `isSelected` is unchanged. Flips $g$ between positive IDs and `groups:"g" AND NOT (...)` whenever doing so saves bytes. |
| **3. Known-group same-op block insertion** | `isFullyKnown(g)` and $\mathcal{L} \setminus \{g\}$ has an earlier non-tail rule with operation `op` | Splices $(g, \text{op})$ immediately after the last existing rule of polarity `op` (`insertAt = lastSame + 1`) so $g$ coalesces into that block, re-deriving overrides in $\mathcal{E}$ for any items of $g$ affected by intervening rules. |
| **4. Saturated group collapse (unknown IDs)** | `!isFullyKnown(g) && st.fresh` and $C_g \in \{0, N_g\}$ | `collapseSaturatedGroup(enc, g, op)` promotes $(g, \text{INCLUDE})$ (if $C_g = N_g$) or $(g, \text{EXCLUDE})$ (if $C_g = 0$) to the tail of $\mathcal{L}$ and sweeps overrides in $\mathcal{E}$ belonging to $g$ whose truth is now supplied by the new rule, while preserving any opposite-polarity overrides. |
| **5. Single, pairwise ($k=2$), and multi-group ($k \ge 3$) rule drop** | $g$ (or subset of `ruledKnown`) is currently in $\mathcal{L}$ and `isFullyKnown` | Tests dropping a single rule $g$, dropping any pair $(a, b)$ of ruled known groups, and (when $\vert{}\text{ruledKnown}\vert{} \ge 3$) dropping all $k$ ruled known groups simultaneously. Simultaneous multi-rule drops escape local minima where $k \ge 2$ overlapping groups share negative overrides in $g_{i_1} \cap \dots \cap g_{i_k}$: dropping fewer than $k$ rules leaves the negative overrides needed against the surviving rule(s), whereas dropping all $k$ collapses them into a smaller set of positive overrides. |
| **6. Composite unruled-bucket completion + $\beta$ flip** | $\vert{}\text{unruled}\vert{} \ge 2$ and every $g \in \text{unruled}$ is either empty ($N_g = 0$), `isFullyKnown(g)`, or fresh and saturated ($C_g \in \{0, N_g\}$) | Encodes all non-empty unruled buckets together in a single composite step and evaluates both $\beta$ polarities (`comp.base` and `!comp.base`). Escapes the local minimum where encoding one unruled bucket at a time increases byte length before reaching `fullCoverage`. |

A candidate move is committed if and only if its normalized, swept compiled byte count is **strictly less** than the current byte count (`best.bytes < cur`). Because byte count is a non-negative integer that strictly decreases on every accepted step, the loop is guaranteed to terminate.

Finally, if `consolidate()` ends at a pure-$\beta$ state ($\mathcal{L} = \emptyset$ and $\mathcal{E} = \emptyset$), every bucket count is known to be either $N_b$ ($\beta = \text{true}$) or $0$ ($\beta = \text{false}$) and is marked `fresh = true` immediately.

---

## AIP-160 compilation and grammar

### 1. Dual-layout block coalescing (`coalesce` and `compileEncoding`)

Given $\mathcal{L} = [(b_1, \text{op}_1), \dots, (b_m, \text{op}_m)]$, adjacent rules with the same operation commute and coalesce into alternating blocks $B_1, B_2, \dots, B_p$ where $B_r = (\text{op}_r, G_r)$.

A subtle byte-length trade-off arises when $\mathcal{L}$ contains `(UNGROUPED, EXCLUDE)`:

* In AST form, `groupNode(UNGROUPED)` is `{ type: 'ungrouped' }`, which prints as `NOT groups:*` ($12$ bytes).
* When negated on its own (`not({ type: 'ungrouped' })`), double-negation elimination in `printFilter` emits `groups:*` ($8$ bytes).
* If `(UNGROUPED, EXCLUDE)` is merged into a neighbouring `EXCLUDE` block with real groups (say `a` and `b`), it prints as `NOT (groups:"a" OR groups:"b" OR NOT groups:*)`. If split into its own block, it prints as `groups:* AND NOT (groups:"a" OR groups:"b")`.
* When `(UNGROUPED, EXCLUDE)` sits at the start or end of an `EXCLUDE` run, splitting saves bytes; when it sits in the middle of an `EXCLUDE` run (`a`, `b`, `UNGROUPED`, `c`), splitting breaks one `NOT (... OR ...)` block into three blocks and costs extra bytes.

To guarantee the shorter output in all cases, whenever `(UNGROUPED, EXCLUDE)` is present in $\mathcal{L}$, `compileEncoding` evaluates both `coalesce(precedence, false)` (merged) and `coalesce(precedence, true)` (isolated `UNGROUPED` `EXCLUDE`) and keeps the layout with fewer UTF-8 bytes.

### 2. $\Phi(p)$ recurrence and exception attachment

For each coalesced block list $B_1, \dots, B_p$:

1. **Base case**:

$$\Phi(0) = \begin{cases} \text{ALL\_NODE} & \text{if } \beta = \text{true} \\ \text{NONE\_NODE} & \text{if } \beta = \text{false} \end{cases}$$


2. **Block fold ($1 \le r \le p$)**:

$$\Phi(r) = \begin{cases} \text{or}\!\left(\Phi(r-1), \; \bigvee_{g \in G_r} \text{groupNode}(g)\right) & \text{if } \text{op}_r = \text{INCLUDE} \\ \text{and}\!\left(\Phi(r-1), \; \text{not}\!\left(\bigvee_{g \in G_r} \text{groupNode}(g)\right)\right) & \text{if } \text{op}_r = \text{EXCLUDE} \end{cases}$$


3. **Exception attachment**: Let $I^+ = \{x \in \mathcal{E} \mid \mathcal{E}[x].\text{selected} = \text{true}\}$ and $I^- = \{y \in \mathcal{E} \mid \mathcal{E}[y].\text{selected} = \text{false}\}$, sorted lexicographically for deterministic wire output:

$$\Psi = \text{and}\!\left(\text{or}\!\left(\Phi(p), \; \bigvee_{x \in I^+} \text{idNode}(x)\right), \; \text{not}\!\left(\bigvee_{y \in I^-} \text{idNode}(y)\right)\right)$$



The algebraic constructors `or`, `and`, and `not` (`src/engine/filterAst.ts`) flatten nested nodes of the same kind and apply boolean identity/annihilator laws (`or(X, ALL) = ALL`, `or(X, NONE) = X`, `and(X, ALL) = X`, `and(X, NONE) = NONE`, `not(not(X)) = X`).

### 3. AIP-160 grammar, operator precedence, and escaping (`filterAst.ts` & `filterParser.ts`)

`src/engine/filterParser.ts` implements the formal AIP-160 grammar subset used by the engine and `MockServer`:

```ebnf
expression  = sequence { "AND" sequence } ;
sequence    = factor { factor } ;          (* adjacency = implicit AND *)
factor      = term { "OR" term } ;
term        = [ "NOT" | "-" ] simple ;
simple      = restriction | "(" expression ")" ;
restriction = comparable [ comparator arg ] ;
comparator  = ":" | "=" | "!=" | "<" | "<=" | ">" | ">=" ;

```

Key protocol and serialization details:

* **Cross-convention parenthesization**: In AIP-160, `OR` (`factor`) binds tighter than `AND` (`expression`), which is the inverse of SQL/CEL/C-style precedence. `printFilter` parenthesizes every `or` node inside an `and` node and every `and` node inside an `or` node. As a result, emitted filters parse to the identical AST under both strict AIP-160 parsers and SQL/CEL-precedence parsers.
* **No bare chained negation**: Per `term = [ "NOT" | "-" ] simple`, bare chained negation (`NOT NOT x` without parentheses) is invalid AIP-160 syntax and is rejected by the parser. Double negation on `UNGROUPED` is simplified at AST construction/print time (`NOT (NOT groups:*)` $\to$ `groups:*`).
* **JSON escaping and wildcard disambiguation**: Group IDs and item IDs are serialized via `JSON.stringify` (`groups:"..."`, `id="..."`). The tokenizer decodes all JSON escapes (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) and records `argQuoted: boolean` on parsed restrictions. Consequently, unquoted `groups:*` (`arg === '*' && !argQuoted`) evaluates the presence check `item.groups.length > 0`, whereas a group or item literally named `"*"` serializes as `groups:"*"` or `id="*"` (`argQuoted === true`) and matches the literal string `"*"` without ambiguity.
* **Empty selection guard**: `printFilter(NONE_NODE)` throws an error rather than returning `""` (which means the full universe in AIP-160). Only `compileEncoding`'s top-level `expr.type === 'none' ? null : printFilter(expr)` maps the empty selection to `null`.

---

## UI architecture and concurrency invariants

The interactive demo (`src/App.tsx` and `src/components/`) is structured around four UI and lifecycle invariants:

1. **External store synchronization (`src/hooks/useStores.ts`)**: `SelectionEngine` and `MockServer` are plain TypeScript classes outside React state, bridged to React 19 via `useSyncExternalStore` (`useEngineVersion` and `useServerLog`).
2. **Virtualized grid with pin-aware LRU page cache (`src/components/ItemGrid.tsx`)**:
* `computeGridRange(scrollTop, viewportH, totalSize, pageSize)` returns `{ first: 0, last: -1, firstPage: 0, lastPage: 0 }` when `totalSize <= 0`, rendering 0 DOM rows on empty views without ghost skeleton rows. For `totalSize > 0`, it clamps both `first` and `last` row indices to `maxRow = totalSize - 1`, preventing out-of-bounds page offset requests when `totalSize` shrinks while scrolled down.
* `ItemGrid` caches at most `PAGE_CACHE_CAP = 5` pages in memory. Cache hits promote the page to the MRU position; cache misses evict only the least-recently-used pages outside the currently visible `[firstPage, lastPage]` window.
* `ItemGrid` is keyed on ``${view}:${pageSize}`` and guards in-flight fetches with an incrementing `epoch` ref so cross-view or cross-dataset responses are ignored.


3. **Version-gated count reconciliation (`src/App.tsx`)**: Debounced `page_size=0` count queries capture `const v = engine.version` before firing and pass `v` to `engine.reconcile(results, v)`, ensuring slow network responses never overwrite newer user mutations.
4. **Monotonic token cancellation in `ScenarioRunner` (`src/components/ScenarioRunner.tsx`)**: Scripted async walkthroughs capture `const myRunId = ++runSeq.current` on start. A synchronous ref (`runningRef`) guards against rapid concurrent click races. Manual abort sets `abort.current = true;` without incrementing `runSeq.current`, enabling the active scenario to cleanly complete its `finally` block, clear `running`, and log cancellation. Engine swap and unmount cleanup increment `runSeq.current` and clear `running` and `runningRef`, immediately invalidating all in-flight coroutines. All async continuations (`waitFresh`, `sleep`, `fetchItems`, `log`, and `finally`) check `runSeq.current === myRunId`, preventing zombie coroutines from mutating state across dataset or `knownCap` changes.

---

## Repository layout

```text
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── scripts/
│   ├── check.ts               # CLI property test suite (72 runs across 3 dataset shapes, 34,200 steps)
│   ├── regressions.ts         # 25 deterministic regression tests for engine, compiler, parser, and UI math
│   └── walkthrough.ts         # CLI trace of the 5 core selection & consolidation scenarios
└── src/
    ├── App.tsx                # Top-level workbench layout, bootstrap, debounced reconciliation, live oracle
    ├── main.tsx               # React entry point
    ├── index.css              # Tailwind CSS entry
    ├── engine/
    │   ├── types.ts           # Core types: GroupId, BucketId, Rule, Override, Encoding, effectiveGroups
    │   ├── SelectionEngine.ts # State machine, normalization, local-search consolidation, AIP-160 compiler
    │   ├── filterAst.ts       # FilterNode AST, constant-folding constructors, AIP-160 printer
    │   ├── filterParser.ts    # Recursive-descent AIP-160 parser and predicate evaluator
    │   └── propertyTest.ts    # Seeded randomized property test harness & invariant oracle
    ├── server/
    │   └── mockServer.ts      # Seeded dataset generator (N=4000, K=8) & AIP-132/160 MockServer
    ├── hooks/
    │   └── useStores.ts       # useSyncExternalStore bindings for SelectionEngine and MockServer
    ├── components/
    │   ├── GroupPane.tsx      # LHS bucket list with tri-state checkboxes, freshness pulse, and cache badges
    │   ├── ItemGrid.tsx       # RHS virtualized item grid with 5-page pin-aware LRU cache & row provenance
    │   ├── WirePanel.tsx      # Live AIP-160 filter output, byte/token stats, Φ(p) block fold, AST viewer
    │   ├── EnginePanel.tsx    # Live (β, ℒ, ℰ) inspector and consolidation move log
    │   ├── ScenarioRunner.tsx # 5 interactive walkthroughs + in-browser 400-step property test runner
    │   ├── NetworkLog.tsx     # Live RPC request/response log highlighting page_size=0 count queries
    │   └── ui.tsx             # Shared TriCheckbox, Chip, Panel, Spinner primitives
    └── utils/
        └── cn.ts              # Classname utility

```

---

## Getting started and verification

### Live interactive workbench

The reference implementation and interactive workbench is deployed live on GitHub Pages:
[https://joeycumines.github.io/paginated-group-selection-component/](https://joeycumines.github.io/paginated-group-selection-component/)

### Prerequisites

* Node.js $\ge 20$ and `npm`

### Installation and interactive development

```bash
npm install
npm run dev

```

Open the local Vite URL to inspect the 4-pane workbench, adjust `page_size`, `knownCap` ($0, 20, 100, 300$), and simulated network latency ($0\text{–}600\text{ ms}$), step through the five automated walkthrough scenarios, or run the in-browser property test.

### Verification commands

The repository includes a headless verification pipeline powered by TypeScript, `esbuild`, and Vite:

```bash
# 1. Typecheck all source, script, and config files (tsc --noEmit)
npm run typecheck

# 2. Run the 25 deterministic regression tests (compiler, normalization, staleness, parser, grid bounds)
npm run regressions

# 3. Run the 72-configuration randomized property test suite
#    (3 dataset sizes [4000, 60, 300] × 2 knownCap settings × 2 reconcile probabilities [1.0, 0.5] × 6 seeds)
npm run check

# 4. Build the production bundle
npm run build

```

To print a concise CLI trace of the five core scenarios (multi-group overlap trap, saturation collapse, $\gt 50\%$ polarity flip, full-coverage $\beta$ absorption, and `UNGROUPED` floating):

```bash
npx esbuild scripts/walkthrough.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/walkthrough.mjs && node node_modules/.cache/walkthrough.mjs

```

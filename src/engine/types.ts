export type GroupId = string;

/** Synthetic bucket for items with `groups.size() == 0`. Disjoint from every real group. */
export const UNGROUPED: GroupId = '__UNGROUPED__';
/** Synthetic bucket for the whole universe. */
export const ALL = 'ALL' as const;
export type BucketId = GroupId | typeof ALL;

export type Op = 'INCLUDE' | 'EXCLUDE';

export interface Rule {
  group: GroupId;
  op: Op;
}

/** An explicit item override. Only stored when `selected !== GroupEval(groups)`. */
export interface Override {
  id: string;
  groups: GroupId[]; // cached from the Resource when the item was observed
  selected: boolean;
}

/** The AIP resource returned by the List method. */
export interface ItemResource {
  id: string;
  name: string;
  groups: GroupId[];
}

export interface GroupInfo {
  id: GroupId;
  name: string;
  total: number;
  color: string;
}

export interface BucketStats {
  total: number;
  selected: number;
  /** false = count unknown until reconciled with the server (overlap knowledge gap). */
  fresh: boolean;
}

/** The pure, serialisable encoding of a selection. Everything else is derivable. */
export interface Encoding {
  base: boolean; // β: false = "just these", true = "all except these"
  precedence: Rule[]; // ℒ: ordered, ≤ 1 entry per group, tail = highest precedence
  exceptions: Map<string, Override>; // ℰ
}

export const effectiveGroups = (groups: GroupId[]): GroupId[] =>
  groups.length === 0 ? [UNGROUPED] : groups;

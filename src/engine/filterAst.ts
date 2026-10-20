import { UNGROUPED, type GroupId } from './types';

/**
 * Minimal AST for the subset of AIP-160 we emit.
 *  - ALL  : the universe (serialises as the empty filter "")
 *  - NONE : the empty set (nothing to send → serialises as null)
 */
export type FilterNode =
  | { type: 'all' }
  | { type: 'none' }
  | { type: 'group'; group: GroupId } // groups:"g"
  | { type: 'ungrouped' } // NOT groups:*
  | { type: 'id'; id: string } // id="x"
  | { type: 'not'; child: FilterNode }
  | { type: 'and'; children: FilterNode[] }
  | { type: 'or'; children: FilterNode[] };

export const ALL_NODE: FilterNode = { type: 'all' };
export const NONE_NODE: FilterNode = { type: 'none' };

export const groupNode = (g: GroupId): FilterNode =>
  g === UNGROUPED ? { type: 'ungrouped' } : { type: 'group', group: g };

export const idNode = (id: string): FilterNode => ({ type: 'id', id });

export function or(...nodes: FilterNode[]): FilterNode {
  const children: FilterNode[] = [];
  for (const n of nodes) {
    if (n.type === 'all') return ALL_NODE;
    if (n.type === 'none') continue;
    if (n.type === 'or') children.push(...n.children);
    else children.push(n);
  }
  if (children.length === 0) return NONE_NODE;
  if (children.length === 1) return children[0];
  return { type: 'or', children };
}

export function and(...nodes: FilterNode[]): FilterNode {
  const children: FilterNode[] = [];
  for (const n of nodes) {
    if (n.type === 'none') return NONE_NODE;
    if (n.type === 'all') continue;
    if (n.type === 'and') children.push(...n.children);
    else children.push(n);
  }
  if (children.length === 0) return ALL_NODE;
  if (children.length === 1) return children[0];
  return { type: 'and', children };
}

export function not(n: FilterNode): FilterNode {
  if (n.type === 'all') return NONE_NODE;
  if (n.type === 'none') return ALL_NODE;
  if (n.type === 'not') return n.child;
  return { type: 'not', child: n };
}

const quote = (s: string) => JSON.stringify(s);

/**
 * Serialises to AIP-160 text.
 * NOTE: AIP-160's grammar binds OR tighter than AND (expression = sequence {AND sequence};
 * factor = term {OR term}), which is the opposite of C-style precedence. We parenthesise
 * every OR that sits inside an AND, and every AND inside an OR, so the output parses
 * identically under either convention. Cost = a couple of bytes per clause boundary.
 */
export function printFilter(node: FilterNode): string {
  switch (node.type) {
    case 'all':
      return '';
    case 'none':
      throw new Error('an empty selection has no AIP-160 filter text');
    case 'group':
      return `groups:${quote(node.group)}`;
    case 'ungrouped':
      return 'NOT groups:*';
    case 'id':
      return `id=${quote(node.id)}`;
    case 'not': {
      const c = node.child;
      if (c.type === 'ungrouped') return 'groups:*'; // double negation elimination
      if (c.type === 'group' || c.type === 'id') return `NOT ${printFilter(c)}`;
      return `NOT (${printFilter(c)})`;
    }
    case 'or':
      return node.children
        .map((c) => (c.type === 'and' ? `(${printFilter(c)})` : printFilter(c)))
        .join(' OR ');
    case 'and':
      return node.children
        .map((c) => (c.type === 'or' || c.type === 'and' ? `(${printFilter(c)})` : printFilter(c)))
        .join(' AND ');
  }
}

/** Number of leaf literals (group literals + id literals). */
export function countTokens(node: FilterNode): { groups: number; ids: number } {
  const acc = { groups: 0, ids: 0 };
  const walk = (n: FilterNode) => {
    switch (n.type) {
      case 'group':
      case 'ungrouped':
        acc.groups++;
        break;
      case 'id':
        acc.ids++;
        break;
      case 'not':
        walk(n.child);
        break;
      case 'and':
      case 'or':
        n.children.forEach(walk);
        break;
    }
  };
  walk(node);
  return acc;
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

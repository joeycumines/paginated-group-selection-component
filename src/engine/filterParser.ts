import type { ItemResource } from './types';

/**
 * A small but faithful AIP-160 parser for the subset used here.
 *
 *   expression  = sequence { AND sequence }
 *   sequence    = factor { factor }            (adjacency = implicit AND)
 *   factor      = term { OR term }
 *   term        = [ NOT | "-" ] simple
 *   simple      = restriction | "(" expression ")"
 *   restriction = comparable [ comparator arg ]
 *   comparator  = ":" | "=" | "!=" | "<" | "<=" | ">" | ">="
 *
 * Note OR binds tighter than AND in AIP-160.
 */
export type ParsedNode =
  | { kind: 'and'; children: ParsedNode[] }
  | { kind: 'or'; children: ParsedNode[] }
  | { kind: 'not'; child: ParsedNode }
  | { kind: 'restriction'; field: string; comparator: string | null; arg: string | null; argQuoted?: boolean }
  | { kind: 'true' };

type Tok =
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'cmp'; v: string }
  | { t: 'minus' }
  | { t: 'string'; v: string }
  | { t: 'word'; v: string }
  | { t: 'eof' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      toks.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      toks.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (ch === ':' || ch === '=') {
      toks.push({ t: 'cmp', v: ch });
      i++;
      continue;
    }
    if (ch === '!' && src[i + 1] === '=') {
      toks.push({ t: 'cmp', v: '!=' });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'cmp', v: ch + '=' });
        i += 2;
      } else {
        toks.push({ t: 'cmp', v: ch });
        i++;
      }
      continue;
    }
    if (ch === '-') {
      toks.push({ t: 'minus' });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === undefined) throw new Error(`Unterminated string at ${i}`);
          switch (esc) {
            case '"':
            case "'":
            case '\\':
            case '/':
              out += esc;
              j += 2;
              break;
            case 'b':
              out += '\b';
              j += 2;
              break;
            case 'f':
              out += '\f';
              j += 2;
              break;
            case 'n':
              out += '\n';
              j += 2;
              break;
            case 'r':
              out += '\r';
              j += 2;
              break;
            case 't':
              out += '\t';
              j += 2;
              break;
            case 'u': {
              const hex = src.slice(j + 2, j + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`Invalid unicode escape at ${j}`);
              out += String.fromCharCode(parseInt(hex, 16));
              j += 6;
              break;
            }
            default:
              throw new Error(`Unknown escape \\${esc} at ${j}`);
          }
        } else {
          out += src[j];
          j++;
        }
      }
      if (src[j] !== q) throw new Error(`Unterminated string at ${i}`);
      toks.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    // word: identifiers, dotted members, numbers, '*'
    let j = i;
    while (j < src.length && !/[\s()=:<>!"']/.test(src[j])) j++;
    if (j === i) throw new Error(`Unexpected character '${ch}' at ${i}`);
    toks.push({ t: 'word', v: src.slice(i, j) });
    i = j;
  }
  toks.push({ t: 'eof' });
  return toks;
}

export function parseFilter(src: string): ParsedNode {
  if (src.trim() === '') return { kind: 'true' };
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isWord = (v: string) => peek().t === 'word' && (peek() as { v: string }).v === v;

  function expression(): ParsedNode {
    const children = [sequence()];
    while (isWord('AND')) {
      next();
      children.push(sequence());
    }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  }
  function sequence(): ParsedNode {
    const children = [factor()];
    while (peek().t !== 'eof' && peek().t !== 'rparen' && !isWord('AND')) {
      children.push(factor());
    }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  }
  function factor(): ParsedNode {
    const children = [term()];
    while (isWord('OR')) {
      next();
      children.push(term());
    }
    return children.length === 1 ? children[0] : { kind: 'or', children };
  }
  function term(): ParsedNode {
    if (isWord('NOT')) {
      next();
      return { kind: 'not', child: simple() };
    }
    if (peek().t === 'minus') {
      next();
      return { kind: 'not', child: simple() };
    }
    return simple();
  }
  function simple(): ParsedNode {
    if (peek().t === 'lparen') {
      next();
      const e = expression();
      if (next().t !== 'rparen') throw new Error('Expected )');
      return e;
    }
    const tk = next();
    if (tk.t !== 'word' && tk.t !== 'string') throw new Error(`Unexpected token ${JSON.stringify(tk)}`);
    const field = tk.v;
    if (peek().t === 'cmp') {
      const cmp = (next() as { v: string }).v;
      const a = next();
      if (a.t !== 'word' && a.t !== 'string') throw new Error('Expected argument');
      return { kind: 'restriction', field, comparator: cmp, arg: a.v, argQuoted: a.t === 'string' };
    }
    return { kind: 'restriction', field, comparator: null, arg: null };
  }

  const ast = expression();
  if (peek().t !== 'eof') throw new Error('Trailing tokens');
  return ast;
}

/** Evaluate a parsed filter against an item resource. */
export function evaluateFilter(node: ParsedNode, item: ItemResource): boolean {
  switch (node.kind) {
    case 'true':
      return true;
    case 'and':
      return node.children.every((c) => evaluateFilter(c, item));
    case 'or':
      return node.children.some((c) => evaluateFilter(c, item));
    case 'not':
      return !evaluateFilter(node.child, item);
    case 'restriction': {
      const { field, comparator, arg, argQuoted } = node;
      if (comparator === null) throw new Error(`Bare restriction '${field}' unsupported`);
      if (field === 'groups') {
        if (comparator === ':') return arg === '*' && !argQuoted ? item.groups.length > 0 : item.groups.includes(arg!);
        throw new Error(`Unsupported comparator ${comparator} for repeated field groups`);
      }
      if (field === 'id') {
        if (arg === '*' && !argQuoted) return true;
        if (comparator === '=' || comparator === ':') return item.id === arg;
        if (comparator === '!=') return item.id !== arg;
      }
      throw new Error(`Unknown field ${field}`);
    }
  }
}

export function compileFilterPredicate(src: string): (item: ItemResource) => boolean {
  const ast = parseFilter(src);
  return (item) => evaluateFilter(ast, item);
}

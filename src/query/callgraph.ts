import type { ClastDb } from '../db/index.js';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { isTestPath } from './format.js';
import type { Resolver } from './resolve.js';

export interface CallerEdge {
  /** Calling symbol, or null for a call at file level. */
  caller: SymbolRow | null;
  path: string;
  line: number;
  count: number;
  /** False when name-based resolution could not rule out another target. */
  certain: boolean;
}

export interface CalleeEdge {
  name: string;
  line: number;
  count: number;
  receiver: string | null;
  /** Resolved definition, or null for external / unknown callees. */
  target: SymbolRow | null;
  certain: boolean;
  /** Number of other plausible definitions. */
  alternatives: number;
}

interface CallRow {
  file_id: number;
  caller_id: number | null;
  line: number;
  receiver: string | null;
  rtype: string | null;
  count: number;
  path: string;
  lang: string;
}

const MAX_CALL_ROWS = 4000;

/** Ids of the symbol itself plus (for containers) its direct members. */
function bodyIds(db: ClastDb, sym: SymbolRow): number[] {
  if (CONTAINER_KINDS.has(sym.kind)) {
    const members = db.all<{ id: number }>(`SELECT id FROM symbols WHERE parent_id = ?`, sym.id);
    return [sym.id, ...members.map(m => m.id)];
  }
  // A function's body includes the closures and helpers nested inside it.
  const ids = [sym.id];
  let frontier = [sym.id];
  for (let depth = 0; depth < 4 && frontier.length && ids.length < 200; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const row of db.all<{ id: number }>(
        `SELECT id FROM symbols WHERE parent_id = ? AND kind IN ('function', 'method')`, id
      )) {
        ids.push(row.id);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return ids;
}

/**
 * Who calls `target`? Call sites are matched by name and then filtered by
 * resolving each site back to its most plausible definition.
 */
export function callersOf(db: ClastDb, resolver: Resolver, target: SymbolRow): CallerEdge[] {
  const nameId = db.nameId(target.name, false);
  if (nameId === undefined) return [];
  const rows = db.all<CallRow>(
    `SELECT c.file_id, c.caller_id, c.line, c.receiver, c.rtype, c.count, f.path, f.lang
     FROM calls c JOIN files f ON f.id = c.file_id
     WHERE c.name_id = ? LIMIT ${MAX_CALL_ROWS}`,
    nameId
  );

  const family = resolver.familyOf(target);
  const edges: CallerEdge[] = [];
  const callerCache = new Map<number, SymbolRow | undefined>();
  for (const row of rows) {
    let caller: SymbolRow | null = null;
    if (row.caller_id !== null) {
      if (!callerCache.has(row.caller_id)) callerCache.set(row.caller_id, db.symbolById(row.caller_id));
      caller = callerCache.get(row.caller_id) ?? null;
    }
    // A symbol "calling itself" by name from inside its own definition line is recursion: keep it.
    const res = resolver.resolve(target.name, {
      fileId: row.file_id, path: row.path, lang: row.lang, receiver: row.receiver, rtype: row.rtype, caller,
    });
    if (res.candidates.length === 0) continue;
    const top = res.candidates[0]!;
    let certain: boolean;
    if (family.has(top.sym.id)) {
      // Resolved to the target or to its interface/override/overload twin.
      certain = res.confident;
    } else {
      const mine = res.candidates.find(c => family.has(c.sym.id));
      // Keep near-ties as uncertain edges; drop sites that clearly mean another definition.
      if (!mine || top.score - mine.score > 10) continue;
      certain = false;
    }
    edges.push({ caller, path: row.path, line: row.line, count: row.count, certain });
  }

  // Production code first, then resolved before name-only, then by location.
  edges.sort(
    (a, b) =>
      Number(isTestPath(a.path)) - Number(isTestPath(b.path)) ||
      Number(b.certain) - Number(a.certain) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
  );
  return edges;
}

/** What does `sym` call? For containers, the calls of all direct members. */
export function calleesOf(db: ClastDb, resolver: Resolver, sym: SymbolRow): CalleeEdge[] {
  const ids = bodyIds(db, sym);
  const byName = new Map<string, CalleeEdge>();
  for (const id of ids) {
    const caller = id === sym.id ? sym : db.symbolById(id) ?? sym;
    const rows = db.all<{ name: string; line: number; receiver: string | null; rtype: string | null; count: number }>(
      `SELECT n.name, c.line, c.receiver, c.rtype, c.count
       FROM calls c JOIN names n ON n.id = c.name_id
       WHERE c.caller_id = ? ORDER BY c.line`,
      id
    );
    for (const row of rows) {
      const res = resolver.resolve(row.name, {
        fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: row.receiver, rtype: row.rtype, caller,
      });
      const top = res.candidates[0];
      const key = row.name + '\0' + (top ? top.sym.id : '');
      const existing = byName.get(key);
      if (existing) {
        existing.count += row.count;
        continue;
      }
      byName.set(key, {
        name: row.name,
        line: row.line,
        count: row.count,
        receiver: row.receiver,
        target: top ? top.sym : null,
        certain: res.confident,
        alternatives: Math.max(0, res.candidates.length - 1),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.line - b.line);
}

/** One entry per calling symbol (call sites inside the same caller are merged). */
export interface CallerGroup {
  caller: SymbolRow | null;
  path: string;
  /** First call line inside the caller. */
  line: number;
  /** Number of call sites in this caller. */
  sites: number;
  certain: boolean;
}

export function groupCallers(edges: CallerEdge[]): CallerGroup[] {
  const groups = new Map<string, CallerGroup>();
  for (const e of edges) {
    const key = e.caller ? 's' + e.caller.id : 'f' + e.path;
    const g = groups.get(key);
    if (g) {
      g.sites += e.count;
      if (e.certain) g.certain = true;
      if (e.line < g.line) g.line = e.line;
    } else {
      groups.set(key, { caller: e.caller, path: e.path, line: e.line, sites: e.count, certain: e.certain });
    }
  }
  return [...groups.values()];
}

/**
 * Call sites of a name that has no definition in the project (an external
 * library function, a dynamically defined method).
 */
export function externalCallSites(db: ClastDb, name: string, limit = 2000): CallerEdge[] {
  const nameId = db.nameId(name, false);
  if (nameId === undefined) return [];
  const rows = db.all<CallRow>(
    `SELECT c.file_id, c.caller_id, c.line, c.receiver, c.rtype, c.count, f.path, f.lang
     FROM calls c JOIN files f ON f.id = c.file_id WHERE c.name_id = ? LIMIT ?`,
    nameId, limit
  );
  const edges: CallerEdge[] = rows.map(row => ({
    caller: row.caller_id !== null ? db.symbolById(row.caller_id) ?? null : null,
    path: row.path, line: row.line, count: row.count, certain: false,
  }));
  edges.sort(
    (a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path) || a.line - b.line
  );
  return edges;
}

export interface GraphNode {
  sym: SymbolRow | null;
  /** For callers: where the call happens. For callees: call line in the parent. */
  path: string;
  line: number;
  certain: boolean;
  /** Call sites merged into this node. */
  sites: number;
  label?: string;
  children: GraphNode[];
  /** Set when this symbol was already expanded elsewhere in the tree. */
  repeated?: boolean;
  /** Children omitted because of the node budget. */
  omitted?: number;
  /** Set when the node has too many edges to expand at this depth. */
  hub?: number;
}

export interface GraphOptions {
  depth: number;
  /** Total node budget. */
  budget: number;
  includeTests: boolean;
  /** Only edges whose file matches this path filter. */
  path?: (path: string) => boolean;
}

/** Symbols with more direct edges than this are not expanded below the first level. */
const HUB_LIMIT = 30;

/**
 * Breadth-first expansion of callers or callees, bounded by a total node
 * budget so the output stays small. Hubs (symbols with dozens of callers)
 * are reported but not expanded beyond the first level: their fan-out would
 * drown the rest of the tree.
 */
export function buildGraph(
  db: ClastDb,
  resolver: Resolver,
  root: SymbolRow,
  direction: 'callers' | 'callees',
  opts: GraphOptions
): GraphNode {
  const rootNode: GraphNode = { sym: root, path: root.path, line: root.start_line, certain: true, sites: 1, children: [] };
  const expanded = new Set<number>([root.id]);
  let frontier: GraphNode[] = [rootNode];
  let remaining = opts.budget;

  for (let level = 0; level < opts.depth && frontier.length && remaining > 0; level++) {
    const next: GraphNode[] = [];
    // Split the remaining budget fairly across this level's nodes.
    const perNode = level === 0 ? remaining : Math.max(3, Math.ceil(remaining / frontier.length));
    for (const node of frontier) {
      if (!node.sym || remaining <= 0) continue;
      let children: GraphNode[];
      if (direction === 'callers') {
        children = groupCallers(callersOf(db, resolver, node.sym))
          .filter(g => (opts.includeTests || !isTestPath(g.path)) && (!opts.path || opts.path(g.path)))
          .map(g => ({
            sym: g.caller, path: g.path, line: g.line, certain: g.certain, sites: g.sites,
            label: g.caller ? undefined : '<file level>', children: [],
          }));
      } else {
        children = calleesOf(db, resolver, node.sym)
          .filter(e => e.target !== null && (opts.includeTests || !isTestPath(e.target.path)))
          .map(e => ({ sym: e.target, path: e.target!.path, line: e.line, certain: e.certain, sites: e.count, children: [] }));
      }
      if (level > 0 && children.length > HUB_LIMIT) {
        node.hub = children.length;
        continue;
      }
      const take = Math.min(children.length, perNode, remaining);
      node.omitted = children.length - take;
      node.children = children.slice(0, take);
      remaining -= take;
      for (const child of node.children) {
        if (!child.sym) continue;
        if (expanded.has(child.sym.id)) {
          child.repeated = true;
          continue;
        }
        expanded.add(child.sym.id);
        next.push(child);
      }
    }
    frontier = next;
  }
  return rootNode;
}
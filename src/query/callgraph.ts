import type { ClastDb } from '../db/index.js';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { isTestPath } from './format.js';
import { goInterfaceMethods } from './hierarchy.js';
import { langFamily, type Resolver } from './resolve.js';

export interface CallerEdge {
  /** Calling symbol, or null for a call at file level. */
  caller: SymbolRow | null;
  path: string;
  line: number;
  count: number;
  /** False when name-based resolution could not rule out another target. */
  certain: boolean;
  /**
   * True for call sites whose receiver type is unknown and that could not be
   * attributed to any definition: they MAY call the target (same method
   * name), but there is no evidence either way.
   */
  weak?: boolean;
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
  via: number | null;
  /** Arguments at the call site; -1 or absent when unknown. */
  argc?: number;
  count: number;
  path: string;
  lang: string;
}

const MAX_CALL_ROWS = 4000;
const MAX_NEAR_ROWS = 20000;
const QUICK_NEAR_ROWS = 5000;
const QUICK_FAR_ROWS = 1500;
const MAX_WEAK = 1500;

/**
 * The definition that best stands for a symbol's family member with the same
 * qualified name: the function body rather than its prototype, the
 * out-of-line C++ method rather than the in-class declaration.
 */
export function representative(db: ClastDb, resolver: Resolver, sym: SymbolRow): SymbolRow {
  // Only C-family code separates declarations from definitions across files.
  if (langFamily(sym.lang) !== 'c' && sym.kind !== 'declaration') return sym;
  let best = sym;
  let bestScore = (sym.kind === 'declaration' ? 0 : 1000) + (sym.end_line - sym.start_line);
  for (const id of resolver.familyOf(sym)) {
    if (id === sym.id) continue;
    const other = db.symbolById(id);
    // The same member in another file (header vs source); overloads in the same file are different functions.
    if (!other || other.qname !== sym.qname || (other.file_id === sym.file_id && sym.kind !== 'declaration')) continue;
    const score = (other.kind === 'declaration' ? 0 : 1000) + (other.end_line - other.start_line);
    if (score > bestScore) {
      best = other;
      bestScore = score;
    }
  }
  return best;
}

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
export interface CallerQuery {
  /** Only call sites in files whose path contains this text (pushed down to SQL). */
  pathContains?: string;
  /** Examine fewer call sites (summaries that only show the first few callers). */
  quick?: boolean;
  /** Other overloads of the target whose call sites count too (a bare name means "any overload"). */
  overloads?: SymbolRow[];
}

/** Set by callersOf when a name has more call sites than were examined. */
export interface CallerStats {
  examined: number;
  total: number;
}

export function callersOf(
  db: ClastDb,
  resolver: Resolver,
  target: SymbolRow,
  query: CallerQuery = {},
  stats?: CallerStats
): CallerEdge[] {
  const nameId = db.nameId(target.name, false);
  if (nameId === undefined) return [];
  const cols = `c.rowid AS id, c.file_id, c.caller_id, c.line, c.receiver, c.rtype, c.via, c.argc, c.count, f.path, f.lang`;
  const pathClause = query.pathContains ? ` AND f.path LIKE ? ESCAPE '\\'` : '';
  const pathArg = query.pathContains ? ['%' + query.pathContains.replace(/[\\%_]/g, c => '\\' + c) + '%'] : [];

  // Very common names (`dispose`, `push`, `get`) have more call sites than can be examined.
  // Sites that can see the target - its own file and the files that import it - always go first.
  const near = db.all<CallRow & { id: number }>(
    `SELECT ${cols} FROM calls c JOIN files f ON f.id = c.file_id
     WHERE c.name_id = ? AND (c.file_id = ? OR c.file_id IN (SELECT file_id FROM imports WHERE resolved_id = ?))${pathClause}
     LIMIT ${query.quick ? QUICK_NEAR_ROWS : MAX_NEAR_ROWS}`,
    nameId, target.file_id, target.file_id, ...pathArg
  );
  const seenRows = new Set(near.map(r => r.id));
  const far = db
    .all<CallRow & { id: number }>(
      `SELECT ${cols} FROM calls c JOIN files f ON f.id = c.file_id
       WHERE c.name_id = ?${pathClause} LIMIT ${MAX_CALL_ROWS + MAX_NEAR_ROWS}`,
      nameId, ...pathArg
    )
    .filter(r => !seenRows.has(r.id))
    .slice(0, query.quick ? QUICK_FAR_ROWS : MAX_CALL_ROWS);
  const rows: CallRow[] = [...near, ...far];
  if (stats) {
    stats.examined = rows.length;
    stats.total = rows.length < (query.quick ? QUICK_FAR_ROWS : MAX_CALL_ROWS)
      ? rows.length
      : db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM calls WHERE name_id = ?`, nameId)?.n ?? rows.length;
  }

  let family = resolver.familyOf(target);
  // A constructor is called by naming its class: `new Foo(...)` resolves to the class.
  if (target.parent_id !== null && target.kind === 'method') {
    const parent = db.symbolById(target.parent_id);
    if (parent && parent.name === target.name && CONTAINER_KINDS.has(parent.kind)) family = new Set([...family, parent.id]);
  }
  const arityTargets = query.overloads?.length ? [target, ...query.overloads] : [target];
  /** Go interface methods the target satisfies structurally: calls through them are possible, not certain. */
  let structural: Set<number> | null = null;
  if (target.lang === 'go' && target.kind === 'method') {
    // Go interfaces are satisfied structurally: a call through an interface this method's
    // type implements may reach it.
    const viaInterface = goInterfaceMethods(db, target);
    if (viaInterface.length) {
      family = new Set([...family, ...viaInterface]);
      structural = new Set(viaInterface);
    }
  }
  const edges: CallerEdge[] = [];
  const weak: CallerEdge[] = [];
  const targetIsMember = target.kind === 'method' || target.qname.includes('.');
  // `@property def count` / `get count()`: read as an attribute, so `.count(...)` calls elsewhere are something else.
  const propertyLike = /^@(cached_)?property\b|^(public |private |protected |static |override )*get \w/.test(target.signature);
  const callerCache = new Map<number, SymbolRow | undefined>();
  for (const row of rows) {
    let caller: SymbolRow | null = null;
    if (row.caller_id !== null) {
      if (!callerCache.has(row.caller_id)) callerCache.set(row.caller_id, db.symbolById(row.caller_id));
      caller = callerCache.get(row.caller_id) ?? null;
    }
    const site = {
      fileId: row.file_id, path: row.path, lang: row.lang, receiver: row.receiver, rtype: row.rtype, via: row.via,
      argc: row.argc, caller,
    };
    // A call with another number of arguments is a call of another overload (or of something else).
    if (!arityTargets.some(t => resolver.arityFits(t, site))) continue;
    // A symbol "calling itself" by name from inside its own definition line is recursion: keep it.
    const res = resolver.resolve(target.name, site);
    if (res.candidates.length === 0) {
      // Nothing could be attributed. If the receiver's type is simply unknown,
      // keep the site as a possible caller instead of silently dropping it.
      if (targetIsMember && !propertyLike && weak.length < MAX_WEAK && resolver.canSee(row.file_id, target) && resolver.isOpaqueReceiver(site) && langFamily(row.lang) === langFamily(target.lang) && !(isTestPath(target.path) && !isTestPath(row.path))) {
        weak.push({ caller, path: row.path, line: row.line, count: row.count, certain: false, weak: true });
      }
      continue;
    }
    const top = res.candidates[0]!;
    let certain: boolean;
    if (family.has(top.sym.id)) {
      // Resolved to the target or to its interface/override/overload twin.
      certain = res.confident;
      // Any type with these methods satisfies a Go interface: a call through it may reach the
      // target, but equally one of the other implementers.
      if (structural && structural.has(top.sym.id)) certain = false;
      // Bound to an override in a subclass: that call does not run the target.
      if (top.sym.id !== target.id && resolver.overriddenBelow(target, top.sym)) {
        if (certain) continue;
      }
      // Bound to a supertype's declaration, but on a receiver that cannot be the target's class
      // (a sibling subclass, or an explicit super call).
      if (certain && top.sym.id !== target.id && !resolver.reaches(target, top.sym, site)) continue;
    } else {
      const mine = res.candidates.find(c => family.has(c.sym.id));
      // Keep near-ties as uncertain edges; drop sites that clearly mean another definition.
      if (!mine || top.score - mine.score > 10) continue;
      certain = false;
    }
    edges.push({ caller, path: row.path, line: row.line, count: row.count, certain });
  }

  // Call sites that use a local alias of the target: `import { X as Y }`, default imports, require bindings.
  for (const use of resolver.aliasesOf(target)) {
    const aliasId = db.nameId(use.alias, false);
    if (aliasId === undefined) continue;
    const aliasRows = db.all<CallRow>(
      `SELECT c.file_id, c.caller_id, c.line, c.receiver, c.rtype, c.via, c.count, f.path, f.lang
       FROM calls c JOIN files f ON f.id = c.file_id
       WHERE c.name_id = ? AND c.file_id = ? AND c.receiver IS NULL`,
      aliasId, use.fileId
    );
    for (const row of aliasRows) {
      const caller = row.caller_id !== null ? db.symbolById(row.caller_id) ?? null : null;
      edges.push({ caller, path: row.path, line: row.line, count: row.count, certain: true });
    }
  }
  // Unattributed sites only matter when they are not already explained.
  const known = new Set(edges.map(e => e.path + ':' + e.line));
  for (const w of weak) if (!known.has(w.path + ':' + w.line)) edges.push(w);

  // Production code first, then resolved before name-only, then by location.
  edges.sort(
    (a, b) =>
      Number(isTestPath(a.path)) - Number(isTestPath(b.path)) ||
      Number(b.certain) - Number(a.certain) ||
      Number(a.weak ?? false) - Number(b.weak ?? false) ||
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
    const rows = db.all<{ name: string; line: number; receiver: string | null; rtype: string | null; via: number | null; argc: number; count: number }>(
      `SELECT n.name, c.line, c.receiver, c.rtype, c.via, c.argc, c.count
       FROM calls c JOIN names n ON n.id = c.name_id
       WHERE c.caller_id = ? ORDER BY c.line`,
      id
    );
    for (const row of rows) {
      const res = resolver.resolve(row.name, {
        fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: row.receiver, rtype: row.rtype, via: row.via,
        argc: row.argc, caller,
      });
      const first = res.candidates[0];
      // Follow the call to the implementation, not to a prototype / in-class declaration.
      const top = first ? { ...first, sym: representative(db, resolver, first.sym) } : undefined;
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
        alternatives: top
          ? Math.max(0, res.candidates.length - 1)
          // Unresolved, but the project does define methods with this name: not "external".
          : resolver.isOpaqueReceiver({
              fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: row.receiver, rtype: row.rtype, via: row.via, caller,
            })
            ? resolver.candidates(row.name).filter(c => langFamily(c.lang) === langFamily(sym.lang)).length
            : 0,
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
  /** All call sites in this caller are unattributed (receiver type unknown). */
  weak: boolean;
}

export function groupCallers(edges: CallerEdge[]): CallerGroup[] {
  const groups = new Map<string, CallerGroup>();
  for (const e of edges) {
    const key = e.caller ? 's' + e.caller.id : 'f' + e.path;
    const g = groups.get(key);
    if (g) {
      g.sites += e.count;
      if (e.certain) g.certain = true;
      if (!e.weak) g.weak = false;
      if (e.line < g.line) g.line = e.line;
    } else {
      groups.set(key, {
        caller: e.caller, path: e.path, line: e.line, sites: e.count, certain: e.certain, weak: e.weak ?? false,
      });
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
    `SELECT c.file_id, c.caller_id, c.line, c.receiver, c.rtype, c.via, c.count, f.path, f.lang
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
  /** Unattributed call site (receiver type unknown). */
  weak?: boolean;
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
  /** Text every call-site path must contain (lets the database do the first cut for `within`). */
  pathContains?: string;
  /** Filled in for the root symbol: how many call sites of the name exist vs were examined. */
  stats?: CallerStats;
  /** Other overloads of the root whose callers are included. */
  overloads?: SymbolRow[];
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
        children = groupCallers(
          callersOf(
            db, resolver, node.sym,
            { pathContains: opts.pathContains, overloads: level === 0 ? opts.overloads : undefined },
            level === 0 ? opts.stats : undefined
          )
        )
          .filter(g => (opts.includeTests || !isTestPath(g.path)) && (!opts.path || opts.path(g.path)))
          .map(g => ({
            sym: g.caller, path: g.path, line: g.line, certain: g.certain, sites: g.sites, weak: g.weak,
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
        // Only confirmed edges are worth following further.
        if (!child.sym || child.weak || (direction === 'callers' && !child.certain)) continue;
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
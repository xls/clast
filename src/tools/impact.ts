import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import { callersOf, groupCallers, type CallerGroup } from '../query/callgraph.js';
import { firstLine, isTestPath, isTestSite, isVendoredPath, loc, plural, symLine } from '../query/format.js';
import { directSubtypes, directSupertypes } from '../query/hierarchy.js';
import { findSymbols, langFamily, parseSymbolRef, pathMatches } from '../query/resolve.js';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { ToolContext } from './context.js';
import { otherTextFiles } from './explore.js';
import { containerNote, disambiguate, notFound } from './search.js';

// ---------------------------------------------------------------------------
// clast_impact: what has to change with a symbol, who reaches it, which tests to run
// ---------------------------------------------------------------------------

export interface ImpactArgs {
  name: string;
  path?: string;
  /** How many caller levels to follow. Default 3. */
  depth?: number;
  /** Max lines per section. Default 30. */
  limit?: number;
}

const IMPACT_BUDGET_MS = 8000;
const IMPACT_MAX_EXPANSIONS = 400;

function dirOf(path: string, depth = 3): string {
  const parts = path.split('/');
  parts.pop();
  return parts.slice(0, depth).join('/') || '.';
}

/** `a.ts: f :12, g :40 (x2)` lines, one per file, in the order of the groups. */
function byFile(groups: CallerGroup[], limit: number, out: string[]): void {
  const files = new Map<string, string[]>();
  for (const g of groups) {
    const list = files.get(g.path) ?? [];
    list.push(`${g.caller ? g.caller.qname : '<file level>'} :${g.line}${g.sites > 1 ? ` (x${g.sites})` : ''}${g.certain ? '' : ' ?'}`);
    files.set(g.path, list);
  }
  let n = 0;
  for (const [path, list] of files) {
    if (n++ >= limit) {
      out.push(`  ... ${files.size - limit} more files`);
      break;
    }
    out.push(`  ${path}: ${list.slice(0, 8).join(', ')}${list.length > 8 ? `, +${list.length - 8} more` : ''}`);
  }
}

export async function impact(ctx: ToolContext, args: ImpactArgs): Promise<string> {
  const note = await ctx.ready();
  if (!args.name || !args.name.trim()) return 'error: name is required';
  const matches = findSymbols(ctx.db, args.name, { path: args.path });
  if (matches.length === 0) return note + notFound(ctx, args.name, args.path).join('\n');
  const amb = disambiguate(ctx, args.name, args.path, matches);
  if (amb.stop) return note + amb.lines.join('\n');
  const sym = matches[0]!;
  const depth = Math.max(1, Math.min(args.depth ?? 3, 6));
  const limit = Math.max(1, Math.min(args.limit ?? 30, 500));
  const started = performance.now();
  const out: string[] = [symLine(sym)];
  if (sym.signature) out.push(`  ${firstLine(sym.signature, 160)}`);
  out.push(...amb.lines);
  out.push(...containerNote(args.name, sym));

  const isType = CONTAINER_KINDS.has(sym.kind) || sym.kind === 'type';
  const overloads = matches.filter(
    m => m.id !== sym.id && m.file_id === sym.file_id && m.qname === sym.qname && m.kind === sym.kind
  );
  const oneOverload = parseSymbolRef(args.name).line !== undefined;

  // 1. What shares the contract: the same member on related types, or the subtypes of a type.
  if (isType) {
    const seen = new Set<number>([sym.id]);
    const subs: SymbolRow[] = [];
    let frontier = [sym];
    while (frontier.length && subs.length < 5000) {
      const next: SymbolRow[] = [];
      for (const s of frontier) {
        for (const sub of directSubtypes(ctx.db, ctx.resolver, s)) {
          if (seen.has(sub.sym.id)) continue;
          seen.add(sub.sym.id);
          subs.push(sub.sym);
          next.push(sub.sym);
        }
      }
      frontier = next;
    }
    if (subs.length) {
      out.push(`subtypes that inherit a change to it (${subs.length}):`);
      for (const s of subs.slice(0, Math.min(limit, 12))) out.push(`  ${s.kind} ${s.qname}  ${s.path}:${s.start_line}`);
      if (subs.length > 12) out.push(`  ... ${subs.length - Math.min(limit, 12)} more (clast_hierarchy lists them)`);
    }
  } else {
    const family = [...ctx.resolver.familyOf(sym)]
      .filter(id => id !== sym.id)
      .map(id => ctx.db.symbolById(id))
      .filter((s): s is SymbolRow => !!s);
    if (family.length) {
      family.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
      out.push(`change together - declarations, overrides, implementations and overloads of the same member (${family.length}):`);
      for (const f of family.slice(0, limit)) out.push(`  ${f.kind} ${f.qname}  ${loc(f)}`);
      if (family.length > limit) out.push(`  ... ${family.length - limit} more (clast_hierarchy lists them)`);
    }
  }

  // 2. Direct callers (for a type: the places that construct it).
  const stats = { examined: 0, total: 0 };
  const direct = groupCallers(callersOf(ctx.db, ctx.resolver, sym, { overloads: oneOverload ? undefined : overloads }, stats));
  const isTest = (g: CallerGroup): boolean => isTestSite(g.path, g.caller?.qname);
  const prod = direct.filter(g => !isTest(g));
  const certain = prod.filter(g => g.certain);
  const unsure = prod.filter(g => !g.certain);
  const what = isType ? 'direct uses as a call (construction)' : 'direct callers';
  const files = new Set(certain.map(g => g.path));
  out.push(
    `${what}: ${certain.length} resolved in ${plural(files.size, 'file')}` +
      (unsure.length ? `, ${unsure.length} unconfirmed "?"` : '') + ' (each must be checked when the signature changes):'
  );
  if (prod.length === 0) out.push('  none in production code');
  byFile(certain, limit, out);
  if (unsure.length) byFile(unsure, Math.min(limit, certain.length ? 6 : limit), out);
  if (stats.total > stats.examined) {
    out.push(`  note: "${sym.name}" is called in ${stats.total} places; ${stats.examined} were examined.`);
  }

  // 3. Everything that reaches it through those callers, and the tests among them.
  interface TestHit { path: string; via: string | null; level: number; tests: Set<string> }
  const tests = new Map<string, TestHit>();
  const addTest = (g: CallerGroup, level: number, via: string | null): void => {
    let hit = tests.get(g.path);
    if (!hit) tests.set(g.path, (hit = { path: g.path, via, level, tests: new Set() }));
    if (g.caller) hit.tests.add(g.caller.name);
  };
  for (const g of direct) if (isTest(g)) addTest(g, 1, null);

  const reached = new Map<number, SymbolRow>();
  for (const g of certain) if (g.caller) reached.set(g.caller.id, g.caller);
  const perLevel: number[] = [];
  let frontier = [...reached.values()];
  let expansions = 0;
  let cut = false;
  for (let level = 2; level <= depth && frontier.length; level++) {
    const next: SymbolRow[] = [];
    for (const s of frontier) {
      if (expansions >= IMPACT_MAX_EXPANSIONS || performance.now() - started > IMPACT_BUDGET_MS) {
        cut = true;
        break;
      }
      expansions++;
      for (const g of groupCallers(callersOf(ctx.db, ctx.resolver, s, { quick: true }))) {
        if (!g.certain) continue;
        if (isTest(g)) {
          addTest(g, level, s.qname);
          continue;
        }
        if (!g.caller || g.caller.id === sym.id || reached.has(g.caller.id)) continue;
        reached.set(g.caller.id, g.caller);
        next.push(g.caller);
      }
    }
    perLevel.push(next.length);
    if (cut) break;
    frontier = next;
  }
  const indirect = [...reached.values()].filter(s => !certain.some(g => g.caller?.id === s.id));
  if (indirect.length) {
    const dirs = new Map<string, number>();
    for (const s of indirect) dirs.set(dirOf(s.path), (dirs.get(dirOf(s.path)) ?? 0) + 1);
    const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]);
    out.push(
      `indirect callers (through the direct ones, up to depth ${depth}): ${plural(indirect.length, 'function')} in ` +
        `${plural(new Set(indirect.map(s => s.path)).size, 'file')}${cut ? ' (search cut short; the real number is higher)' : ''}`
    );
    out.push(`  by area: ${top.slice(0, 8).map(([d, n]) => `${d} ${n}`).join(', ')}${top.length > 8 ? ', ...' : ''}`);
  }

  // 4. Tests to run.
  const hits = [...tests.values()].sort((a, b) => a.level - b.level || a.path.localeCompare(b.path));
  if (hits.length) {
    const directN = hits.filter(h => h.level === 1).length;
    out.push(`tests to run (${plural(hits.length, 'file')}: ${directN} call it directly, ${hits.length - directN} reach it through callers):`);
    for (const h of hits.slice(0, limit)) {
      const names = [...h.tests];
      out.push(
        `  ${h.path}  ${h.level === 1 ? 'direct' : `via ${h.via}`}` +
          (names.length ? `  (${names.slice(0, 3).join(', ')}${names.length > 3 ? `, +${names.length - 3}` : ''})` : '')
      );
    }
    if (hits.length > limit) out.push(`  ... ${hits.length - limit} more`);
  } else {
    // No test calls it: fall back to test files that mention the name at all.
    const nameId = ctx.db.nameId(sym.name, false);
    const mention = nameId === undefined ? [] : ctx.db
      .all<{ path: string }>(`SELECT f.path FROM occ o JOIN files f ON f.id = o.file_id WHERE o.name_id = ?`, nameId)
      .map(r => r.path)
      .filter(p => isTestPath(p));
    out.push(
      mention.length
        ? `tests: none call it (directly or through its callers); ${plural(mention.length, 'test file')} mention the name: ` +
            `${mention.slice(0, 6).join(', ')}${mention.length > 6 ? ', ...' : ''}`
        : `tests: none found that call it or mention its name (depth ${depth}).`
    );
  }
  if (out.some(l => / \?(,|$)/.test(l))) {
    out.push('("?" = matched by name only; the receiver type is unknown and another definition could be the real target)');
  }
  return note + out.join('\n');
}

// ---------------------------------------------------------------------------
// clast_unused: dead code
// ---------------------------------------------------------------------------

export interface UnusedArgs {
  path?: string;
  lang?: string;
  /** Kinds to judge, comma separated. Default: function, method, class, struct, interface, trait, enum, type. */
  kind?: string;
  /** Include exported / public symbols (dead only if nothing outside the project uses them). Default true. */
  exported?: boolean;
  /** Max symbols listed. Default 60. */
  limit?: number;
}

const DEFAULT_UNUSED_KINDS = ['function', 'method', 'class', 'struct', 'interface', 'trait', 'enum', 'type'];
const MAX_REFS = 12;
/** `getattr(x, "as_" + vendor)`, `send("on_#{e}")`, `obj["handle" + kind]`, obj[`on${Name}`]: the literal prefix of a computed member name. */
const DYNAMIC =
  /(?:getattr|hasattr|send|public_send|method)\(\s*[^,()\n]{0,60},?\s*f?["'](\w{2,})(?:["']\s*[+%]|[{#])|\[\s*["'`](\w{2,})(?:["']\s*\+|\$\{)/g;
const EXTENSION_LANGS = new Set(['csharp', 'kotlin', 'swift', 'dart']);
const HASH_COMMENT = new Set(['python', 'ruby', 'bash', 'shell', 'perl', 'r']);
const NOMINAL = new Set(['java', 'csharp', 'cpp', 'c', 'rust', 'kotlin']);
const UNUSED_BUDGET_MS = 30_000;

/** Names the runtime, the language or a common framework calls without the project naming them. */
const IMPLICIT = new Set([
  'main', 'Main', 'wmain', 'WinMain', 'wWinMain', 'DllMain', '_start', 'app_main', 'setup', 'loop', 'init', 'constructor',
  'toString', 'ToString', 'equals', 'Equals', 'hashCode', 'GetHashCode', 'compareTo', 'CompareTo', 'Dispose', 'finalize',
  'clone', 'valueOf', 'toJSON', 'setUp', 'tearDown', 'SetUp', 'TearDown', 'setUpClass', 'tearDownClass',
  'String', 'Error', 'ServeHTTP', 'MarshalJSON', 'UnmarshalJSON', 'MarshalText', 'UnmarshalText', 'Len', 'Less', 'Swap',
  'fmt', 'drop', 'default', 'from', 'into', 'try_from', 'deref', 'deref_mut', 'next', 'eq', 'ne', 'hash', 'cmp',
  'partial_cmp', 'poll', 'as_ref', 'as_mut', 'from_str', 'index', 'call',
]);
const EXPORT_MARKER =
  /dllexport|JNIEXPORT|JNICALL|__attribute__|EMSCRIPTEN_KEEPALIVE|extern\s+"C"|\b(WINAPI|CALLBACK|APIENTRY|STDMETHODCALLTYPE|IRAM_ATTR|ISR|Q_INVOKABLE|UFUNCTION)\b/;
/** Decorators / attributes that do not make something reachable. */
const HARMLESS_MARK =
  /^(@(staticmethod|classmethod|property|abstractmethod|override|Override|Deprecated|deprecated|SuppressWarnings|final|Nullable|NonNull|NotNull|VisibleForTesting|dataclass|overload|cached_property|functools\.\w+|lru_cache|contextmanager|inline|internal|private|protected|public|param|returns?|see|throws|type|template)\b|\[(Obsolete|Serializable|DebuggerDisplay|MethodImpl|Pure|NotNull|CanBeNull|EditorBrowsable|SuppressMessage)\b|#!?\[(derive|inline|allow|warn|deny|cfg|cfg_attr|must_use|doc|repr|non_exhaustive|deprecated|track_caller|cold|automatically_derived|rustfmt|clippy)\b)/;

interface Cand extends SymbolRow {
  exported: number;
}

interface Ref {
  fileId: number;
  path: string;
  line: number;
}

export async function unused(ctx: ToolContext, args: UnusedArgs = {}): Promise<string> {
  const gate = await ctx.gate();
  if (gate) return gate;
  const db = ctx.db;
  const started = performance.now();
  const limit = Math.max(1, Math.min(args.limit ?? 60, 1000));
  const kinds = (args.kind ? args.kind.split(',').map(k => k.trim()).filter(Boolean) : DEFAULT_UNUSED_KINDS);
  const showExported = args.exported !== false;

  const all = db.all<Cand>(
    `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.kind IN (${kinds.map(() => '?').join(',')})`, ...kinds
  );
  const cands = all.filter(
    s =>
      !isTestSite(s.path, s.qname) && !isVendoredPath(s.path) && (!args.path || pathMatches(s.path, args.path)) &&
      (!args.lang || s.lang === args.lang) && (showExported || !s.exported)
  );
  if (cands.length === 0) return 'no symbols of these kinds in production code match the filters.';

  // --- 1. Names: where is each one referenced outside its own definitions? ---
  const pathOf = new Map<number, string>();
  for (const f of db.all<{ id: number; path: string }>(`SELECT id, path FROM files`)) pathOf.set(f.id, f.path);
  const names = new Set(cands.map(c => c.name));
  /** null = referenced too widely to look at (alive); else the references outside the definitions. */
  const refs = new Map<string, Ref[] | null>();
  const headLine = new Map<number, number>();
  const srcCache = new Map<string, string[] | null>();
  const srcOf = (path: string): string[] | null => {
    let src = srcCache.get(path);
    if (src === undefined) {
      if (srcCache.size > 4000) srcCache.clear();
      try {
        src = readFileSync(join(ctx.clast.root, path), 'utf-8').split(/\r?\n/);
      } catch {
        src = null;
      }
      srcCache.set(path, src);
    }
    return src;
  };
  /**
   * Is an occurrence inside a definition's range part of that definition? For a type: always
   * (constructors and self references do not make it used). For a callable: the line that declares
   * it, and calls of the same name on itself (recursion, one overload delegating to another). A call
   * on another object (`return inner.name()`) or a plain mention further down is a real use - the
   * range may also be stretched over an #if / #else pair of definitions.
   */
  const isOwn = (d: SymbolRow, nameId: number, line: number): boolean => {
    if (CONTAINER_KINDS.has(d.kind)) return true;
    let head = headLine.get(d.id);
    if (head === undefined) {
      head = d.start_line;
      const src = line === d.start_line ? null : srcOf(d.path);
      const word = new RegExp(`(^|[^\\w$])${d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\  const refs = new Map<string, Ref[] | null>();')}($|[^\\w$])`);
      for (let n = d.start_line; src && n <= Math.min(d.end_line, d.start_line + 8); n++) {
        if (word.test(src[n - 1] ?? '')) {
          head = n;
          break;
        }
      }
      if (src) headLine.set(d.id, head);
    }
    if (line < head) return true;
    const calls = db.all<{ receiver: string | null }>(
      `SELECT receiver FROM calls WHERE name_id = ? AND file_id = ? AND line = ?`, nameId, d.file_id, line
    );
    const onSelf = calls.every(c => c.receiver === null || /^(this|self|Self|cls|super|base)$/.test(c.receiver));
    // The declaring line: its own unless it also forwards to another object (`int n() { return inner.n(); }`).
    return line === head ? onSelf : calls.length > 0 && onSelf;
  };
  const defsOf = new Map<string, SymbolRow[]>();
  for (const name of names) {
    const nameId = db.nameId(name, false);
    const defs = db.symbolsByName(name);
    defsOf.set(name, defs);
    if (nameId === undefined) {
      refs.set(name, []);
      continue;
    }
    const rows = db.all<{ file_id: number; lines: string }>(`SELECT file_id, lines FROM occ WHERE name_id = ?`, nameId);
    const list: Ref[] = [];
    let alive = false;
    outer: for (const r of rows) {
      const inFile = defs.filter(d => d.file_id === r.file_id);
      for (const part of r.lines.split(',')) {
        const line = Number(part);
        if (inFile.some(d => line >= d.start_line && line <= d.end_line && isOwn(d, nameId, line))) continue;
        list.push({ fileId: r.file_id, path: pathOf.get(r.file_id) ?? '', line });
        if (list.length > MAX_REFS) {
          alive = true;
          break outer;
        }
      }
    }
    refs.set(name, alive ? null : list);
  }

  // --- 2. What something outside the code can reach: never unused, and what it uses is used. ---
  const skipped = { implicit: 0, marked: 0, library: 0, shared: 0, members: 0, structural: 0 };
  const externalAncestor = new Map<number, boolean>();
  /** True when the type extends or implements something that is not defined in this project. */
  const hasExternalAncestor = (type: SymbolRow, depthLeft = 4): boolean => {
    const cached = externalAncestor.get(type.id);
    if (cached !== undefined) return cached;
    externalAncestor.set(type.id, false);
    let ext = false;
    for (const sup of directSupertypes(db, ctx.resolver, type)) {
      if (!sup.sym || (depthLeft > 0 && hasExternalAncestor(sup.sym, depthLeft - 1))) {
        ext = true;
        break;
      }
    }
    externalAncestor.set(type.id, ext);
    return ext;
  };
  const containersOf = (s: SymbolRow, container: string): SymbolRow[] => {
    const parent = s.parent_id !== null ? db.symbolById(s.parent_id) : undefined;
    if (parent) return [parent];
    return db.symbolsByName(container).filter(c => CONTAINER_KINDS.has(c.kind) && c.lang === s.lang).slice(0, 4);
  };
  const hasMain = new Map<number, boolean>();
  const isProgram = (type: SymbolRow): boolean => {
    let hit = hasMain.get(type.id);
    if (hit === undefined) {
      hit = db.get(`SELECT 1 AS x FROM symbols WHERE parent_id = ? AND name IN ('main', 'Main') LIMIT 1`, type.id) !== undefined;
      hasMain.set(type.id, hit);
    }
    return hit;
  };
  const marked = (s: SymbolRow): boolean => {
    if (EXPORT_MARKER.test(s.signature)) return true;
    // `override` of a member that only this project's one definition has: the base is a library type.
    if (/(^|\s)override\b|@Override\b/.test(s.signature) && new Set((defsOf.get(s.name) ?? []).map(d => d.qname)).size <= 1) return true;
    const src = srcOf(s.path);
    if (!src) return false;
    // The lines above the definition, as far as they are attributes, decorators or comments.
    let from = s.doc_line > 0 ? Math.min(s.doc_line, s.start_line) : s.start_line;
    while (from > 1 && s.start_line - from < 12 && /^(@|\[[A-Za-z]|#!?\[|\/\/|\/\*|\*|#\s)/.test((src[from - 2] ?? '').trim())) from--;
    for (let n = from; n <= s.start_line; n++) {
      const t = (src[n - 1] ?? '').trim();
      if (/^@Override\b/.test(t) && new Set((defsOf.get(s.name) ?? []).map(d => d.qname)).size <= 1) return true;
      if (!/^(@|\[[A-Za-z]|#!?\[)/.test(t) || HARMLESS_MARK.test(t)) continue;
      // JSDoc tags and C++ lambdas / array literals are not attributes.
      if (t.startsWith('[') && (s.lang !== 'csharp' || /^\[.*\]\s*[=;(]/.test(t))) continue;
      if (t.startsWith('@') && langFamily(s.lang) === 'c') continue;
      return true;
    }
    return false;
  };

  const membersInUse = (type: SymbolRow): boolean =>
    db.all<{ name: string }>(
      `SELECT DISTINCT name FROM symbols WHERE parent_id = ? AND kind IN ('method', 'function', 'property')`, type.id
    ).some(m => m.name !== type.name && refs.get(m.name)?.length !== 0 && memberRefs(m.name));
  /** Is this member name referenced anywhere outside its definitions (also for names that were not candidates)? */
  const memberRefs = (name: string): boolean => {
    if (refs.has(name)) return true; // candidates with zero references were excluded by the caller
    const id = db.nameId(name, false);
    if (id === undefined) return false;
    const defLines = new Set(db.symbolsByName(name).map(d => d.file_id + ':' + d.start_line));
    for (const r of db.all<{ file_id: number; lines: string }>(`SELECT file_id, lines FROM occ WHERE name_id = ?`, id)) {
      for (const l of r.lines.split(',')) if (!defLines.has(r.file_id + ':' + l)) return true;
    }
    return false;
  };
  const verdictOf = new Map<number, keyof typeof skipped | 'ok'>();
  const verdict = (s: Cand): keyof typeof skipped | 'ok' => {
    let v = verdictOf.get(s.id);
    if (v === undefined) verdictOf.set(s.id, (v = decide(s)));
    return v;
  };
  const decide = (s: Cand): keyof typeof skipped | 'ok' => {
    const container = s.qname.includes('.') ? s.qname.split('.').slice(-2, -1)[0]! : null;
    if (
      IMPLICIT.has(s.name) || /^__\w+__$/.test(s.name) || s.name.startsWith('~') || s.name.startsWith('operator') ||
      s.name === container || (s.lang === 'go' && /^(Test|Benchmark|Example|Fuzz)/.test(s.name)) ||
      // A computed name (`[Service.init]()`) or one that is not an identifier (`'agent/created'(...)` in an
      // event map) is reached through a symbol or a string, never by writing the name.
      !/^[A-Za-z_$][\w$]*$/.test(s.name)
    ) return 'implicit';
    if (marked(s)) return 'marked';
    if (
      s.kind === 'method' && container && s.lang !== 'go' && s.lang !== 'rust' &&
      containersOf(s, container).some(c => hasExternalAncestor(c))
    ) return 'library';
    // A subclass of a library type that nothing names is usually found by the library (Django apps,
    // migrations, commands, servlets, plugins).
    if ((s.kind === 'class' || s.kind === 'struct') && hasExternalAncestor(s)) return 'library';
    // An exported Go method may be what makes its type satisfy an interface of a library (afero.Fs,
    // http.Handler): nothing in the project has to name it.
    if (s.lang === 'go' && s.kind === 'method' && s.exported) return 'structural';
    if (
      s.lang === 'go' && s.kind === 'method' &&
      (defsOf.get(s.name) ?? []).some(d => d.parent_id !== null && db.symbolById(d.parent_id)?.kind === 'interface')
    ) return 'structural';
    // A member of an object literal: the object is handed to something that calls it by shape.
    if (langFamily(s.lang) === 'js' && s.kind === 'method') {
      const parent = s.parent_id !== null ? db.symbolById(s.parent_id) : undefined;
      if (!parent || !CONTAINER_KINDS.has(parent.kind)) return 'structural';
    }
    // A named function expression (`useMemo(function bind() { ... })`, `x = function f() {}`) is used
    // where it is written: its name is only a label.
    if (langFamily(s.lang) === 'js' && s.kind === 'function') {
      const line = srcOf(s.path)?.[s.start_line - 1] ?? '';
      if (new RegExp(`[(=,:?&|]\\s*(async\\s+)?function\\s*\\*?\\s*${s.name.replace(/[$]/g, '\\$&')}\\b`).test(line)) return 'structural';
    }
    // A class with a main method is a program: something outside the code starts it.
    if (CONTAINER_KINDS.has(s.kind) && isProgram(s)) return 'implicit';
    // Extension methods are used without naming the class that holds them.
    if (CONTAINER_KINDS.has(s.kind) && EXTENSION_LANGS.has(s.lang) && membersInUse(s)) return 'members';
    return 'ok';
  };
  const candsByName = new Map<string, Cand[]>();
  for (const c of cands) {
    const l = candsByName.get(c.name);
    if (l) l.push(c);
    else candsByName.set(c.name, [c]);
  }
  /** Counts what is left out, once per symbol. */
  const judge = (s: Cand): boolean => {
    const v = verdict(s);
    if (v !== 'ok') skipped[v]++;
    return v === 'ok';
  };
  /** A name only counts as unused when none of its definitions is reachable from outside. */
  const reachable = (name: string): boolean => (candsByName.get(name) ?? []).some(c => verdict(c) !== 'ok');

  // --- 3. Fixpoint: a name used only inside unused code is unused too. ---
  const dead = new Map<string, string | null>(); // name -> the unused name that holds its only uses
  for (const [name, list] of refs) if (list && list.length === 0 && !reachable(name)) dead.set(name, null);
  const enclosingNames = new Map<string, string[]>();
  const enclosing = (r: Ref): string[] => {
    const key = r.fileId + ':' + r.line;
    let hit = enclosingNames.get(key);
    if (!hit) {
      hit = [];
      let s = db.enclosingSymbol(r.fileId, r.line);
      for (let i = 0; s && i < 8; i++) {
        hit.push(s.name);
        s = s.parent_id !== null ? db.symbolById(s.parent_id) : undefined;
      }
      enclosingNames.set(key, hit);
    }
    return hit;
  };
  const testOnly = new Set<string>();
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const [name, list] of refs) {
      if (!list || list.length === 0 || dead.has(name) || reachable(name)) continue;
      let holder: string | null = null;
      const ok = list.every(r => {
        const h = enclosing(r).find(n => n !== name && dead.has(n));
        if (h) holder = h;
        return h !== undefined;
      });
      if (ok) {
        dead.set(name, holder);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const [name, list] of refs) {
    if (!list || list.length === 0 || dead.has(name)) continue;
    if (list.every(r => isTestPath(r.path) || enclosing(r).some(n => n !== name && dead.has(n)))) testOnly.add(name);
  }

  interface Found { sym: Cand; why: 'unused' | 'tests' | 'unbound'; holder?: string | null; mention?: string; members?: number }
  const found: Found[] = [];
  for (const s of cands) {
    if (dead.has(s.name)) {
      found.push({ sym: s, why: 'unused', holder: dead.get(s.name) });
    } else if (refs.get(s.name)?.length === 0) {
      judge(s);
    } else if (testOnly.has(s.name)) {
      if (judge(s)) found.push({ sym: s, why: 'tests' });
    }
  }

  // --- 4. Members whose name is used, but never on them: every use is a call bound to another definition. ---
  let unboundCut = false;
  const hasCall = (nameId: number, r: Ref): boolean =>
    db.get(`SELECT 1 AS x FROM calls WHERE name_id = ? AND file_id = ? AND line = ? LIMIT 1`, nameId, r.fileId, r.line) !== undefined;
  for (const s of cands) {
    if (s.kind !== 'method' && s.kind !== 'function') continue;
    // Only where types are nominal: a structurally typed object (TypeScript, Go, Python) can stand in for
    // another definition without declaring it.
    if (!NOMINAL.has(s.lang)) continue;
    const list = refs.get(s.name);
    if (!list || list.length === 0 || dead.has(s.name) || testOnly.has(s.name)) continue;
    const defs = defsOf.get(s.name) ?? [];
    if (defs.length < 2) continue;
    if (performance.now() - started > UNUSED_BUDGET_MS / 2) {
      unboundCut = true;
      break;
    }
    const nameId = db.nameId(s.name, false)!;
    if (!list.every(r => hasCall(nameId, r))) continue;
    // A member used inside another definition of the same name (an override calling super) is still a use.
    const inside = defs.some(d => d.id !== s.id && d.end_line > d.start_line && db.get(
      `SELECT 1 AS x FROM calls WHERE name_id = ? AND file_id = ? AND line BETWEEN ? AND ? LIMIT 1`,
      nameId, d.file_id, d.start_line, d.end_line
    ) !== undefined);
    if (inside) continue;
    if (ctx.resolver.familyOf(s).size > 1) continue;
    if (callersOf(db, ctx.resolver, s, { quick: true }).length > 0) continue;
    if (judge(s)) found.push({ sym: s, why: 'unbound' });
  }
  for (const s of cands) if (refs.get(s.name) === null) skipped.shared++;

  // Members of an unused container are part of it, not findings of their own.
  const foundIds = new Map<number, Found>();
  for (const f of found) if (f.why === 'unused') foundIds.set(f.sym.id, f);
  const kept: Found[] = [];
  for (const f of found) {
    let p = f.sym.parent_id;
    let owner: Found | undefined;
    for (let i = 0; p !== null && i < 8 && !owner; i++) {
      owner = foundIds.get(p);
      p = db.symbolById(p)?.parent_id ?? null;
    }
    if (owner && owner !== f) owner.members = (owner.members ?? 0) + 1;
    else kept.push(f);
  }

  // --- 5. Strings, comments, templates and config can name a symbol too. ---
  const wanted = new Map<string, Found[]>();
  for (const f of kept) {
    const list = wanted.get(f.sym.name) ?? [];
    list.push(f);
    wanted.set(f.sym.name, list);
  }
  let scanCut = false;
  /** Name prefixes that some code completes at run time -> where. */
  const dynamic = new Map<string, string>();
  if (wanted.size) {
    const indexed = db.all<{ path: string; lang: string }>(`SELECT path, lang FROM files`);
    const langOf = new Map(indexed.map(f => [f.path, f.lang]));
    const work = [...indexed.map(f => f.path), ...otherTextFiles(ctx)];
    const word = /[A-Za-z_$][\w$]*/g;
    const BATCH = 96;
    for (let i = 0; i < work.length; i += BATCH) {
      if (performance.now() - started > UNUSED_BUDGET_MS) {
        scanCut = true;
        break;
      }
      const batch = work.slice(i, i + BATCH);
      const bufs = await Promise.all(batch.map(p => readFile(join(ctx.clast.root, p)).catch(() => null)));
      for (let k = 0; k < batch.length; k++) {
        const buf = bufs[k];
        if (!buf || buf.length > 4 * 1024 * 1024 || buf.subarray(0, 1024).includes(0)) continue;
        const text = buf.toString('latin1');
        const path = batch[k]!;
        if (text.includes('getattr(') || text.includes('send(') || /\[\s*["'`]\w/.test(text)) {
          DYNAMIC.lastIndex = 0;
          let dm: RegExpExecArray | null;
          while ((dm = DYNAMIC.exec(text)) !== null) {
            const prefix = dm[1] ?? dm[2]!;
            if (!dynamic.has(prefix)) dynamic.set(prefix, `${batch[k]!}:${text.slice(0, dm.index).split('\n').length}`);
          }
        }
        let lineNo = 1;
        let pos = 0;
        let m: RegExpExecArray | null;
        word.lastIndex = 0;
        while ((m = word.exec(text)) !== null) {
          const hits = wanted.get(m[0]);
          if (!hits) continue;
          for (let j = text.indexOf('\n', pos); j !== -1 && j < m.index; j = text.indexOf('\n', j + 1)) {
            lineNo++;
            pos = j + 1;
          }
          // Its own definition (and the comment above it) does not count.
          const own = (defsOf.get(m[0]) ?? []).some(
            d => d.path === path && lineNo >= (d.doc_line > 0 ? Math.min(d.doc_line, d.start_line) : d.start_line) && lineNo <= d.end_line
          );
          if (own || refs.get(m[0])?.some(r => r.path === path && r.line === lineNo)) continue;
          // A comment line in source code that names it (`{@link Foo}`, "see foo()") does not keep it alive.
          const lang = langOf.get(path);
          if (lang !== undefined) {
            const head = text.slice(pos, pos + 200).trimStart();
            if (/^(\/\/|\/\*|\*)/.test(head) || (head.startsWith('#') && HASH_COMMENT.has(lang))) continue;
          }
          // What only tests use may be mentioned by tests; anything else that names it counts.
          const live = hits.filter(h => h.why !== 'tests' || !isTestPath(path));
          if (live.length === 0) continue;
          for (const h of live) h.mention ??= `${path}:${lineNo}`;
          if (live.length === hits.length) wanted.delete(m[0]);
          else wanted.set(m[0], hits.filter(h => !live.includes(h)));
        }
      }
    }
  }

  for (const f of kept) {
    if (f.mention) continue;
    for (const [prefix, at] of dynamic) {
      if (f.sym.name.length > prefix.length && f.sym.name.startsWith(prefix)) {
        f.mention = `${at} builds "${prefix}..." names at run time`;
        break;
      }
    }
  }

  // What is used only by something that turned out to be reachable after all is reachable too.
  const saved = new Set(kept.filter(f => f.mention).map(f => f.sym.name));
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const f of kept) {
      if (f.mention || !f.holder || !saved.has(f.holder)) continue;
      f.mention = `used by ${f.holder}, listed here`;
      saved.add(f.sym.name);
      grew = true;
    }
    if (!grew) break;
  }

  // --- 6. Report ---
  const span = (s: SymbolRow): number => s.end_line - s.start_line + 1;
  const sure = kept.filter(f => f.why === 'unused' && !f.mention);
  const unbound = kept.filter(f => f.why === 'unbound' && !f.mention);
  const mentioned = kept.filter(f => f.mention);
  const tests = kept.filter(f => f.why === 'tests' && !f.mention);
  const out: string[] = [];
  const lines = (list: Found[]): number => list.reduce((n, f) => n + span(f.sym), 0);
  const priv = sure.filter(f => !f.sym.exported);
  out.push(
    `unused code: ${plural(sure.length, 'symbol')}, ${lines(sure)} lines in ${plural(new Set(sure.map(f => f.sym.path)).size, 'file')}` +
      ` - the name is never referenced outside its own definition, or only from other unused code` +
      ` (${cands.length} symbols judged${args.path ? ` under ${args.path}` : ''})`
  );
  if (sure.length) {
    out.push(
      `  ${priv.length} not exported (${lines(priv)} lines), ${sure.length - priv.length} exported or public ` +
        `(marked "exported": unused inside this project, dead unless something outside uses them)`
    );
  }
  const section = (list: Found[], cap: number, tail: (f: Found) => string): void => {
    const byPath = new Map<string, Found[]>();
    for (const f of list) {
      const l = byPath.get(f.sym.path) ?? [];
      l.push(f);
      byPath.set(f.sym.path, l);
    }
    const order = [...byPath.entries()].sort((a, b) => lines(b[1]) - lines(a[1]));
    let shown = 0;
    for (const [path, fs] of order) {
      if (shown >= cap) break;
      out.push(`${path}  (${plural(fs.length, 'symbol')}, ${lines(fs)} lines)`);
      fs.sort((a, b) => a.sym.start_line - b.sym.start_line);
      for (const f of fs) {
        if (shown >= cap) break;
        shown++;
        out.push(
          `  ${f.sym.kind} ${f.sym.qname}  :${f.sym.start_line}${f.sym.end_line > f.sym.start_line ? '-' + f.sym.end_line : ''}` +
            (f.sym.exported ? '  exported' : '') + (f.members ? `  (+${plural(f.members, 'unused member')})` : '') + tail(f)
        );
      }
    }
    if (list.length > shown) out.push(`... ${list.length - shown} more (raise limit, or narrow with path)`);
  };
  section(sure, limit, f => (f.holder ? `  (used only by unused ${f.holder})` : ''));
  if (unbound.length) {
    out.push(`probably unused (${unbound.length}): the name is called elsewhere, but every call binds to another definition:`);
    section(unbound, Math.min(limit, 25), () => '');
  }
  if (tests.length) {
    out.push(`used only by tests (${tests.length}, ${lines(tests)} lines):`);
    section(tests, Math.min(limit, 25), () => '');
  }
  if (mentioned.length) {
    out.push(
      `no code reference, but the name appears in a string, trailing comment or non-code file (${mentioned.length}; ` +
        `reflection, templates, config, docs - look before deleting):`
    );
    section(mentioned, Math.min(limit, 25), f => `  <- ${f.mention}`);
  }
  const notes: string[] = [];
  if (skipped.marked) notes.push(`${skipped.marked} with a decorator, attribute or export marker (routes, tests, exported C symbols)`);
  if (skipped.library) notes.push(`${skipped.library} subclasses of library types and their methods (the library may find and call them)`);
  if (skipped.structural) notes.push(`${skipped.structural} members used by shape (object-literal members, exported Go methods that may satisfy a library interface)`);
  if (skipped.implicit) notes.push(`${skipped.implicit} entry points, constructors and conventional names (main, toString, ...)`);
  if (skipped.members) notes.push(`${skipped.members} classes never named but whose members are used (extension methods)`);
  if (notes.length) out.push(`not judged: ${notes.join('; ')}.`);
  out.push(
    `limits: judged by name - a member whose name is widely used elsewhere (${skipped.shared} symbols, e.g. "get", "run") ` +
      `is never listed; check one with clast_call_graph. Calls built from strings at run time are invisible.` +
      (scanCut ? ' The string / comment scan hit its time budget: verify with clast_grep before deleting.' : '') +
      (unboundCut ? ' The "probably unused" pass hit its time budget; narrow with path for full coverage.' : '')
  );
  return out.join('\n');
}

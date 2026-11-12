import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { isTestPath } from './format.js';
import { genericArity } from '../parser/spec.js';
import { langFamily, type Resolver } from './resolve.js';

/** Type parameters a type is declared with: `class ActionResult<TValue>` -> 1. */
function declaredArity(sym: SymbolRow): number {
  const at = sym.signature.search(new RegExp('\\b' + sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*<'));
  return at === -1 ? 0 : genericArity(sym.signature.slice(at));
}

const isPartial = (s: SymbolRow): boolean => /\bpartial\b/.test(s.signature);
/** C# static classes cannot be inherited from. */
const isStaticClass = (s: SymbolRow): boolean => s.lang === 'csharp' && /\bstatic\s+(partial\s+)?class\b/.test(s.signature);

export interface TypeEdge {
  sym: SymbolRow;
  /** 'extends' | 'implements' | 'structural' */
  kind: string;
  /** False when the name matches but another definition of that name could be meant. */
  certain: boolean;
}

export interface SuperEdge {
  name: string;
  kind: string;
  /** Resolved definition; null for types outside the project. */
  sym: SymbolRow | null;
}

const RUST_RELATIVE = new Set(['crate', 'self', 'super', 'Self']);

/**
 * Can `qualifier.Name` / `qualifier::Name` written in Go or Rust mean the type `cand`?
 * The qualifier is a package or module, which shows in the path of the defining file
 * (directory or file name). Other languages: always true. `strict` rejects relative paths too.
 */
function qualifierFits(qualifier: string, cand: SymbolRow, lang: string, strict = false): boolean {
  if (lang !== 'go' && lang !== 'rust') return true;
  const q = qualifier.split(/::|\./).filter(Boolean);
  const last = q[q.length - 1];
  if (!last) return true;
  if (lang === 'rust' && RUST_RELATIVE.has(last)) return !strict;
  const segs = cand.path.toLowerCase().split('/');
  const want = last.toLowerCase().replace(/_/g, '-');
  for (let i = 0; i < segs.length; i++) {
    const seg = (i === segs.length - 1 ? segs[i]!.replace(/\.[a-z]+$/, '') : segs[i]!).replace(/_/g, '-');
    if (seg === want) return true;
  }
  // An enclosing module / type of the same name inside the file.
  return cand.qname.split('.').slice(0, -1).some(p => p.toLowerCase() === last.toLowerCase());
}

/**
 * Lexical scope lookup of a type name written inside `from`: `Enum` inside
 * `ActiveRecord.Base` is `ActiveRecord.Base.Enum`, else `ActiveRecord.Enum`,
 * else top-level `Enum`. Returns null when no enclosing scope defines it.
 */
function lexicalType(db: ClastDb, from: SymbolRow, qualifier: string | null, name: string): SymbolRow | null {
  const cands = db
    .symbolsByName(name)
    .filter(s => (CONTAINER_KINDS.has(s.kind) || s.kind === 'type') && s.id !== from.id && s.lang === from.lang && !isStaticClass(s));
  if (cands.length === 0) return null;
  const parts = from.qname.split('.');
  const tail = (qualifier ? qualifier.replace(/::|\\/g, '.') + '.' : '') + name;
  for (let n = parts.length; n >= 0; n--) {
    const want = (n ? parts.slice(0, n).join('.') + '.' : '') + tail;
    const hits = cands.filter(s => s.qname === want);
    if (hits.length) return hits.find(s => !isTestPath(s.path)) ?? hits[0]!;
  }
  return null;
}

/**
 * Types that directly extend / implement `sym`. Heritage is recorded by
 * name, so each candidate is checked by resolving that name from the
 * subtype's file (imports, same file, proximity) back to `sym`.
 */
export function directSubtypes(db: ClastDb, resolver: Resolver, sym: SymbolRow): TypeEdge[] {
  if (isStaticClass(sym)) return [];
  type Row = SymbolRow & { hkind: string; hqual: string | null; harity: number; hfile: number };
  const symArity = sym.lang === 'csharp' ? declaredArity(sym) : -1;
  const select = `SELECT ${SYMBOL_COLUMNS}, h.kind AS hkind, h.qualifier AS hqual, h.arity AS harity, h.file_id AS hfile FROM heritage h
     JOIN symbols s ON s.id = h.symbol_id JOIN files f ON f.id = s.file_id`;
  const rows = db.all<Row>(`${select} WHERE h.name = ? LIMIT 5000`, sym.name);
  const sameName = db.symbolsByName(sym.name).filter(s => CONTAINER_KINDS.has(s.kind) || s.kind === 'type');
  const out: TypeEdge[] = [];
  const seen = new Set<number>();

  // Subtypes that name the supertype through an import alias (`import { X as Base }`).
  for (const use of resolver.aliasesOf(sym)) {
    for (const row of db.all<Row>(`${select} WHERE h.name = ? AND h.file_id = ?`, use.alias, use.fileId)) {
      if (row.id === sym.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ sym: row, kind: row.hkind, certain: true });
    }
  }

  const qparts = sym.qname.split('.');
  const symContainer = qparts.length >= 2 ? qparts[qparts.length - 2]! : null;
  for (const row of rows) {
    if (row.id === sym.id || seen.has(row.id)) continue;
    // A C++ class does not implement a C# interface of the same name.
    if (langFamily(row.lang) !== langFamily(sym.lang)) continue;
    // `io.Closer` / a `Wake` imported from std is not the project's type of that name.
    if (resolver.externalSupertype(sym.name, row.hqual, row.hfile, row.lang)) continue;
    // C#: `Foo` and `Foo<T>` are different types.
    if (symArity !== -1 && row.harity !== symArity) continue;
    let certain = true;
    const lex = row.lang === 'ruby' ? lexicalType(db, row, row.hqual, sym.name) : null;
    if (lex) {
      // Ruby constant lookup is lexical: the name means the nearest enclosing definition.
      if (lex.id !== sym.id && lex.qname !== sym.qname) continue;
    } else if (row.lang === 'ruby' && !row.hqual && sym.qname.includes('.')) {
      continue; // the unqualified name does not reach this nested constant from there
    } else if (row.hqual && !qualifierFits(row.hqual, sym, row.lang)) {
      continue; // Go / Rust: qualified by another package or module
    } else if (row.hqual && symContainer) {
      // Written as Outer::Name / Outer.Name: the qualifier must be our enclosing type or namespace.
      if (row.hqual !== symContainer) continue;
    } else if (sameName.length > 1 || row.hqual) {
      const res = resolver.resolve(
        sym.name,
        { fileId: row.file_id, path: row.path, lang: row.lang, receiver: row.hqual, caller: row },
        0,
        true
      );
      // A type does not extend itself (`class Foo<T> : Foo`), and in C# the arity must match.
      const cands = res.candidates.filter(
        c => c.sym.id !== row.id && (symArity === -1 || declaredArity(c.sym) === row.harity) && !isStaticClass(c.sym)
      );
      const top = cands[0];
      if (!top) {
        certain = false;
      } else if (top.sym.id !== sym.id) {
        const mine = cands.find(c => c.sym.id === sym.id);
        // The heritage name clearly refers to another definition of the same name.
        if (!mine || top.score - mine.score > 10) continue;
        certain = false;
      } else {
        // C#: the arity already singled out one of the same-named types.
        certain = res.confident || (symArity !== -1 && cands.length === 1);
      }
    }
    seen.add(row.id);
    out.push({ sym: row, kind: row.hkind, certain });
  }
  out.sort(
    (a, b) =>
      Number(b.certain) - Number(a.certain) ||
      Number(isTestPath(a.sym.path)) - Number(isTestPath(b.sym.path)) ||
      Number(b.sym.file_id === sym.file_id) - Number(a.sym.file_id === sym.file_id) ||
      a.sym.path.localeCompare(b.sym.path) ||
      a.sym.start_line - b.sym.start_line
  );
  return out;
}

/** Declared supertypes of `sym`, resolved to project symbols where possible. */
export function directSupertypes(db: ClastDb, resolver: Resolver, sym: SymbolRow): SuperEdge[] {
  // C# partial classes: the base list may be on any of the parts.
  let ids = [sym.id];
  if (sym.lang === 'csharp' && isPartial(sym)) {
    const dir = sym.path.slice(0, sym.path.lastIndexOf('/') + 1);
    ids = db
      .symbolsByName(sym.name)
      .filter(s => s.qname === sym.qname && s.kind === sym.kind && s.lang === sym.lang && isPartial(s) && s.path.startsWith(dir))
      .map(s => s.id);
    if (!ids.includes(sym.id)) ids.push(sym.id);
  }
  const rows = db.all<{ name: string; kind: string; qualifier: string | null; arity: number; file_id: number }>(
    `SELECT name, kind, qualifier, arity, file_id FROM heritage WHERE symbol_id IN (${ids.map(() => '?').join(',')})`, ...ids
  );
  const out: SuperEdge[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // (`include Thor::Actions` and `include Rails::Generators::Actions` are two supertypes.)
    const key = `${row.qualifier ?? ''}::${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isType = (s: SymbolRow): boolean =>
      (CONTAINER_KINDS.has(s.kind) || s.kind === 'type') && s.id !== sym.id && !isStaticClass(s) &&
      // Rust associated types (`type Future = ...` inside an impl) are not the trait `Future`.
      !(s.lang === 'rust' && s.kind === 'type' && s.qname !== s.name);
    if (resolver.externalSupertype(row.name, row.qualifier, row.file_id, sym.lang)) {
      out.push({ name: row.name, kind: row.kind, sym: null });
      continue;
    }
    let res = resolver.resolve(
      row.name,
      { fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: row.qualifier, caller: sym },
      0,
      true
    );
    let target = res.candidates.find(c => isType(c.sym));
    if (sym.lang === 'ruby' || !res.confident) {
      const lex = lexicalType(db, sym, row.qualifier, row.name);
      if (lex) target = { sym: lex, score: 95 };
      // Ruby: an unqualified constant that no enclosing scope defines is not some class of that name
      // nested elsewhere (`class SlowRedis < Redis` at top level means the gem's Redis).
      // The same holds for a qualified one: `Thor::Group` is not some other class called Group.
      else if (sym.lang === 'ruby') target = undefined;
    }
    if (!target && row.qualifier && sym.lang !== 'ruby') {
      // Qualified by an enclosing type / namespace that is part of the qualified name.
      const want = row.qualifier + '.' + row.name;
      const direct = db.symbolsByName(row.name).find(s => isType(s) && (s.qname === want || s.qname.endsWith('.' + want)));
      if (direct) target = { sym: direct, score: 90 };
      else {
        res = resolver.resolve(
          row.name, { fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: null, caller: sym }, 0, true
        );
        target = res.candidates.find(c => isType(c.sym) && qualifierFits(row.qualifier!, c.sym, sym.lang));
      }
    }
    // Go / Rust: `page.Provider`, `futures_io::AsyncRead` name a package / module. A same-named type
    // that lives somewhere else is a different type.
    if (target && row.qualifier && !qualifierFits(row.qualifier, target.sym, sym.lang)) {
      const better = db.symbolsByName(row.name).find(s => isType(s) && s.lang === sym.lang && qualifierFits(row.qualifier!, s, sym.lang, true));
      target = better ? { sym: better, score: 90 } : undefined;
    }
    if (target && sym.lang === 'csharp' && declaredArity(target.sym) !== row.arity) {
      // `: ActionResult` is not `ActionResult<TValue>`.
      const fit = db.symbolsByName(row.name).filter(s => isType(s) && s.lang === 'csharp' && declaredArity(s) === row.arity);
      const best = fit.find(s => !isTestPath(s.path)) ?? fit[0];
      target = best ? { sym: best, score: 90 } : undefined;
    }
    // PHP traits are recorded as 'implements'; say what they are.
    const kind = target && target.sym.kind === 'trait' && sym.lang === 'php' ? 'uses' : row.kind;
    out.push({ name: row.name, kind, sym: target ? target.sym : null });
  }
  return out;
}


function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Top-level comma-separated items in a parameter / result list. */
function countItems(list: string): number {
  if (!list.trim()) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of list) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) n++;
  }
  return n;
}

/**
 * Shape of a Go method signature: number of parameters and of results
 * (`Close() error` -> "0/1", `Close(n Node, r Reader)` -> "2/0"). Go matches
 * interfaces on full signatures; counting is enough to reject look-alikes
 * without parsing types. Null when the signature cannot be read.
 */
export function goShape(signature: string, name: string): string | null {
  let sig = signature;
  // func (r *T) Name(...) ...: skip the receiver.
  const recv = /^func\s*\(/.exec(sig);
  if (recv) {
    let depth = 0;
    let i = recv[0].length - 1;
    for (; i < sig.length; i++) {
      if (sig[i] === '(') depth++;
      else if (sig[i] === ')' && --depth === 0) break;
    }
    sig = sig.slice(i + 1);
  }
  const at = sig.indexOf(name);
  if (at === -1) return null;
  let i = at + name.length;
  while (i < sig.length && sig[i] === ' ') i++;
  if (sig[i] === '[') {
    // type parameters
    let depth = 0;
    for (; i < sig.length; i++) {
      if (sig[i] === '[') depth++;
      else if (sig[i] === ']' && --depth === 0) { i++; break; }
    }
  }
  if (sig[i] !== '(') return null;
  let depth = 0;
  const open = i;
  for (; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) break;
  }
  if (i >= sig.length) return null; // cut off
  const params = countItems(sig.slice(open + 1, i));
  const rest = sig.slice(i + 1).replace(/\{\s*$/, '').trim();
  let results = 0;
  if (rest.startsWith('(')) {
    const close = rest.lastIndexOf(')');
    if (close === -1) return null;
    results = countItems(rest.slice(1, close));
  } else if (rest) {
    results = 1;
  }
  return params + '/' + results;
}

interface Member {
  id: number;
  name: string;
  shape: string | null;
}

function membersOf(db: ClastDb, containerId: number): Member[] {
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const r of db.all<{ id: number; name: string; signature: string }>(
    `SELECT id, name, signature FROM symbols WHERE parent_id = ? AND kind = 'method'`, containerId
  )) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({ id: r.id, name: r.name, shape: goShape(r.signature, r.name) });
  }
  return out;
}

/**
 * Methods of the type called `typeName` that are defined outside its body
 * (Go receivers), with their shapes. `dir` limits this to one package.
 */
function methodsOfType(db: ClastDb, typeName: string, lang: string, dir?: string): Map<string, Set<string | null>> {
  const rows = db.all<{ name: string; qname: string; signature: string; path: string }>(
    `SELECT s.name, s.qname, s.signature, f.path FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.kind = 'method' AND f.lang = ? AND s.qname LIKE ? ESCAPE '\\'`,
    lang, '%' + typeName.replace(/[\\%_]/g, c => '\\' + c) + '.%'
  );
  const out = new Map<string, Set<string | null>>();
  for (const r of rows) {
    const parts = r.qname.split('.');
    if (parts.length < 2 || parts[parts.length - 2] !== typeName) continue;
    if (dir !== undefined && dirOf(r.path) !== dir) continue;
    let set = out.get(r.name);
    if (!set) out.set(r.name, (set = new Set()));
    set.add(goShape(r.signature, r.name));
  }
  return out;
}

/** Does a method set cover every required interface method (by name and, where readable, shape)? */
function covers(methods: Map<string, Set<string | null>>, required: Member[]): boolean {
  for (const m of required) {
    const shapes = methods.get(m.name);
    if (!shapes) return false;
    if (m.shape !== null && !shapes.has(m.shape) && !shapes.has(null)) return false;
  }
  return true;
}

/**
 * Go has no `implements`: a type satisfies an interface when its method set
 * contains the interface's methods. Returns the types whose methods (name,
 * parameter and result counts) cover every method of the interface.
 */
export function structuralImplementers(db: ClastDb, iface: SymbolRow, limit = 200): SymbolRow[] {
  if (iface.lang !== 'go' || iface.kind !== 'interface') return [];
  const required = membersOf(db, iface.id);
  if (required.length === 0) return [];

  // Start from the rarest method name to keep the candidate set small.
  let rarest = required[0]!.name;
  let rarestCount = Infinity;
  for (const m of required) {
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM symbols WHERE name = ? AND kind = 'method'`, m.name)?.n ?? 0;
    if (n < rarestCount) { rarestCount = n; rarest = m.name; }
  }
  const holders = db.all<{ qname: string; path: string }>(
    `SELECT s.qname, f.path FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.name = ? AND s.kind = 'method' AND f.lang = 'go' LIMIT 5000`,
    rarest
  );
  // A type is identified by its package directory and name.
  const types = new Map<string, { dir: string; name: string }>();
  for (const h of holders) {
    const parts = h.qname.split('.');
    if (parts.length < 2) continue;
    const name = parts[parts.length - 2]!;
    const dir = dirOf(h.path);
    if (name === iface.name && dir === dirOf(iface.path)) continue;
    types.set(dir + '\0' + name, { dir, name });
  }

  const out: SymbolRow[] = [];
  for (const t of types.values()) {
    if (!covers(methodsOfType(db, t.name, 'go', t.dir), required)) continue;
    const defs = db
      .all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.name = ? AND f.lang = 'go'`, t.name)
      .filter(s => (s.kind === 'struct' || s.kind === 'type') && dirOf(s.path) === t.dir);
    for (const d of defs) out.push(d);
    if (out.length >= limit) break;
  }
  // A struct that embeds an implementer gets its methods with it (promotion) and so satisfies the
  // interface too: `type decisionRequest struct { jsonRetrieval; ... }`.
  const seen = new Set(out.map(s => s.id));
  let frontier = [...out];
  for (let depth = 0; depth < 3 && frontier.length && out.length < limit; depth++) {
    const next: SymbolRow[] = [];
    for (const impl of frontier) {
      const embedders = db.all<SymbolRow & { qualifier: string | null }>(
        `SELECT ${SYMBOL_COLUMNS}, h.qualifier AS qualifier FROM heritage h
         JOIN symbols s ON s.id = h.symbol_id JOIN files f ON f.id = s.file_id
         WHERE h.name = ? AND f.lang = 'go' AND s.kind = 'struct' LIMIT 500`,
        impl.name
      );
      const implDir = dirOf(impl.path);
      for (const e of embedders) {
        if (seen.has(e.id)) continue;
        // Unqualified: the embedded type is in the same package. Qualified: the package is its directory name.
        const samePackage = e.qualifier ? implDir.split('/').pop() === e.qualifier : dirOf(e.path) === implDir;
        if (!samePackage) continue;
        seen.add(e.id);
        out.push(e);
        next.push(e);
      }
    }
    frontier = next;
  }
  out.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
  return out;
}

/** Go: interfaces whose method set is covered by the methods of `type`. */
export function structuralInterfaces(db: ClastDb, type: SymbolRow, limit = 40): SymbolRow[] {
  if (type.lang !== 'go' || (type.kind !== 'struct' && type.kind !== 'type')) return [];
  const methods = methodsOfType(db, type.name, 'go', dirOf(type.path));
  if (methods.size === 0) return [];
  const ifaces = db.all<SymbolRow>(
    `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.kind = 'interface' AND f.lang = 'go' LIMIT 20000`
  );
  const out: SymbolRow[] = [];
  for (const iface of ifaces) {
    const required = membersOf(db, iface.id);
    if (required.length === 0 || required.length > methods.size) continue;
    if (covers(methods, required)) out.push(iface);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
  return out;
}

/**
 * Go: ids of the interface methods that `method` implements (its type covers
 * the whole interface). A call through such an interface may reach `method`.
 */
export function goInterfaceMethods(db: ClastDb, method: SymbolRow): number[] {
  if (method.lang !== 'go' || method.kind !== 'method') return [];
  const parts = method.qname.split('.');
  if (parts.length < 2) return [];
  const typeName = parts[parts.length - 2]!;
  const decls = db.all<{ id: number; parent_id: number }>(
    `SELECT s.id, s.parent_id FROM symbols s JOIN symbols p ON p.id = s.parent_id JOIN files f ON f.id = s.file_id
     WHERE s.name = ? AND s.kind = 'method' AND p.kind = 'interface' AND f.lang = 'go' LIMIT 400`,
    method.name
  );
  if (decls.length === 0) return [];
  const methods = methodsOfType(db, typeName, 'go', dirOf(method.path));
  const out: number[] = [];
  for (const d of decls) {
    if (d.id === method.id) continue;
    const required = membersOf(db, d.parent_id);
    if (required.length && covers(methods, required)) out.push(d.id);
  }
  return out;
}

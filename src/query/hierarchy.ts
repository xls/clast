import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { isTestPath } from './format.js';
import type { Resolver } from './resolve.js';

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

/**
 * Types that directly extend / implement `sym`. Heritage is recorded by
 * name, so each candidate is checked by resolving that name from the
 * subtype's file (imports, same file, proximity) back to `sym`.
 */
export function directSubtypes(db: ClastDb, resolver: Resolver, sym: SymbolRow): TypeEdge[] {
  type Row = SymbolRow & { hkind: string; hqual: string | null };
  const select = `SELECT ${SYMBOL_COLUMNS}, h.kind AS hkind, h.qualifier AS hqual FROM heritage h
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
    let certain = true;
    if (row.hqual && symContainer) {
      // Written as Outer::Name / Outer.Name: the qualifier must be our enclosing type or namespace.
      if (row.hqual !== symContainer) continue;
    } else if (sameName.length > 1 || row.hqual) {
      const res = resolver.resolve(sym.name, {
        fileId: row.file_id, path: row.path, lang: row.lang, receiver: row.hqual, caller: row,
      });
      const top = res.candidates[0];
      if (!top) {
        certain = false;
      } else if (top.sym.id !== sym.id) {
        const mine = res.candidates.find(c => c.sym.id === sym.id);
        // The heritage name clearly refers to another definition of the same name.
        if (!mine || top.score - mine.score > 10) continue;
        certain = false;
      } else {
        certain = res.confident;
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
  const rows = db.all<{ name: string; kind: string; qualifier: string | null }>(
    `SELECT name, kind, qualifier FROM heritage WHERE symbol_id = ?`, sym.id
  );
  const out: SuperEdge[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    const isType = (s: SymbolRow): boolean => (CONTAINER_KINDS.has(s.kind) || s.kind === 'type') && s.id !== sym.id;
    let res = resolver.resolve(row.name, {
      fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: row.qualifier, caller: sym,
    });
    let target = res.candidates.find(c => isType(c.sym));
    if (!target && row.qualifier) {
      // Qualified by an enclosing type / namespace that is part of the qualified name.
      const want = row.qualifier + '.' + row.name;
      const direct = db.symbolsByName(row.name).find(s => isType(s) && (s.qname === want || s.qname.endsWith('.' + want)));
      if (direct) target = { sym: direct, score: 90 };
      else {
        res = resolver.resolve(row.name, { fileId: sym.file_id, path: sym.path, lang: sym.lang, receiver: null, caller: sym });
        target = res.candidates.find(c => isType(c.sym));
      }
    }
    // PHP traits are recorded as 'implements'; say what they are.
    const kind = target && target.sym.kind === 'trait' && sym.lang === 'php' ? 'uses' : row.kind;
    out.push({ name: row.name, kind, sym: target ? target.sym : null });
  }
  return out;
}

function memberNames(db: ClastDb, containerId: number): string[] {
  return db
    .all<{ name: string }>(`SELECT DISTINCT name FROM symbols WHERE parent_id = ? AND kind = 'method'`, containerId)
    .map(r => r.name);
}

/** Method names of a type that are defined outside its body (Go receivers, Rust impl blocks). */
function methodsByQname(db: ClastDb, typeName: string, lang: string): Set<string> {
  const rows = db.all<{ name: string; qname: string }>(
    `SELECT s.name, s.qname FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.kind = 'method' AND f.lang = ? AND s.qname LIKE ? ESCAPE '\\'`,
    lang, '%' + typeName.replace(/[\\%_]/g, c => '\\' + c) + '.%'
  );
  const out = new Set<string>();
  for (const r of rows) {
    const parts = r.qname.split('.');
    if (parts.length >= 2 && parts[parts.length - 2] === typeName) out.add(r.name);
  }
  return out;
}

/**
 * Go has no `implements`: a type satisfies an interface when its method set
 * contains the interface's methods. Returns the types whose methods (by
 * name) cover every method of the interface.
 */
export function structuralImplementers(db: ClastDb, iface: SymbolRow, limit = 200): SymbolRow[] {
  if (iface.lang !== 'go' || iface.kind !== 'interface') return [];
  const required = memberNames(db, iface.id);
  if (required.length === 0) return [];

  // Start from the rarest method name to keep the candidate set small.
  let rarest = required[0]!;
  let rarestCount = Infinity;
  for (const m of required) {
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM symbols WHERE name = ? AND kind = 'method'`, m)?.n ?? 0;
    if (n < rarestCount) { rarestCount = n; rarest = m; }
  }
  const holders = db.all<{ qname: string; path: string }>(
    `SELECT s.qname, f.path FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.name = ? AND s.kind = 'method' AND f.lang = 'go' LIMIT 5000`,
    rarest
  );
  const typeNames = new Set<string>();
  for (const h of holders) {
    const parts = h.qname.split('.');
    if (parts.length >= 2) typeNames.add(parts[parts.length - 2]!);
  }
  typeNames.delete(iface.name);

  const out: SymbolRow[] = [];
  for (const typeName of typeNames) {
    const methods = methodsByQname(db, typeName, 'go');
    if (!required.every(m => methods.has(m))) continue;
    const defs = db
      .all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.name = ? AND f.lang = 'go'`, typeName)
      .filter(s => s.kind === 'struct' || s.kind === 'type');
    for (const d of defs) out.push(d);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
  return out;
}

/** Go: interfaces whose method set is covered by the methods of `type`. */
export function structuralInterfaces(db: ClastDb, type: SymbolRow, limit = 40): SymbolRow[] {
  if (type.lang !== 'go' || (type.kind !== 'struct' && type.kind !== 'type')) return [];
  const methods = methodsByQname(db, type.name, 'go');
  if (methods.size === 0) return [];
  const ifaces = db.all<SymbolRow>(
    `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.kind = 'interface' AND f.lang = 'go' LIMIT 20000`
  );
  const out: SymbolRow[] = [];
  for (const iface of ifaces) {
    const required = memberNames(db, iface.id);
    if (required.length === 0 || required.length > methods.size) continue;
    if (required.every(m => methods.has(m))) out.push(iface);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
  return out;
}

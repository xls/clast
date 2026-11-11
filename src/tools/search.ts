import { CALLABLE_KINDS, CONTAINER_KINDS, SYMBOL_KINDS, type SymbolRow } from '../types.js';
import {
  buildGraph, calleesOf, callersOf, externalCallSites, groupCallers, type CallerEdge, type GraphNode,
} from '../query/callgraph.js';
import { firstLine, isTestPath, isTestSite, loc, plural, symLine } from '../query/format.js';
import {
  directSubtypes, directSupertypes, structuralImplementers, structuralInterfaces,
} from '../query/hierarchy.js';
import { findSymbols, otherDefinitions, parseSymbolRef, pathMatches } from '../query/resolve.js';
import { searchSymbols, type SearchOptions } from '../query/search.js';
import { ToolContext, toList } from './context.js';

// ---------------------------------------------------------------------------
// clast_search
// ---------------------------------------------------------------------------

export interface SearchArgs extends SearchOptions {
  query: string | string[];
}

export async function search(ctx: ToolContext, args: SearchArgs): Promise<string> {
  const note = await ctx.ready();
  const queries = toList(args.query);
  if (queries.length === 0) return 'error: query is required';
  const kinds = args.kind ? (Array.isArray(args.kind) ? args.kind : [args.kind]) : [];
  const badKind = kinds.find(k => !(SYMBOL_KINDS as string[]).includes(k));
  if (badKind) return `error: unknown kind "${badKind}". Valid kinds: ${SYMBOL_KINDS.join(', ')}.`;
  const out: string[] = [];

  for (const q of queries) {
    const { hits, truncated } = searchSymbols(ctx.db, q, args);
    if (hits.length === 0) {
      out.push(
        `"${q}": no symbols found. The name may be defined dynamically or outside the indexed code: ` +
          `try clast_grep for the text, or fewer / different words.`
      );
      continue;
    }
    out.push(`"${q}": ${plural(hits.length, 'match')}${truncated ? ' (more exist; raise limit or add kind/path filters)' : ''}`);
    for (const h of hits) {
      const s = h.sym;
      const tags: string[] = [];
      if (h.refs > 1 && h.unique) tags.push(`refs:${h.refs}`);
      if (h.match !== 'exact') tags.push(h.match);
      out.push(`${symLine(s)}${tags.length ? '  [' + tags.join(' ') + ']' : ''}`);
      if (s.signature && s.signature !== s.name) out.push(`  ${firstLine(s.signature, 180)}`);
      if (s.doc) out.push(`  // ${firstLine(s.doc, 140)}`);
    }
    out.push('');
  }
  return note + out.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// clast_get_context
// ---------------------------------------------------------------------------

export interface ContextArgs {
  name: string | string[];
  path?: string;
  /** Include source. Default true. */
  includeBody?: boolean;
  /** Max source lines per symbol. Default 120. */
  maxLines?: number;
  /** Include callers/callees. Default true. */
  includeCalls?: boolean;
}

const MAX_DOC_LINES = 12;
const IMPORT_LINE = /^(import\b|from\b.*\bimport\b|export\s*(\*|\{)|use\s|using\s|#\s*include|require(_relative|_once)?\b|include(_once)?\b|(const|let|var)\s.*=\s*require\()/;
const MINOR_KINDS = new Set(['property', 'field', 'constant', 'variable']);

function range(s: { start_line: number; end_line: number }): string {
  return s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
}

/** Members of a container: callables with signatures first, data members as a compact name list. */
function memberOutline(ctx: ToolContext, sym: SymbolRow, max: number): string[] {
  const members = ctx.db.symbolsInFile(sym.file_id).filter(m => m.parent_id === sym.id);
  const callables = members.filter(m => !MINOR_KINDS.has(m.kind));
  const data = members.filter(m => MINOR_KINDS.has(m.kind));
  const out: string[] = [];
  const seen = new Set<string>();
  let shown = 0;
  for (const m of callables) {
    if (shown >= max) break;
    const line = `  ${range(m).padEnd(9)} ${m.signature || m.kind + ' ' + m.name}${m.doc ? '  // ' + firstLine(m.doc, 80) : ''}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    shown++;
  }
  if (callables.length > shown) out.push(`  ... ${callables.length - shown} more methods (clast_file_summary ${sym.path} lists all)`);
  if (data.length) {
    const names = [...new Set(data.map(d => d.name))];
    out.push(`  fields (${names.length}): ${names.slice(0, 40).join(', ')}${names.length > 40 ? ', ...' : ''}`);
  }
  return out;
}

/** Doc comment lines for signature-only output, capped. */
function docLines(doc: string, max: number): string[] {
  const lines = doc.split('\n');
  const out = lines.slice(0, max).map(l => '// ' + l);
  if (lines.length > max) out.push(`// ... (${lines.length - max} more doc lines)`);
  return out;
}

function callerLines(edges: CallerEdge[], out: string[]): void {
  const groups = groupCallers(edges);
  if (groups.length === 0) return;
  const prod = groups.filter(g => !isTestSite(g.path, g.caller?.qname));
  const tests = groups.filter(g => isTestSite(g.path, g.caller?.qname));
  const certain = prod.filter(g => g.certain);
  const possible = prod.filter(g => !g.certain && !g.weak);
  const unknown = prod.filter(g => g.weak);

  const parts: string[] = [];
  if (certain.length) parts.push(`${certain.length} resolved`);
  if (possible.length) parts.push(`${possible.length} name-only "?"`);
  if (unknown.length) parts.push(`${unknown.length} on receivers of unknown type`);
  if (tests.length) parts.push(`${tests.length} in tests/examples`);
  out.push(`callers (${parts.join(', ')}):`);

  const line = (g: (typeof groups)[number], mark: string): string =>
    `  ${g.caller ? g.caller.qname : '<file level>'}  ${g.path}:${g.line}${g.sites > 1 ? ` (x${g.sites})` : ''}${mark}`;

  // Resolved production callers are what matters; weaker matches fill in when there are few.
  for (const g of certain.slice(0, 10)) out.push(line(g, ''));
  if (certain.length > 10) out.push(`  ... ${certain.length - 10} more resolved (clast_call_graph lists all)`);
  let budget = Math.max(0, 6 - certain.length);
  for (const g of possible.slice(0, budget)) out.push(line(g, '  ?'));
  budget -= Math.min(budget, possible.length);
  if (unknown.length) {
    // These call a method with this name on an object whose type could not be determined.
    for (const g of unknown.slice(0, budget)) out.push(line(g, '  ? (receiver type unknown)'));
  }
  const hidden = Math.max(0, possible.length - Math.max(0, 6 - certain.length)) + Math.max(0, unknown.length - budget);
  if (hidden) out.push(`  ... ${hidden} more unconfirmed call sites (clast_call_graph with uncertain=true lists them)`);
  if (tests.length) {
    const files = [...new Set(tests.map(t => t.path))];
    out.push(`  tests/examples: ${files.slice(0, 4).join(', ')}${files.length > 4 ? `, +${files.length - 4} more files` : ''}`);
  }
}

/** Places that mention the symbol without calling it (passed as a value, exported, decorated, typed). */
function valueReferences(
  ctx: ToolContext,
  sym: SymbolRow,
  callers: CallerEdge[],
  max: number,
  accept?: (path: string) => boolean
): string[] {
  const nameId = ctx.db.nameId(sym.name, false);
  if (nameId === undefined) return [];
  let rows = ctx.db.all<{ file_id: number; path: string; lines: string }>(
    `SELECT o.file_id, f.path, o.lines FROM occ o JOIN files f ON f.id = o.file_id WHERE o.name_id = ? LIMIT 400`,
    nameId
  );
  let nearest = false;
  if (accept) rows = rows.filter(r => accept(r.path));
  if (rows.length > 40) {
    // A widely used name: only the defining file and the files importing it can mean this symbol.
    const visible = new Set<number>([sym.file_id]);
    for (const r of ctx.db.all<{ file_id: number }>(
      `SELECT DISTINCT file_id FROM imports WHERE resolved_id = ? LIMIT 200`, sym.file_id
    )) {
      visible.add(r.file_id);
    }
    const narrowed = ctx.db.all<{ file_id: number; path: string; lines: string }>(
      `SELECT o.file_id, f.path, o.lines FROM occ o JOIN files f ON f.id = o.file_id WHERE o.name_id = ?`, nameId
    ).filter(r => visible.has(r.file_id));
    const kept = accept ? narrowed.filter(r => accept(r.path)) : narrowed;
    if (kept.length > 40) return [];
    if (!kept.some(r => r.file_id !== sym.file_id)) {
      // No file-level imports to narrow by (C# / Java namespaces, Ruby autoload): show the nearest uses.
      const home = sym.path.split('/');
      const near = (p: string): number => {
        const segs = p.split('/');
        let n = 0;
        while (n < segs.length - 1 && n < home.length - 1 && segs[n] === home[n]) n++;
        return n;
      };
      rows.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || near(b.path) - near(a.path) || a.path.localeCompare(b.path));
      rows.length = Math.min(rows.length, 40);
      nearest = true;
    } else {
      rows.length = 0;
      rows.push(...kept);
    }
  }
  // Every line that calls *something* with this name is a call, whichever definition it resolves to.
  const callSites = new Set(callers.map(c => c.path + ':' + c.line));
  for (const row of ctx.db.all<{ path: string; line: number }>(
    `SELECT f.path, c.line FROM calls c JOIN files f ON f.id = c.file_id WHERE c.name_id = ? LIMIT 5000`, nameId
  )) {
    callSites.add(row.path + ':' + row.line);
  }
  const callerIds = new Set(callers.map(c => c.caller?.id).filter((id): id is number => id !== undefined));
  const defLines = new Set(ctx.db.symbolsByName(sym.name).map(d => d.path + ':' + d.start_line));
  const out: string[] = [];
  const seen = new Set<string>();
  const callPattern = new RegExp('\\b' + sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(<[^>]*>)?[!?]?\\(');
  if (!nearest) rows.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
  for (const r of rows) {
    for (const n of r.lines.split(',').map(Number)) {
      const key = r.path + ':' + n;
      if (callSites.has(key) || defLines.has(key)) continue;
      if (r.file_id === sym.file_id && n >= sym.start_line && n <= sym.end_line) continue;
      const enclosing = ctx.db.enclosingSymbol(r.file_id, n);
      if (enclosing && callerIds.has(enclosing.id)) continue;
      const text = ctx.lines.line(r.path, n, 90);
      // Imports only say the name is in scope; they are not uses.
      if (!enclosing && IMPORT_LINE.test(text)) continue;
      // The line calls the name (a repeat call inside a caller already listed, or a call on an untyped receiver).
      if (callPattern.test(text)) continue;
      const who = enclosing ? enclosing.qname : '<file level>';
      if (seen.has(r.path + who)) continue;
      seen.add(r.path + who);
      if (out.length < max) out.push(`  ${who}  ${key}  ${text}`);
    }
  }
  if (seen.size > out.length || nearest) {
    out.push(`  ... ${nearest ? 'more' : seen.size - out.length + ' more'} (clast_references ${sym.name}${nearest ? ' lists every use; nearest shown' : ''})`);
  }
  return out;
}

function subtypeLines(ctx: ToolContext, sym: SymbolRow, max: number, out: string[]): void {
  const subs = directSubtypes(ctx.db, ctx.resolver, sym);
  const structural = structuralImplementers(ctx.db, sym, 60);
  if (subs.length) {
    out.push(`subtypes (${subs.length} direct):`);
    for (const s of subs.slice(0, max)) out.push(`  ${s.sym.qname}  ${s.sym.path}:${s.sym.start_line}${s.certain ? '' : '  ?'}`);
    if (subs.length > max) out.push(`  ... ${subs.length - max} more (clast_hierarchy ${sym.qname} lists all, transitively)`);
  }
  if (structural.length) {
    out.push(`implemented by (${structural.length}, matched by method set):`);
    for (const s of structural.slice(0, max)) out.push(`  ${s.qname}  ${s.path}:${s.start_line}`);
    if (structural.length > max) out.push(`  ... ${structural.length - max} more (clast_hierarchy)`);
  }
}

async function describe(ctx: ToolContext, sym: SymbolRow, args: ContextArgs, overloads: SymbolRow[]): Promise<string[]> {
  const out: string[] = [];
  const maxLines = Math.max(1, Math.min(args.maxLines ?? 120, 2000));
  out.push(`${symLine(sym)}${sym.exported ? '  [exported]' : ''}`);

  const isContainer = CONTAINER_KINDS.has(sym.kind);
  const hasDoc = sym.doc_line > 0 && sym.doc_line < sym.start_line;
  const codeLines = sym.end_line - sym.start_line + 1;

  if (args.includeBody === false) {
    if (sym.signature) out.push(firstLine(sym.signature, 200));
    if (sym.doc) out.push(...docLines(sym.doc, 6));
    if (isContainer) {
      const members = ctx.db.symbolsInFile(sym.file_id).filter(m => m.parent_id === sym.id);
      const methods = [...new Set(members.filter(m => !MINOR_KINDS.has(m.kind)).map(m => m.name))];
      const data = [...new Set(members.filter(m => MINOR_KINDS.has(m.kind)).map(m => m.name))];
      if (methods.length) out.push(`methods (${methods.length}): ${methods.slice(0, 50).join(', ')}${methods.length > 50 ? ', ...' : ''}`);
      if (data.length) out.push(`fields (${data.length}): ${data.slice(0, 30).join(', ')}${data.length > 30 ? ', ...' : ''}`);
    }
  } else if (isContainer && codeLines > maxLines) {
    // Large container: signature + doc + member outline instead of a wall of code.
    if (sym.signature) out.push(sym.signature);
    if (sym.doc) out.push(...docLines(sym.doc, 6));
    out.push(`members (${codeLines} lines; ask for Container.member to get a member's source):`);
    out.push(...memberOutline(ctx, sym, Math.max(10, Math.min(60, maxLines))));
  } else {
    // The doc comment is shown, but it must not eat the budget meant for code.
    if (hasDoc) {
      const docCount = sym.start_line - sym.doc_line;
      const docEnd = docCount > MAX_DOC_LINES ? sym.doc_line + MAX_DOC_LINES - 5 : sym.start_line - 1;
      const text = ctx.lines.excerpt(sym.path, sym.doc_line, docEnd);
      if (text !== null) out.push(text);
      if (docEnd < sym.start_line - 1) out.push(`   ... (${sym.start_line - 1 - docEnd} more doc lines)`);
    }
    const end = Math.min(sym.end_line, sym.start_line + maxLines - 1);
    const text = ctx.lines.excerpt(sym.path, sym.start_line, end);
    if (text === null) {
      out.push(sym.signature, '(source file is not readable)');
    } else {
      out.push(text);
      if (end < sym.end_line) {
        out.push(`... ${sym.end_line - end} more lines (${sym.path}:${end + 1}-${sym.end_line}); raise maxLines to see them`);
      }
    }
  }

  if (overloads.length) {
    out.push(`overloads / other declarations here (address one as ${sym.path}:<line>):`);
    for (const o of overloads.slice(0, 6)) out.push(`  ${range(o).padEnd(9)} ${o.signature}`);
    if (overloads.length > 6) out.push(`  ... ${overloads.length - 6} more`);
  }

  // Type relationships.
  if (isContainer || sym.kind === 'type') {
    const supers = directSupertypes(ctx.db, ctx.resolver, sym);
    if (supers.length) {
      out.push('inherits: ' + supers.map(h => `${h.kind} ${h.name}${h.sym ? ` (${h.sym.path}:${h.sym.start_line})` : ''}`).join(', '));
    }
    const satisfied = structuralInterfaces(ctx.db, sym, 12);
    if (satisfied.length) out.push('satisfies (by method set): ' + satisfied.map(s => s.qname).join(', '));
    subtypeLines(ctx, sym, 8, out);
  } else if (sym.kind === 'method') {
    // Same method on related types: the interface declaration, overrides, implementations.
    const family = [...ctx.resolver.familyOf(sym)]
      .filter(id => id !== sym.id)
      .map(id => ctx.db.symbolById(id))
      .filter((s): s is SymbolRow => !!s && !(s.file_id === sym.file_id && s.qname === sym.qname));
    if (family.length) {
      out.push(`same method on related types (${family.length}; calls through a supertype or interface count as callers):`);
      for (const f of family.slice(0, 6)) out.push(`  ${f.qname}  ${loc(f)}`);
      if (family.length > 6) out.push(`  ... ${family.length - 6} more (clast_hierarchy ${sym.qname})`);
    }
  }

  if (args.includeCalls === false) return out;

  const callable = CALLABLE_KINDS.has(sym.kind);
  if (callable || isContainer || MINOR_KINDS.has(sym.kind)) {
    // A summary: bounded work even for names with tens of thousands of call sites.
    const callerStats = { examined: 0, total: 0 };
    const callers = callersOf(ctx.db, ctx.resolver, sym, { quick: true }, callerStats);
    callerLines(callers, out);
    if (callerStats.total > callerStats.examined) {
      out.push(
        `  ("${sym.name}" has ${callerStats.total} call sites; this summary examined ${callerStats.examined}. ` +
          `clast_call_graph with within=<path> covers an area completely.)`
      );
    }
    const resolved = callers.filter(c => c.certain && !isTestPath(c.path)).length;
    if (callable && callers.length === 0) out.push('callers: none found');
    if ((callable || MINOR_KINDS.has(sym.kind)) && resolved < 3) {
      const refs = valueReferences(ctx, sym, callers, 6);
      if (refs.length) {
        out.push('referenced without a call (passed as a value, exported, used as a type):');
        out.push(...refs);
      } else if (!callable && callers.length === 0) {
        const n = ctx.db.refFileCount(sym.name);
        if (n > 1) out.push(`referenced in ${plural(n, 'file')} (clast_references ${sym.name})`);
      }
    }
  }

  if (callable) {
    const callees = calleesOf(ctx.db, ctx.resolver, sym);
    const internal = callees.filter(c => c.target);
    const external = callees.filter(c => !c.target);
    if (internal.length) {
      out.push(`calls (${internal.length}):`);
      for (const c of internal.slice(0, 20)) {
        out.push(`  ${c.target!.qname}  ${loc(c.target!)}${c.certain ? '' : '  ?'}`);
      }
      if (internal.length > 20) out.push(`  ... ${internal.length - 20} more (clast_call_graph direction=callees)`);
    }
    if (external.length) {
      const names = [...new Set(external.map(c => c.name))];
      out.push(`external calls: ${names.slice(0, 24).join(', ')}${names.length > 24 ? ', ...' : ''}`);
    }
  }

  return out;
}

function notFound(ctx: ToolContext, name: string, path?: string): string[] {
  const out: string[] = [];
  const bare = parseSymbolRef(name).name || name;
  const { hits } = searchSymbols(ctx.db, bare, { limit: 6, path });
  out.push(`"${name}": no symbol with this name in the index.`);
  if (hits.length) {
    out.push('closest matches:');
    for (const h of hits) out.push(`  ${symLine(h.sym)}`);
  }
  const uses = ctx.db.refFileCount(bare);
  out.push(
    uses > 0
      ? `"${bare}" is used in ${plural(uses, 'file')} but not defined here (external, generated or defined dynamically): ` +
          `clast_references ${bare} lists the usages, clast_grep finds dynamic definitions.`
      : `It may be defined dynamically (metaprogramming, string keys) or in a non-indexed file: try clast_grep "${bare}".`
  );
  return out;
}

export async function getContext(ctx: ToolContext, args: ContextArgs): Promise<string> {
  const note = await ctx.ready();
  const names = toList(args.name);
  if (names.length === 0) return 'error: name is required';
  const out: string[] = [];

  for (const name of names) {
    let matches = findSymbols(ctx.db, name, { path: args.path });
    if (matches.length) {
      // Line numbers and source must reflect the file as it is on disk now.
      await ctx.fresh(new Set(matches.slice(0, 3).map(m => m.path)));
      matches = findSymbols(ctx.db, name, { path: args.path });
    }
    if (matches.length === 0) {
      out.push(...notFound(ctx, name, args.path), '');
      continue;
    }

    const chosen = matches[0]!;
    const overloads = matches.filter(m => m.id !== chosen.id && m.file_id === chosen.file_id && m.qname === chosen.qname);
    const { others } = otherDefinitions(chosen, matches, ctx.resolver.familyOf(chosen));
    const ref = parseSymbolRef(name);
    const unqualified = ref.container.length === 0 && !ref.path && !args.path && ref.line === undefined;

    if (unqualified && others.length >= 4) {
      // Many unrelated definitions share this name: listing them is worth more than guessing one.
      out.push(`"${name}" has ${others.length + 1} definitions. Pick one with Container.name or path:name:`);
      for (const m of [chosen, ...others].slice(0, 14)) {
        out.push(`  ${symLine(m)}${m.signature ? '  ' + firstLine(m.signature, 70) : ''}`);
      }
      if (others.length + 1 > 14) out.push(`  ... ${others.length + 1 - 14} more (clast_search ${name} with kind/path filters)`);
      const size = chosen.end_line - chosen.start_line + 1;
      if (size <= 40) {
        out.push('most prominent definition:');
        out.push(...(await describe(ctx, chosen, { ...args, includeCalls: false }, overloads)));
      }
      out.push('');
      continue;
    }

    out.push(...(await describe(ctx, chosen, args, overloads)));
    if (others.length) {
      out.push(`other definitions named "${chosen.name}" (${others.length}; select with Container.name or path:name):`);
      for (const m of others.slice(0, 6)) out.push(`  ${symLine(m)}`);
      if (others.length > 6) out.push(`  ... ${others.length - 6} more`);
    }
    out.push('');
  }
  return note + out.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// clast_call_graph
// ---------------------------------------------------------------------------

export interface CallGraphArgs {
  name: string;
  path?: string;
  direction?: 'callers' | 'callees' | 'both';
  depth?: number;
  /** Max nodes per direction. Default 50. */
  limit?: number;
  includeTests?: boolean;
  /** Only callers / callees located under this path. */
  within?: string;
  /** List every unconfirmed caller (name-only matches, unknown receivers) instead of a summary. */
  uncertain?: boolean;
}

function renderGraph(node: GraphNode, indent: number, out: string[], direction: 'callers' | 'callees'): void {
  for (const child of node.children) {
    const pad = '  '.repeat(indent);
    const name = child.sym ? child.sym.qname : child.label ?? '<file level>';
    const where = direction === 'callers' ? `${child.path}:${child.line}` : child.sym ? loc(child.sym) : '';
    const tags =
      (child.sites > 1 ? ` (x${child.sites})` : '') +
      (child.weak ? '  ? (receiver type unknown)' : child.certain ? '' : '  ?') +
      (child.repeated ? '  (shown above)' : '') +
      (child.hub ? `  (${child.hub} ${direction}, not expanded: query it directly)` : '');
    out.push(`${pad}${name}  ${where}${tags}`);
    renderGraph(child, indent + 1, out, direction);
  }
  if (node.omitted) out.push(`${'  '.repeat(indent)}... ${node.omitted} more (raise limit, or narrow with within)`);
}

/**
 * When a bare name has several unrelated definitions, say so before answering
 * (and stop when there are too many to guess). Returns lines to print and
 * whether the caller should continue with the first match.
 */
function disambiguate(
  ctx: ToolContext,
  name: string,
  path: string | undefined,
  matches: SymbolRow[]
): { lines: string[]; stop: boolean } {
  const chosen = matches[0]!;
  const all = otherDefinitions(chosen, matches, ctx.resolver.familyOf(chosen)).others;
  // Verbatim copies of the same definition (vendored forks, generated duplicates) are not real alternatives.
  const span = chosen.end_line - chosen.start_line;
  const copies = all.filter(
    o => o.qname === chosen.qname && o.kind === chosen.kind && o.signature === chosen.signature && o.end_line - o.start_line === span
  );
  const others = all.filter(o => !copies.includes(o));
  if (others.length === 0) {
    return {
      lines: copies.length
        ? [`(identical cop${copies.length === 1 ? 'y' : 'ies'} elsewhere: ${copies.slice(0, 2).map(c => c.path + ':' + c.start_line).join(', ')}${copies.length > 2 ? ', ...' : ''})`]
        : [],
      stop: false,
    };
  }
  const ref = parseSymbolRef(name);
  const unqualified = ref.container.length === 0 && !ref.path && !path && ref.line === undefined;
  // One definition that the rest of the project overwhelmingly imports is "the" one
  // (lifecycle.ts:Disposable vs a few same-named helpers in extensions): do not make the caller choose.
  const importers = (s: SymbolRow): number =>
    ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT file_id) AS n FROM imports WHERE resolved_id = ?`, s.file_id)?.n ?? 0;
  const mine = unqualified && others.length >= 4 ? importers(chosen) : 0;
  const dominant = mine >= 20 && others.slice(0, 12).every(o => importers(o) * 10 <= mine);
  if (unqualified && others.length >= 4 && !dominant) {
    const lines = [`"${name}" has ${others.length + 1} definitions. Pick one with Container.name or path:name:`];
    for (const m of [chosen, ...others].slice(0, 14)) {
      lines.push(`  ${symLine(m)}${m.signature ? '  ' + firstLine(m.signature, 70) : ''}`);
    }
    if (others.length + 1 > 14) lines.push(`  ... ${others.length + 1 - 14} more (clast_search ${name} with kind/path filters)`);
    return { lines, stop: true };
  }
  const lines = [`note: "${chosen.name}" has ${others.length} other definition(s); using the first. Others (select with Container.name or path:name):`];
  for (const m of others.slice(0, 4)) lines.push(`  ${symLine(m)}`);
  return { lines, stop: false };
}

export async function callGraph(ctx: ToolContext, args: CallGraphArgs): Promise<string> {
  const note = await ctx.ready();
  if (!args.name || !args.name.trim()) return 'error: name is required';
  const matches = findSymbols(ctx.db, args.name, { path: args.path });
  const direction = args.direction ?? 'both';
  const depth = Math.max(1, Math.min(args.depth ?? 1, 6));
  const budget = Math.max(1, Math.min(args.limit ?? 50, 2000));
  const within = args.within;
  const pathFilter = within ? (p: string): boolean => pathMatches(p, within) : undefined;
  // Tests: listed in full only on request (or when the scope itself is a test / example tree);
  // by default they are summarised per file.
  const listTests = args.includeTests === true || (within !== undefined && isTestPath(within.replace(/\/?$/, '/')));
  const dropTests = args.includeTests === false;

  if (matches.length === 0) {
    // Not defined here (library function, dynamic method): still answer "who calls it".
    const bare = parseSymbolRef(args.name).name || args.name;
    const sites = groupCallers(externalCallSites(ctx.db, bare)).filter(
      g => (!dropTests || !isTestPath(g.path)) && (!pathFilter || pathFilter(g.path))
    );
    // "Foo.bar" where bar exists but not on Foo (an extension method, a typo in the qualifier): not external.
    const definedElsewhere = ctx.db.symbolsByName(bare).length > 0;
    if (sites.length === 0 || direction === 'callees' || definedElsewhere) {
      return note + notFound(ctx, args.name, args.path).join('\n');
    }
    const out = [
      `"${bare}" is not defined in this project (external or dynamic). Call sites by name (${plural(sites.length, 'caller')}):`,
    ];
    for (const g of sites.slice(0, budget)) {
      out.push(`  ${g.caller ? g.caller.qname : '<file level>'}  ${g.path}:${g.line}${g.sites > 1 ? ` (x${g.sites})` : ''}`);
    }
    if (sites.length > budget) out.push(`  ... ${sites.length - budget} more (raise limit or narrow with within)`);
    return note + out.join('\n');
  }

  const amb = disambiguate(ctx, args.name, args.path, matches);
  if (amb.stop) return note + amb.lines.join('\n');
  const sym = matches[0]!;
  const out: string[] = [symLine(sym)];
  if (sym.signature) out.push(`  ${firstLine(sym.signature, 160)}`);
  out.push(...amb.lines);
  const stats = { examined: 0, total: 0 };
  // A plain directory / file fragment can be pre-filtered by the database.
  const pathContains = within && !/[*?]/.test(within) ? within.replace(/\\/g, '/').replace(/^\.\//, '') : undefined;
  const opts = { depth, budget: 100000, includeTests: !dropTests, path: pathFilter, pathContains, stats };
  const accept = (p: string): boolean => (!dropTests || !isTestPath(p)) && (!pathFilter || pathFilter(p));

  if (direction !== 'callees') {
    const graph = buildGraph(ctx.db, ctx.resolver, sym, 'callers', opts);
    const all = graph.children;
    const tests = all.filter(c => isTestSite(c.path, c.sym?.qname));
    const prod = all.filter(c => !isTestSite(c.path, c.sym?.qname));
    const certain = prod.filter(c => c.certain);
    const possible = prod.filter(c => !c.certain && !c.weak);
    const unknown = prod.filter(c => c.weak);

    const parts: string[] = [];
    if (certain.length) parts.push(`${certain.length} resolved`);
    if (possible.length) parts.push(`${possible.length} name-only "?"`);
    if (unknown.length) parts.push(`${unknown.length} on receivers of unknown type`);
    if (tests.length) parts.push(`${tests.length} in tests/examples`);
    out.push(`callers (${parts.length ? parts.join(', ') : '0'}${depth > 1 ? `; depth ${depth}` : ''}; caller  call-site):`);

    let remaining = budget;
    const emit = (nodes: GraphNode[], cap: number, more: string): void => {
      const take = Math.min(nodes.length, cap, remaining);
      renderGraph({ ...graph, children: nodes.slice(0, take), omitted: 0 }, 1, out, 'callers');
      remaining -= take;
      if (nodes.length > take) out.push(`  ... ${nodes.length - take} more ${more}`);
    };
    if (all.length === 0) out.push('  none found');
    emit(certain, budget, '(raise limit, or narrow with within)');
    // Unconfirmed edges are summarised unless asked for, or unless they are all there is.
    const showAll = args.uncertain === true || certain.length === 0;
    if (possible.length) emit(possible, showAll ? budget : 5, 'name-only matches (uncertain=true lists them)');
    if (unknown.length) emit(unknown, showAll ? budget : 3, 'call sites on receivers of unknown type (uncertain=true lists them)');
    if (certain.length === 0) {
      // Nothing confirmed: the symbol may be used as a value (callback, property read, export) instead.
      const refs = valueReferences(ctx, sym, [], 6, accept);
      if (refs.length) {
        out.push('referenced without a call (passed as a value, read as a property, exported):');
        out.push(...refs);
      }
    }
    if (stats.total > stats.examined) {
      out.push(
        `  note: "${sym.name}" is called in ${stats.total} places; ${stats.examined} were examined (files that import the definition first). ` +
          `Narrow with within to cover a specific area completely.`
      );
    }
    if (tests.length) {
      if (listTests) {
        out.push('in tests/examples:');
        emit(tests, budget, '(raise limit)');
      } else {
        const files = [...new Set(tests.map(t => t.path))];
        out.push(
          `  tests/examples (${tests.length} callers in ${plural(files.length, 'file')}; includeTests=true lists them): ` +
            `${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}`
        );
      }
    }
  }
  if (direction !== 'callers') {
    const graph = buildGraph(ctx.db, ctx.resolver, sym, 'callees', { ...opts, budget });
    const total = graph.children.length + (graph.omitted ?? 0);
    out.push(`callees (${total}${depth > 1 ? `, depth ${depth}` : ''}; callee  definition):`);
    if (graph.children.length === 0) out.push('  none resolved inside this project');
    renderGraph(graph, 1, out, 'callees');
    const rest = calleesOf(ctx.db, ctx.resolver, sym).filter(c => !c.target);
    const unresolved = [...new Set(rest.filter(c => c.alternatives > 0).map(c => `${c.name} (${c.alternatives} defs)`))];
    const external = [...new Set(rest.filter(c => c.alternatives === 0).map(c => c.name))];
    if (unresolved.length) {
      out.push(`  unresolved (receiver type unknown; project defines these names): ${unresolved.slice(0, 16).join(', ')}${unresolved.length > 16 ? ', ...' : ''}`);
    }
    if (external.length) out.push(`  external: ${external.slice(0, 30).join(', ')}${external.length > 30 ? ', ...' : ''}`);
  }
  if (out.some(l => /  \?(  |$)/.test(l))) {
    out.push('("?" = matched by name only; the receiver type is unknown and another definition could be the real target)');
  }
  return note + out.join('\n');
}

// ---------------------------------------------------------------------------
// clast_hierarchy
// ---------------------------------------------------------------------------

export interface HierarchyArgs {
  name: string;
  path?: string;
  direction?: 'supertypes' | 'subtypes' | 'both';
  /** Levels of subtypes / supertypes to expand. Default 3. */
  depth?: number;
  /** Max lines per direction. Default 80. */
  limit?: number;
  /** Only subtypes / overrides located under this path. */
  within?: string;
}

export async function hierarchy(ctx: ToolContext, args: HierarchyArgs): Promise<string> {
  const note = await ctx.ready();
  if (!args.name || !args.name.trim()) return 'error: name is required';
  let matches = findSymbols(ctx.db, args.name, { path: args.path });
  if (matches.length === 0) return note + notFound(ctx, args.name, args.path).join('\n');
  // A bare type name means the type, not its constructors or same-named members.
  const types = matches.filter(m => CONTAINER_KINDS.has(m.kind) || m.kind === 'type');
  if (types.length && parseSymbolRef(args.name).container.length === 0) matches = types;
  // A C# static class has no place in a hierarchy: prefer a same-named class that can.
  const isStatic = (s: SymbolRow): boolean => s.lang === 'csharp' && /\bstatic\s+(partial\s+)?class\b/.test(s.signature);
  if (matches.length > 1 && isStatic(matches[0]!)) {
    const other = matches.findIndex(m => !isStatic(m));
    if (other > 0) matches = [matches[other]!, ...matches.filter((_, i) => i !== other)];
  }
  const amb = disambiguate(ctx, args.name, args.path, matches);
  if (amb.stop) return note + amb.lines.join('\n');
  const sym = matches[0]!;
  const direction = args.direction ?? 'both';
  const depth = Math.max(1, Math.min(args.depth ?? 3, 8));
  const limit = Math.max(1, Math.min(args.limit ?? 80, 1000));
  const out: string[] = [symLine(sym)];
  if (sym.signature) out.push(`  ${firstLine(sym.signature, 160)}`);
  out.push(...amb.lines);

  // A method: show the same method across the type hierarchy.
  if (!CONTAINER_KINDS.has(sym.kind) && sym.kind !== 'type') {
    const family = [...ctx.resolver.familyOf(sym)]
      .filter(id => id !== sym.id)
      .map(id => ctx.db.symbolById(id))
      .filter((s): s is SymbolRow => !!s);
    const total = family.length;
    if (args.within) family.splice(0, family.length, ...family.filter(f => pathMatches(f.path, args.within!)));
    if (family.length === 0) {
      out.push(
        total
          ? `no overrides under "${args.within}" (${total} elsewhere).`
          : 'no overrides, implementations or declarations of this member on related types.'
      );
    } else {
      out.push(
        `declarations / overrides / implementations on related types (${family.length}${args.within ? ` under ${args.within}, ${total} in total` : ''}):`
      );
      family.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path));
      for (const f of family.slice(0, limit)) out.push(`  ${f.kind} ${f.qname}  ${loc(f)}`);
      if (family.length > limit) out.push(`  ... ${family.length - limit} more (raise limit)`);
    }
    return note + out.join('\n');
  }

  if (direction !== 'subtypes') {
    out.push('supertypes:');
    let lines = 0;
    const seen = new Set<number>([sym.id]);
    const walkUp = (s: SymbolRow, indent: number): void => {
      if (indent > depth || lines >= limit) return;
      for (const sup of directSupertypes(ctx.db, ctx.resolver, s)) {
        if (lines >= limit) return;
        lines++;
        out.push(`${'  '.repeat(indent)}${sup.kind} ${sup.sym ? sup.sym.qname + '  ' + loc(sup.sym) : sup.name + '  (not in this project)'}`);
        if (sup.sym && !seen.has(sup.sym.id)) {
          seen.add(sup.sym.id);
          walkUp(sup.sym, indent + 1);
        }
      }
    };
    walkUp(sym, 1);
    if (lines === 0) out.push('  none declared');
    const satisfied = structuralInterfaces(ctx.db, sym, 60);
    if (satisfied.length) {
      out.push(`satisfies by method set (${satisfied.length}):`);
      for (const s of satisfied.slice(0, limit)) out.push(`  ${s.qname}  ${loc(s)}`);
    }
  }

  if (direction !== 'supertypes') {
    let lines = 0;
    let total = 0;
    const seen = new Set<number>([sym.id]);
    const body: string[] = [];
    const walkDown = (s: SymbolRow, indent: number): void => {
      if (indent > depth) return;
      const subs = directSubtypes(ctx.db, ctx.resolver, s);
      for (const sub of subs) {
        const shown = !args.within || pathMatches(sub.sym.path, args.within);
        if (shown) total++;
        if (shown && lines < limit) {
          lines++;
          body.push(`${'  '.repeat(indent)}${sub.sym.kind} ${sub.sym.qname}  ${sub.sym.path}:${sub.sym.start_line}${sub.certain ? '' : '  ?'}`);
        }
        if (!seen.has(sub.sym.id) && total < 5000) {
          seen.add(sub.sym.id);
          walkDown(sub.sym, indent + 1);
        }
      }
    };
    walkDown(sym, 1);
    out.push(`subtypes (${total}${depth > 1 ? ', transitive' : ''}):`);
    out.push(...(body.length ? body : ['  none found']));
    if (total > lines) out.push(`  ... ${total - lines} more (raise limit)`);
    const structural = structuralImplementers(ctx.db, sym, 500);
    if (structural.length) {
      out.push(`implemented by, matched by method set (${structural.length}):`);
      for (const s of structural.slice(0, limit)) out.push(`  ${s.kind} ${s.qname}  ${s.path}:${s.start_line}`);
      if (structural.length > limit) out.push(`  ... ${structural.length - limit} more (raise limit)`);
    }
  }
  return note + out.join('\n');
}

import { CALLABLE_KINDS, CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { buildGraph, calleesOf, callersOf, type GraphNode } from '../query/callgraph.js';
import { firstLine, isTestPath, loc, plural, symLine } from '../query/format.js';
import { findSymbols, otherDefinitions, parseSymbolRef } from '../query/resolve.js';
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
  const out: string[] = [];

  for (const q of queries) {
    const { hits, truncated } = searchSymbols(ctx.db, q, args);
    if (hits.length === 0) {
      out.push(
        `"${q}": no symbols found. Try fewer or different words, or clast_grep for raw text.`
      );
      continue;
    }
    out.push(`"${q}": ${plural(hits.length, 'match')}${truncated ? ' (more exist; raise limit or add kind/path filters)' : ''}`);
    for (const h of hits) {
      const s = h.sym;
      const tags: string[] = [];
      if (h.refs > 1) tags.push(`refs:${h.refs}`);
      if (h.match !== 'exact') tags.push(h.match);
      out.push(`${symLine(s)}${tags.length ? '  [' + tags.join(' ') + ']' : ''}`);
      if (s.signature && s.signature !== s.name) out.push(`  ${s.signature}`);
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

function memberOutline(ctx: ToolContext, sym: SymbolRow, max: number): string[] {
  const members = ctx.db
    .symbolsInFile(sym.file_id)
    .filter(m => m.parent_id === sym.id);
  const out: string[] = [];
  const shown = members.slice(0, max);
  for (const m of shown) {
    const range = m.start_line === m.end_line ? `${m.start_line}` : `${m.start_line}-${m.end_line}`;
    out.push(`  ${range.padEnd(9)} ${m.signature || m.kind + ' ' + m.name}${m.doc ? '  // ' + firstLine(m.doc, 80) : ''}`);
  }
  if (members.length > shown.length) out.push(`  ... ${members.length - shown.length} more members`);
  return out;
}

async function describe(ctx: ToolContext, sym: SymbolRow, args: ContextArgs): Promise<string[]> {
  const out: string[] = [];
  const maxLines = Math.max(5, Math.min(args.maxLines ?? 120, 2000));
  out.push(`${symLine(sym)}${sym.exported ? '  [exported]' : ''}`);

  const isContainer = CONTAINER_KINDS.has(sym.kind);
  const start = sym.doc_line > 0 && sym.doc_line < sym.start_line ? sym.doc_line : sym.start_line;
  const length = sym.end_line - start + 1;

  if (args.includeBody === false) {
    if (sym.signature) out.push(sym.signature);
    if (sym.doc) out.push(sym.doc.split('\n').map(l => '// ' + l).join('\n'));
  } else if (isContainer && length > maxLines) {
    // Large container: signature + doc + member outline instead of a wall of code.
    if (sym.signature) out.push(sym.signature);
    if (sym.doc) out.push(sym.doc.split('\n').map(l => '// ' + l).join('\n'));
    out.push(`members (${length} lines total; request a member by name for its source):`);
    out.push(...memberOutline(ctx, sym, 80));
  } else {
    const end = Math.min(sym.end_line, start + maxLines - 1);
    const text = ctx.lines.excerpt(sym.path, start, end);
    if (text === null) {
      out.push(sym.signature, '(source file is not readable)');
    } else {
      out.push(text);
      if (end < sym.end_line) {
        out.push(`... ${sym.end_line - end} more lines (${sym.path}:${end + 1}-${sym.end_line}); raise maxLines to see them`);
      }
    }
  }

  // Heritage
  if (isContainer) {
    const supers = ctx.db.all<{ name: string; kind: string }>(
      `SELECT name, kind FROM heritage WHERE symbol_id = ?`, sym.id
    );
    if (supers.length) {
      out.push('inherits: ' + supers.map(h => `${h.kind} ${h.name}`).join(', '));
    }
    const subs = ctx.db.all<{ qname: string; path: string; start_line: number; kind: string }>(
      `SELECT s.qname, f.path, s.start_line, h.kind FROM heritage h
       JOIN symbols s ON s.id = h.symbol_id JOIN files f ON f.id = s.file_id
       WHERE h.name = ? LIMIT 40`,
      sym.name
    );
    if (subs.length) {
      out.push(`subtypes (${subs.length}${subs.length === 40 ? '+' : ''}):`);
      for (const s of subs.slice(0, 12)) out.push(`  ${s.qname}  ${s.path}:${s.start_line}`);
      if (subs.length > 12) out.push(`  ... ${subs.length - 12} more`);
    }
  }

  if (args.includeCalls === false) return out;

  if (CALLABLE_KINDS.has(sym.kind) || isContainer) {
    const callers = callersOf(ctx.db, ctx.resolver, sym);
    if (callers.length) {
      const prod = callers.filter(c => !isTestPath(c.path));
      const tests = callers.length - prod.length;
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const c of prod.length ? prod : callers) {
        const key = c.caller ? c.caller.qname + c.path : c.path;
        if (seen.has(key)) continue;
        seen.add(key);
        if (lines.length >= 10) continue;
        lines.push(`  ${c.caller ? c.caller.qname : '<file level>'}  ${c.path}:${c.line}${c.certain ? '' : '  ?'}`);
      }
      out.push(`callers (${seen.size}${tests && prod.length ? ` + ${tests} in tests` : ''}):`);
      out.push(...lines);
      if (seen.size > lines.length) out.push(`  ... ${seen.size - lines.length} more (clast_call_graph for all)`);
    } else if (CALLABLE_KINDS.has(sym.kind)) {
      const refs = ctx.db.refFileCount(sym.name);
      out.push(`callers: none found${refs > 1 ? ` (name appears in ${refs} files; see clast_references)` : ''}`);
    }
  }

  if (CALLABLE_KINDS.has(sym.kind)) {
    const callees = calleesOf(ctx.db, ctx.resolver, sym);
    const internal = callees.filter(c => c.target);
    const external = callees.filter(c => !c.target);
    if (internal.length) {
      out.push(`calls (${internal.length}):`);
      for (const c of internal.slice(0, 14)) {
        out.push(`  ${c.target!.qname}  ${loc(c.target!)}${c.certain ? '' : '  ?'}`);
      }
      if (internal.length > 14) out.push(`  ... ${internal.length - 14} more`);
    }
    if (external.length) {
      const names = [...new Set(external.map(c => c.name))];
      out.push(`external calls: ${names.slice(0, 24).join(', ')}${names.length > 24 ? ', ...' : ''}`);
    }
  } else if (!isContainer) {
    const refs = ctx.db.refFileCount(sym.name);
    if (refs) out.push(`referenced in ${plural(refs, 'file')} (clast_references for locations)`);
  }

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
      const { hits } = searchSymbols(ctx.db, parseSymbolRef(name).name || name, { limit: 6, path: args.path });
      out.push(`"${name}": no symbol with this exact name.`);
      if (hits.length) {
        out.push('closest matches:');
        for (const h of hits) out.push(`  ${symLine(h.sym)}`);
      }
      out.push('');
      continue;
    }

    out.push(...(await describe(ctx, matches[0]!, args)));

    const { others, overloads } = otherDefinitions(matches[0]!, matches);
    if (overloads) out.push(`(+${overloads} overload/declaration(s) of the same name in this file)`);
    if (others.length) {
      out.push(`other definitions named "${matches[0]!.name}" (${others.length}; pass path or Container.name to select):`);
      for (const m of others.slice(0, 8)) out.push(`  ${symLine(m)}`);
      if (others.length > 8) out.push(`  ... ${others.length - 8} more`);
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
  /** Max nodes per direction. Default 60. */
  limit?: number;
  includeTests?: boolean;
}

function renderGraph(node: GraphNode, indent: number, out: string[], direction: 'callers' | 'callees'): void {
  for (const child of node.children) {
    const pad = '  '.repeat(indent);
    const name = child.sym ? child.sym.qname : child.label ?? '<file level>';
    const where =
      direction === 'callers'
        ? `${child.path}:${child.line}`
        : child.sym ? loc(child.sym) : '';
    out.push(`${pad}${name}  ${where}${child.certain ? '' : '  ?'}${child.repeated ? '  (shown above)' : ''}`);
    renderGraph(child, indent + 1, out, direction);
  }
  if (node.omitted) out.push(`${'  '.repeat(indent)}... ${node.omitted} more`);
}

export async function callGraph(ctx: ToolContext, args: CallGraphArgs): Promise<string> {
  const note = await ctx.ready();
  const matches = findSymbols(ctx.db, args.name, { path: args.path });
  if (matches.length === 0) {
    const { hits } = searchSymbols(ctx.db, parseSymbolRef(args.name).name || args.name, { limit: 5 });
    return (
      note +
      `"${args.name}": no symbol with this exact name.` +
      (hits.length ? '\nclosest matches:\n' + hits.map(h => '  ' + symLine(h.sym)).join('\n') : '')
    );
  }
  const sym = matches[0]!;
  const direction = args.direction ?? 'both';
  const depth = Math.max(1, Math.min(args.depth ?? 2, 6));
  const budget = Math.max(5, Math.min(args.limit ?? 60, 400));
  const includeTests = args.includeTests ?? true;
  const out: string[] = [symLine(sym)];
  if (sym.signature) out.push(`  ${sym.signature}`);

  if (direction !== 'callees') {
    const graph = buildGraph(ctx.db, ctx.resolver, sym, 'callers', depth, budget, includeTests);
    out.push(`callers (depth ${depth}; each line: caller  call-site):`);
    if (graph.children.length === 0) out.push('  none found');
    renderGraph(graph, 1, out, 'callers');
  }
  if (direction !== 'callers') {
    const graph = buildGraph(ctx.db, ctx.resolver, sym, 'callees', depth, budget, includeTests);
    out.push(`callees (depth ${depth}; each line: callee  definition):`);
    if (graph.children.length === 0) out.push('  none resolved inside this project');
    renderGraph(graph, 1, out, 'callees');
    if (depth === 1 || graph.children.length === 0) {
      const external = calleesOf(ctx.db, ctx.resolver, sym).filter(c => !c.target);
      const names = [...new Set(external.map(c => c.name))];
      if (names.length) out.push(`  external: ${names.slice(0, 30).join(', ')}${names.length > 30 ? ', ...' : ''}`);
    }
  }
  if (out.some(l => l.endsWith('  ?') || l.includes('  ?  '))) {
    out.push('("?" = matched by name only; another definition with the same name could be the real target)');
  }
  const { others } = otherDefinitions(sym, matches);
  if (others.length) {
    out.push(`note: ${others.length} other definition(s) named "${sym.name}" exist; pass path or Container.name to pick one:`);
    for (const m of others.slice(0, 4)) out.push(`  ${symLine(m)}`);
  }
  return note + out.join('\n');
}

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import { callersOf } from '../query/callgraph.js';
import { firstLine, isTestPath, isVendoredPath, loc, plural, symLine } from '../query/format.js';
import { findFiles, findSymbols, parseSymbolRef, pathMatches, type FileHit } from '../query/resolve.js';
import { splitIdentifier } from '../query/words.js';
import { ToolContext } from './context.js';

// ---------------------------------------------------------------------------
// clast_references
// ---------------------------------------------------------------------------

export interface ReferencesArgs {
  name: string;
  /** Restrict to files under / matching this path. */
  path?: string;
  /** Max reference lines to print. Default 40. */
  limit?: number;
  includeTests?: boolean;
}

export async function references(ctx: ToolContext, args: ReferencesArgs): Promise<string> {
  const note = await ctx.ready();
  const ref = parseSymbolRef(args.name);
  const name = ref.name;
  const limit = Math.max(1, Math.min(args.limit ?? 40, 500));
  const defs = findSymbols(ctx.db, { ...ref, path: undefined });
  const nameId = ctx.db.nameId(name, false);
  if (nameId === undefined) {
    return note + `"${name}": no occurrences in indexed code (identifiers in strings and comments are not indexed; use clast_grep for those).`;
  }

  let rows = ctx.db.all<{ file_id: number; path: string; lines: string }>(
    `SELECT o.file_id, f.path, o.lines FROM occ o JOIN files f ON f.id = o.file_id WHERE o.name_id = ?`,
    nameId
  );
  const pathFilter = args.path ?? ref.path;
  if (pathFilter) rows = rows.filter(r => pathMatches(r.path, pathFilter));
  if (args.includeTests === false) rows = rows.filter(r => !isTestPath(r.path));

  const defFiles = new Set(defs.map(d => d.path));
  rows.sort(
    (a, b) =>
      Number(defFiles.has(b.path)) - Number(defFiles.has(a.path)) ||
      Number(isTestPath(a.path)) - Number(isTestPath(b.path)) ||
      Number(isVendoredPath(a.path)) - Number(isVendoredPath(b.path)) ||
      a.path.localeCompare(b.path)
  );

  const totalFiles = rows.length;
  let totalLines = 0;
  for (const r of rows) totalLines += r.lines.split(',').length;

  const out: string[] = [];
  out.push(`"${name}": ${plural(totalLines, 'reference line')} in ${plural(totalFiles, 'file')}`);
  if (defs.length) {
    out.push(`defined: ${defs.slice(0, 2).map(d => `${d.kind} ${d.qname} ${loc(d)}`).join('; ')}${defs.length > 2 ? `; +${defs.length - 2} more definitions of this name` : ''}`);
    if (defs.length > 1) out.push('(references are matched by name, so they cover every definition of it)');
  }

  if (ref.container.length) {
    out.push(`(matched by the identifier "${name}" alone; the qualifier "${ref.container.join('.')}" is not used to filter usages)`);
  }

  // Definition lines of the name are context, not usages: they never eat the
  // limit, and when many definitions share the name they are left out.
  const allDefLines = new Set(ctx.db.symbolsByName(name).map(d => d.path + ':' + d.start_line));
  const showDefs = allDefLines.size <= 3;
  const perFile = totalFiles <= 3 ? limit : Math.max(4, Math.ceil(limit / 5));
  let printed = 0;
  let filesShown = 0;
  let filesWithMore = 0;
  for (const r of rows) {
    if (printed >= limit) break;
    await ctx.fresh([r.path]);
    // Re-read the occurrence lines in case the file was just re-indexed.
    const cur = ctx.db.get<{ lines: string }>(`SELECT lines FROM occ WHERE name_id = ? AND file_id = ?`, nameId, r.file_id);
    if (!cur) continue;
    const lineNums = cur.lines.split(',').map(Number);
    const body: string[] = [];
    let inFile = 0;
    let skipped = 0;
    for (const n of lineNums) {
      const isDef = allDefLines.has(r.path + ':' + n);
      if (isDef) {
        if (showDefs) body.push(`  ${String(n).padStart(5)}  [def] ${ctx.lines.line(r.path, n, 150)}`);
        continue;
      }
      if (printed >= limit || inFile >= perFile) {
        skipped++;
        continue;
      }
      const enclosing = ctx.db.enclosingSymbol(r.file_id, n);
      body.push(`  ${String(n).padStart(5)}  ${enclosing ? '[' + enclosing.qname + '] ' : ''}${ctx.lines.line(r.path, n, 150)}`);
      printed++;
      inFile++;
    }
    if (body.length === 0) continue;
    out.push(r.path);
    out.push(...body);
    filesShown++;
    if (skipped) {
      out.push(`  ... ${skipped} more in this file`);
      filesWithMore++;
    }
  }
  const rest = rows.length - filesShown;
  if (rest > 0 && printed >= limit) {
    const remaining = rows.slice(filesShown).filter(r => !out.includes(r.path));
    out.push(`... ${plural(remaining.length, 'more file')}: ${remaining.slice(0, 12).map(r => r.path).join(', ')}${remaining.length > 12 ? ', ...' : ''}`);
  }
  if ((rest > 0 && printed >= limit) || filesWithMore) out.push('(narrow with path, or raise limit)');
  return note + out.join('\n');
}

// ---------------------------------------------------------------------------
// clast_file_summary
// ---------------------------------------------------------------------------

export interface FileSummaryArgs {
  /** File or directory path (partial paths are resolved). */
  path: string;
  /** Include fields / properties / constants inside containers. Default: auto. */
  members?: 'all' | 'callable' | 'auto';
  /** Max outline lines for a file. Default 300. */
  limit?: number;
}

const MINOR_KINDS = new Set(['property', 'field', 'constant', 'variable']);

function range(s: { start_line: number; end_line: number }): string {
  return s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
}

function outlineFile(ctx: ToolContext, file: FileHit, members: 'all' | 'callable' | 'auto', maxLines = 300): string[] {
  const out: string[] = [];
  const symbols = ctx.db.symbolsInFile(file.id);
  out.push(`${file.path}  (${file.lang}, ${plural(file.line_count, 'line')}, ${plural(symbols.length, 'symbol')})`);

  const imports = ctx.db.all<{ source: string; resolved: string | null }>(
    `SELECT i.source, f.path AS resolved FROM imports i LEFT JOIN files f ON f.id = i.resolved_id
     WHERE i.file_id = ? ORDER BY i.line`,
    file.id
  );
  if (imports.length) {
    const internal = [...new Set(imports.filter(i => i.resolved).map(i => i.resolved!))];
    const external = [...new Set(imports.filter(i => !i.resolved).map(i => i.source))];
    if (internal.length) out.push(`imports (project): ${internal.slice(0, 20).join(', ')}${internal.length > 20 ? `, +${internal.length - 20}` : ''}`);
    if (external.length) out.push(`imports (external): ${external.slice(0, 20).join(', ')}${external.length > 20 ? `, +${external.length - 20}` : ''}`);
  }
  const importedBy = ctx.db.all<{ path: string }>(
    `SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolved_id = ? ORDER BY f.path LIMIT 200`,
    file.id
  );
  if (importedBy.length) {
    out.push(`imported by (${importedBy.length}${importedBy.length === 200 ? '+' : ''}): ${importedBy.slice(0, 5).map(r => r.path).join(', ')}${importedBy.length > 5 ? ', ...' : ''}`);
  }

  const hideMinor = members === 'callable' || (members === 'auto' && symbols.length > 150);
  const depthOf = new Map<number, number>();
  const hidden = new Map<number | null, number>();
  const width = String(file.line_count).length * 2 + 1;
  let lastLine = '';
  let printed = 0;
  let omitted = 0;
  for (const s of symbols) {
    const depth = s.parent_id !== null && depthOf.has(s.parent_id) ? depthOf.get(s.parent_id)! + 1 : 0;
    depthOf.set(s.id, depth);
    if (hideMinor && depth > 0 && MINOR_KINDS.has(s.kind)) {
      hidden.set(s.parent_id, (hidden.get(s.parent_id) ?? 0) + 1);
      continue;
    }
    const label = s.signature || `${s.kind} ${s.name}`;
    // Members defined outside their type's body (Go receivers, Rust impl blocks, C++ Foo::bar):
    // say which type they belong to when the signature does not.
    const dot = s.qname.lastIndexOf('.');
    const owner = depth === 0 && dot > 0 ? s.qname.slice(0, dot) : '';
    const ownerLast = owner.slice(owner.lastIndexOf('.') + 1);
    const ownerTag = owner && !label.includes(ownerLast) ? `[${owner}] ` : '';
    const line =
      `${range(s).padEnd(width)} ${'  '.repeat(depth)}${ownerTag}${label}` +
      `${s.doc ? '  // ' + firstLine(s.doc, 70) : ''}`;
    if (line === lastLine) continue; // multi-declarator lines
    lastLine = line;
    if (printed >= maxLines) {
      omitted++;
      continue;
    }
    printed++;
    out.push(line);
  }
  if (omitted) {
    out.push(
      `... ${omitted} more symbols not shown (limit ${maxLines}). Narrow with clast_search path="${file.path}", ` +
        `or fetch a region with clast_get_context "${file.path}:<line>".`
    );
  }
  if (hidden.size) {
    let n = 0;
    for (const v of hidden.values()) n += v;
    out.push(`(${n} fields/properties/constants hidden; pass members: "all" to list them)`);
  }
  return out;
}

function outlineDirectory(ctx: ToolContext, dir: string, files: FileHit[]): string[] {
  const out: string[] = [];
  const prefix = dir.endsWith('/') ? dir : dir + '/';
  let totalLines = 0;
  for (const f of files) totalLines += f.line_count;
  out.push(`${prefix}  (${plural(files.length, 'indexed file')}, ${totalLines} lines)`);

  // Direct files get their top-level symbols; subdirectories are summarised.
  const subdirs = new Map<string, { files: number; lines: number }>();
  const direct: FileHit[] = [];
  for (const f of files) {
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) direct.push(f);
    else {
      const name = rest.slice(0, slash);
      const agg = subdirs.get(name) ?? { files: 0, lines: 0 };
      agg.files++;
      agg.lines += f.line_count;
      subdirs.set(name, agg);
    }
  }
  if (subdirs.size) {
    out.push('subdirectories:');
    for (const [name, agg] of [...subdirs.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 40)) {
      out.push(`  ${name}/  ${plural(agg.files, 'file')}, ${agg.lines} lines`);
    }
    if (subdirs.size > 40) out.push(`  ... ${subdirs.size - 40} more`);
  }
  const shown = direct.slice(0, 60);
  if (shown.length) out.push('files:');
  for (const f of shown) {
    const top = ctx.db.all<{ name: string; kind: string }>(
      `SELECT name, kind FROM symbols WHERE file_id = ? AND parent_id IS NULL
       AND kind NOT IN ('variable', 'constant', 'property', 'field')
       ORDER BY (kind IN ('class','interface','struct','trait','enum')) DESC, exported DESC, start_line LIMIT 9`,
      f.id
    );
    const names = top.slice(0, 8).map(t => t.name).join(', ');
    out.push(`  ${f.path.slice(prefix.length)}  (${f.line_count} lines)${names ? ': ' + names + (top.length > 8 ? ', ...' : '') : ''}`);
  }
  if (direct.length > shown.length) out.push(`  ... ${direct.length - shown.length} more files`);
  return out;
}

export async function fileSummary(ctx: ToolContext, args: FileSummaryArgs): Promise<string> {
  const note = await ctx.ready();
  const q = args.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const cols = 'id, path, lang, line_count, symbol_count';

  // Directory?
  if (q === '' || q === '.') {
    const all = ctx.db.all<FileHit>(`SELECT ${cols} FROM files ORDER BY path`);
    return note + outlineDirectory(ctx, '', all).join('\n').replace(/^\/  /, './  ');
  }
  const dirFiles = ctx.db.all<FileHit>(
    `SELECT ${cols} FROM files WHERE path >= ? AND path < ? ORDER BY path`,
    q + '/', q + '/\uffff'
  );
  if (dirFiles.length) return note + outlineDirectory(ctx, q, dirFiles).join('\n');

  const files = findFiles(ctx.db, q, 12);
  if (files.length === 0) {
    return note + `"${args.path}": no indexed file or directory matches. Use clast_overview to see the project layout.`;
  }
  if (files.length > 1) {
    return (
      note +
      `"${args.path}" matches ${files.length}${files.length === 12 ? '+' : ''} files; be more specific:\n` +
      files.map(f => `  ${f.path}`).join('\n')
    );
  }
  await ctx.fresh([files[0]!.path]);
  const file = findFiles(ctx.db, files[0]!.path, 1)[0];
  if (!file) return note + `"${args.path}": file is no longer indexable.`;
  return note + outlineFile(ctx, file, args.members ?? 'auto', Math.max(20, Math.min(args.limit ?? 300, 5000))).join('\n');
}

// ---------------------------------------------------------------------------
// clast_overview
// ---------------------------------------------------------------------------

export interface OverviewArgs {
  /** Limit the overview to a subdirectory. */
  path?: string;
}

const overviewCache = new WeakMap<object, Map<string, { gen: number; text: string }>>();

export async function overview(ctx: ToolContext, args: OverviewArgs = {}): Promise<string> {
  const note = await ctx.ready();
  const scope = (args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  let cache = overviewCache.get(ctx.db);
  if (!cache) overviewCache.set(ctx.db, (cache = new Map()));
  const cached = cache.get(scope);
  if (cached && cached.gen === ctx.db.generation) return note + cached.text;

  const prefix = scope ? scope + '/' : '';
  const files = ctx.db.all<{ id: number; path: string; lang: string; line_count: number; symbol_count: number }>(
    scope
      ? `SELECT id, path, lang, line_count, symbol_count FROM files WHERE path >= ? AND path < ? ORDER BY path`
      : `SELECT id, path, lang, line_count, symbol_count FROM files ORDER BY path`,
    ...(scope ? [prefix, prefix + '\uffff'] : [])
  );
  if (files.length === 0) return note + (scope ? `no indexed files under "${scope}"` : 'the index is empty (no supported source files found)');

  const out: string[] = [];
  const langs = new Map<string, { files: number; lines: number }>();
  let lines = 0;
  let symbols = 0;
  for (const f of files) {
    const agg = langs.get(f.lang) ?? { files: 0, lines: 0 };
    agg.files++;
    agg.lines += f.line_count;
    langs.set(f.lang, agg);
    lines += f.line_count;
    symbols += f.symbol_count;
  }
  out.push(`${scope || basename(ctx.clast.root)}: ${plural(files.length, 'file')}, ${lines} lines, ${symbols} symbols`);
  out.push(
    'languages: ' +
      [...langs.entries()]
        .sort((a, b) => b[1].lines - a[1].lines)
        .slice(0, 6)
        .map(([l, a]) => `${l} ${a.files} files/${a.lines} lines`)
        .join(', ') +
      (langs.size > 6 ? `, +${langs.size - 6} more` : '')
  );

  // Directory tree: two levels below the scope, single-child chains collapsed.
  interface Dir { files: number; lines: number; children: Map<string, Dir> }
  const root: Dir = { files: 0, lines: 0, children: new Map() };
  for (const f of files) {
    const parts = f.path.slice(prefix.length).split('/');
    parts.pop();
    let node = root;
    node.files++;
    node.lines += f.line_count;
    for (const p of parts) {
      let child = node.children.get(p);
      if (!child) node.children.set(p, (child = { files: 0, lines: 0, children: new Map() }));
      child.files++;
      child.lines += f.line_count;
      node = child;
    }
  }
  out.push('layout (files, lines):');
  // Collapse a/b/c chains where each level has a single subdirectory and no files of its own.
  interface View { label: string; dir: Dir; depth: number; expanded: boolean; test: boolean }
  const collapse = (name: string, dir: Dir): { label: string; dir: Dir } => {
    let label = name;
    let cur = dir;
    while (cur.children.size === 1) {
      const [childName, child] = [...cur.children.entries()][0]!;
      if (child.files !== cur.files) break;
      label += '/' + childName;
      cur = child;
    }
    return { label, dir: cur };
  };
  const viewOf = (name: string, dir: Dir, depth: number): View => {
    const c = collapse(name, dir);
    return { label: c.label, dir: c.dir, depth, expanded: false, test: isTestPath(c.label + '/') };
  };
  // Greedy expansion: keep opening the biggest non-test directory until the
  // map reaches its line budget, so big repos get depth where the code is.
  const LAYOUT_BUDGET = 44;
  const CHILD_CAP = 8;
  const tree = new Map<View, View[]>();
  const rootViews = [...root.children.entries()]
    .map(([n, d]) => viewOf(n, d, 1))
    .sort((a, b) => Number(a.test) - Number(b.test) || b.dir.lines - a.dir.lines)
    .slice(0, 14);
  let lineCount = rootViews.length;
  const open: View[] = [...rootViews];
  while (lineCount < LAYOUT_BUDGET) {
    let best: View | null = null;
    for (const v of open) {
      if (v.expanded || v.test || v.depth >= 4 || v.dir.children.size < 2) continue;
      if (!best || v.dir.lines > best.dir.lines) best = v;
    }
    if (!best) break;
    best.expanded = true;
    const kids = [...best.dir.children.entries()]
      .map(([n, d]) => viewOf(n, d, best!.depth + 1))
      .sort((a, b) => Number(a.test) - Number(b.test) || b.dir.lines - a.dir.lines);
    tree.set(best, kids);
    const shown = Math.min(kids.length, CHILD_CAP);
    lineCount += shown + (kids.length > shown ? 1 : 0);
    open.push(...kids.slice(0, shown));
  }
  const renderView = (v: View): void => {
    out.push(`${'  '.repeat(v.depth)}${v.label}/  ${v.dir.files}, ${v.dir.lines}`);
    const kids = tree.get(v);
    if (!kids) return;
    for (const k of kids.slice(0, CHILD_CAP)) renderView(k);
    if (kids.length > CHILD_CAP) {
      let restFiles = 0;
      for (const k of kids.slice(CHILD_CAP)) restFiles += k.dir.files;
      out.push(`${'  '.repeat(v.depth + 1)}... ${kids.length - CHILD_CAP} more dirs (${restFiles} files)`);
    }
  };
  const rootFiles = files.filter(f => !f.path.slice(prefix.length).includes('/')).length;
  if (rootFiles) out.push(`  (${plural(rootFiles, 'file')} directly in ${scope || 'the root'})`);
  for (const v of rootViews) renderView(v);
  if (root.children.size > rootViews.length) out.push(`  ... ${root.children.size - rootViews.length} more top-level dirs`);

  // Key symbols: types and functions whose names are mentioned in the most files.
  const popular = ctx.db.all<{ name: string; refs: number }>(
    `SELECT n.name, t.refs
     FROM (SELECT o.name_id, COUNT(*) AS refs FROM occ o GROUP BY o.name_id ORDER BY refs DESC LIMIT 2500) t
     JOIN names n ON n.id = t.name_id
     WHERE length(n.name) > 3
     ORDER BY t.refs DESC`
  );
  const KEY_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'function', 'type']);
  const resolvedImports =
    ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM imports WHERE resolved_id IS NOT NULL`)?.n ?? 0;
  const hasImportGraph = resolvedImports > files.length / 2;
  const keyLines: string[] = [];
  for (const p of popular) {
    // Inside a sub-tree only a handful of landmarks are worth the space.
    if (keyLines.length >= (scope ? 10 : 25)) break;
    if (scope && p.refs < 5) break;
    const defs = findSymbols(ctx.db, { name: p.name, container: [] }, { exact: true }).filter(
      s => KEY_KINDS.has(s.kind) && s.parent_id === null
    );
    // Names defined all over the place ("constructor", "main", "test") are not landmarks.
    if (defs.length === 0 || defs.length > 8) continue;
    const c = defs[0]!;
    if (scope && !c.path.startsWith(prefix)) continue;
    if (isTestPath(c.path) || isVendoredPath(c.path)) continue;
    // Single common words ("filter", "join", "default") collect references that are not theirs.
    if (c.kind === 'function' && splitIdentifier(c.name).length < 2) continue;
    // A widely used symbol lives in a widely imported file. A popular *name*
    // defined in a file nobody imports is a collision with a builtin or property.
    if (hasImportGraph) {
      const importers =
        ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM imports WHERE resolved_id = ?`, c.file_id)?.n ?? 0;
      if (importers < Math.max(2, p.refs * 0.04)) continue;
      if (defs.length > 1) {
        // Several definitions share the name: this one must itself be imported by name
        // often enough to own that popularity (an `Error` class next to a famous `Error`).
        const byName = ctx.db.get<{ n: number }>(
          `SELECT COUNT(DISTINCT file_id) AS n FROM imports WHERE resolved_id = ? AND (',' || names || ',') LIKE ? ESCAPE '\\'`,
          c.file_id, '%,' + c.name.replace(/[\\%_]/g, ch => '\\' + ch) + ',%'
        )?.n ?? 0;
        if (byName < Math.max(2, p.refs * 0.03)) continue;
      }
    }
    keyLines.push(`  ${c.kind} ${c.qname}  ${c.path}:${c.start_line}  refs:${p.refs}${c.doc ? '  // ' + firstLine(c.doc, 60) : ''}`);
  }
  if (keyLines.length) {
    out.push('key symbols (most widely referenced):');
    out.push(...keyLines);
  }
  // Hub files: imported by the most other files.
  const hubs = ctx.db
    .all<{ path: string; n: number }>(
      `SELECT f.path, COUNT(DISTINCT i.file_id) AS n FROM imports i JOIN files f ON f.id = i.resolved_id
       WHERE i.resolved_id IS NOT NULL GROUP BY i.resolved_id ORDER BY n DESC LIMIT 60`
    )
    .filter(h => !scope || h.path.startsWith(prefix))
    .slice(0, 12);
  if (hubs.length) {
    out.push('hub files (imported by N files):');
    for (const h of hubs) out.push(`  ${h.path}  ${h.n}`);
  }

  // Entry points.
  const entries = ctx.db
    .all<{ qname: string; path: string; start_line: number }>(
      `SELECT s.qname, f.path, s.start_line FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.name IN ('main', 'Main', '__main__') AND s.kind IN ('function', 'method') LIMIT 2000`
    )
    .filter(e => (!scope || e.path.startsWith(prefix)) && !isTestPath(e.path) && !isVendoredPath(e.path))
    // The real entry points sit near the top of the tree, in files named after the program.
    .sort((a, b) => {
      const rank = (p: string): number =>
        p.split('/').length * 2 - (/(^|\/)(main|server|app|cli|index|program|cmd)[^/]*$/i.test(p) ? 3 : 0);
      return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
    })
    .slice(0, 8);
  if (entries.length) {
    out.push('entry points:');
    for (const e of entries) out.push(`  ${e.qname}  ${e.path}:${e.start_line}`);
  }

  if (scope && files.length <= 40) {
    // Small enough to show whole: save the follow-up clast_file_summary call.
    out.push('files:');
    for (const f of files) {
      const topSymbols = ctx.db.all<{ name: string }>(
        `SELECT name FROM symbols WHERE file_id = ? AND parent_id IS NULL
         AND kind NOT IN ('variable', 'constant', 'property', 'field')
         ORDER BY (kind IN ('class','interface','struct','trait','enum')) DESC, exported DESC, start_line LIMIT 7`,
        f.id
      );
      const names = topSymbols.slice(0, 6).map(t => t.name).join(', ');
      out.push(`  ${f.path.slice(prefix.length)}  (${f.line_count} lines)${names ? ': ' + names + (topSymbols.length > 6 ? ', ...' : '') : ''}`);
    }
  }
  out.push('next: clast_file_summary <dir or file> for an outline, clast_search <words> to find symbols.');
  const text = out.join('\n');
  cache.set(scope, { gen: ctx.db.generation, text });
  return note + text;
}

// ---------------------------------------------------------------------------
// clast_grep
// ---------------------------------------------------------------------------

export interface GrepArgs {
  pattern: string;
  /** Treat pattern as a JavaScript regular expression. Default false (literal). */
  regex?: boolean;
  path?: string;
  lang?: string;
  /** Default: smart case (case-insensitive unless the pattern has uppercase). */
  caseSensitive?: boolean;
  /** Max matching lines. Default 50. */
  limit?: number;
  includeTests?: boolean;
}

/** Non-indexed text files, cached per project (re-listed at most once a minute). */
const otherFilesCache = new WeakMap<object, { at: number; files: string[] }>();

function otherTextFiles(ctx: ToolContext): string[] {
  const hit = otherFilesCache.get(ctx.indexer);
  if (hit && Date.now() - hit.at < 60_000) return hit.files;
  const files = ctx.indexer.rules.otherTextFiles();
  otherFilesCache.set(ctx.indexer, { at: Date.now(), files });
  return files;
}

export async function grep(ctx: ToolContext, args: GrepArgs): Promise<string> {
  const note = await ctx.ready();
  if (!args.pattern) return 'error: pattern is required';
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));
  const caseSensitive = args.caseSensitive ?? /[A-Z]/.test(args.pattern);
  let re: RegExp;
  try {
    const source = args.regex ? args.pattern : args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return `error: invalid regular expression: ${err instanceof Error ? err.message : err}`;
  }
  // For plain ASCII literals a one-byte view of the file is enough to reject
  // it, which avoids UTF-8 decoding the (vast majority of) non-matching files.
  const cheapProbe = !args.regex && /^[\x20-\x7E]+$/.test(args.pattern);
  const needle = cheapProbe && caseSensitive ? Buffer.from(args.pattern, 'latin1') : null;

  let files = ctx.db.all<{ id: number; path: string; lang: string }>(`SELECT id, path, lang FROM files ORDER BY path`);
  if (args.path) files = files.filter(f => pathMatches(f.path, args.path!));
  if (args.lang) files = files.filter(f => f.lang === args.lang);
  if (args.includeTests === false) files = files.filter(f => !isTestPath(f.path));
  files.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)));

  // Then everything else that is text: config, docs, data files, unsupported languages.
  let others: string[] = [];
  if (!args.lang) {
    others = otherTextFiles(ctx);
    if (args.path) others = others.filter(p => pathMatches(p, args.path!));
    if (args.includeTests === false) others = others.filter(p => !isTestPath(p));
    // Shallow files (package.json, pyproject.toml, Makefile) before deep trees of docs and data.
    const depthOf = (p: string): number => p.split('/').length;
    others.sort((a, b) => Number(isTestPath(a)) - Number(isTestPath(b)) || depthOf(a) - depthOf(b));
  }

  const started = performance.now();
  const out: string[] = [];
  let matches = 0;
  let filesWithMatches = 0;
  let scanned = 0;
  let timedOut = false;
  const total = files.length + others.length;

  const scanFile = async (path: string, fileId: number | null, buf: Buffer | null): Promise<void> => {
    if (!buf) return;
    scanned++;
    if (fileId === null && (buf.length > ctx.clast.config.maxFileSize || buf.subarray(0, 1024).includes(0))) return;
    if (needle) {
      if (!buf.includes(needle)) return;
    } else if (cheapProbe) {
      re.lastIndex = 0;
      if (!re.test(buf.toString('latin1'))) return;
    }
    let text = buf.toString('utf-8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    re.lastIndex = 0;
    if (!cheapProbe && !re.test(text)) return;
    if (fileId !== null) await ctx.fresh([path]);
    filesWithMatches++;
    out.push(fileId === null ? `${path}  (not indexed)` : path);
    re.lastIndex = 0;
    let lineNo = 1;
    let pos = 0;
    let lastLine = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      for (let i = text.indexOf('\n', pos); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
        lineNo++;
        pos = i + 1;
      }
      if (lineNo === lastLine) continue;
      lastLine = lineNo;
      if (matches >= limit) {
        out.push('  ... more matches in this file');
        break;
      }
      const end = text.indexOf('\n', m.index);
      let line = text.slice(pos, end === -1 ? text.length : end).trim();
      if (line.length > 170) {
        // Keep the match visible in very long lines.
        const at = Math.max(0, m.index - pos - 60);
        line = (at > 0 ? '...' : '') + line.slice(at, at + 165) + '...';
      }
      const enclosing = fileId !== null ? ctx.db.enclosingSymbol(fileId, lineNo) : undefined;
      out.push(`  ${String(lineNo).padStart(5)}  ${enclosing ? '[' + enclosing.qname + '] ' : ''}${line}`);
      matches++;
    }
  };

  // Read in parallel batches (file opens dominate on large trees), process in order.
  const work: Array<{ path: string; id: number | null }> = [
    ...files.map(f => ({ path: f.path, id: f.id as number | null })),
    ...others.map(p => ({ path: p, id: null })),
  ];
  const BATCH = 96;
  for (let i = 0; i < work.length && matches < limit; i += BATCH) {
    if (performance.now() - started > 8000) { timedOut = true; break; }
    const batch = work.slice(i, i + BATCH);
    const bufs = await Promise.all(
      batch.map(w => readFile(join(ctx.clast.root, w.path)).catch(() => null))
    );
    for (let k = 0; k < batch.length && matches < limit; k++) {
      await scanFile(batch[k]!.path, batch[k]!.id, bufs[k] ?? null);
    }
  }

  const what = args.regex ? '/' + args.pattern + '/' : JSON.stringify(args.pattern);
  const header =
    matches === 0
      ? `no matches for ${what} in ${plural(scanned, 'file')}` +
        (timedOut ? ' (time budget hit before all files were read; narrow with path)' : '') +
        (caseSensitive && !args.caseSensitive ? ' (case-sensitive because the pattern has uppercase; pass caseSensitive=false to relax)' : '')
      : `${matches >= limit ? 'first ' : ''}${plural(matches, 'matching line')} in ${plural(filesWithMatches, 'file')}` +
        (matches >= limit ? ` (limit reached after ${scanned}/${total} files; narrow with path or raise limit)` : '') +
        (timedOut ? ' (time budget hit; narrow with path)' : '') +
        '  [enclosing symbol in brackets]';
  return note + [header, ...out].join('\n');
}

// ---------------------------------------------------------------------------
// clast_changes
// ---------------------------------------------------------------------------

export interface ChangesArgs {
  /** Git ref to diff against. Default HEAD (uncommitted changes). */
  base?: string;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
  } catch {
    return null;
  }
}

export async function changes(ctx: ToolContext, args: ChangesArgs = {}): Promise<string> {
  const note = await ctx.ready();
  const root = ctx.clast.root;
  const base = args.base?.trim() || 'HEAD';
  if (!/^[\w./~^@{}-]+$/.test(base)) return 'error: invalid base ref';

  if (git(root, ['rev-parse', '--git-dir']) === null) {
    return note + 'error: this project is not a git repository (or git is not installed); clast_changes needs git.';
  }
  if (git(root, ['rev-parse', '--verify', '--quiet', base + '^{commit}']) === null) {
    return note + `error: git ref "${base}" does not exist in this repository (shallow clone or typo?). Try HEAD, a branch name, or a commit hash.`;
  }
  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', base, '--']);
  if (diff === null) return note + `error: git diff against "${base}" failed.`;

  // file -> changed line ranges on the new side
  const changed = new Map<string, Array<[number, number]>>();
  const stats = new Map<string, { add: number; del: number }>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current && !changed.has(current)) {
        changed.set(current, []);
        stats.set(current, { add: 0, del: 0 });
      }
    } else if (line.startsWith('@@') && current) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const del = m[2] === undefined ? 1 : Number(m[2]);
      const start = Number(m[3]);
      const count = m[4] === undefined ? 1 : Number(m[4]);
      const st = stats.get(current)!;
      st.add += count;
      st.del += del;
      changed.get(current)!.push(count === 0 ? [start, start + 1] : [start, start + count - 1]);
    }
  }
  // Untracked files are new code too.
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']) ?? '';
  for (const p of untracked.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (!changed.has(p) && ctx.indexer.rules.isSupported(p)) {
      changed.set(p, [[1, Number.MAX_SAFE_INTEGER]]);
      stats.set(p, { add: -1, del: 0 });
    }
  }

  if (changed.size === 0) return note + `no changes relative to ${base}.`;
  await ctx.fresh(changed.keys());

  const out: string[] = [];
  const touched: SymbolRow[] = [];
  let unindexed = 0;
  for (const [path, ranges] of changed) {
    const file = ctx.db.fileByPath(path);
    const st = stats.get(path)!;
    const stat = st.add === -1 ? 'new file' : `+${st.add} -${st.del}`;
    if (!file) {
      unindexed++;
      out.push(`${path}  (${stat}; not an indexed source file)`);
      continue;
    }
    const symbols = ctx.db.symbolsInFile(file.id);
    // Innermost symbols overlapping a changed range; containers only when no member covers the change.
    const hit = new Set<number>();
    for (const [a, b] of ranges) {
      const overlapping = symbols.filter(s => s.start_line <= b && s.end_line >= a);
      for (const s of overlapping) {
        const hasInner = overlapping.some(o => o.parent_id === s.id);
        if (CONTAINER_KINDS.has(s.kind) && hasInner) continue;
        hit.add(s.id);
      }
    }
    out.push(`${path}  (${stat})`);
    const list = symbols.filter(s => hit.has(s.id));
    for (const s of list.slice(0, 40)) {
      out.push(`  ${s.kind} ${s.qname}  :${range(s)}`);
      touched.push(s);
    }
    if (list.length > 40) out.push(`  ... ${list.length - 40} more symbols`);
    if (list.length === 0) out.push('  (changes outside any symbol: imports, top-level statements or comments)');
  }

  // Impact: who calls the changed callables, and which tests exercise them.
  const impact: string[] = [];
  const tests = new Set<string>();
  const changedIds = new Set(touched.map(t => t.id));
  for (const s of touched) {
    if (s.kind !== 'function' && s.kind !== 'method' && s.kind !== 'class') continue;
    if (impact.length >= 40) break;
    const callers = callersOf(ctx.db, ctx.resolver, s).filter(c => !c.caller || !changedIds.has(c.caller.id));
    if (callers.length === 0) continue;
    const prod: string[] = [];
    for (const c of callers) {
      if (isTestPath(c.path)) tests.add(c.path);
      else if (prod.length < 5) prod.push(`${c.caller ? c.caller.qname : c.path}${c.certain ? '' : '?'}`);
    }
    const prodCount = callers.filter(c => !isTestPath(c.path)).length;
    if (prodCount) {
      impact.push(`  ${s.qname} <- ${[...new Set(prod)].join(', ')}${prodCount > prod.length ? `, +${prodCount - prod.length} more` : ''}`);
    }
  }
  const header = `changes vs ${base}: ${plural(changed.size, 'file')}, ${plural(touched.length, 'symbol')} touched` +
    (unindexed ? ` (${unindexed} not indexed)` : '');
  const result = [header, ...out];
  if (impact.length) {
    result.push('callers outside the change (review for breakage):');
    result.push(...impact);
  }
  if (tests.size) {
    result.push(`tests exercising changed symbols (${tests.size}):`);
    for (const t of [...tests].slice(0, 15)) result.push(`  ${t}`);
    if (tests.size > 15) result.push(`  ... ${tests.size - 15} more`);
  }
  return note + result.join('\n');
}

// ---------------------------------------------------------------------------
// clast_status / clast_reindex
// ---------------------------------------------------------------------------

export async function status(ctx: ToolContext, watcher?: { isActive: boolean; pendingCount: number }): Promise<string> {
  const s = ctx.db.stats();
  const p = ctx.indexer.progress;
  const out: string[] = [];
  out.push(`project: ${ctx.clast.root}`);
  out.push(
    `index: ${plural(s.files, 'file')}, ${s.symbols} symbols, ${s.calls} call edges, ${s.names} distinct identifiers, ${s.imports} imports`
  );
  const langs = ctx.db.all<{ lang: string; n: number }>(`SELECT lang, COUNT(*) AS n FROM files GROUP BY lang ORDER BY n DESC`);
  if (langs.length) out.push('languages: ' + langs.map(l => `${l.lang} ${l.n}`).join(', '));
  out.push(
    ctx.indexer.isIndexing
      ? `state: indexing (${p.phase}, ${p.done}/${p.total} files)`
      : 'state: idle (up to date as of last scan; files are also re-checked when queried)'
  );
  if (ctx.indexer.lastResult) {
    const r = ctx.indexer.lastResult;
    out.push(
      `last index run: scanned ${r.scanned}, parsed ${r.parsed}, removed ${r.removed} in ${r.durationMs}ms (${plural(r.workers, 'worker')})`
    );
  }
  if (s.lastIndexed) out.push(`last file indexed: ${new Date(s.lastIndexed).toISOString()}`);
  if (ctx.indexer.rules.skippedLarge) {
    out.push(`skipped: ${plural(ctx.indexer.rules.skippedLarge, 'file')} larger than ${ctx.clast.config.maxFileSize} bytes (maxFileSize)`);
  }
  if (watcher) out.push(`watcher: ${watcher.isActive ? 'active' : 'off'}${watcher.pendingCount ? `, ${watcher.pendingCount} pending` : ''}`);
  out.push(`database: ${ctx.db.path}`);
  return out.join('\n');
}

export async function reindex(ctx: ToolContext, args: { path?: string; force?: boolean } = {}): Promise<string> {
  if (args.path) {
    const rel = ctx.indexer.toRel(args.path);
    const changed = await ctx.indexer.indexFile(rel, { force: true });
    ctx.lines.invalidate(rel);
    const row = ctx.db.fileByPath(rel);
    return row
      ? `reindexed ${rel}: ${plural(row.symbol_count, 'symbol')}${changed ? '' : ' (no change)'}`
      : `${rel} is not indexable (unsupported type, ignored, too large, or missing)`;
  }
  const r = await ctx.indexer.indexAll({ force: args.force ?? false });
  ctx.lines.invalidate();
  const s = ctx.db.stats();
  return (
    `${args.force ? 'full rebuild' : 'incremental scan'}: scanned ${r.scanned} files, parsed ${r.parsed}, removed ${r.removed} ` +
    `in ${r.durationMs}ms. Index: ${s.files} files, ${s.symbols} symbols.`
  );
}

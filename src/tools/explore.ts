import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    out.push(`defined: ${defs.slice(0, 4).map(d => `${d.kind} ${d.qname} ${loc(d)}`).join('; ')}${defs.length > 4 ? `; +${defs.length - 4} more` : ''}`);
    if (defs.length > 1) out.push('(references are matched by name, so they cover all definitions above)');
  }

  let printed = 0;
  let filesShown = 0;
  for (const r of rows) {
    if (printed >= limit) break;
    await ctx.fresh([r.path]);
    // Re-read the occurrence lines in case the file was just re-indexed.
    const cur = ctx.db.get<{ lines: string }>(`SELECT lines FROM occ WHERE name_id = ? AND file_id = ?`, nameId, r.file_id);
    if (!cur) continue;
    const lineNums = cur.lines.split(',').map(Number);
    out.push(r.path);
    filesShown++;
    const defLines = new Set(defs.filter(d => d.path === r.path).map(d => d.start_line));
    for (const n of lineNums) {
      if (printed >= limit) {
        out.push(`  ... more lines in this file`);
        break;
      }
      const enclosing = ctx.db.enclosingSymbol(r.file_id, n);
      const tag = defLines.has(n) ? 'def' : enclosing ? enclosing.qname : '';
      out.push(`  ${String(n).padStart(5)}  ${tag ? '[' + tag + '] ' : ''}${ctx.lines.line(r.path, n, 150)}`);
      printed++;
    }
  }
  if (filesShown < totalFiles) {
    const rest = rows.slice(filesShown);
    out.push(`... ${plural(rest.length, 'more file')}: ${rest.slice(0, 12).map(r => r.path).join(', ')}${rest.length > 12 ? ', ...' : ''}`);
    out.push('(narrow with path, or raise limit)');
  }
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
}

const MINOR_KINDS = new Set(['property', 'field', 'constant', 'variable']);

function range(s: { start_line: number; end_line: number }): string {
  return s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
}

function outlineFile(ctx: ToolContext, file: FileHit, members: 'all' | 'callable' | 'auto'): string[] {
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
    out.push(`imported by (${importedBy.length}${importedBy.length === 200 ? '+' : ''}): ${importedBy.slice(0, 10).map(r => r.path).join(', ')}${importedBy.length > 10 ? ', ...' : ''}`);
  }

  const hideMinor = members === 'callable' || (members === 'auto' && symbols.length > 150);
  const depthOf = new Map<number, number>();
  const hidden = new Map<number | null, number>();
  const width = String(file.line_count).length * 2 + 1;
  for (const s of symbols) {
    const depth = s.parent_id !== null && depthOf.has(s.parent_id) ? depthOf.get(s.parent_id)! + 1 : 0;
    depthOf.set(s.id, depth);
    if (hideMinor && depth > 0 && MINOR_KINDS.has(s.kind)) {
      hidden.set(s.parent_id, (hidden.get(s.parent_id) ?? 0) + 1);
      continue;
    }
    const label = s.signature || `${s.kind} ${s.name}`;
    // Signatures of variables / fields do not say what they are; prefix the kind.
    const text = MINOR_KINDS.has(s.kind) || s.kind === 'type' || s.kind === 'macro' ? label : label;
    out.push(
      `${range(s).padEnd(width)} ${'  '.repeat(depth)}${text}${s.doc ? '  // ' + firstLine(s.doc, 70) : ''}`
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
    q + '/', q + '/￿'
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
  return note + outlineFile(ctx, file, args.members ?? 'auto').join('\n');
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
    ...(scope ? [prefix, prefix + '￿'] : [])
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
        .map(([l, a]) => `${l} ${a.files} files/${a.lines} lines`)
        .join(', ')
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
  const renderDir = (node: Dir, name: string, depth: number, maxDepth: number): void => {
    // Collapse a/b/c chains where each level only has one subdirectory and no extra files.
    let label = name;
    let cur = node;
    while (cur.children.size === 1) {
      const [childName, child] = [...cur.children.entries()][0]!;
      if (child.files !== cur.files) break;
      label += '/' + childName;
      cur = child;
    }
    out.push(`${'  '.repeat(depth)}${label}/  ${cur.files}, ${cur.lines}`);
    // Test / fixture trees are listed but not expanded: navigation rarely starts there.
    if (depth >= maxDepth || isTestPath(label + '/')) return;
    const kids = [...cur.children.entries()].sort((a, b) => b[1].lines - a[1].lines);
    const cap = depth === 1 ? 12 : 6;
    for (const [n, c] of kids.slice(0, cap)) renderDir(c, n, depth + 1, maxDepth);
    if (kids.length > cap) {
      let restFiles = 0;
      for (const [, c] of kids.slice(cap)) restFiles += c.files;
      out.push(`${'  '.repeat(depth + 1)}... ${kids.length - cap} more dirs (${restFiles} files)`);
    }
  };
  const top = [...root.children.entries()].sort(
    (a, b) => Number(isTestPath(a[0] + '/')) - Number(isTestPath(b[0] + '/')) || b[1].lines - a[1].lines
  );
  // Small repos can afford a deeper tree.
  const maxDepth = files.length > 1500 ? 2 : 3;
  const rootFiles = files.filter(f => !f.path.slice(prefix.length).includes('/')).length;
  if (rootFiles) out.push(`  (${plural(rootFiles, 'file')} directly in ${scope || 'the root'})`);
  for (const [n, c] of top.slice(0, 16)) renderDir(c, n, 1, maxDepth);
  if (top.length > 16) out.push(`  ... ${top.length - 16} more top-level dirs`);

  // Key symbols: types and functions whose names are mentioned in the most files.
  const candidates = ctx.db.all<SymbolRow & { refs: number }>(
    `SELECT s.id, s.file_id, s.name, s.name_lc, s.qname, s.kind, s.signature, s.doc, s.start_line, s.end_line,
            s.start_col, s.doc_line, s.parent_id, s.exported, f.path, f.lang, t.refs
     FROM (SELECT o.name_id, COUNT(*) AS refs FROM occ o GROUP BY o.name_id ORDER BY refs DESC LIMIT 1500) t
     JOIN names n ON n.id = t.name_id
     JOIN symbols s ON s.name = n.name
     JOIN files f ON f.id = s.file_id
     WHERE s.kind IN ('class', 'interface', 'struct', 'trait', 'enum', 'function', 'type')
       AND s.parent_id IS NULL AND length(s.name) > 3
     ORDER BY t.refs DESC LIMIT 600`
  );
  const perName = new Map<string, number>();
  for (const c of candidates) perName.set(c.name, (perName.get(c.name) ?? 0) + 1);
  const key = candidates
    .filter(c =>
      (!scope || c.path.startsWith(prefix)) &&
      !isTestPath(c.path) && !isVendoredPath(c.path) &&
      (perName.get(c.name) ?? 0) <= 3 && // names defined all over the place are not landmarks
      // Single common words ("filter", "join", "default") collect references that are not theirs.
      (c.kind !== 'function' || splitIdentifier(c.name).length >= 2)
    );
  const seenNames = new Set<string>();
  const keyLines: string[] = [];
  for (const c of key) {
    if (seenNames.has(c.name)) continue;
    seenNames.add(c.name);
    keyLines.push(`  ${c.kind} ${c.qname}  ${c.path}:${c.start_line}  refs:${c.refs}${c.doc ? '  // ' + firstLine(c.doc, 60) : ''}`);
    if (keyLines.length >= 25) break;
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
       WHERE s.name IN ('main', 'Main', '__main__') AND s.kind IN ('function', 'method') LIMIT 200`
    )
    .filter(e => (!scope || e.path.startsWith(prefix)) && !isTestPath(e.path) && !isVendoredPath(e.path))
    .slice(0, 10);
  if (entries.length) {
    out.push('entry points:');
    for (const e of entries) out.push(`  ${e.qname}  ${e.path}:${e.start_line}`);
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

  let files = ctx.db.all<{ id: number; path: string; lang: string }>(`SELECT id, path, lang FROM files ORDER BY path`);
  if (args.path) files = files.filter(f => pathMatches(f.path, args.path!));
  if (args.lang) files = files.filter(f => f.lang === args.lang);
  if (args.includeTests === false) files = files.filter(f => !isTestPath(f.path));
  files.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)));

  const started = performance.now();
  const out: string[] = [];
  let matches = 0;
  let filesWithMatches = 0;
  let scanned = 0;
  let timedOut = false;

  for (const f of files) {
    if (matches >= limit) break;
    if (performance.now() - started > 8000) { timedOut = true; break; }
    let text: string;
    try {
      text = readFileSync(join(ctx.clast.root, f.path), 'utf-8');
    } catch {
      continue;
    }
    scanned++;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    await ctx.fresh([f.path]);
    filesWithMatches++;
    out.push(f.path);
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
      const enclosing = ctx.db.enclosingSymbol(f.id, lineNo);
      out.push(`  ${String(lineNo).padStart(5)}  ${enclosing ? '[' + enclosing.qname + '] ' : ''}${line}`);
      matches++;
    }
  }

  const header =
    matches === 0
      ? `no matches for ${args.regex ? '/' + args.pattern + '/' : JSON.stringify(args.pattern)} in ${plural(scanned, 'indexed file')}` +
        (timedOut ? ' (time budget hit; narrow with path)' : '') +
        '. Only indexed source files are searched; use a regular grep for other file types.'
      : `${matches >= limit ? 'first ' : ''}${plural(matches, 'matching line')} in ${plural(filesWithMatches, 'file')}` +
        (matches >= limit ? ` (limit reached after scanning ${scanned}/${files.length} files; narrow with path or raise limit)` : '') +
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

  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', base, '--']);
  if (diff === null) return note + 'error: not a git repository, or the base ref does not exist.';

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

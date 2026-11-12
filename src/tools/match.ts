import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { SourceParser } from '../parser/index.js';
import { isTestPath, plural } from '../query/format.js';
import { pathMatches } from '../query/resolve.js';
import { ToolContext } from './context.js';

// ---------------------------------------------------------------------------
// clast_match: find code by its shape
// ---------------------------------------------------------------------------
//
// The pattern is a piece of code with holes: `$NAME` stands for any one node (an expression, a name,
// a type) and `$$$NAME` for any run of siblings (arguments, statements). The pattern is parsed with
// the same grammar as the files and compared tree against tree, so layout, comments and line breaks
// do not matter, and a match is a syntactic one: `log($MSG)` finds calls of log with one argument,
// not the word "log" in a string. The same name used twice must match the same text.

export interface MatchArgs {
  pattern: string;
  /** Only this language. Default: every indexed language the pattern parses in. */
  lang?: string;
  path?: string;
  /** Max matches listed. Default 40. */
  limit?: number;
  includeTests?: boolean;
}

const SINGLE = /^__CLAST_([A-Z0-9_]+)__$/;
const MULTI = /^__CLASTM_([A-Z0-9_]*)__$/;
const BUDGET_MS = 20_000;

/** Ways to give a fragment the surroundings its grammar needs (`%s` is the pattern). */
const WRAPPERS: Record<string, string[]> = {
  java: ['class __CLASTW__ { %s }', 'class __CLASTW__ { void __clastw__() { %s } }'],
  csharp: ['class __CLASTW__ { %s }', 'class __CLASTW__ { void __clastw__() { %s } }'],
  dart: ['class __CLASTW__ { %s }', 'void __clastw__() { %s }'],
  typescript: ['class __CLASTW__ { %s }'],
  tsx: ['class __CLASTW__ { %s }'],
  javascript: ['class __CLASTW__ { %s }'],
  go: ['package p\n%s', 'package p\nfunc __clastw__() { %s }'],
  rust: ['fn __clastw__() { %s }', 'impl __CLASTW__ { %s }'],
  c: ['void __clastw__() { %s }'],
  cpp: ['void __clastw__() { %s }', 'class __CLASTW__ { %s };'],
  php: ['<?php %s', '<?php class __CLASTW__ { %s }'],
  python: ['class __CLASTW__:\n    %s'],
  swift: ['class __CLASTW__ { %s }'],
  ruby: [],
};

/** Surroundings for a clause pattern: `catch (...) { }`, `finally { }`, `except E:`. */
const CLAUSE_WRAPPERS: Record<string, string[]> = {
  java: ['class __CLASTW__ { void __clastw__() { try { } %s } }'],
  csharp: ['class __CLASTW__ { void __clastw__() { try { } %s } }'],
  dart: ['void __clastw__() { try { } %s }'],
  typescript: ['try { } %s'],
  tsx: ['try { } %s'],
  javascript: ['try { } %s'],
  cpp: ['void __clastw__() { try { } %s }'],
  php: ['<?php try { } %s'],
  python: ['try:\n    pass\n%s'],
};

let parser: SourceParser | null = null;

/** Text of a node without a trailing `;` (a hole in statement position is wrapped in a statement). */
function bare(n: Node): string {
  let t = n.text;
  if (t.endsWith(';')) t = t.slice(0, -1).trimEnd();
  // ... or in a call, where a bare name is not a statement (C#).
  return t.endsWith('__()') ? t.slice(0, -2) : t;
}

/** Children that carry meaning: no comments, no separators (a trailing comma must not matter). */
function kids(n: Node): Node[] {
  const out: Node[] = [];
  for (const c of n.children) {
    if (!c) continue;
    if (c.type === ',' || c.type === ';' || /comment/.test(c.type)) continue;
    out.push(c);
  }
  return out;
}

function matchNode(p: Node, t: Node, bound: Map<string, string>): boolean {
  const hole = SINGLE.exec(bare(p));
  if (hole) {
    const name = hole[1]!;
    if (name === '_') return true;
    const seen = bound.get(name);
    if (seen !== undefined) return seen === t.text;
    bound.set(name, t.text);
    return true;
  }
  if (p.type !== t.type) return false;
  const pc = kids(p);
  if (pc.length === 0) return p.text === t.text;
  return matchSeq(pc, 0, kids(t), 0, bound);
}

function matchSeq(pc: Node[], i: number, tc: Node[], j: number, bound: Map<string, string>): boolean {
  if (i === pc.length) return j === tc.length;
  if (MULTI.test(bare(pc[i]!))) {
    for (let k = j; k <= tc.length; k++) {
      const saved = new Map(bound);
      if (matchSeq(pc, i + 1, tc, k, bound)) return true;
      bound.clear();
      for (const [a, b] of saved) bound.set(a, b);
    }
    return false;
  }
  if (j === tc.length) return false;
  const saved = new Map(bound);
  if (matchNode(pc[i]!, tc[j]!, bound) && matchSeq(pc, i + 1, tc, j + 1, bound)) return true;
  bound.clear();
  for (const [a, b] of saved) bound.set(a, b);
  return false;
}

interface Compiled {
  /** Root of the pattern inside its (kept alive) tree. */
  root: Node;
  dispose: () => void;
}

/** Parse the pattern for one language, trying the wrappers when it does not stand alone. */
async function compile(p: SourceParser, lang: string, original: string): Promise<Compiled | null> {
  // Grammars with statement terminators want them: after the pattern, and after a hole that stands for
  // statements (`{ $$BODY }`). Try the pattern as written first.
  const holes = original.replace(/(__CLASTM_[A-Z0-9_]*__)(\s*\})/g, '$1;$2');
  const calls = original.replace(/(__CLASTM_[A-Z0-9_]*__)(\s*\})/g, '$1();$2');
  const variants = [...new Set([original, holes, original.trimEnd() + ';', holes.trimEnd() + ';', calls, calls.trimEnd() + ';'])];
  // A clause (`catch ($T $E) { }`) is not code by itself: give it the statement it belongs to.
  const clause = /^(catch|finally|except)\b/.test(original.trim());
  const wrappers = clause ? CLAUSE_WRAPPERS[lang] ?? [] : ['%s', ...(WRAPPERS[lang] ?? [])];
  for (const code of variants)
  for (const wrapper of wrappers) {
    const at = wrapper.indexOf('%s');
    const source = wrapper.replace('%s', () => code);
    const tree = await p.parseAs(lang, source);
    if (!tree) return null;
    const start = at + (code.length - code.trimStart().length);
    const end = at + code.trimEnd().length;
    let node = tree.rootNode.namedDescendantForIndex(start, end - 1);
    // A statement pattern written without its `;` still means the expression inside.
    while (node && node.startIndex === start && node.endIndex === end && node.namedChildCount === 1 &&
      node.firstNamedChild!.startIndex === start && node.firstNamedChild!.endIndex === end) {
      node = node.firstNamedChild;
    }
    const exact = node && node.startIndex === start && node.endIndex <= end + 1 && node.endIndex >= end;
    if (node && exact && !node.hasError) return { root: node, dispose: () => tree.delete() };
    tree.delete();
  }
  return null;
}

export async function match(ctx: ToolContext, args: MatchArgs): Promise<string> {
  const note = await ctx.ready();
  const pattern = (args.pattern ?? '').trim();
  if (!pattern) return 'error: pattern is required, e.g. `fetch($URL, $$$REST)`';
  const limit = Math.max(1, Math.min(args.limit ?? 40, 500));
  parser ??= new SourceParser();

  // Holes become identifiers the grammars accept.
  const code = pattern
    .replace(/\$\$\$([A-Z_][A-Z0-9_]*)?/g, (_m, n: string | undefined) => `__CLASTM_${n ?? ''}__`)
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, n: string) => `__CLAST_${n}__`);
  // Words every matching file must contain: a cheap filter before parsing.
  const literals = [...new Set(code.replace(/__CLASTM?_[A-Z0-9_]*__/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map(w => Buffer.from(w, 'latin1'));

  let files = ctx.db.all<{ path: string; lang: string }>(`SELECT path, lang FROM files ORDER BY path`);
  if (args.lang) files = files.filter(f => f.lang === args.lang || (args.lang === 'typescript' && f.lang === 'tsx'));
  if (args.path) files = files.filter(f => pathMatches(f.path, args.path!));
  if (args.includeTests === false) files = files.filter(f => !isTestPath(f.path));
  files.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)));
  if (files.length === 0) return note + 'no indexed files match the filters.';

  const compiled = new Map<string, Compiled | null>();
  for (const lang of new Set(files.map(f => f.lang))) compiled.set(lang, await compile(parser, lang, code));
  const usable = [...compiled.entries()].filter(([, c]) => c).map(([l]) => l);
  if (usable.length === 0) {
    for (const c of compiled.values()) c?.dispose();
    return (
      note +
      `error: the pattern does not parse as one expression, statement or declaration in ${[...compiled.keys()].join(', ')}. ` +
      'Write it as real code with holes: `$NAME` for one node, `$$$NAME` for any run of arguments or statements, ' +
      'e.g. `fetch($URL, $$$REST)`, `if ($COND) { return null; }`, `class $NAME extends Component { $$$BODY }`.'
    );
  }

  const started = performance.now();
  const out: string[] = [];
  let total = 0;
  let filesWithMatches = 0;
  let parsed = 0;
  let timedOut = false;
  const work = files.filter(f => compiled.get(f.lang));
  const BATCH = 64;
  try {
    for (let i = 0; i < work.length; i += BATCH) {
      if (performance.now() - started > BUDGET_MS) {
        timedOut = true;
        break;
      }
      const batch = work.slice(i, i + BATCH);
      const bufs = await Promise.all(batch.map(f => readFile(join(ctx.clast.root, f.path)).catch(() => null)));
      for (let k = 0; k < batch.length; k++) {
        const buf = bufs[k];
        const file = batch[k]!;
        if (!buf || buf.length > ctx.clast.config.maxFileSize || !literals.every(w => buf.includes(w))) continue;
        const pat = compiled.get(file.lang)!;
        let text = buf.toString('utf-8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const tree = await parser.parseAs(file.lang, text, file.path);
        if (!tree) continue;
        parsed++;
        try {
          const lines: string[] = [];
          let inFile = 0;
          for (const node of tree.rootNode.descendantsOfType(pat.root.type)) {
            if (!node) continue;
            const bound = new Map<string, string>();
            if (!matchNode(pat.root, node, bound)) continue;
            total++;
            inFile++;
            if (total > limit) continue;
            const line = node.startPosition.row + 1;
            const fileId = ctx.db.fileByPath(file.path)?.id;
            const enclosing = fileId !== undefined ? ctx.db.enclosingSymbol(fileId, line) : undefined;
            const first = node.text.split('\n')[0]!.trim();
            const caps = [...bound.entries()]
              .filter(([, v]) => v.length <= 40 && !v.includes('\n'))
              .slice(0, 4)
              .map(([n, v]) => `${n}=${v}`);
            lines.push(
              `  ${String(line).padStart(5)}  ${enclosing ? '[' + enclosing.qname + '] ' : ''}` +
                `${first.length > 120 ? first.slice(0, 117) + '...' : first}${caps.length ? '    ' + caps.join('  ') : ''}`
            );
          }
          if (inFile) filesWithMatches++;
          if (lines.length) out.push(file.path, ...lines);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    for (const c of compiled.values()) c?.dispose();
  }

  const skipped = [...compiled.entries()].filter(([, c]) => !c).map(([l]) => l);
  const header =
    (total === 0 ? `no matches for \`${pattern}\`` : `\`${pattern}\`: ${plural(total, 'match')}${total > limit ? ` (first ${limit} listed)` : ''} in ${plural(filesWithMatches, 'file')}`) +
    ` (${usable.join(', ')}; ${parsed} of ${plural(work.length, 'file')} contained the pattern's words and were parsed)` +
    (timedOut ? ' - time budget hit before all files were read: narrow with path or lang' : '') +
    (skipped.length ? `; not valid ${skipped.join(' / ')} code, so those files were skipped` : '');
  return note + [header, ...out].join('\n');
}

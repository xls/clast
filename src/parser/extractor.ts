import type { Language, Node, Tree } from 'web-tree-sitter';
import type { ExCall, ExHeritage, ExImport, ExSymbol, Extraction, SymbolKind } from '../types.js';
import type { Ctx, DefOpts, LangSpec, Visitor } from './spec.js';

const MAX_SIGNATURE = 240;
const MAX_DOC = 600;
const MAX_OCC_LINES = 40;
const MAX_NAME = 120;

/** A language spec bound to a loaded grammar (node types resolved to ids). */
export interface CompiledSpec {
  spec: LangSpec;
  language: Language;
  visitors: Array<Visitor | undefined>;
  isIdent: Uint8Array;
  isComment: Uint8Array;
  /** Visitor / identifier node types that do not exist in the grammar. */
  unknownTypes: string[];
}

export function compileSpec(spec: LangSpec, language: Language): CompiledSpec {
  const count = language.nodeTypeCount;
  const visitors: Array<Visitor | undefined> = new Array(count);
  const isIdent = new Uint8Array(count);
  const isComment = new Uint8Array(count);

  const idsByName = new Map<string, number[]>();
  for (let id = 0; id < count; id++) {
    if (!language.nodeTypeIsNamed(id)) continue;
    const name = language.nodeTypeForId(id);
    if (!name) continue;
    let list = idsByName.get(name);
    if (!list) idsByName.set(name, (list = []));
    list.push(id);
  }

  const unknownTypes: string[] = [];
  for (const [type, visitor] of Object.entries(spec.visit)) {
    const ids = idsByName.get(type);
    if (!ids) { unknownTypes.push(type); continue; }
    for (const id of ids) visitors[id] = visitor;
  }
  for (const type of spec.identifiers) {
    const ids = idsByName.get(type);
    if (!ids) { unknownTypes.push(type); continue; }
    for (const id of ids) isIdent[id] = 1;
  }
  const commentTypes = spec.comments ?? [...idsByName.keys()].filter(n => n.includes('comment'));
  for (const type of commentTypes) {
    for (const id of idsByName.get(type) ?? []) isComment[id] = 1;
  }

  return { spec, language, visitors, isIdent, isComment, unknownTypes };
}

interface Scope {
  /** Symbol index, or -1 for naming-only scopes. */
  sym: number;
  name: string;
  kind: SymbolKind | null;
  /** Whether calls inside are attributed to this symbol. */
  callScope: boolean;
}

export function cleanComment(raw: string): string {
  let s = raw.trim();
  // Block comments: /** ... */, /* ... */, """ ... """, =begin ... =end
  s = s.replace(/^\/\*+!?/, '').replace(/\*+\/$/, '');
  const lines = s.split(/\r?\n/).map(l =>
    l
      .replace(/^\s*(\/\/[\/!]?|#+!?|--+|\*+(?!\/)|;+)\s?/, '')
      .replace(/\s+$/, '')
  );
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join('\n');
}

function squash(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/**
 * Walk a parsed tree and extract symbols, calls, imports, heritage and
 * identifier occurrences according to the language spec.
 */
export function extract(tree: Tree, source: string, compiled: CompiledSpec): Extraction {
  const { visitors, isIdent, isComment } = compiled;

  const symbols: ExSymbol[] = [];
  const imports: ExImport[] = [];
  const heritage: ExHeritage[] = [];
  const callMap = new Map<string, ExCall>();
  const occ = new Map<string, number[]>();
  const scopes: Scope[] = [];

  function currentCaller(): number {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i]!;
      if (s.sym >= 0 && s.callScope) return s.sym;
    }
    return -1;
  }

  function leadingDoc(range: Node): { doc: string; line: number } {
    const parts: string[] = [];
    let line = 0;
    let nextRow = range.startPosition.row;
    let prev = range.previousSibling;
    while (prev && isComment[prev.typeId]) {
      if (prev.endPosition.row < nextRow - 1) break;
      // A comment trailing a statement on the same line documents that statement.
      const before = prev.previousSibling;
      if (before && before.endPosition.row === prev.startPosition.row && !isComment[before.typeId]) break;
      parts.unshift(prev.text);
      nextRow = prev.startPosition.row;
      line = nextRow + 1;
      if (parts.length >= 60) break;
      prev = prev.previousSibling;
    }
    if (parts.length === 0) return { doc: '', line: 0 };
    let doc = parts.map(cleanComment).join('\n').trim();
    if (doc.length > MAX_DOC) doc = doc.slice(0, MAX_DOC - 3) + '...';
    return { doc, line };
  }

  const ctx: Ctx = {
    src: source,

    def(node: Node, o: DefOpts): number {
      let name = o.name;
      if (!name) name = '<anonymous>';
      if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);
      const range = o.range ?? node;

      const prefix: string[] = [];
      let parent = -1;
      for (const s of scopes) {
        prefix.push(s.name);
      }
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i]!.sym >= 0) { parent = scopes[i]!.sym; break; }
      }
      if (o.qualifier) prefix.push(...o.qualifier.split(/::|\./).filter(Boolean));
      const qname = prefix.length ? prefix.join('.') + '.' + name : name;

      let signature: string;
      if (o.sig !== undefined) {
        signature = squash(o.sig, MAX_SIGNATURE);
      } else {
        const body = o.body === undefined ? node.childForFieldName('body') : o.body;
        const start = range.startIndex;
        let end: number;
        if (body && body.startIndex > start) {
          end = body.startIndex;
        } else {
          end = range.endIndex;
          const nl = source.indexOf('\n', start);
          // Without a body, keep at most a few lines.
          if (nl !== -1 && end - start > 400) end = Math.min(end, start + 400);
        }
        signature = squash(source.slice(start, end), MAX_SIGNATURE).replace(/\s*[{=]$/, '');
      }

      let doc = '';
      let docLine = 0;
      if (o.doc !== undefined && o.doc !== null) {
        doc = o.doc.length > MAX_DOC ? o.doc.slice(0, MAX_DOC - 3) + '...' : o.doc;
      }
      const lead = leadingDoc(range);
      if (lead.line) {
        docLine = lead.line;
        if (!doc) doc = lead.doc;
      }

      const index = symbols.length;
      symbols.push({
        name,
        qname,
        kind: o.kind,
        signature,
        doc,
        startLine: range.startPosition.row + 1,
        endLine: range.endPosition.row + 1,
        startCol: range.startPosition.column,
        docLine,
        parent,
        exported: o.exported ?? false,
      });
      if (o.scope !== false) scopes.push({ sym: index, name, kind: o.kind, callScope: true });
      return index;
    },

    scope(name: string): void {
      if (!name) return;
      scopes.push({ sym: -1, name, kind: null, callScope: false });
    },

    call(name, node, receiver = null): void {
      if (!name || name.length > MAX_NAME) return;
      if (!/^[\p{L}_$~][\p{L}\p{N}_$!?]*$/u.test(name)) return;
      const caller = currentCaller();
      const key = caller + '\0' + name;
      const existing = callMap.get(key);
      if (existing) {
        existing.count++;
        if (!existing.receiver && receiver) existing.receiver = receiver;
        return;
      }
      callMap.set(key, { caller, name, line: node.startPosition.row + 1, receiver, count: 1 });
    },

    imp(src, node, names = []): void {
      if (!src) return;
      imports.push({ source: src.slice(0, 300), names: names.slice(0, 50), line: node.startPosition.row + 1 });
    },

    inherit(sym, name, kind = 'extends'): void {
      if (!name || sym < 0) return;
      const clean = name.trim();
      if (!clean || clean.length > MAX_NAME) return;
      heritage.push({ symbol: sym, name: clean, kind });
    },

    parentKind(): SymbolKind | null {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i]!.sym >= 0) return scopes[i]!.kind;
      }
      return null;
    },

    inCallable(): boolean {
      for (const s of scopes) {
        if (s.kind === 'function' || s.kind === 'method') return true;
      }
      return false;
    },

    depth(): number {
      let d = 0;
      for (const s of scopes) if (s.sym >= 0) d++;
      return d;
    },
  };

  const cursor = tree.walk();
  let hadError = tree.rootNode.hasError;

  function visit(): void {
    const typeId = cursor.nodeTypeId;
    if (isIdent[typeId]) {
      const name = source.slice(cursor.startIndex, cursor.endIndex);
      if (name.length >= 2 && name.length <= MAX_NAME) {
        const line = cursor.startPosition.row + 1;
        const lines = occ.get(name);
        if (!lines) occ.set(name, [line]);
        else if (lines.length < MAX_OCC_LINES && lines[lines.length - 1] !== line) lines.push(line);
      }
      // Identifiers are leaves in every supported grammar, but a few grammars
      // wrap them (e.g. PHP `name`); fall through to children only if any.
    }

    const before = scopes.length;
    const visitor = visitors[typeId];
    let skip = false;
    if (visitor) {
      try {
        if (visitor(cursor.currentNode, ctx) === 'skip') skip = true;
      } catch {
        // A visitor bug must never take down indexing of the whole file.
        hadError = true;
      }
    }

    if (!skip && cursor.gotoFirstChild()) {
      do {
        visit();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
    scopes.length = before;
  }

  try {
    visit();
  } catch (err) {
    // Typically a stack overflow on pathological (generated) files: keep what we have.
    if (!(err instanceof RangeError)) throw err;
    hadError = true;
  } finally {
    cursor.delete();
  }

  let lineCount = 1;
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineCount++;

  return {
    lang: compiled.spec.id,
    lineCount,
    symbols,
    calls: [...callMap.values()],
    imports,
    heritage,
    occ: [...occ.entries()].map(([name, lines]) => [name, lines.join(',')] as [string, string]),
    hadError,
  };
}

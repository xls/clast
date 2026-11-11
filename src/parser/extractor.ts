import type { Language, Node, Tree } from 'web-tree-sitter';
import { CONTAINER_KINDS, type ExCall, type ExHeritage, type ExImport, type ExSymbol, type Extraction, type SymbolKind } from '../types.js';
import { typeName, type Ctx, type DefOpts, type LangSpec, type Visitor } from './spec.js';

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
  /** Node types skipped between a doc comment and its item (attributes). */
  isDocSkip: Uint8Array;
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

  const isDocSkip = new Uint8Array(count);
  for (const type of spec.docSkip ?? []) {
    const ids = idsByName.get(type);
    if (!ids) { unknownTypes.push(type); continue; }
    for (const id of ids) isDocSkip[id] = 1;
  }

  return { spec, language, visitors, isIdent, isComment, isDocSkip, unknownTypes };
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
  const { visitors, isIdent, isComment, isDocSkip } = compiled;

  const symbols: ExSymbol[] = [];
  const imports: ExImport[] = [];
  const heritage: ExHeritage[] = [];
  const callMap = new Map<string, ExCall>();
  const occ = new Map<string, number[]>();
  const scopes: Scope[] = [];
  const containerDefs = new Map<string, number>();
  /** Declared types: owner symbol index (-1 = file) -> variable/field name -> type name. */
  const hints = new Map<number, Map<string, string>>();

  function addOcc(name: string, line: number): void {
    const lines = occ.get(name);
    if (!lines) occ.set(name, [line]);
    else if (lines.length < MAX_OCC_LINES && lines[lines.length - 1] !== line) lines.push(line);
  }

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
    if (!prev) {
      // First node of a wrapper (e.g. Ruby body_statement): the comment sits before the wrapper.
      const p = range.parent;
      if (p && p.startIndex === range.startIndex) prev = p.previousSibling;
    }
    while (prev) {
      if (isDocSkip[prev.typeId]) {
        // Attributes / annotations between the doc comment and the item.
        nextRow = prev.startPosition.row;
        prev = prev.previousSibling;
        continue;
      }
      if (!isComment[prev.typeId]) break;
      if (prev.endPosition.row < nextRow - 1) break;
      // A comment trailing a statement on the same line documents that statement.
      // (Preprocessor nodes end at column 0 of the next line: not trailing.)
      const before = prev.previousSibling;
      if (
        before && !isComment[before.typeId] &&
        before.endPosition.row === prev.startPosition.row && before.endPosition.column > 0
      ) break;
      parts.unshift(prev.text);
      nextRow = prev.startPosition.row;
      line = nextRow + 1;
      if (parts.length >= 200) break;
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
      let depth = scopes.length;
      if (o.inContainer) {
        // Attach to the nearest enclosing class-like scope instead of the method we are in.
        depth = 0;
        for (let i = scopes.length - 1; i >= 0; i--) {
          const k = scopes[i]!.kind;
          if (k !== null && CONTAINER_KINDS.has(k)) { depth = i + 1; break; }
        }
      }
      for (let i = 0; i < depth; i++) {
        prefix.push(scopes[i]!.name);
      }
      for (let i = depth - 1; i >= 0; i--) {
        if (scopes[i]!.sym >= 0) { parent = scopes[i]!.sym; break; }
      }
      if (o.qualifier) prefix.push(...o.qualifier.split(/::|\./).filter(Boolean));
      const qname = prefix.length ? prefix.join('.') + '.' + name : name;

      let signature: string;
      if (o.sig !== undefined) {
        signature = squash(o.sig, MAX_SIGNATURE).replace(/\s*\{$/, '');
      } else {
        const body = o.body === undefined ? node.childForFieldName('body') : o.body;
        const start = range.startIndex;
        let end: number;
        if (body && body.startIndex > start) {
          end = body.startIndex;
        } else {
          end = range.endIndex;
          // Without a body: short declarations in full, long ones (object
          // literals, tables) only up to the end of their first line.
          if (end - start > 200) {
            const nl = source.indexOf('\n', start);
            end = nl !== -1 && nl < end ? nl : Math.min(end, start + 200);
          }
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

      if (o.inContainer) {
        // Instance attributes are assigned many times; keep the first.
        const key = o.kind + ' ' + qname;
        const seen = containerDefs.get(key);
        if (seen !== undefined) return seen;
        containerDefs.set(key, symbols.length);
      }

      const index = symbols.length;
      symbols.push({
        name,
        qname,
        kind: o.kind,
        signature,
        doc,
        startLine: range.startPosition.row + 1,
        // Nodes that swallow the trailing newline (preprocessor) end at column 0 of the next row.
        endLine:
          range.endPosition.column === 0 && range.endPosition.row > range.startPosition.row
            ? range.endPosition.row
            : range.endPosition.row + 1,
        startCol: range.startPosition.column,
        docLine,
        parent,
        exported: o.exported ?? false,
      });
      if (o.scope !== false) {
        // The qualifier is part of the scope so nested definitions inherit it.
        const scopeName = o.qualifier ? o.qualifier.split(/::|\./).filter(Boolean).concat(name).join('.') : name;
        scopes.push({ sym: index, name: scopeName, kind: o.kind, callScope: true });
      }
      return index;
    },

    scope(name: string): void {
      if (!name) return;
      scopes.push({ sym: -1, name, kind: null, callScope: false });
    },

    ref(name, node): void {
      if (!name || name.length < 2 || name.length > MAX_NAME) return;
      addOcc(name, node.startPosition.row + 1);
    },

    typeHint(name, type, onContainer = false): void {
      if (!name || name.length > MAX_NAME) return;
      const t = typeName(type);
      if (!t) return;
      // Owner: nearest enclosing function/method, else nearest container, else the file.
      let owner = -1;
      for (let i = scopes.length - 1; i >= 0; i--) {
        const s = scopes[i]!;
        if (s.sym < 0 || s.kind === null) continue;
        const isContainer = CONTAINER_KINDS.has(s.kind);
        if (isContainer || (!onContainer && (s.kind === 'function' || s.kind === 'method'))) { owner = s.sym; break; }
      }
      let map = hints.get(owner);
      if (!map) hints.set(owner, (map = new Map()));
      if (!map.has(name)) map.set(name, t);
    },

    call(name, node, receiver = null): void {
      if (!name || name.length > MAX_NAME) return;
      if (!/^[\p{L}_$~][\p{L}\p{N}_$!?]*$/u.test(name)) return;
      const caller = currentCaller();
      const key = caller + '\0' + name + '\0' + (receiver ?? '');
      const existing = callMap.get(key);
      if (existing) {
        existing.count++;
        return;
      }
      callMap.set(key, { caller, name, line: node.startPosition.row + 1, receiver, rtype: null, count: 1 });
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
        addOcc(name, cursor.startPosition.row + 1);
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

  // Resolve receivers to declared types: `x.foo()` with `x: Foo` in scope,
  // `this.repo.find()` with a typed `repo` field on the enclosing class,
  // `s.pool.Get()` where `s` is a typed receiver/parameter whose class is in this file.
  if (hints.size) {
    const SELF = new Set(['this', 'self', '$this', 'base', 'Self', 'super']);
    let containerByName: Map<string, number> | null = null;
    const containerNamed = (name: string): number | undefined => {
      if (!containerByName) {
        containerByName = new Map();
        for (let i = 0; i < symbols.length; i++) {
          const s = symbols[i]!;
          if (CONTAINER_KINDS.has(s.kind) && !containerByName.has(s.name)) containerByName.set(s.name, i);
        }
      }
      return containerByName.get(name);
    };
    /** Declared type of `name` visible from symbol `owner` (walks enclosing symbols, then the file). */
    const lookup = (owner: number, name: string): string | undefined => {
      for (let cur = owner, guard = 0; guard < 12; guard++) {
        const hit = hints.get(cur)?.get(name);
        if (hit) return hit;
        if (cur < 0) return undefined;
        cur = symbols[cur]!.parent;
      }
      return undefined;
    };
    /** Class-like symbol a method belongs to: lexical parent, or by qualified name (Go receivers, Rust impl, C++ out-of-line). */
    const containerOf = (sym: number): number | undefined => {
      for (let cur = sym; cur >= 0; cur = symbols[cur]!.parent) {
        if (CONTAINER_KINDS.has(symbols[cur]!.kind)) return cur;
      }
      if (sym < 0) return undefined;
      const parts = symbols[sym]!.qname.split('.');
      for (let i = parts.length - 2; i >= 0; i--) {
        const hit = containerNamed(parts[i]!);
        if (hit !== undefined) return hit;
      }
      return undefined;
    };
    const fieldType = (container: number | undefined, name: string): string | undefined =>
      container === undefined ? undefined : hints.get(container)?.get(name);

    for (const call of callMap.values()) {
      const r = call.receiver;
      if (!r || r === '?') continue;
      const parts = r.replace(/->|::/g, '.').split('.');
      if (parts.length > 2 || parts.some(p => !/^[$@]?[A-Za-z_]\w*$/.test(p))) continue;
      let t: string | undefined;
      if (parts.length === 1) {
        const p = parts[0]!;
        if (SELF.has(p)) continue;
        // Ruby @ivar is a field of the enclosing class; anything else is a local / parameter.
        t = p.startsWith('@')
          ? fieldType(containerOf(call.caller), p.slice(1))
          : lookup(call.caller, p.replace(/^\$/, ''));
      } else {
        const [a, b] = parts as [string, string];
        const field = b.replace(/^[$@]/, '');
        if (SELF.has(a)) {
          t = fieldType(containerOf(call.caller), field);
        } else {
          const ta = lookup(call.caller, a.replace(/^[$@]/, ''));
          if (ta) t = fieldType(containerNamed(ta), field);
        }
      }
      if (t) call.rtype = t;
    }
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

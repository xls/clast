import type { Language, Node, Tree } from 'web-tree-sitter';
import { CONTAINER_KINDS, type ExCall, type ExHeritage, type ExImport, type ExSymbol, type Extraction, type SymbolKind } from '../types.js';
import { genericArity, typeName, type Ctx, type DefOpts, type LangSpec, type Visitor } from './spec.js';
import { returnTypeOf } from './returns.js';

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
  return lines.join('\n').trim();
}

const VALUE_WRAPPERS = new Set([
  'await_expression', 'try_expression', 'parenthesized_expression', 'non_null_expression', 'as_expression',
  'expression_list', 'equals_value_clause', 'unary_expression', 'reference_expression', 'type_cast_expression',
]);
const BINDING_NODES = new Set([
  'variable_declarator', 'assignment_expression', 'assignment', 'short_var_declaration', 'let_declaration',
  'init_declarator', 'var_spec', 'local_variable_declaration', 'const_spec', 'augmented_assignment',
  'property_declaration', 'initialized_variable_definition', // Swift, Dart
]);

/**
 * If `call` is the whole right-hand side of a simple variable binding
 * (`x = f()`, `let x = f()?`, `x, err := f()`, `auto x = f()`), the name of
 * that variable; otherwise null. Works across grammars by looking at the
 * usual field names.
 */
function boundVariable(call: Node): string | null {
  let node: Node = call;
  let p = call.parent;
  for (let i = 0; p && i < 3 && VALUE_WRAPPERS.has(p.type); i++) {
    node = p;
    p = p.parent;
  }
  if (!p || !BINDING_NODES.has(p.type)) return null;
  const target =
    p.childForFieldName('name') ?? p.childForFieldName('left') ?? p.childForFieldName('pattern') ??
    p.childForFieldName('declarator');
  if (!target || target.endIndex > node.startIndex) return null;
  // Go: `x, err := f()` - the first name receives the first result.
  const first = target.type === 'expression_list' ? target.namedChild(0) : target;
  if (!first || first.endIndex - first.startIndex > 60) return null;
  const text = first.text.replace(/^[$@*&]+/, '').replace(/^mut\s+/, '');
  return /^[A-Za-z_]\w*$/.test(text) ? text : null;
}

const ARGUMENT_LISTS = new Set(['argument_list', 'arguments', 'value_arguments']);

/** Languages where a bare name inside a method can be a field of the enclosing class. */
const IMPLICIT_THIS_SPECS = new Set(['java', 'csharp', 'cpp', 'c', 'swift', 'dart', 'kotlin']);

/** Number of arguments of a call node, or -1 when it cannot be counted (spread, no argument list). */
function argCount(node: Node): number {
  // Flat grammars (Dart) hand in synthetic call spans that are not real nodes.
  if (typeof node.childForFieldName !== 'function' || !Array.isArray(node.namedChildren)) return -1;
  let args = node.childForFieldName('arguments');
  if (!args) {
    for (const c of node.namedChildren) {
      if (c && ARGUMENT_LISTS.has(c.type)) { args = c; break; }
    }
  }
  if (!args || !ARGUMENT_LISTS.has(args.type)) return -1;
  let n = 0;
  for (const c of args.namedChildren) {
    if (!c || c.type.includes('comment')) continue;
    // f(*args), f(...xs), f(xs...): the count is not known statically.
    if (/splat|spread|variadic/.test(c.type)) return -1;
    n++;
  }
  return Math.min(n, 99);
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
  /** Outer calls of a chain waiting for the call that produces their receiver, by start offset. */
  const chainOuters = new Map<number, Array<{ call: ExCall; end: number }>>();
  const viaRef = new Map<ExCall, ExCall>();
  /** Variables initialised from a call: owner symbol index -> variable name -> that call. */
  const callHints = new Map<number, Map<string, ExCall>>();
  let defaultExport: string | null = null;
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

  function leadingDoc(range: Node): { doc: string; line: number; returns: string | null } {
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
    if (parts.length === 0) return { doc: '', line: 0, returns: null };
    let doc = parts.map(cleanComment).join('\n').trim();
    // Documented return type (PHPDoc / JSDoc): taken before the text is truncated.
    const returns = /@returns?\s+\{?([^\s}|]+)/.exec(doc)?.[1] ?? null;
    if (doc.length > MAX_DOC) doc = doc.slice(0, MAX_DOC - 3) + '...';
    return { doc, line, returns };
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

      let ret: string | null = null;
      if (o.kind === 'function' || o.kind === 'method' || o.kind === 'declaration') {
        // Enclosing class for Self / static / this return types: the last qualifier segment.
        const selfType = prefix.length ? prefix[prefix.length - 1]!.split('.').pop()! : null;
        ret = returnTypeOf(signature, name, compiled.spec.id, selfType, compiled.spec.lowercaseTypes === true);
        if (!ret) {
          // No declared type: fall back to the documented one (`@return $this`, `@returns {Foo}`).
          const documented = lead.returns ?? /@returns?\s+\{?([^\s}|]+)/.exec(doc)?.[1] ?? null;
          if (documented) {
            ret = /^\\?(\$this|static|self|this)$/.test(documented)
              ? selfType
              : typeName(documented, compiled.spec.lowercaseTypes === true);
          }
        }
      }

      const index = symbols.length;
      symbols.push({
        name,
        qname,
        kind: o.kind,
        ret,
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

    exportDefault(name): void {
      // '*' = "whatever the required module exports" (`module.exports = require('./lib/x')`).
      if (name === '*') defaultExport ??= '*';
      else if (name && name.length <= MAX_NAME && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) defaultExport = name;
    },

    ref(name, node): void {
      if (!name || name.length < 2 || name.length > MAX_NAME) return;
      addOcc(name, node.startPosition.row + 1);
    },

    typeHint(name, type, onContainer = false): void {
      if (!name || name.length > MAX_NAME) return;
      const t = typeName(type, compiled.spec.lowercaseTypes === true, compiled.spec.packageTypes === true);
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

    typeOf(name): string | null {
      if (!name) return null;
      for (let i = scopes.length - 1; i >= 0; i--) {
        const s = scopes[i]!;
        // Class-level hints are fields (reached through this / self), not variables in scope.
        if (s.sym < 0 || (s.kind !== 'function' && s.kind !== 'method')) continue;
        const hit = hints.get(s.sym)?.get(name);
        if (hit) return hit;
      }
      return hints.get(-1)?.get(name) ?? null;
    },

    call(name, node, receiver = null, receiverType = null): void {
      if (!name || name.length > MAX_NAME) return;
      if (!/^[\p{L}_$~][\p{L}\p{N}_$!?]*$/u.test(name)) return;
      const caller = currentCaller();
      const start = node.startIndex;
      const end = node.endIndex;
      const argc = argCount(node);
      // Calls on expression receivers are kept apart per site until the chain is known (merged below).
      const key = caller + '\0' + name + '\0' + (receiver === '?' ? '?' + start + ':' + end : receiver ?? '') + '\0' + argc;
      let rec = callMap.get(key);
      if (rec) {
        rec.count++;
      } else {
        const rtype = receiverType
          ? typeName(receiverType, compiled.spec.lowercaseTypes === true, compiled.spec.packageTypes === true)
          : null;
        // A chained call spanning several lines starts at the head of the chain; report the
        // line where this call's own argument list opens (`->then(`), which is where a reader looks.
        let row = node.startPosition.row;
        if (node.endPosition.row !== row) {
          const args = node.childForFieldName('arguments');
          if (args) row = args.startPosition.row;
        }
        rec = { caller, name, line: row + 1, receiver, rtype, argc, count: 1, via: -1 };
        callMap.set(key, rec);
      }
      // Call chains: in `a.b().c()` the expression for c starts where the expression for b starts,
      // and the walker reaches c first. Link each outer call to the call that produces its receiver.
      const outers = chainOuters.get(start);
      if (outers) {
        for (const o of outers) {
          if (o.end > end && !viaRef.has(o.call) && o.call !== rec) viaRef.set(o.call, rec);
        }
      }
      if (receiver === '?' && !rec.rtype) {
        if (outers) outers.push({ call: rec, end });
        else chainOuters.set(start, [{ call: rec, end }]);
      }
      // `x = make()`, `let x = Foo::new()?`, `x, err := load()`: x gets the call's return type.
      const bound = boundVariable(node);
      if (bound) {
        let map = callHints.get(caller);
        if (!map) callHints.set(caller, (map = new Map()));
        if (!map.has(bound)) map.set(bound, rec);
      }
    },

    imp(src, node, names = []): void {
      if (!src) return;
      imports.push({ source: src.slice(0, 300), names: names.slice(0, 50), line: node.startPosition.row + 1 });
    },

    inherit(sym, name, kind = 'extends', arity?: number): void {
      if (!name || sym < 0) return;
      const clean = name.trim().replace(/<.*$/s, '');
      if (arity === undefined) arity = genericArity(name);
      if (!clean || clean.length > MAX_NAME) return;
      // `pkg.mod.Base` / `ns::Base`: index by the bare name, keep the qualifier for resolution.
      const parts = clean.split(/\.|::|\\/).filter(Boolean);
      const bare = parts.pop();
      if (!bare) return;
      const qualifier = parts.length ? parts[parts.length - 1]! : null;
      if (heritage.some(h => h.symbol === sym && h.name === bare)) return;
      heritage.push({ symbol: sym, name: bare, qualifier, kind, arity });
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

  // Iterative pre-order walk (no recursion: generated files nest tens of thousands deep).
  // `open` holds, for every node whose children are being visited, the scope depth to restore on leaving it.
  const open: number[] = [];
  try {
    let entering = true;
    for (;;) {
      if (entering) {
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
          open.push(before);
          continue;
        }
        scopes.length = before; // leaf (or skipped subtree): its scope closes right away
      }
      if (cursor.gotoNextSibling()) {
        entering = true;
        continue;
      }
      if (open.length === 0) break;
      cursor.gotoParent();
      scopes.length = open.pop()!;
      entering = false;
    }
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
    // Only where members can be named without `this.` is a class field in scope for a bare name:
    // in TypeScript or Python a local `targets` is not the field `this.targets`.
    const implicitThis = IMPLICIT_THIS_SPECS.has(compiled.spec.id);
    const lookup = (owner: number, name: string): string | undefined => {
      for (let cur = owner, guard = 0; guard < 12; guard++) {
        const skip = !implicitThis && cur >= 0 && CONTAINER_KINDS.has(symbols[cur]!.kind);
        const hit = skip ? undefined : hints.get(cur)?.get(name);
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
      if (!r || r === '?' || call.rtype) continue;
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
          if (ta) {
            t = fieldType(containerNamed(ta), field);
            // `opts.logger.info()` with `opts: Options` declared in another file: the type of the
            // field is not known here. Leave "Options#logger" for the resolver, which sees every file.
            if (!t && containerNamed(ta) === undefined) t = ta + '#' + field;
          }
        }
      }
      if (t) call.rtype = t;
    }
  }
  // Receivers that are variables initialised from a call take that call's return type
  // (resolved at query time through the same link as call chains).
  if (callHints.size) {
    for (const call of callMap.values()) {
      const r = call.receiver;
      if (!r || r === '?' || call.rtype || viaRef.has(call)) continue;
      if (!/^[$@]?[A-Za-z_]\w*$/.test(r)) continue;
      const name = r.replace(/^[$@]/, '');
      for (let cur = call.caller, guard = 0; guard < 6; guard++) {
        const hit = callHints.get(cur)?.get(name);
        if (hit && hit !== call) {
          viaRef.set(call, hit);
          break;
        }
        if (cur < 0) break;
        const s = symbols[cur]!;
        // Stop at the function boundary: locals of an enclosing class / file are not visible by bare name.
        if (s.kind !== 'function' && s.kind !== 'method') break;
        cur = s.parent;
        if (cur >= 0 && symbols[cur]!.kind !== 'function' && symbols[cur]!.kind !== 'method') break;
      }
    }
  }

  // Merge chained calls that are the same edge (`x.a().b()` twice in one function), then
  // express receiver links as indexes into the final list.
  const calls: ExCall[] = [];
  {
    const kept = new Map<string, ExCall>();
    const redirect = new Map<ExCall, ExCall>();
    for (const call of callMap.values()) {
      if (call.receiver !== '?') {
        calls.push(call);
        continue;
      }
      const inner = viaRef.get(call);
      const key =
        call.caller + '\0' + call.name + '\0' + (inner ? inner.name + '\0' + (inner.receiver ?? '') : '') + '\0' +
        (call.rtype ?? '') + '\0' + call.argc;
      const first = kept.get(key);
      if (first) {
        first.count += call.count;
        redirect.set(call, first);
      } else {
        kept.set(key, call);
        calls.push(call);
      }
    }
    const indexOf = new Map<ExCall, number>();
    calls.forEach((c, i) => indexOf.set(c, i));
    for (const [outer, innerRaw] of viaRef) {
      if (redirect.has(outer)) continue;
      const inner = redirect.get(innerRaw) ?? innerRaw;
      const i = indexOf.get(inner);
      if (i !== undefined) outer.via = i;
    }
  }

  // Field types of class-like symbols are exported so the resolver can type
  // `this.x.foo()` / `x_->foo()` when the class lives in another file
  // (C++ headers, Go structs in the same package, partial classes).
  const fieldTypes: Array<[string, string, string]> = [];
  for (const [owner, map] of hints) {
    if (owner < 0 || !CONTAINER_KINDS.has(symbols[owner]!.kind)) continue;
    const container = symbols[owner]!.name;
    for (const [field, type] of map) {
      if (fieldTypes.length < 4000) fieldTypes.push([container, field, type]);
    }
  }

  let lineCount = 1;
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineCount++;

  return {
    lang: compiled.spec.id,
    lineCount,
    symbols,
    calls,
    imports,
    heritage,
    fieldTypes,
    defaultExport,
    occ: [...occ.entries()].map(([name, lines]) => [name, lines.join(',')] as [string, string]),
    hadError,
  };
}

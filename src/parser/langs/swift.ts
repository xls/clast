import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../../types.js';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field, simpleReceiver } from '../spec.js';

const MAX_SIG_SLICE = 400;
const MAX_TYPE_TEXT = 120;
const MAX_INLINE_VALUE = 60;

/** Bodies whose direct children are members of a type. */
const MEMBER_BODIES = new Set(['class_body', 'enum_class_body', 'protocol_body']);

/**
 * Types declared so far in the file being extracted (simple name -> symbol),
 * so `extension Foo: Bar` can attach the conformance to Foo. The Ctx object
 * is created once per file.
 */
const declaredTypes = new WeakMap<Ctx, Map<string, number>>();

function modifiersOf(node: Node): Node | null {
  const first = node.firstChild;
  return first && first.type === 'modifiers' ? first : null;
}

/** `private` / `fileprivate` (but not `private(set)`, which only restricts the setter). */
function isPrivate(mods: Node | null): boolean {
  if (!mods) return false;
  for (const c of mods.children) {
    if (!c || c.type !== 'visibility_modifier') continue;
    const first = c.firstChild;
    if (c.childCount === 1 && first && (first.type === 'private' || first.type === 'fileprivate')) return true;
  }
  return false;
}

/** Offset where the signature starts: after leading attributes (`@MainActor`, `@available(...)`). */
function sigStart(node: Node, mods: Node | null): number {
  if (!mods) return node.startIndex;
  for (const c of mods.children) {
    if (!c) continue;
    if (c.type === 'attribute' || c.type === 'comment' || c.type === 'multiline_comment') continue;
    return c.startIndex;
  }
  const next = mods.nextSibling;
  return next ? next.startIndex : node.startIndex;
}

function sliceSig(ctx: Ctx, start: number, end: number): string {
  if (end - start > MAX_SIG_SLICE) end = start + MAX_SIG_SLICE;
  return ctx.src.slice(start, end).replace(/\s*[{=]\s*$/, '');
}

/** Signature from after the attributes up to `stop` (a body node) or the node end. */
function signature(node: Node, mods: Node | null, ctx: Ctx, stop: Node | null): string {
  const start = sigStart(node, mods);
  return sliceSig(ctx, start, stop && stop.startIndex > start ? stop.startIndex : node.endIndex);
}

const MAX_SIG = 236;

/**
 * Signature of a callable. Long parameter lists are elided in the middle
 * (`func f(a: A, ...) -> R`) so the return type survives truncation.
 */
function callableSignature(node: Node, mods: Node | null, ctx: Ctx, stop: Node | null): string {
  const start = sigStart(node, mods);
  let end = stop && stop.startIndex > start ? stop.startIndex : node.endIndex;
  if (end - start <= MAX_SIG) return sliceSig(ctx, start, end);
  if (end - start > 4000) end = start + 4000;
  const full = ctx.src.slice(start, end).replace(/\s+/g, ' ').replace(/\s*[{=]\s*$/, '').trim();
  if (full.length <= MAX_SIG) return full;
  const open = full.indexOf('(');
  if (open === -1) return full;
  // Matching close of the parameter list and the top-level commas inside it.
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < full.length; i++) {
    const ch = full[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth === 0) { close = i; break; }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return full;
  const tail = full.slice(close);
  const budget = MAX_SIG - tail.length - 4;
  let cut = -1;
  for (const c of commas) {
    if (c > budget) break;
    cut = c;
  }
  if (cut === -1) return full;
  return full.slice(0, cut + 1) + ' ...' + tail;
}

/** Identifier text without the backticks of escaped names (`default`). */
function identText(node: Node): string {
  const t = node.text;
  return t.charCodeAt(0) === 96 ? t.replace(/`/g, '') : t;
}

/** Standard-library protocols that often come first in a class's inheritance clause. */
const KNOWN_PROTOCOLS = new Set([
  'Sendable', 'Codable', 'Decodable', 'Encodable', 'Hashable', 'Equatable', 'Comparable', 'Identifiable',
  'CustomStringConvertible', 'CustomDebugStringConvertible', 'Error', 'LocalizedError', 'ObservableObject',
  'AnyObject', 'Sequence', 'Collection', 'CaseIterable', 'RawRepresentable', 'View',
]);

/** Dotted name of a `user_type` without generic arguments: `Foo.Bar<T>` -> `Foo.Bar`. */
function userTypeName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'type_identifier' || node.type === 'simple_identifier') return node.text;
  if (node.type !== 'user_type') return null;
  let out = '';
  for (const c of node.namedChildren) {
    if (c && c.type === 'type_identifier') out = out ? out + '.' + c.text : c.text;
  }
  return out || null;
}

/** Raw type text for ctx.typeHint, or null for types that never name a class (arrays, tuples, closures). */
function hintType(type: Node | null | undefined): string | null {
  let n = type ?? null;
  for (let i = 0; n && i < 4; i++) {
    switch (n.type) {
      case 'user_type':
        return n.endIndex - n.startIndex > MAX_TYPE_TEXT ? userTypeName(n) : n.text;
      case 'type_identifier':
        return n.text;
      case 'optional_type':
        n = field(n, 'wrapped') ?? n.namedChild(0);
        break;
      case 'existential_type': // any Foo
      case 'opaque_type': // some Foo
        n = n.namedChild(n.namedChildCount - 1);
        break;
      default:
        return null;
    }
  }
  return null;
}

/** Class constructed by an initialiser expression: `Foo()`, `Foo<T>(x)`, `y as! Foo`. */
function constructedType(value: Node | null | undefined): string | null {
  if (!value) return null;
  switch (value.type) {
    case 'call_expression': {
      const callee = value.firstChild;
      if (callee && callee.type === 'simple_identifier') {
        const name = callee.text;
        return /^[A-Z]/.test(name) ? name : null;
      }
      return null;
    }
    case 'constructor_expression':
      return hintType(field(value, 'constructed_type'));
    case 'as_expression':
      return hintType(field(value, 'name'));
    default:
      return null;
  }
}

const TYPE_KINDS: Record<string, SymbolKind> = {
  class: 'class',
  struct: 'struct',
  enum: 'enum',
  actor: 'class',
};

/** class / struct / enum / actor / extension: the grammar uses one node type for all of them. */
const classDeclaration: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const kindNode = field(node, 'declaration_kind');
  const keyword = kindNode ? kindNode.type : 'class';
  const mods = modifiersOf(node);

  if (keyword === 'extension') {
    // Not a symbol: members are named after the extended type.
    const name = userTypeName(nameNode);
    if (!name) return;
    const known = declaredTypes.get(ctx);
    if (known) {
      const sym = known.get(name.slice(name.lastIndexOf('.') + 1));
      if (sym !== undefined) {
        for (const c of node.namedChildren) {
          if (c && c.type === 'inheritance_specifier') ctx.inherit(sym, userTypeName(field(c, 'inherits_from')), 'implements');
        }
      }
    }
    ctx.scope(name);
    return;
  }

  const name = nameNode.text;
  const kind = TYPE_KINDS[keyword] ?? 'class';
  const sym = ctx.def(node, {
    name,
    kind,
    sig: signature(node, mods, ctx, field(node, 'body')),
    exported: !isPrivate(mods),
  });
  let known = declaredTypes.get(ctx);
  if (!known) declaredTypes.set(ctx, (known = new Map()));
  if (!known.has(name)) known.set(name, sym);

  let first = keyword === 'class';
  for (const c of node.namedChildren) {
    if (!c || c.type !== 'inheritance_specifier') continue;
    const base = userTypeName(field(c, 'inherits_from'));
    if (!base) continue;
    ctx.inherit(sym, base, first && !KNOWN_PROTOCOLS.has(base) ? 'extends' : 'implements');
    first = false;
  }
};

const protocolDeclaration: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const mods = modifiersOf(node);
  const name = nameNode.text;
  const sym = ctx.def(node, {
    name,
    kind: 'interface',
    sig: signature(node, mods, ctx, field(node, 'body')),
    exported: !isPrivate(mods),
  });
  let known = declaredTypes.get(ctx);
  if (!known) declaredTypes.set(ctx, (known = new Map()));
  if (!known.has(name)) known.set(name, sym);
  for (const c of node.namedChildren) {
    if (c && c.type === 'inheritance_specifier') ctx.inherit(sym, userTypeName(field(c, 'inherits_from')), 'extends');
  }
};

function isMember(node: Node): boolean {
  const p = node.parent;
  return !!p && MEMBER_BODIES.has(p.type);
}

/** Members of a protocol take the protocol's visibility. */
function memberExported(node: Node, mods: Node | null): boolean {
  if (isPrivate(mods)) return false;
  const body = node.parent;
  if (body && (body.type === 'protocol_body' || node.type === 'enum_entry')) {
    const decl = body.parent;
    if (decl && isPrivate(modifiersOf(decl))) return false;
  }
  return true;
}

/** `func`, protocol method requirements and operator functions (`static func == (...)`). */
const functionDeclaration: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode || nameNode.endIndex - nameNode.startIndex > 100) return;
  const mods = modifiersOf(node);
  ctx.def(node, {
    name: identText(nameNode),
    kind: isMember(node) ? 'method' : 'function',
    sig: callableSignature(node, mods, ctx, field(node, 'body')),
    exported: memberExported(node, mods),
  });
};

const fixedName = (name: string): Visitor => (node, ctx) => {
  const mods = modifiersOf(node);
  let stop = field(node, 'body');
  if (!stop) {
    // subscript: the accessor block has no field name.
    const last = node.lastChild;
    if (last && last.type === 'computed_property') stop = last;
  }
  ctx.def(node, {
    name,
    kind: 'method',
    sig: callableSignature(node, mods, ctx, stop),
    exported: memberExported(node, mods),
  });
};

const typealiasDeclaration: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const mods = modifiersOf(node);
  ctx.def(node, {
    name: nameNode.text,
    kind: 'type',
    sig: signature(node, mods, ctx, null),
    exported: memberExported(node, mods),
  });
};

/** `case a = 1, b(Int)`: one constant per name. */
const enumEntry: Visitor = (node, ctx) => {
  const exported = memberExported(node, modifiersOf(node));
  let name: Node | null = null;
  let end = 0;
  const flush = (): void => {
    if (!name) return;
    ctx.def(node, {
      name: identText(name),
      kind: 'constant',
      sig: 'case ' + sliceSig(ctx, name.startIndex, end),
      scope: false,
      exported,
    });
  };
  const count = node.childCount;
  for (let i = 0; i < count; i++) {
    const c = node.child(i);
    if (!c) continue;
    const f = node.fieldNameForChild(i);
    if (f === 'name' && c.type === 'simple_identifier') {
      flush();
      name = c;
      end = c.endIndex;
    } else if ((f === 'data_contents' || f === 'raw_value') && name) {
      end = c.endIndex;
    }
  }
  flush();
};

interface Binding {
  name: Node;
  type: Node | null;
  value: Node | null;
  /** Accessor / observer block (`{ get set }`, `{ didSet {} }`). */
  block: Node | null;
  end: number;
}

function bindingsOf(node: Node): Binding[] {
  const out: Binding[] = [];
  let cur: Binding | null = null;
  const count = node.childCount;
  for (let i = 0; i < count; i++) {
    const c = node.child(i);
    if (!c || !c.isNamed) continue;
    switch (c.type) {
      case 'pattern': {
        const id = field(c, 'bound_identifier');
        cur = id ? { name: id, type: null, value: null, block: null, end: c.endIndex } : null;
        if (cur) out.push(cur);
        break;
      }
      case 'type_annotation':
        if (cur) {
          cur.type = c.namedChild(c.namedChildCount - 1);
          cur.end = c.endIndex;
        }
        break;
      case 'computed_property':
      case 'willset_didset_block':
      case 'protocol_property_requirements':
        if (cur && !cur.block) cur.block = c;
        break;
      case 'modifiers':
      case 'value_binding_pattern':
      case 'comment':
      case 'multiline_comment':
      case 'type_constraints':
        break;
      default:
        if (cur && !cur.value && !cur.block) {
          cur.value = c;
          cur.end = c.endIndex;
        }
    }
  }
  return out;
}

function isLet(node: Node): boolean {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'value_binding_pattern') return c.firstChild?.type === 'let';
    if (c.type === 'pattern') return c.firstChild?.firstChild?.type === 'let';
  }
  return false;
}

/**
 * Stored and computed properties, protocol property requirements and
 * top-level `let` / `var`. Locals are not symbols: they only contribute a
 * receiver type hint.
 */
const propertyDeclaration: Visitor = (node, ctx) => {
  const parent = node.parent;
  if (!parent) return;
  const member = MEMBER_BODIES.has(parent.type);
  const bindings = bindingsOf(node);

  if (!member && parent.type !== 'source_file') {
    if (!ctx.inCallable()) return;
    for (const b of bindings) {
      const type = hintType(b.type) ?? constructedType(b.value);
      if (type) ctx.typeHint(identText(b.name), type);
    }
    return;
  }

  const mods = modifiersOf(node);
  const exported = memberExported(node, mods);
  const kind: SymbolKind = member ? 'property' : isLet(node) ? 'constant' : 'variable';
  // Inside an extension there is no class symbol to carry the hint; it would land on the file.
  const hintable = !member || ctx.parentKind() !== null;
  const start = sigStart(node, mods);
  const single = bindings.length === 1;

  for (const b of bindings) {
    const name = identText(b.name);
    let sig: string;
    if (single) {
      let end = b.block ? b.block.startIndex : node.endIndex;
      if (b.value && (b.value.endIndex - b.value.startIndex > MAX_INLINE_VALUE || b.value.endPosition.row !== b.value.startPosition.row)) {
        end = b.value.startIndex;
      } else if (b.block && b.block.type === 'protocol_property_requirements') {
        end = node.endIndex; // `var x: Int { get set }` is short and part of the contract
      }
      sig = sliceSig(ctx, start, end);
    } else {
      // `var a: Int = 0, b: Int`: modifiers + keyword + this binding.
      const head = ctx.src.slice(start, Math.min(bindings[0]!.name.startIndex, start + MAX_SIG_SLICE));
      const end = b.value && b.value.endIndex - b.value.startIndex > MAX_INLINE_VALUE ? b.value.startIndex : b.end;
      sig = head + sliceSig(ctx, b.name.startIndex, end);
    }
    // Only one definition can own the scope of the visited node.
    ctx.def(node, { name, kind, sig, exported, scope: single ? undefined : false });
    if (hintable) {
      const type = hintType(b.type) ?? constructedType(b.value);
      if (type) ctx.typeHint(name, type);
    }
  }
};

/** Function, initialiser and subscript parameters: `label name: Type`. */
const parameter: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  const type = node.lastNamedChild;
  if (!name || !type || type.startIndex === name.startIndex) return;
  ctx.typeHint(name.text, hintType(type));
};

/** Closure parameters with explicit types: `{ (v: Value) in ... }`. */
const lambdaParameter: Visitor = (node, ctx) => {
  if (!ctx.inCallable()) return;
  parameter(node, ctx);
};

/** `if let t: Thing = make()`, `guard let ...`, `for item: Item in items`. */
const typeAnnotation: Visitor = (node, ctx) => {
  const parent = node.parent;
  if (!parent || parent.type === 'property_declaration' || parent.type === 'protocol_property_declaration') return;
  if (!ctx.inCallable()) return;
  const prev = node.previousSibling;
  if (!prev) return;
  const id = prev.type === 'pattern' ? field(prev, 'bound_identifier') : prev;
  if (id && id.type === 'simple_identifier') ctx.typeHint(id.text, hintType(node.namedChild(node.namedChildCount - 1)));
};

/** `if let s = x as? Session`, `guard let s = x as? Session`. */
const asExpression: Visitor = (node, ctx) => {
  const eq = node.previousSibling;
  if (!eq || eq.type !== '=') return;
  const id = eq.previousSibling;
  if (id && id.type === 'simple_identifier' && ctx.inCallable()) ctx.typeHint(id.text, hintType(field(node, 'name')));
};

/** Receiver text of a member call: `a`, `self.session`, `a?` / `a!` without the sigil, or '?'. */
function receiverOf(target: Node | null): string {
  if (target && target.type === 'simple_identifier') return identText(target);
  const r = simpleReceiver(target);
  if (!r) return '?';
  if (r === '?') return r;
  return r.replace(/[?!]/g, '') || '?';
}

const callExpression: Visitor = (node, ctx) => {
  const suffix = node.lastChild;
  if (suffix && suffix.type === 'call_suffix') {
    // Subscript access `items[0]` is parsed as a call.
    const args = suffix.firstChild;
    if (args && args.type === 'value_arguments' && args.firstChild?.type === '[') return;
  }
  let callee = node.firstChild;
  for (let i = 0; callee && i < 5; i++) {
    switch (callee.type) {
      case 'simple_identifier':
        ctx.call(identText(callee), node);
        return;
      case 'navigation_expression': {
        const name = field(field(callee, 'suffix'), 'suffix');
        if (!name || name.type !== 'simple_identifier') return;
        const target = field(callee, 'target');
        const method = identText(name);
        if (method === 'init' && target && target.type === 'simple_identifier') {
          // `Foo.init(x)` constructs a Foo.
          const cls = target.text;
          if (/^[A-Z]/.test(cls) && cls !== 'Self') {
            ctx.call(cls, node);
            return;
          }
        }
        // `Foo().bar()` / `Foo<T>().bar()`: the receiver's class is evident.
        // (The grammar puts a leading `try` / `await` on the receiver: `try Foo().bar()`.)
        let made = target;
        if (made && (made.type === 'try_expression' || made.type === 'await_expression')) made = field(made, 'expr');
        const rtype = made && (made.type === 'call_expression' || made.type === 'constructor_expression')
          ? constructedType(made)
          : null;
        ctx.call(method, node, receiverOf(target), rtype);
        return;
      }
      case 'prefix_expression': {
        const target = field(callee, 'target');
        if (callee.firstChild?.type === '.') {
          // Implicit member: `.custom(r: 1)`, `.init(x)`.
          if (target && target.type === 'simple_identifier') ctx.call(target.text, node, '?');
          return;
        }
        callee = target;
        break;
      }
      case 'try_expression':
      case 'await_expression':
        callee = field(callee, 'expr');
        break;
      default:
        // The grammar parses `a + f(x)` as a call whose callee is `a + f`: the real callee is the right operand.
        callee = field(callee, 'rhs');
    }
  }
};

/** `Foo<Int>(x: 1)`. */
const constructorExpression: Visitor = (node, ctx) => {
  const name = userTypeName(field(node, 'constructed_type'));
  if (name) ctx.call(name.slice(name.lastIndexOf('.') + 1), node);
};

const IMPORT_KINDS = new Set(['struct', 'class', 'enum', 'protocol', 'typealias', 'func', 'let', 'var']);

/** `import Foundation`, `@testable import X`, `import struct Foo.Bar`. */
const importDeclaration: Visitor = (node, ctx) => {
  let path: Node | null = null;
  let kinded = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'identifier') { path = c; break; }
    if (!c.isNamed && IMPORT_KINDS.has(c.type)) kinded = true;
  }
  if (!path || path.endIndex - path.startIndex > 200) return;
  const source = path.text.replace(/\s+/g, '');
  const dot = source.lastIndexOf('.');
  if (kinded && dot > 0) ctx.imp(source.slice(0, dot), node, [source.slice(dot + 1)]);
  else ctx.imp(source, node);
};

export const swift: LangSpec = {
  id: 'swift',
  grammar: 'swift',
  extensions: ['.swift'],
  identifiers: ['simple_identifier', 'type_identifier'],
  comments: ['comment', 'multiline_comment'],
  visit: {
    class_declaration: classDeclaration,
    protocol_declaration: protocolDeclaration,
    function_declaration: functionDeclaration,
    protocol_function_declaration: functionDeclaration,
    init_declaration: fixedName('init'),
    deinit_declaration: fixedName('deinit'),
    subscript_declaration: fixedName('subscript'),
    typealias_declaration: typealiasDeclaration,
    associatedtype_declaration: typealiasDeclaration,
    enum_entry: enumEntry,
    property_declaration: propertyDeclaration,
    protocol_property_declaration: propertyDeclaration,
    parameter,
    lambda_parameter: lambdaParameter,
    type_annotation: typeAnnotation,
    as_expression: asExpression,
    call_expression: callExpression,
    constructor_expression: constructorExpression,
    import_declaration: importDeclaration,
  },
};

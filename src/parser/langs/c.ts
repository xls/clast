import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../../types.js';
import { cleanComment } from '../extractor.js';
import type { Ctx, DefOpts, LangSpec, Visitor } from '../spec.js';
import { childOfType, field, isConstName, simpleReceiver, stripQuotes } from '../spec.js';

const MAX_SIG_SOURCE = 400;
const MAX_TYPE_TEXT = 100;

/** struct/union/enum/class specifier node type -> symbol kind. */
const CONTAINER_KIND: Record<string, SymbolKind> = {
  struct_specifier: 'struct',
  union_specifier: 'struct',
  class_specifier: 'class',
  enum_specifier: 'enum',
};

// ---------------------------------------------------------------------------
// Declarator handling
// ---------------------------------------------------------------------------

interface Declared {
  name: string;
  /** `a::b::Foo` for `a::b::Foo::bar`, else null. */
  qualifier: string | null;
  /** True when the declarator declares a function (not a function pointer). */
  isFn: boolean;
  /** The function_declarator that owns the name, if any. */
  fn: Node | null;
}

/** Name of a type-ish node used as a scope or base: `Foo`, `Foo<T>`, `a::Foo`. */
function typeName(node: Node | null): string {
  let cur = node;
  for (let i = 0; cur && i < 12; i++) {
    switch (cur.type) {
      case 'qualified_identifier':
        cur = field(cur, 'name');
        break;
      case 'template_type':
      case 'template_function':
      case 'template_method':
      case 'dependent_name':
      case 'dependent_type':
        cur = field(cur, 'name') ?? cur.lastNamedChild;
        break;
      case 'type_identifier':
      case 'identifier':
      case 'namespace_identifier':
      case 'field_identifier':
        return cur.text;
      default:
        return '';
    }
  }
  return '';
}

function operatorName(raw: string): string {
  const rest = raw.replace(/^operator/, '').replace(/\s+/g, ' ').trim();
  // `operator new`, `operator""_kb` keep a separator; symbolic operators do not.
  return /^[A-Za-z_]/.test(rest) ? 'operator ' + rest : 'operator' + rest.replace(/ /g, '');
}

/** Resolve the (possibly qualified) name node at the bottom of a declarator. */
function leafName(leaf: Node, fn: Node | null): Declared | null {
  const scopes: string[] = [];
  let cur: Node | null = leaf;
  for (let i = 0; cur && cur.type === 'qualified_identifier' && i < 12; i++) {
    const scope = field(cur, 'scope');
    // `EXPORT_MACRO Status Foo()` is parsed as type EXPORT_MACRO + a qualified
    // identifier `Status Foo` with a zero-width (missing) `::`; that scope is
    // really the return type.
    const sep = scope ? cur.child(1) : null;
    if (scope && sep && sep.endIndex > sep.startIndex) {
      const s = typeName(scope);
      if (s) scopes.push(s);
    }
    cur = field(cur, 'name');
  }
  if (!cur) return null;

  let name = '';
  let isFn = fn !== null;
  switch (cur.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
      name = cur.text;
      break;
    case 'destructor_name':
      name = cur.text.replace(/\s+/g, '');
      break;
    case 'operator_name':
      name = operatorName(cur.text);
      break;
    case 'operator_cast': {
      const t = field(cur, 'type');
      if (!t) return null;
      name = 'operator ' + t.text.replace(/\s+/g, ' ');
      isFn = true;
      break;
    }
    case 'template_function':
    case 'template_method':
    case 'template_type':
      name = typeName(cur);
      break;
    default:
      return null;
  }
  if (!name || name.length > 100) return null;
  if (!name.startsWith('operator') && !/^~?[A-Za-z_$][\w$]*$/.test(name)) return null;
  return { name, qualifier: scopes.length ? scopes.join('::') : null, isFn, fn };
}

/**
 * Unwrap pointer / reference / array / parenthesized / init / function
 * declarators down to the declared name.
 */
function declared(d: Node | null): Declared | null {
  let cur = d;
  let fn: Node | null = null;
  let paren = false;
  for (let i = 0; cur && i < 24; i++) {
    switch (cur.type) {
      case 'function_declarator':
        fn = cur;
        paren = false;
        cur = field(cur, 'declarator');
        break;
      case 'parenthesized_declarator':
        paren = true;
        cur = cur.lastNamedChild;
        break;
      case 'pointer_declarator':
      case 'reference_declarator':
        // `(*name)(args)` is a pointer to function, not a function.
        if (paren) fn = null;
        cur = field(cur, 'declarator') ?? cur.lastNamedChild;
        break;
      case 'array_declarator':
      case 'init_declarator':
      case 'attributed_declarator':
        cur = field(cur, 'declarator') ?? cur.firstNamedChild;
        break;
      default:
        return leafName(cur, fn);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

interface Where {
  /** Inside a block (function body, lambda, statement expression). */
  local: boolean;
  /** Inside an anonymous namespace. */
  anon: boolean;
}

/**
 * `class EXPORT_MACRO Name { ... };` is parsed by tree-sitter as a function
 * definition: return type `class EXPORT_MACRO`, declarator `Name`, and the
 * class body as a block of statements. Returns the specifier node if so.
 */
function pseudoClass(fnDef: Node): Node | null {
  const d = field(fnDef, 'declarator');
  if (!d || (d.type !== 'identifier' && d.type !== 'type_identifier')) return null;
  const type = field(fnDef, 'type');
  if (!type || (type.type !== 'class_specifier' && type.type !== 'struct_specifier')) return null;
  return field(type, 'body') ? null : type;
}

function where(node: Node): Where {
  let anon = false;
  for (let p = node.parent; p; p = p.parent) {
    const t = p.type;
    if (t === 'compound_statement') {
      const owner = p.parent;
      if (owner && owner.type === 'function_definition' && pseudoClass(owner)) continue;
      return { local: true, anon };
    }
    if (t === 'namespace_definition' && !field(p, 'name')) anon = true;
  }
  return { local: false, anon };
}

/** Widen to enclosing template_declaration(s) so docs and `template<...>` are picked up. */
function outer(node: Node): Node {
  let cur = node;
  for (let p = cur.parent; p && p.type === 'template_declaration'; p = p.parent) cur = p;
  return cur;
}

function hasSpecifier(node: Node, type: string, re: RegExp): boolean {
  for (const c of node.namedChildren) {
    if (c && c.type === type && re.test(c.text)) return true;
  }
  return false;
}

const isStatic = (node: Node): boolean => hasSpecifier(node, 'storage_class_specifier', /^static$/);
const isExtern = (node: Node): boolean => hasSpecifier(node, 'storage_class_specifier', /^extern$/);
const isConst = (node: Node): boolean => hasSpecifier(node, 'type_qualifier', /^(const|constexpr)$/);

function inType(ctx: Ctx): boolean {
  const k = ctx.parentKind();
  return k === 'class' || k === 'struct';
}

/** Source from the start of `range` up to `end`, without trailing `;`, `{` or `=`. */
function sigText(ctx: Ctx, range: Node, end: number, stripAssign = false): string {
  const start = range.startIndex;
  const s = ctx.src.slice(start, Math.min(end, start + MAX_SIG_SOURCE));
  return s.replace(stripAssign ? /[\s;{=]+$/ : /[\s;{]+$/, '');
}

/**
 * Signature for a declaration whose type is an inline struct/enum body:
 * `struct cfg { ... } name` instead of the whole body.
 */
function declSig(ctx: Ctx, node: Node, range: Node, name: string, value: Node | null): string {
  const type = field(node, 'type');
  const body = type && CONTAINER_KIND[type.type] ? field(type, 'body') : null;
  if (body) return sigText(ctx, range, body.startIndex) + ' { ... } ' + name;
  return sigText(ctx, range, value ? value.startIndex : range.endIndex, value !== null);
}

/**
 * Preprocessor nodes end at column 0 of the following line, which makes the
 * generic doc lookup mistake a comment on that line for a trailing comment of
 * the directive. Recover the doc comment in that case:
 *
 *     #include "x.h"
 *     // documented
 *     int f(void);
 */
function docAfterPreproc(range: Node): string | undefined {
  let c = range.previousSibling;
  if (!c || c.type !== 'comment') return undefined;
  const parts: string[] = [];
  let nextRow = range.startPosition.row;
  while (c && c.type === 'comment' && c.endPosition.row >= nextRow - 1 && parts.length < 60) {
    parts.unshift(c.text);
    nextRow = c.startPosition.row;
    c = c.previousSibling;
  }
  if (!c || !c.type.startsWith('preproc_') || c.endPosition.column !== 0 || c.endPosition.row !== nextRow) return undefined;
  return parts.map(cleanComment).join('\n').trim() || undefined;
}

function define(ctx: Ctx, node: Node, opts: DefOpts): number {
  const doc = docAfterPreproc(opts.range ?? node);
  return ctx.def(node, doc ? { ...opts, doc } : opts);
}

// ---------------------------------------------------------------------------
// Receiver type hints
// ---------------------------------------------------------------------------

/**
 * Raw text of a declared type worth a hint, or null for primitives, `auto`,
 * decltype and anything large. Normalisation is left to ctx.typeHint().
 */
function typeText(type: Node | null): string | null {
  if (!type) return null;
  switch (type.type) {
    case 'type_identifier':
      return type.text;
    case 'qualified_identifier':
    case 'template_type':
      return type.endIndex - type.startIndex <= MAX_TYPE_TEXT ? type.text : null;
    case 'struct_specifier':
    case 'class_specifier':
    case 'union_specifier': {
      const name = field(type, 'name'); // `struct Foo *p`; never the text of a body
      return name && name.type === 'type_identifier' ? name.text : null;
    }
    default:
      return null;
  }
}

/** Templates whose first type argument is the type of the result. */
const TYPE_MAKERS = new Set([
  'make_unique', 'make_shared', 'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'static_pointer_cast', 'dynamic_pointer_cast', 'down_cast', 'MakeUnique', 'MakeShared',
]);

/** Type of an `auto` variable from its initializer: `new Foo(...)`, `std::make_unique<Foo>(...)`, `static_cast<Foo*>(p)`. */
function inferredType(value: Node | null): string | null {
  if (!value) return null;
  if (value.type === 'new_expression') return typeText(field(value, 'type'));
  if (value.type !== 'call_expression') return null;
  let fn = field(value, 'function');
  for (let i = 0; fn && fn.type === 'qualified_identifier' && i < 4; i++) fn = field(fn, 'name');
  if (!fn || fn.type !== 'template_function') return null;
  const name = field(fn, 'name');
  if (!name || !TYPE_MAKERS.has(name.text)) return null;
  const arg = field(fn, 'arguments')?.firstNamedChild;
  return arg && arg.endIndex - arg.startIndex <= MAX_TYPE_TEXT ? arg.text : null;
}

/** Name node of a plain / pointer / reference declarator; null for functions, arrays, bindings. */
function hintTarget(d: Node | null): Node | null {
  let cur = d;
  for (let i = 0; cur && i < 6; i++) {
    switch (cur.type) {
      case 'identifier':
      case 'field_identifier':
        return cur;
      case 'init_declarator':
      case 'pointer_declarator':
        cur = field(cur, 'declarator');
        break;
      case 'reference_declarator':
        cur = field(cur, 'declarator') ?? cur.lastNamedChild;
        break;
      default:
        return null;
    }
  }
  return null;
}

/** Hints for `Foo x;`, `Foo* p = ...`, `auto p = new Foo(...)`, `MemTable* mem_;` (declaration / field_declaration). */
function hintDeclaration(node: Node, ctx: Ctx): void {
  const type = field(node, 'type');
  if (!type) return;
  const auto = type.type === 'placeholder_type_specifier';
  const text = auto ? null : typeText(type);
  if (!auto && !text) return;
  for (const decl of node.childrenForFieldName('declarator')) {
    if (!decl) continue;
    const name = hintTarget(decl);
    if (!name) continue;
    if (!auto) ctx.typeHint(name.text, text);
    // `if (auto* p = new Foo)` keeps the value on the declaration itself.
    else ctx.typeHint(name.text, inferredType(field(decl.type === 'init_declarator' ? decl : node, 'value')));
  }
}

/** True for parameters of a function definition or lambda (not of prototypes or function pointer types). */
function ownedByDefinition(param: Node): boolean {
  let p = param.parent?.parent; // parameter_list > (abstract_)function_declarator
  if (!p) return false;
  if (p.type === 'abstract_function_declarator') return p.parent?.type === 'lambda_expression';
  for (let i = 0; p && i < 8; i++, p = p.parent) {
    if (p.type === 'function_definition') return true;
    if (!p.type.endsWith('_declarator')) return false;
  }
  return false;
}

const parameter: Visitor = (node, ctx) => {
  const text = typeText(field(node, 'type'));
  if (!text) return;
  const name = hintTarget(field(node, 'declarator'));
  if (name && ownedByDefinition(node)) ctx.typeHint(name.text, text);
};

/** `for (const Item& it : items)` */
const forRange: Visitor = (node, ctx) => {
  const text = typeText(field(node, 'type'));
  if (!text) return;
  const name = hintTarget(field(node, 'declarator'));
  if (name) ctx.typeHint(name.text, text);
};

// ---------------------------------------------------------------------------
// Visitors
// ---------------------------------------------------------------------------

/** `TEST(Suite, Name) { ... }` style macro-defined functions: name them by their arguments. */
function macroDefinedName(fn: Node | null): { name: string; qualifier: string | null } | null {
  const params = field(fn, 'parameters');
  if (!params || params.namedChildCount === 0 || params.namedChildCount > 2) return null;
  const parts: string[] = [];
  for (const p of params.namedChildren) {
    if (!p || p.type !== 'parameter_declaration' || p.namedChildCount !== 1) return null;
    if (p.firstNamedChild?.type !== 'type_identifier') return null;
    parts.push(p.text);
  }
  return parts.length === 2 ? { name: parts[1]!, qualifier: parts[0]! } : { name: parts[0]!, qualifier: null };
}

/**
 * Attribute macros confuse the parser: in `void ATTR(malloc) je_malloc(size_t n)`
 * it takes ATTR for the function. When the parsed name is a MACRO_NAME, prefer
 * the identifier in front of the last parameter list of the signature.
 */
function nameBehindMacros(name: string, sig: string): string {
  if (!isConstName(name)) return name;
  const m = /([A-Za-z_]\w*)\s*\([^()]*\)[\s\w]*$/.exec(sig);
  return m && !isConstName(m[1]!) ? m[1]! : name;
}

/**
 * Annotation macros after a declarator, as in
 * 'void Add(int n) LOCKS_EXCLUDED(mu_) { ... }' or 'int n_ GUARDED_BY(mu_);',
 * are parsed as a second function named after the macro, following a
 * declaration whose ';' is missing.
 */
function isTrailingAnnotation(node: Node, name: string): boolean {
  if (!isConstName(name) || field(node, 'type')) return false;
  const prev = node.previousSibling;
  if (!prev || (prev.type !== 'field_declaration' && prev.type !== 'declaration')) return false;
  return missingSemicolon(prev);
}

function missingSemicolon(decl: Node): boolean {
  const last = decl.lastChild;
  return !!last && last.type === ';' && last.endIndex === last.startIndex;
}

/**
 * 'MemTable* imm_ GUARDED_BY(mutex_);' with a non-primitive type is parsed as a
 * function GUARDED_BY whose real name sits in an ERROR node in front of the
 * function declarator. Returns that name node.
 */
function annotatedField(decl: Node): Node | null {
  let cur: Node | null = decl;
  for (let i = 0; cur && i < 6; i++) {
    const prev: Node | null = cur.previousSibling;
    if (prev && prev.type === 'ERROR') {
      const only = prev.namedChildCount === 1 ? prev.firstNamedChild : null;
      return only && only.type === 'identifier' ? only : null;
    }
    if (cur.type !== 'pointer_declarator' && cur.type !== 'reference_declarator') return null;
    cur = field(cur, 'declarator') ?? cur.lastNamedChild;
  }
  return null;
}

/** Signature of a declaration with parse errors: never run into a body. */
function cutAtBrace(sig: string): string {
  const b = sig.indexOf('{');
  return b > 0 ? sig.slice(0, b).trimEnd() : sig;
}

/** See pseudoClass(): recover the class and (best effort) its bases. */
function macroClass(node: Node, spec: Node, ctx: Ctx): void {
  const body = field(node, 'body');
  if (!body || ctx.inCallable()) return;
  // Text between 'class EXPORT_MACRO' and the body: 'Name [final] [: bases]'.
  const header = ctx.src.slice(spec.endIndex, Math.min(body.startIndex, spec.endIndex + MAX_SIG_SOURCE));
  const m = /^\s*([A-Za-z_]\w*)\s*(?:final\s*)?(?::(?!:)(.*))?$/s.exec(header);
  if (!m) return;
  const w = where(node);
  if (w.local) return;
  const range = outer(node);
  const sym = define(ctx, node, {
    name: m[1]!,
    kind: CONTAINER_KIND[spec.type] ?? 'class',
    range,
    sig: sigText(ctx, range, body.startIndex),
    exported: !w.anon,
  });
  if (!m[2]) return;
  for (const base of m[2].replace(/<[^<>]*>/g, '').split(',')) {
    const b = /([A-Za-z_]\w*)\s*$/.exec(base);
    if (b) ctx.inherit(sym, b[1], 'extends');
  }
}

const functionDefinition: Visitor = (node, ctx) => {
  const spec = pseudoClass(node);
  if (spec) return macroClass(node, spec, ctx);
  const d = declared(field(node, 'declarator'));
  if (!d) return;
  if (!d.isFn) {
    // `TEST_BEGIN(name) { ... }` at file level: type TEST_BEGIN, declarator `(name)`.
    const type = field(node, 'type');
    const paren = field(node, 'declarator')?.type === 'parenthesized_declarator';
    if (!paren || type?.type !== 'type_identifier' || !isConstName(type.text) || !field(node, 'body')) return;
  }
  if (isTrailingAnnotation(node, d.name)) return;
  const w = where(node);
  if (w.local) return;
  const member = inType(ctx);
  let { name, qualifier } = d;
  const range = outer(node);
  const end = childOfType(node, 'field_initializer_list') ?? field(node, 'body');
  let sig = sigText(ctx, range, end ? end.startIndex : range.endIndex);
  if (node.hasError) sig = cutAtBrace(sig);
  if (!member && !qualifier && isConstName(name)) {
    const real = nameBehindMacros(name, sig);
    if (real !== name) {
      name = real;
    } else {
      const m = macroDefinedName(d.fn);
      if (m) ({ name, qualifier } = m);
    }
  }
  define(ctx, node, {
    name,
    kind: member || d.qualifier ? 'method' : 'function',
    range,
    sig,
    qualifier,
    exported: !w.anon && (member || !isStatic(node)),
  });
};

/** Shared by `declaration` (file / namespace / class level) and `field_declaration`. */
function declare(node: Node, ctx: Ctx, isField: boolean): void {
  if (!isField) hintDeclaration(node, ctx); // locals too
  if (ctx.inCallable()) return;
  const decls = node.childrenForFieldName('declarator');
  if (decls.length === 0) return;
  if (node.parent?.type === 'friend_declaration') return;
  const member = inType(ctx);
  if (isField && !member) return; // members of an anonymous aggregate without a symbol
  const w = where(node);
  if (w.local) return;
  const range = outer(node);
  const exported = !w.anon && (member || !isStatic(node));
  // Macro-heavy code: a declaration with parse errors is only trusted for prototypes.
  // (A lone missing ';' is harmless: 'int n_ GUARDED_BY(mu_);'.)
  const broken = node.hasError && !missingSemicolon(node);
  if (isField) hintDeclaration(node, ctx);
  // `int a, b, c;` members: one symbol each with signature `int a`, not the whole line.
  const type = decls.length > 1 && member ? field(node, 'type') : null;
  const head = type && !(CONTAINER_KIND[type.type] && field(type, 'body')) ? sigText(ctx, range, decls[0]!.startIndex) : '';

  for (const decl of decls) {
    if (!decl) continue;
    const d = declared(decl);
    if (!d) continue;
    if (d.isFn) {
      if (isTrailingAnnotation(node, d.name)) continue;
      let sig = sigText(ctx, range, range.endIndex);
      if (node.hasError) sig = cutAtBrace(sig);
      const real = isField && node.hasError && isConstName(d.name) ? annotatedField(decl) : null;
      if (real) {
        define(ctx, node, { name: real.text, kind: 'field', range, sig, exported, scope: false });
        ctx.typeHint(real.text, typeText(field(node, 'type')));
        continue;
      }
      define(ctx, node, {
        name: d.qualifier ? d.name : nameBehindMacros(d.name, sig),
        kind: member ? 'method' : 'declaration',
        range,
        sig,
        qualifier: d.qualifier,
        exported,
        scope: false,
      });
      continue;
    }
    // `T (x);` is almost always a misparsed call or constructor initializer.
    const inner = decl.type === 'init_declarator' ? field(decl, 'declarator') : decl;
    if (broken || inner?.type === 'parenthesized_declarator') continue;
    const value = decl.type === 'init_declarator' ? field(decl, 'value') : null;
    if (member) {
      const sig = head && inner
        ? head + ' ' + (inner.endIndex - inner.startIndex <= 80 ? inner.text.replace(/\s+/g, ' ') : d.name)
        : declSig(ctx, node, range, d.name, null);
      define(ctx, node, { name: d.name, kind: 'field', range, sig, exported, scope: false });
      continue;
    }
    if (!value && isExtern(node)) continue; // forward declaration of a global defined elsewhere
    if (value && value.type === 'lambda_expression' && decls.length === 1) {
      const body = field(value, 'body');
      define(ctx, node, {
        name: d.name,
        kind: 'function',
        range,
        sig: sigText(ctx, range, body ? body.startIndex : range.endIndex),
        qualifier: d.qualifier,
        exported,
      });
      continue;
    }
    define(ctx, node, {
      name: d.name,
      kind: isConst(node) || isConstName(d.name) ? 'constant' : 'variable',
      range,
      sig: declSig(ctx, node, range, d.name, value),
      qualifier: d.qualifier,
      exported,
      scope: false,
    });
  }
}

const declaration: Visitor = (node, ctx) => declare(node, ctx, false);
const fieldDeclaration: Visitor = (node, ctx) => declare(node, ctx, true);

function heritage(node: Node, sym: number, ctx: Ctx): void {
  const clause = childOfType(node, 'base_class_clause');
  if (!clause) return;
  for (const b of clause.namedChildren) {
    if (!b || b.type === 'access_specifier') continue;
    const name = typeName(b);
    if (name) ctx.inherit(sym, name, 'extends');
  }
}

const container: Visitor = (node, ctx) => {
  const body = field(node, 'body');
  const nameNode = field(node, 'name');
  // No body: a type reference. No name: anonymous, or named by an enclosing typedef.
  if (!body || !nameNode || ctx.inCallable()) return;
  const named = leafName(nameNode, null); // `struct Outer::Inner { }` keeps its qualifier
  if (!named) return;
  const w = where(node);
  if (w.local) return;
  const p = node.parent;
  const wrapped = p && (p.type === 'type_definition' || p.type === 'declaration' || p.type === 'field_declaration');
  const range = outer(wrapped ? p : node);
  if (named.qualifier) for (const q of named.qualifier.split('::')) ctx.scope(q);
  const sym = define(ctx, node, {
    name: named.name,
    kind: CONTAINER_KIND[node.type] ?? 'struct',
    range,
    sig: sigText(ctx, range, body.startIndex),
    exported: !w.anon,
  });
  heritage(node, sym, ctx);
};

const typeDefinition: Visitor = (node, ctx) => {
  if (ctx.inCallable()) return;
  const w = where(node);
  if (w.local) return;
  const type = field(node, 'type');
  const kind = type ? CONTAINER_KIND[type.type] : undefined;
  const body = kind ? field(type, 'body') : null;
  const tagName = body ? field(type, 'name')?.text : undefined;
  const head = body ? sigText(ctx, node, body.startIndex) + ' { ... } ' : '';
  // `typedef struct { ... } Foo;` - the first plain declarator names the aggregate.
  let adopt: { name: string } | null = null;

  for (const decl of node.childrenForFieldName('declarator')) {
    if (!decl) continue;
    const d = declared(decl);
    if (!d) continue;
    if (body && !tagName && !adopt && decl.type === 'type_identifier') {
      adopt = { name: d.name };
      continue;
    }
    if (d.name === tagName && decl.type === 'type_identifier') continue; // typedef struct foo {...} foo;
    define(ctx, node, {
      name: d.name,
      kind: 'type',
      sig: body ? head + (decl.endIndex - decl.startIndex < 80 ? decl.text : d.name) : sigText(ctx, node, node.endIndex),
      exported: !w.anon,
      scope: false,
    });
  }
  // Opened last so the aliases above are not nested under it; members are.
  if (adopt) define(ctx, node, { name: adopt.name, kind: kind!, sig: head + adopt.name, exported: !w.anon });
};

const aliasDeclaration: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || ctx.inCallable()) return;
  const w = where(node);
  if (w.local) return;
  const range = outer(node);
  define(ctx, node, { name: name.text, kind: 'type', range, sig: sigText(ctx, range, range.endIndex), exported: !w.anon, scope: false });
};

const enumerator: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || ctx.inCallable()) return;
  // Enumerators of an anonymous enum land in the enclosing scope.
  if (ctx.parentKind() !== 'enum' && where(node).local) return;
  define(ctx, node, { name: name.text, kind: 'constant', sig: sigText(ctx, node, node.endIndex), exported: true, scope: false });
};

const namespaceDefinition: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return; // anonymous namespace: no symbol, no scope
  const parts = nameNode.text.split('::').map(s => s.trim()).filter(Boolean);
  const name = parts.pop();
  if (!name) return;
  for (const p of parts) ctx.scope(p); // namespace a::b { }
  define(ctx, node, { name, kind: 'namespace', sig: sigText(ctx, node, nameNode.endIndex), exported: !where(node).anon });
};

const macro: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode || ctx.inCallable()) return;
  const name = nameNode.text;
  const params = field(node, 'parameters');
  let sig = '#define ' + name;
  if (params) {
    sig += params.text;
  } else {
    const value = field(node, 'value');
    if (!value) {
      if (/_H(PP|XX)?_*$/i.test(name)) return; // include guard
    } else if (value.endIndex - value.startIndex <= 80) {
      const v = value.text.trim();
      if (!v.includes('\n')) sig += ' ' + v;
    }
  }
  define(ctx, node, { name, kind: 'macro', sig, exported: true, scope: false });
};

const include: Visitor = (node, ctx) => {
  const path = field(node, 'path');
  if (!path || (path.type !== 'string_literal' && path.type !== 'system_lib_string')) return;
  // System includes keep their brackets (`<math.h>`) so they are never matched to project files.
  ctx.imp(path.type === 'system_lib_string' ? path.text : stripQuotes(path.text), node);
};

const callExpression: Visitor = (node, ctx) => {
  const fn = field(node, 'function');
  if (!fn) return;
  switch (fn.type) {
    case 'identifier':
      ctx.call(fn.text, node);
      break;
    case 'field_expression':
      ctx.call(typeName(field(fn, 'field')), node, simpleReceiver(field(fn, 'argument')));
      break;
    case 'qualified_identifier': {
      const scopes: string[] = [];
      let cur: Node | null = fn;
      for (let i = 0; cur && cur.type === 'qualified_identifier' && i < 12; i++) {
        const s = typeName(field(cur, 'scope'));
        if (s) scopes.push(s);
        cur = field(cur, 'name');
      }
      if (!cur) break;
      const name = cur.type === 'destructor_name' ? cur.text : typeName(cur);
      ctx.call(name, node, scopes.length ? scopes.join('::') : null);
      break;
    }
    case 'template_function':
      ctx.call(typeName(fn), node);
      break;
  }
};

const newExpression: Visitor = (node, ctx) => {
  ctx.call(typeName(field(node, 'type')), node);
};

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const cVisitors: Record<string, Visitor> = {
  function_definition: functionDefinition,
  declaration,
  field_declaration: fieldDeclaration,
  struct_specifier: container,
  union_specifier: container,
  enum_specifier: container,
  enumerator,
  type_definition: typeDefinition,
  preproc_def: macro,
  preproc_function_def: macro,
  preproc_include: include,
  call_expression: callExpression,
  parameter_declaration: parameter,
};

const cppVisitors: Record<string, Visitor> = {
  ...cVisitors,
  class_specifier: container,
  alias_declaration: aliasDeclaration,
  namespace_definition: namespaceDefinition,
  new_expression: newExpression,
  optional_parameter_declaration: parameter,
  for_range_loop: forRange,
};

const C_IDENTIFIERS = ['identifier', 'type_identifier', 'field_identifier'];

const CPP_HINT = new RegExp(
  [
    String.raw`^[ \t]*(?:template\s*<[^;{]*>\s*)?class\s+[A-Za-z_]\w*\s*(?:final\s*)?(?:[:{;]|$)`,
    String.raw`^[ \t]*(?:inline\s+)?namespace(?:\s+[\w:]+)?\s*\{`,
    String.raw`^[ \t]*using\s+(?:namespace\s+)?[\w:]+\s*[;=]`,
    String.raw`^[ \t]*template\s*<`,
    String.raw`^[ \t]*(?:public|private|protected)\s*:`,
    String.raw`[A-Za-z_]\w*::[A-Za-z_~]`,
    String.raw`^[ \t]*#[ \t]*include[ \t]*<(?:string|vector|memory|map|set|iostream|algorithm|functional|utility|cstdint|cstddef|cstdio|cstdlib|cstring|atomic|mutex|array|unordered_map|type_traits)>`,
  ].join('|'),
  'm',
);

export const c: LangSpec = {
  id: 'c',
  lowercaseTypes: true,
  grammar: 'c',
  extensions: ['.c', '.h'],
  identifiers: C_IDENTIFIERS,
  visit: cVisitors,
  /** `.h` files are shared with C++: parse them as C++ when they look like it. */
  sniff(source, path) {
    if (!/\.h$/i.test(path)) return undefined;
    const head = source.length > 20000 ? source.slice(0, 20000) : source;
    return CPP_HINT.test(head) ? 'cpp' : undefined;
  },
};

export const cpp: LangSpec = {
  id: 'cpp',
  lowercaseTypes: true,
  grammar: 'cpp',
  extensions: ['.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx', '.inl', '.ipp'],
  identifiers: [...C_IDENTIFIERS, 'namespace_identifier'],
  visit: cppVisitors,
};

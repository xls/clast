import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { COMPLEX_RECEIVER, field } from '../spec.js';
import type { SymbolKind } from '../../types.js';

// Namespaces are deliberately not visited: `namespace X;` and `namespace X { }`
// neither create a symbol nor a qualified-name prefix, so qnames are
// `Class.method` regardless of the namespace form.

/** `Foo` / `\A\B\Foo` / `namespace\Foo` -> `Foo`. */
function shortName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'name') return node.text;
  if (node.type === 'qualified_name') {
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const c = node.namedChild(i);
      if (c && c.type === 'name') return c.text;
    }
  }
  return null;
}

/** Literal content of a plain (non-interpolated) string, else null. */
function literal(node: Node | null | undefined): string | null {
  if (!node || (node.type !== 'string' && node.type !== 'encapsed_string')) return null;
  if (node.namedChildCount !== 1) return null;
  const c = node.namedChild(0);
  return c && c.type === 'string_content' ? c.text : null;
}

/** First visibility keyword among the direct children, or null. */
function visibility(node: Node): string | null {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'visibility_modifier') return c.text;
    // Modifiers always precede the name / elements.
    if (c.type === 'name' || c.type === 'property_element' || c.type === 'const_element' || c.type === 'formal_parameters') break;
  }
  return null;
}

function isPublic(node: Node): boolean {
  const v = visibility(node);
  // `public(set)`-style asymmetric visibility still reads as public.
  return v === null || v.startsWith('public');
}

/** Start of the declaration proper, skipping leading `#[Attributes]`. */
function declStart(node: Node): number {
  const attrs = field(node, 'attributes');
  if (!attrs || attrs.startIndex !== node.startIndex) return node.startIndex;
  const next = attrs.nextSibling;
  return next ? next.startIndex : attrs.endIndex;
}

/** Signature: declaration text without attributes, up to the body. */
function signature(node: Node, ctx: Ctx, body: Node | null = field(node, 'body')): string {
  const start = declStart(node);
  let end = body && body.startIndex > start ? body.startIndex : node.endIndex;
  if (end - start > 400) end = start + 400;
  return ctx.src.slice(start, end).replace(/\s*[;{]\s*$/, '');
}

/** base_clause -> extends, class_interface_clause -> implements, `use Trait;` -> implements. */
function heritage(node: Node, body: Node | null, sym: number, ctx: Ctx): void {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'base_clause') {
      for (const n of c.namedChildren) ctx.inherit(sym, shortName(n), 'extends');
    } else if (c.type === 'class_interface_clause') {
      for (const n of c.namedChildren) ctx.inherit(sym, shortName(n), 'implements');
    }
  }
  if (!body) return;
  for (const m of body.namedChildren) {
    if (!m) continue;
    if (m.type === 'use_declaration') {
      for (const n of m.namedChildren) ctx.inherit(sym, shortName(n), 'implements');
    } else if (m.type === 'method_declaration') {
      promotedProperties(m, ctx);
    }
  }
}

/** `__construct(private Foo $foo)` declares property `foo` on the class. */
function promotedProperties(method: Node, ctx: Ctx): void {
  const params = field(method, 'parameters');
  if (!params || params.namedChildCount === 0) return;
  const name = field(method, 'name');
  if (!name || name.text.toLowerCase() !== '__construct') return;
  for (const p of params.namedChildren) {
    if (!p || p.type !== 'property_promotion_parameter') continue;
    const v = field(p, 'name');
    if (!v) continue;
    const vis = field(p, 'visibility')?.text ?? null;
    ctx.def(p, {
      name: v.text.replace(/^&?\s*\$/, ''),
      kind: 'property',
      sig: ctx.src.slice(declStart(p), v.endIndex),
      exported: vis === null || vis.startsWith('public'),
      scope: false,
    });
  }
}

const typeDecl = (kind: SymbolKind): Visitor => (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const body = field(node, 'body');
  const sym = ctx.def(node, { name: name.text, kind, sig: signature(node, ctx, body), exported: true });
  heritage(node, body, sym, ctx);
};

/** `new class(...) extends Base { ... }` (Laravel migrations, test doubles). */
const anonymousClass: Visitor = (node, ctx) => {
  const body = field(node, 'body');
  const sym = ctx.def(node, { name: 'class@anonymous', kind: 'class', sig: signature(node, ctx, body), exported: false });
  heritage(node, body, sym, ctx);
};

// ---------------------------------------------------------------------------
// Receiver type hints
// ---------------------------------------------------------------------------

const varName = (node: Node): string => node.text.replace(/^&?\s*(\.\.\.)?\s*\$/, '');

/** Docblock types that denote a single class: no arrays, generics or shapes. */
function docType(raw: string): string | null {
  return /[\[<{(]/.test(raw) ? null : raw;
}

/** Typed parameter -> local hint; a promoted constructor parameter is also a field. */
function paramHint(p: Node, ctx: Ctx): void {
  const type = field(p, 'type');
  if (!type) return;
  const name = field(p, 'name');
  if (!name) return;
  const n = varName(name);
  const t = type.text;
  ctx.typeHint(n, t);
  if (p.type === 'property_promotion_parameter') ctx.typeHint(n, t, true);
}

/**
 * Hints for the parameters of a named function / method: declared types
 * first, then `@param Foo $x` from the docblock for the untyped ones (the
 * first hint for a name wins).
 */
function signatureHints(node: Node, ctx: Ctx): void {
  const params = field(node, 'parameters');
  if (!params || params.namedChildCount === 0) return;
  for (const p of params.namedChildren) {
    if (p && (p.type === 'simple_parameter' || p.type === 'property_promotion_parameter')) paramHint(p, ctx);
  }
  const doc = node.previousSibling;
  if (!doc || doc.type !== 'comment') return;
  const text = doc.text;
  if (!text.includes('@param')) return;
  for (const m of text.matchAll(/@param\s+(\S+)\s+(?:\.\.\.)?\$(\w+)/g)) {
    ctx.typeHint(m[2], docType(m[1]!));
  }
}

/** Parameters of closures and arrow functions (named functions are handled by their own visitor). */
const parameter: Visitor = (node, ctx) => {
  const owner = node.parent?.parent;
  if (owner && (owner.type === 'method_declaration' || owner.type === 'function_definition')) return;
  paramHint(node, ctx);
};

/** Class named by a `new Foo(...)` expression: `Foo`, or null for anonymous / dynamic classes. */
function createdClass(node: Node): string | null {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'name' || c.type === 'qualified_name') return shortName(c);
    if (c.type === 'arguments' || c.type === 'anonymous_class') return null;
  }
  return null;
}

/**
 * `$x = new Foo(...)` -> local hint; `$this->x = new Foo(...)` -> field hint;
 * `$this->x = $x` -> the field takes the declared type of the parameter `$x`.
 */
const assignmentExpr: Visitor = (node, ctx) => {
  const right = field(node, 'right');
  if (!right) return;
  const isNew = right.type === 'object_creation_expression';
  if (!isNew && right.type !== 'variable_name') return;
  const left = field(node, 'left');
  if (!left) return;
  if (left.type === 'variable_name') {
    if (isNew) ctx.typeHint(varName(left), createdClass(right));
  } else if (left.type === 'member_access_expression') {
    const obj = field(left, 'object');
    const name = field(left, 'name');
    if (obj && name && obj.type === 'variable_name' && name.type === 'name' && obj.text === '$this') {
      ctx.typeHint(name.text, isNew ? createdClass(right) : ctx.typeOf(varName(right)), true);
    }
  }
};

/** `catch (FooException $e)`; multi-catch is ambiguous and skipped. */
const catchClause: Visitor = (node, ctx) => {
  const type = field(node, 'type');
  const name = field(node, 'name');
  if (!type || !name || type.namedChildCount !== 1) return;
  ctx.typeHint(varName(name), type.text);
};

/** Inline `@var Foo $x` annotations (short comments only, to stay cheap). */
const comment: Visitor = (node, ctx) => {
  if (node.endIndex - node.startIndex > 120) return;
  const m = /@var\s+(\S+)\s+\$(\w+)/.exec(node.text);
  if (m) ctx.typeHint(m[2], docType(m[1]!));
};

const functionDef: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'function', sig: signature(node, ctx), exported: true });
  signatureHints(node, ctx);
};

const methodDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'method', sig: signature(node, ctx), exported: isPublic(node) });
  signatureHints(node, ctx);
};

/** `protected static ?string $a = 1, $b;` -> one property per element. */
const propertyDecl: Visitor = (node, ctx) => {
  const exported = isPublic(node);
  // Declared type, else a `@var Foo` docblock (the usual style in pre-7.4 code).
  let type: string | null = field(node, 'type')?.text ?? null;
  if (type === null) {
    const doc = node.previousSibling;
    if (doc && doc.type === 'comment') {
      const m = /@var\s+(\S+)/.exec(doc.text);
      if (m) type = docType(m[1]!);
    }
  }
  let prefix: string | null = null;
  for (const el of node.namedChildren) {
    if (!el || el.type !== 'property_element') continue;
    const v = field(el, 'name') ?? el.namedChild(0);
    if (!v) continue;
    if (type) ctx.typeHint(varName(v), type);
    if (prefix === null) prefix = ctx.src.slice(declStart(node), el.startIndex);
    ctx.def(el, {
      name: v.text.replace(/^&?\s*\$/, ''),
      kind: 'property',
      range: node,
      sig: prefix + v.text,
      exported,
      scope: false,
    });
  }
};

/** `const A = 1, B = 2;` at file level or in a class / interface / enum. */
const constDecl: Visitor = (node, ctx) => {
  const exported = isPublic(node);
  let prefix: string | null = null;
  for (const el of node.namedChildren) {
    if (!el || el.type !== 'const_element') continue;
    const n = el.namedChild(0);
    if (!n || n.type !== 'name') continue;
    if (prefix === null) prefix = ctx.src.slice(declStart(node), el.startIndex);
    const text = el.endIndex - el.startIndex > 160 ? n.text : el.text;
    ctx.def(el, { name: n.text, kind: 'constant', range: node, sig: prefix + text, exported, scope: false });
  }
};

const enumCase: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'constant', sig: signature(node, ctx, null), exported: true, scope: false });
};

const functionCall: Visitor = (node, ctx) => {
  const fn = field(node, 'function');
  if (!fn) return;
  const name = shortName(fn);
  if (!name) return;
  if (name === 'define') {
    // define('NAME', value) declares a global constant.
    const stmt = node.parent;
    const first = field(node, 'arguments')?.namedChild(0);
    const lit = literal(first?.type === 'argument' ? first.namedChild(0) : first);
    if (lit && /^[A-Za-z_\\][\w\\]*$/.test(lit)) {
      const range = stmt && stmt.type === 'expression_statement' ? stmt : node;
      const short = lit.slice(lit.lastIndexOf('\\') + 1);
      let end = node.endIndex;
      const nl = ctx.src.indexOf('\n', node.startIndex);
      if (nl !== -1 && nl < end) end = nl;
      ctx.def(node, {
        name: short,
        kind: 'constant',
        range,
        sig: ctx.src.slice(node.startIndex, end),
        exported: true,
        scope: false,
      });
      return;
    }
  }
  ctx.call(name, node);
};

/**
 * Receiver of a member call: `$user`, `$this`, `$this->repo` as text;
 * `(new Foo(...))->bar()` -> `Foo` (resolves like a static-style call);
 * anything else (call chains, indexing, ...) -> COMPLEX_RECEIVER. Never null:
 * a member call must not be mistaken for a bare `foo()` call.
 */
function receiverOf(node: Node | null): string {
  if (!node) return COMPLEX_RECEIVER;
  switch (node.type) {
    case 'variable_name':
    case 'member_access_expression':
    case 'nullsafe_member_access_expression':
    case 'scoped_property_access_expression':
    case 'relative_scope': {
      if (node.endIndex - node.startIndex > 48) return COMPLEX_RECEIVER;
      const t = node.text.replace('?->', '->');
      return /[\s(\[{'"]/.test(t) ? COMPLEX_RECEIVER : t;
    }
    case 'name':
    case 'qualified_name':
      return shortName(node) ?? COMPLEX_RECEIVER;
    case 'parenthesized_expression': {
      const inner = node.namedChild(0);
      return (inner && inner.type === 'object_creation_expression' && createdClass(inner)) || COMPLEX_RECEIVER;
    }
    case 'object_creation_expression':
      // PHP 8.4: `new Foo()->bar()`.
      return createdClass(node) || COMPLEX_RECEIVER;
    default:
      return COMPLEX_RECEIVER;
  }
}

const memberCall: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || name.type !== 'name') return;
  ctx.call(name.text, node, receiverOf(field(node, 'object')));
};

const scopedCall: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || name.type !== 'name') return;
  const scope = field(node, 'scope');
  // `Foo::bar()`, `\A\Foo::bar()` -> receiver Foo; parent/self/static kept as is.
  ctx.call(name.text, node, receiverOf(scope));
};

const RELATIVE = new Set(['static', 'self', 'parent']);

const objectCreation: Visitor = (node, ctx) => {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'name' || c.type === 'qualified_name') {
      const name = shortName(c);
      if (name && !RELATIVE.has(name)) ctx.call(name, node);
      return;
    }
    if (c.type === 'arguments' || c.type === 'anonymous_class') return;
  }
};

/** `use A\B;`, `use A\B as C, D\E;`, `use A\{B, C as D};`, `use function A\f;` */
const useDecl: Visitor = (node, ctx) => {
  let prefix = '';
  let group: Node | null = null;
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'namespace_name') prefix = c.text.replace(/^\\+|\\+$/g, '') + '\\';
    else if (c.type === 'namespace_use_group') group = c;
  }
  for (const clause of (group ?? node).namedChildren) {
    if (!clause || clause.type !== 'namespace_use_clause') continue;
    let target: Node | null = null;
    for (const c of clause.namedChildren) {
      if (c && (c.type === 'qualified_name' || c.type === 'name')) { target = c; break; }
    }
    if (!target) continue;
    const full = prefix + target.text.replace(/^\\+/, '').replace(/\s+/g, '');
    const original = full.slice(full.lastIndexOf('\\') + 1);
    const alias = field(clause, 'alias')?.text;
    // `use Contracts\Pipeline as PipelineContract`: bind the alias, remember what it stands for.
    ctx.imp(full, node, [alias && alias !== original ? `${alias}=${original}` : original]);
  }
};

/** `require 'x.php'`, `include_once __DIR__ . '/x.php'` */
const includeExpr: Visitor = (node, ctx) => {
  let arg = node.namedChild(0);
  if (arg && arg.type === 'parenthesized_expression') arg = arg.namedChild(0);
  if (!arg) return;
  const lit = literal(arg);
  if (lit) {
    ctx.imp(lit, node);
    return;
  }
  if (arg.type === 'binary_expression') {
    // __DIR__ . '/x.php' is relative to the including file.
    const left = field(arg, 'left');
    const right = literal(field(arg, 'right'));
    if (right && left && left.type === 'name' && left.text === '__DIR__') {
      ctx.imp('.' + (right.startsWith('/') ? right : '/' + right), node);
    }
  }
};

export const php: LangSpec = {
  id: 'php',
  grammar: 'php',
  extensions: ['.php'],
  identifiers: ['name'],
  comments: ['comment'],
  visit: {
    class_declaration: typeDecl('class'),
    interface_declaration: typeDecl('interface'),
    trait_declaration: typeDecl('trait'),
    enum_declaration: typeDecl('enum'),
    anonymous_class: anonymousClass,
    function_definition: functionDef,
    method_declaration: methodDecl,
    simple_parameter: parameter,
    property_promotion_parameter: parameter,
    assignment_expression: assignmentExpr,
    catch_clause: catchClause,
    comment,
    property_declaration: propertyDecl,
    const_declaration: constDecl,
    enum_case: enumCase,
    function_call_expression: functionCall,
    member_call_expression: memberCall,
    nullsafe_member_call_expression: memberCall,
    scoped_call_expression: scopedCall,
    object_creation_expression: objectCreation,
    namespace_use_declaration: useDecl,
    require_expression: includeExpr,
    require_once_expression: includeExpr,
    include_expression: includeExpr,
    include_once_expression: includeExpr,
  },
};

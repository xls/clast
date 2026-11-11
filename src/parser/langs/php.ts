import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field } from '../spec.js';
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

const functionDef: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'function', sig: signature(node, ctx), exported: true });
};

const methodDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'method', sig: signature(node, ctx), exported: isPublic(node) });
};

/** `protected static ?string $a = 1, $b;` -> one property per element. */
const propertyDecl: Visitor = (node, ctx) => {
  const exported = isPublic(node);
  let prefix: string | null = null;
  for (const el of node.namedChildren) {
    if (!el || el.type !== 'property_element') continue;
    const v = field(el, 'name') ?? el.namedChild(0);
    if (!v) continue;
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

/** Receiver text when it is short: `$this`, `$this->repo`, `$user`. */
function receiverOf(node: Node | null): string | null {
  if (!node || node.endIndex - node.startIndex > 40) return null;
  const t = node.text;
  return /[\s(]/.test(t) ? null : t;
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
  ctx.call(name.text, node, shortName(scope) ?? receiverOf(scope));
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
    const alias = field(clause, 'alias')?.text ?? full.slice(full.lastIndexOf('\\') + 1);
    ctx.imp(full, node, [alias]);
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

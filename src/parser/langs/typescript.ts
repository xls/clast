import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { childOfType, field, isConstName, lastSegment, simpleReceiver, stripQuotes } from '../spec.js';

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

function isExported(node: Node): Node | null {
  const p = node.parent;
  return p && p.type === 'export_statement' ? p : null;
}

/** True if a declaration sits directly in a module or namespace body. */
function isTopLevel(decl: Node | null): boolean {
  let p = decl?.parent;
  if (p && p.type === 'export_statement') p = p.parent;
  if (!p) return false;
  if (p.type === 'program') return true;
  if (p.type === 'statement_block') {
    const owner = p.parent?.type;
    return owner === 'internal_module' || owner === 'module';
  }
  return false;
}

function classHeritage(node: Node, sym: number, ctx: Ctx): void {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'class_heritage') {
      // TS: class_heritage > extends_clause / implements_clause. JS: class_heritage > expression.
      let found = false;
      for (const h of c.namedChildren) {
        if (!h) continue;
        if (h.type === 'extends_clause') {
          found = true;
          for (const v of h.childrenForFieldName('value')) if (v) ctx.inherit(sym, lastSegment(v.text), 'extends');
        } else if (h.type === 'implements_clause') {
          found = true;
          for (const t of h.namedChildren) if (t) ctx.inherit(sym, lastSegment(t.text.replace(/<.*$/s, '')), 'implements');
        }
      }
      if (!found && c.namedChildren[0]) ctx.inherit(sym, lastSegment(c.namedChildren[0].text), 'extends');
    } else if (c.type === 'extends_type_clause' || c.type === 'extends_clause') {
      for (const t of c.namedChildren) if (t) ctx.inherit(sym, lastSegment(t.text.replace(/<.*$/s, '')), 'extends');
    }
  }
}

const classLike = (kind: 'class' | 'interface'): Visitor => (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const exp = isExported(node);
  const sym = ctx.def(node, { name: name.text, kind, range: exp ?? node, exported: !!exp });
  classHeritage(node, sym, ctx);
};

const functionDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const exp = isExported(node);
  ctx.def(node, {
    name: name.text,
    kind: ctx.parentKind() === 'class' ? 'method' : 'function',
    range: exp ?? node,
    exported: !!exp,
  });
};

const method: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  // Class members and object-literal members alike: called through an object.
  ctx.def(node, { name: name.text.replace(/^['"]|['"]$/g, ''), kind: 'method' });
};

const fieldDef: Visitor = (node, ctx) => {
  const name = field(node, 'name') ?? field(node, 'property');
  if (!name) return;
  const value = field(node, 'value');
  const isFn = value && FUNCTION_VALUES.has(value.type);
  ctx.def(node, {
    name: name.text,
    kind: isFn ? 'method' : 'property',
    body: isFn ? field(value, 'body') : null,
  });
  ctx.typeHint(name.text, declaredType(node, value));
};

/** Type text of a declaration: its annotation, or the class of a `new X()` initializer. */
function declaredType(node: Node, value: Node | null): string | null {
  const annotation = field(node, 'type');
  if (annotation) return annotation.text;
  if (value && value.type === 'new_expression') return field(value, 'constructor')?.text ?? null;
  return null;
}

/** Parameters with type annotations; constructor parameter properties also declare a field. */
const parameter: Visitor = (node, ctx) => {
  const pattern = field(node, 'pattern');
  const type = field(node, 'type');
  if (!pattern || pattern.type !== 'identifier' || !type) return;
  ctx.typeHint(pattern.text, type.text);
  // `constructor(@IFoo private readonly foo: IFoo)`: a parameter property is also a field.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || c === pattern) break;
    if (c.type === 'accessibility_modifier' || c.type === 'readonly' || c.type === 'override_modifier') {
      ctx.typeHint(pattern.text, type.text, true);
      break;
    }
  }
};

/** `@memoize` / `@ns.decorator`: applying a decorator calls it. (`@foo()` is a call_expression already.) */
const decorator: Visitor = (node, ctx) => {
  const expr = node.namedChildren[0];
  if (!expr) return;
  if (expr.type === 'identifier') ctx.call(expr.text, node);
  else if (expr.type === 'member_expression') {
    ctx.call(field(expr, 'property')?.text, node, simpleReceiver(field(expr, 'object')));
  }
};

const HANDLED_FUNCTION_PARENTS = new Set([
  'variable_declarator', 'assignment_expression', 'pair', 'public_field_definition', 'field_definition',
]);

/** Named function expressions used as values: `defineGetter(req, 'ip', function ip() {})`. */
const functionExpression: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || (node.parent && HANDLED_FUNCTION_PARENTS.has(node.parent.type))) return;
  ctx.def(node, { name: name.text, kind: 'function' });
};

/** Module path if `value` is `require('x')` or `require('x').member`, else null. */
function requireSource(value: Node | null): string | null {
  let call = value;
  if (call && call.type === 'member_expression') call = field(call, 'object');
  if (!call || call.type !== 'call_expression' || field(call, 'function')?.text !== 'require') return null;
  const arg = field(call, 'arguments')?.namedChildren[0];
  return arg && arg.type === 'string' ? stripQuotes(arg.text) : null;
}

const variableDeclarator: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  const value = field(node, 'value');
  if (nameNode && nameNode.type === 'object_pattern') {
    // const { a, b: c } = require('./x')
    const source = requireSource(value);
    if (source) {
      const names: string[] = [];
      for (const p of nameNode.namedChildren) {
        if (!p) continue;
        if (p.type === 'shorthand_property_identifier_pattern') names.push(p.text);
        else if (p.type === 'pair_pattern') {
          const key = field(p, 'key')?.text;
          const bound = field(p, 'value');
          if (key && bound && bound.type === 'identifier') names.push(bound.text === key ? key : `${bound.text}=${key}`);
        }
      }
      ctx.imp(source, node, names);
    }
    return;
  }
  if (!nameNode || nameNode.type !== 'identifier') return;
  const decl = node.parent; // lexical_declaration | variable_declaration
  const exp = decl ? isExported(decl) : null;
  const range = exp ?? (decl && decl.namedChildCount === 1 ? decl : node);
  const name = nameNode.text;
  ctx.typeHint(name, declaredType(node, value));

  if (value && FUNCTION_VALUES.has(value.type)) {
    ctx.def(node, { name, kind: 'function', range, body: field(value, 'body'), exported: !!exp });
    return;
  }
  if (value && value.type === 'class') {
    const sym = ctx.def(node, { name, kind: 'class', range, body: field(value, 'body'), exported: !!exp });
    classHeritage(value, sym, ctx);
    return;
  }
  // CommonJS: `const x = require('y')` and `const f = require('y').f` bind imports, they define nothing.
  const required = requireSource(value);
  if (required) {
    const member = value && value.type === 'member_expression' ? field(value, 'property')?.text : undefined;
    ctx.imp(required, node, [member && member !== name ? `${name}=${member}` : name]);
    return;
  }
  // Only module-level (or namespace-level) variables become symbols; locals
  // inside callbacks (tests, event handlers) are not worth indexing.
  if (ctx.inCallable() || !isTopLevel(decl)) return;
  const wrapped = value && value.type === 'call_expression' ? field(value, 'arguments') : null;
  const fnArg = wrapped?.namedChildren.find(a => a && FUNCTION_VALUES.has(a.type));
  if (fnArg) {
    // const useThing = memo(() => {...}) / forwardRef(function ...) style wrappers
    ctx.def(node, { name, kind: 'function', range, body: field(fnArg, 'body'), exported: !!exp });
    return;
  }
  const isConst = decl?.type === 'lexical_declaration' && decl.child(0)?.type === 'const';
  ctx.def(node, {
    name,
    kind: isConst || isConstName(name) ? 'constant' : 'variable',
    range,
    body: null,
    exported: !!exp,
  });
};

/** `foo.bar = function() {}`, `exports.x = () => {}`, `Foo.prototype.bar = function() {}` */
const assignment: Visitor = (node, ctx) => {
  // `this.repo = repo` / `this.cache = new Cache()`: the field takes the type of what is assigned.
  const target = field(node, 'left');
  if (target && target.type === 'member_expression' && field(target, 'object')?.type === 'this') {
    const prop = field(target, 'property');
    const value = field(node, 'right');
    if (prop && value) {
      if (value.type === 'new_expression') ctx.typeHint(prop.text, field(value, 'constructor')?.text, true);
      else if (value.type === 'identifier') ctx.typeHint(prop.text, ctx.typeOf(value.text), true);
    }
  }
  // Inner links of a chain (a = b = function) are handled from the head.
  if (node.parent && node.parent.type === 'assignment_expression') return;
  const targets: Node[] = [];
  let right: Node | null = node;
  while (right && right.type === 'assignment_expression') {
    const left = field(right, 'left');
    if (left) targets.push(left);
    right = field(right, 'right');
  }
  if (!right) return;
  // module.exports = createApplication / exports = module.exports = createApplication
  if (targets.some(t => /^(module\.)?exports$/.test(t.text))) {
    if (right.type === 'identifier') ctx.exportDefault(right.text);
    else if (requireSource(right)) {
      // module.exports = require('./lib/express'): pass that module's export through.
      ctx.imp(requireSource(right), node, ['*']);
      ctx.exportDefault('*');
    }
    else if ((FUNCTION_VALUES.has(right.type) || right.type === 'class') && field(right, 'name')) {
      ctx.exportDefault(field(right, 'name')!.text);
    }
  }
  const isFn = FUNCTION_VALUES.has(right.type);
  const isClass = right.type === 'class';
  if (!isFn && !isClass) return;
  const stmt = node.parent && node.parent.type === 'expression_statement' ? node.parent : node;

  // `res.set = res.header = function header() {}`: every target names the same function.
  // Aliases are leaf symbols; the first target owns the body scope.
  for (let i = targets.length - 1; i >= 0; i--) {
    const left = targets[i]!;
    if (left.type !== 'member_expression') continue;
    const prop = field(left, 'property');
    const obj = field(left, 'object');
    if (!prop || !obj) continue;
    let qualifier = obj.text.replace(/\.prototype$/, '');
    const exported = /^(module\.)?exports$/.test(qualifier);
    if (exported || qualifier === 'this' || qualifier.length > 60 || /[^\w.$]/.test(qualifier)) qualifier = '';
    ctx.def(node, {
      name: prop.text,
      kind: isClass ? 'class' : qualifier ? 'method' : 'function',
      range: stmt,
      body: field(right, 'body'),
      qualifier,
      exported,
      scope: i === 0,
    });
  }
};

/** Object literal members with function values: `{ foo: () => {} }` */
const pair: Visitor = (node, ctx) => {
  const value = field(node, 'value');
  const key = field(node, 'key');
  if (!value || !key || !FUNCTION_VALUES.has(value.type)) return;
  if (key.type !== 'property_identifier' && key.type !== 'string') return;
  // A member of an object literal: reachable only through the object, never by its bare name.
  ctx.def(node, { name: stripQuotes(key.text), kind: 'method', body: field(value, 'body') });
};

const callExpression: Visitor = (node, ctx) => {
  const fn = field(node, 'function');
  if (!fn) return;
  if (fn.type === 'identifier') {
    ctx.call(fn.text, node);
  } else if (fn.type === 'member_expression') {
    ctx.call(field(fn, 'property')?.text, node, simpleReceiver(field(fn, 'object')));
  } else if (fn.type === 'import') {
    const arg = field(node, 'arguments')?.namedChildren[0];
    if (arg && arg.type === 'string') ctx.imp(stripQuotes(arg.text), node);
  }
};

const newExpression: Visitor = (node, ctx) => {
  const c = field(node, 'constructor');
  if (c) ctx.call(lastSegment(c.text), node);
};

const jsxElement: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const t = lastSegment(name.text);
  // Components are capitalised; lowercase tags are DOM elements.
  if (/^[A-Z]/.test(t)) ctx.call(t, node);
};

const importStatement: Visitor = (node, ctx) => {
  const source = field(node, 'source');
  if (!source) return;
  const names: string[] = [];
  const clause = childOfType(node, 'import_clause');
  if (clause) {
    for (const c of clause.namedChildren) {
      if (!c) continue;
      if (c.type === 'identifier') names.push(c.text);
      else if (c.type === 'namespace_import') names.push(c.namedChildren[0]?.text ?? '*');
      else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          // The local binding is the alias when there is one (import { a as b }).
          if (s && s.type === 'import_specifier') {
            const original = field(s, 'name')?.text ?? s.text;
            const alias = field(s, 'alias')?.text;
            names.push(alias && alias !== original ? `${alias}=${original}` : original);
          }
        }
      }
    }
  }
  const src = stripQuotes(source.text);
  // Remember where each local name comes from, for `export { X as Y }` further down.
  let map = importSources.get(ctx);
  if (!map) importSources.set(ctx, (map = new Map()));
  for (const n of names) map.set(n.split('=')[0]!, src + '\0' + (n.split('=')[1] ?? n));
  ctx.imp(src, node, names);
};

/** Per file: local name -> "source\0original name" of what it was imported as. */
const importSources = new WeakMap<Ctx, Map<string, string>>();

const exportStatement: Visitor = (node, ctx) => {
  // Re-exports: export { a } from './x'; export * from './x';
  const source = field(node, 'source');
  const clause = childOfType(node, 'export_clause');
  // Renamed on the way out: `export { parseId as getId } from './impl'`. Importers of this file
  // call it by the new name, so the alias is recorded like an import alias (`getId=parseId`).
  const renamed: Array<[string, string]> = [];
  if (clause) {
    for (const s of clause.namedChildren) {
      if (!s || s.type !== 'export_specifier') continue;
      const original = field(s, 'name')?.text;
      const alias = field(s, 'alias')?.text;
      if (original && alias && alias !== original && alias !== 'default' && original !== 'default') renamed.push([alias, original]);
    }
  }
  if (source) {
    ctx.imp(stripQuotes(source.text), node, renamed.map(([alias, original]) => `${alias}=${original}`));
  } else if (renamed.length) {
    // `import { Picker } from './picker'; export { Picker as TerminalPicker };`
    const map = importSources.get(ctx);
    for (const [alias, original] of renamed) {
      const from = map?.get(original);
      if (!from) continue;
      const [src, real] = from.split('\0') as [string, string];
      ctx.imp(src, node, [`${alias}=${real}`]);
    }
  }
  // export default X / export default function name() {} / export default class Name {}
  if (node.children.some(c => c?.type === 'default')) {
    const value = field(node, 'value');
    const decl = field(node, 'declaration');
    if (value && value.type === 'identifier') ctx.exportDefault(value.text);
    else if (decl) ctx.exportDefault(field(decl, 'name')?.text);
  }
};

/**
 * Anonymous class expressions (`registerAction2(class extends Action2 { run() {} })`):
 * give them a synthetic name so their methods have a container and the class
 * shows up as a subtype of what it extends.
 */
const classExpression: Visitor = (node, ctx) => {
  if (field(node, 'name')) return; // named class expressions are handled where they are bound
  const p = node.parent;
  if (p && (p.type === 'variable_declarator' || p.type === 'assignment_expression')) return;
  let base = '';
  for (const c of node.namedChildren) {
    if (!c || c.type !== 'class_heritage') continue;
    const ext = c.namedChildren.find(h => h?.type === 'extends_clause');
    const value = ext ? ext.childrenForFieldName('value')[0] : c.namedChildren[0];
    if (value) base = lastSegment(value.text);
  }
  const sym = ctx.def(node, { name: base ? `(anonymous ${base})` : '(anonymous class)', kind: 'class' });
  classHeritage(node, sym, ctx);
};

const typeAlias: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const exp = isExported(node);
  ctx.def(node, { name: name.text, kind: 'type', range: exp ?? node, body: field(node, 'value'), exported: !!exp });
};

const enumDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const exp = isExported(node);
  ctx.def(node, { name: name.text, kind: 'enum', range: exp ?? node, exported: !!exp });
  for (const m of field(node, 'body')?.namedChildren ?? []) {
    if (!m) continue;
    const mName = m.type === 'enum_assignment' ? field(m, 'name') : m.type === 'property_identifier' ? m : null;
    if (mName) ctx.def(m, { name: stripQuotes(mName.text), kind: 'constant', body: null, scope: false });
  }
};

const namespaceDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const outer = node.parent?.type === 'expression_statement' ? node.parent : node;
  const exp = isExported(outer);
  ctx.def(node, { name: stripQuotes(name.text), kind: 'namespace', range: exp ?? outer, exported: !!exp });
};

const propertySignature: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || ctx.parentKind() !== 'interface') return;
  ctx.def(node, { name: stripQuotes(name.text), kind: 'property', body: null, scope: false });
  ctx.typeHint(name.text, field(node, 'type')?.text);
};

const jsVisitors: Record<string, Visitor> = {
  function_declaration: functionDecl,
  generator_function_declaration: functionDecl,
  class_declaration: classLike('class'),
  method_definition: method,
  field_definition: fieldDef,
  variable_declarator: variableDeclarator,
  assignment_expression: assignment,
  pair,
  call_expression: callExpression,
  new_expression: newExpression,
  jsx_opening_element: jsxElement,
  jsx_self_closing_element: jsxElement,
  import_statement: importStatement,
  export_statement: exportStatement,
  decorator,
  function_expression: functionExpression,
  class: classExpression,
};

const tsVisitors: Record<string, Visitor> = {
  ...jsVisitors,
  abstract_class_declaration: classLike('class'),
  interface_declaration: classLike('interface'),
  function_signature: functionDecl,
  method_signature: method,
  abstract_method_signature: method,
  public_field_definition: fieldDef,
  property_signature: propertySignature,
  type_alias_declaration: typeAlias,
  enum_declaration: enumDecl,
  internal_module: namespaceDecl,
  module: namespaceDecl,
  required_parameter: parameter,
  optional_parameter: parameter,
};
delete tsVisitors.field_definition;
delete tsVisitors.jsx_opening_element;
delete tsVisitors.jsx_self_closing_element;

const JS_IDENTIFIERS = [
  'identifier', 'property_identifier', 'shorthand_property_identifier',
  'shorthand_property_identifier_pattern', 'private_property_identifier',
];

export const javascript: LangSpec = {
  id: 'javascript',
  grammar: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  identifiers: JS_IDENTIFIERS,
  visit: jsVisitors,
};

/**
 * The script blocks of a Vue single-file component, everything else blanked out. Lines and columns stay
 * where they are, so the template and the styles simply are not there for the parser. Plain JavaScript
 * in a block is valid input for the TypeScript grammar.
 */
export function vueScript(source: string): string {
  const keep: Array<[number, number]> = [];
  const block = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = block.exec(source)) !== null) {
    const start = m.index + m[0].indexOf('>') + 1;
    keep.push([start, start + m[1]!.length]);
  }
  let out = '';
  let pos = 0;
  for (const [a, b] of keep) {
    out += source.slice(pos, a).replace(/[^\n\r]/g, ' ') + source.slice(a, b);
    pos = b;
  }
  return out + source.slice(pos).replace(/[^\n\r]/g, ' ');
}

export const typescript: LangSpec = {
  id: 'typescript',
  grammar: 'typescript',
  extensions: ['.ts', '.mts', '.cts', '.vue'],
  identifiers: [...JS_IDENTIFIERS, 'type_identifier'],
  visit: tsVisitors,
  preprocess: (source, path) => (path.toLowerCase().endsWith('.vue') ? vueScript(source) : source),
};

export const tsx: LangSpec = {
  id: 'tsx',
  grammar: 'tsx',
  extensions: ['.tsx'],
  identifiers: [...JS_IDENTIFIERS, 'type_identifier'],
  visit: {
    ...tsVisitors,
    jsx_opening_element: jsxElement,
    jsx_self_closing_element: jsxElement,
  },
};

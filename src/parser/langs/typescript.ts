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
  const inType = ctx.parentKind() === 'class' || ctx.parentKind() === 'interface';
  ctx.def(node, { name: name.text.replace(/^['"]|['"]$/g, ''), kind: inType ? 'method' : 'function' });
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
};

const variableDeclarator: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  const value = field(node, 'value');
  if (!nameNode || nameNode.type !== 'identifier') return;
  const decl = node.parent; // lexical_declaration | variable_declaration
  const exp = decl ? isExported(decl) : null;
  const range = exp ?? (decl && decl.namedChildCount === 1 ? decl : node);
  const name = nameNode.text;

  if (value && FUNCTION_VALUES.has(value.type)) {
    ctx.def(node, { name, kind: 'function', range, body: field(value, 'body'), exported: !!exp });
    return;
  }
  if (value && value.type === 'class') {
    const sym = ctx.def(node, { name, kind: 'class', range, body: field(value, 'body'), exported: !!exp });
    classHeritage(value, sym, ctx);
    return;
  }
  // require() imports
  if (value && value.type === 'call_expression' && field(value, 'function')?.text === 'require') {
    const arg = field(value, 'arguments')?.namedChildren[0];
    if (arg && arg.type === 'string') ctx.imp(stripQuotes(arg.text), node, [name]);
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
  const left = field(node, 'left');
  const right = field(node, 'right');
  if (!left || !right || left.type !== 'member_expression') return;
  const isFn = FUNCTION_VALUES.has(right.type);
  const isClass = right.type === 'class';
  if (!isFn && !isClass) return;
  const prop = field(left, 'property');
  const obj = field(left, 'object');
  if (!prop || !obj) return;
  let qualifier = obj.text.replace(/\.prototype$/, '');
  const exported = /^(module\.)?exports$/.test(qualifier);
  if (exported || qualifier === 'this' || qualifier.length > 60 || /[^\w.$]/.test(qualifier)) qualifier = '';
  const stmt = node.parent && node.parent.type === 'expression_statement' ? node.parent : node;
  ctx.def(node, {
    name: prop.text,
    kind: isClass ? 'class' : qualifier ? 'method' : 'function',
    range: stmt,
    body: field(right, 'body'),
    qualifier,
    exported,
  });
};

/** Object literal members with function values: `{ foo: () => {} }` */
const pair: Visitor = (node, ctx) => {
  const value = field(node, 'value');
  const key = field(node, 'key');
  if (!value || !key || !FUNCTION_VALUES.has(value.type)) return;
  if (key.type !== 'property_identifier' && key.type !== 'string') return;
  ctx.def(node, { name: stripQuotes(key.text), kind: 'function', body: field(value, 'body') });
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
          if (s && s.type === 'import_specifier') names.push(field(s, 'name')?.text ?? s.text);
        }
      }
    }
  }
  ctx.imp(stripQuotes(source.text), node, names);
};

const exportStatement: Visitor = (node, ctx) => {
  // Re-exports: export { a } from './x'; export * from './x';
  const source = field(node, 'source');
  if (source) ctx.imp(stripQuotes(source.text), node);
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

export const typescript: LangSpec = {
  id: 'typescript',
  grammar: 'typescript',
  extensions: ['.ts', '.mts', '.cts'],
  identifiers: [...JS_IDENTIFIERS, 'type_identifier'],
  visit: tsVisitors,
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

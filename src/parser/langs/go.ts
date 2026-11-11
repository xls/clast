import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field, stripQuotes } from '../spec.js';

/** Builtin functions and predeclared types: calls/conversions that never resolve to a user symbol. */
const BUILTINS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min',
  'new', 'panic', 'print', 'println', 'real', 'recover',
  'bool', 'byte', 'rune', 'string', 'error', 'any', 'uintptr',
  'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'complex64', 'complex128',
]);

const MAX_SIG_SLICE = 300;

function isExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

/** Bare name of a (possibly pointer / generic / package-qualified) named type. */
function typeName(node: Node | null | undefined): string | null {
  for (let i = 0; node && i < 6; i++) {
    switch (node.type) {
      case 'type_identifier':
      case 'identifier':
        return node.text;
      case 'qualified_type':
        return field(node, 'name')?.text ?? null;
      case 'generic_type':
        node = field(node, 'type');
        break;
      case 'pointer_type':
      case 'parenthesized_type':
      case 'type_elem':
        node = node.namedChildren[0];
        break;
      default:
        return null;
    }
  }
  return null;
}

/**
 * Outermost node of a spec: the surrounding declaration when it holds only
 * this spec (`type X struct{}`, `const A = 1`), so that the doc comment in
 * front of the keyword is found. Specs in `( ... )` groups keep their own range.
 */
function specRange(spec: Node): Node {
  const decl = spec.parent;
  if (decl && decl.namedChildCount === 1 && decl.type.endsWith('_declaration')) return decl;
  return spec;
}

function slice(ctx: Ctx, start: number, end: number): string {
  return ctx.src.slice(start, Math.min(end, start + MAX_SIG_SLICE));
}

function shortText(node: Node | null | undefined, max = 40): string | null {
  if (!node || node.endIndex - node.startIndex > max) return null;
  const t = node.text;
  return /[\s(]/.test(t) ? null : t;
}

const functionDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'function', exported: isExported(name.text) });
};

const methodDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  let recv: Node | null | undefined = field(node, 'receiver');
  recv = recv?.namedChildren.find(c => c && c.type === 'parameter_declaration');
  ctx.def(node, {
    name: name.text,
    kind: 'method',
    qualifier: typeName(field(recv, 'type')),
    exported: isExported(name.text),
  });
};

function structFields(struct: Node, sym: number, ctx: Ctx): void {
  const list = struct.namedChildren.find(c => c && c.type === 'field_declaration_list');
  if (!list) return;
  for (const fd of list.namedChildren) {
    if (!fd || fd.type !== 'field_declaration') continue;
    const names = fd.childrenForFieldName('name');
    if (names.length === 0) {
      // Embedded field: `Base`, `*Base`, `pkg.Other`, `Gen[T]`
      const name = typeName(field(fd, 'type'));
      if (!name) continue;
      ctx.def(fd, { name, kind: 'field', body: null, scope: false, exported: isExported(name) });
      ctx.inherit(sym, name, 'extends');
      continue;
    }
    for (const n of names) {
      if (!n) continue;
      ctx.def(fd, { name: n.text, kind: 'field', body: null, scope: false, exported: isExported(n.text) });
    }
  }
}

function interfaceMembers(iface: Node, sym: number, ctx: Ctx): void {
  for (const m of iface.namedChildren) {
    if (!m) continue;
    if (m.type === 'method_elem' || m.type === 'method_spec') {
      const name = field(m, 'name');
      if (name) ctx.def(m, { name: name.text, kind: 'method', body: null, scope: false, exported: isExported(name.text) });
    } else if (m.type === 'type_elem' || m.type === 'constraint_elem') {
      // A single named type is an embedded interface; unions / ~T are constraints.
      if (m.namedChildCount !== 1) continue;
      const t = m.namedChildren[0];
      if (t && t.type !== 'negated_type') ctx.inherit(sym, typeName(t), 'extends');
    } else if (m.type === 'type_identifier' || m.type === 'qualified_type' || m.type === 'generic_type') {
      ctx.inherit(sym, typeName(m), 'extends');
    }
  }
}

const typeSpec: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const type = field(node, 'type');
  const range = specRange(node);
  const prefix = range === node ? 'type ' : '';
  const exported = isExported(name) && !ctx.inCallable();

  if (type && node.type === 'type_spec' && (type.type === 'struct_type' || type.type === 'interface_type')) {
    const isStruct = type.type === 'struct_type';
    const sig = prefix + ctx.src.slice(range.startIndex, type.startIndex) + (isStruct ? 'struct' : 'interface');
    const sym = ctx.def(node, { name, kind: isStruct ? 'struct' : 'interface', range, sig, exported });
    if (isStruct) structFields(type, sym, ctx);
    else interfaceMembers(type, sym, ctx);
    return;
  }
  ctx.def(node, { name, kind: 'type', range, sig: prefix + slice(ctx, range.startIndex, range.endIndex), exported });
};

/** Package-level `const` / `var` specs. Locals are never symbols. */
const valueSpec = (kind: 'constant' | 'variable'): Visitor => (node, ctx) => {
  let decl = node.parent;
  if (decl && decl.type === 'var_spec_list') decl = decl.parent;
  if (!decl || decl.parent?.type !== 'source_file') return;
  const names = node.childrenForFieldName('name');
  if (names.length === 0) return;
  const range = specRange(node);
  const prefix = range === node ? (kind === 'constant' ? 'const ' : 'var ') : '';

  const values = field(node, 'value');
  const value = names.length === 1 && values && values.namedChildCount === 1 ? values.namedChildren[0] : null;
  if (value && value.type === 'func_literal' && names[0]) {
    const name = names[0].text;
    const body = field(value, 'body');
    const sig = prefix + slice(ctx, range.startIndex, body ? body.startIndex : range.endIndex);
    ctx.def(node, { name, kind: 'function', range, sig, exported: isExported(name) });
    return;
  }
  // Cut composite literals (`var table = map[string]int{ ... }`) at the literal body.
  const lit = value && value.type === 'composite_literal' ? field(value, 'body') : null;
  const sig = prefix + slice(ctx, range.startIndex, lit ? lit.startIndex : range.endIndex);
  for (const n of names) {
    if (!n || n.text === '_') continue;
    ctx.def(node, { name: n.text, kind, range, sig, scope: false, exported: isExported(n.text) });
  }
};

function recordCall(fn: Node | null, node: Node, ctx: Ctx): void {
  for (let i = 0; fn && i < 4; i++) {
    switch (fn.type) {
      case 'identifier':
      case 'type_identifier': {
        const name = fn.text;
        if (!BUILTINS.has(name)) ctx.call(name, node);
        return;
      }
      case 'selector_expression':
        ctx.call(field(fn, 'field')?.text, node, shortText(field(fn, 'operand')));
        return;
      case 'qualified_type':
        ctx.call(field(fn, 'name')?.text, node, field(fn, 'package')?.text);
        return;
      case 'index_expression': // generic instantiation `f[T](x)`
        fn = field(fn, 'operand');
        break;
      case 'type_instantiation_expression':
      case 'generic_type':
        fn = field(fn, 'type');
        break;
      default:
        return;
    }
  }
}

const callExpression: Visitor = (node, ctx) => {
  recordCall(field(node, 'function'), node, ctx);
};

/** `helper[int](1)` is parsed as a conversion to the generic type `helper[int]`. */
const typeConversion: Visitor = (node, ctx) => {
  const type = field(node, 'type');
  if (type && type.type === 'generic_type') recordCall(type, node, ctx);
};

/** `Server{...}`, `pkg.Thing{...}`, `List[int]{...}` use the type. */
const compositeLiteral: Visitor = (node, ctx) => {
  const type = field(node, 'type');
  if (!type) return;
  if (type.type === 'type_identifier' || type.type === 'qualified_type' || type.type === 'generic_type') {
    recordCall(type, node, ctx);
  }
};

const importSpec: Visitor = (node, ctx) => {
  const path = field(node, 'path');
  if (!path) return;
  const source = stripQuotes(path.text);
  const alias = field(node, 'name');
  const name = alias && alias.type === 'package_identifier' ? alias.text : source.slice(source.lastIndexOf('/') + 1);
  ctx.imp(source, node, name ? [name] : []);
};

export const go: LangSpec = {
  id: 'go',
  grammar: 'go',
  extensions: ['.go'],
  identifiers: ['identifier', 'type_identifier', 'field_identifier', 'package_identifier'],
  comments: ['comment'],
  visit: {
    function_declaration: functionDecl,
    method_declaration: methodDecl,
    type_spec: typeSpec,
    type_alias: typeSpec,
    const_spec: valueSpec('constant'),
    var_spec: valueSpec('variable'),
    call_expression: callExpression,
    type_conversion_expression: typeConversion,
    composite_literal: compositeLiteral,
    import_spec: importSpec,
  },
};

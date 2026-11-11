import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field, simpleReceiver, stripQuotes } from '../spec.js';

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

/** Like typeName, but a package-qualified type keeps its package: `*deps.Deps` -> `deps.Deps`. */
function hintType(node: Node | null | undefined): string | null {
  for (let i = 0; node && i < 6; i++) {
    switch (node.type) {
      case 'qualified_type':
        return node.text.replace(/\s+/g, '');
      case 'generic_type':
        node = field(node, 'type');
        break;
      case 'pointer_type':
      case 'parenthesized_type':
      case 'type_elem':
        node = node.namedChildren[0];
        break;
      default:
        return typeName(node);
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

/** True for a (pointer to a / generic) type qualified by a package: `http.Handler`, `*pkg.Base`. */
function isQualified(node: Node | null | undefined): boolean {
  for (let i = 0; node && i < 6; i++) {
    switch (node.type) {
      case 'qualified_type':
        return true;
      case 'generic_type':
        node = field(node, 'type');
        break;
      case 'pointer_type':
      case 'parenthesized_type':
      case 'type_elem':
        node = node.namedChildren[0];
        break;
      default:
        return false;
    }
  }
  return false;
}

/**
 * Per-file state (a fresh `Ctx` is created for every extraction): type
 * symbols and interface satisfaction assertions (`var _ I = (*T)(nil)`),
 * which may come before or after the declaration of `T`.
 */
interface FileState {
  types: Map<string, number>;
  /** Type name -> interfaces asserted before the type was declared. */
  asserted: Map<string, string[]>;
}
const states = new WeakMap<Ctx, FileState>();
function state(ctx: Ctx): FileState {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { types: new Map(), asserted: new Map() }));
  return s;
}

/**
 * Type of the value an expression obviously constructs: `Foo{..}`, `&Foo{..}`,
 * `new(Foo)`, and the constructor convention `NewFoo(..)` / `pkg.NewFoo(..)`.
 * Other calls are not guessed.
 */
function valueType(value: Node | null | undefined, qualified = false): string | null {
  if (!value) return null;
  const nameOf = qualified ? hintType : typeName;
  if (value.type === 'unary_expression') {
    value = field(value, 'operand');
    if (!value || value.type !== 'composite_literal') return null;
  }
  if (value.type === 'composite_literal') return nameOf(field(value, 'type'));
  if (value.type !== 'call_expression') return null;
  let fn = field(value, 'function');
  if (!fn) return null;
  let pkg = '';
  if (fn.type === 'selector_expression') {
    const operand = field(fn, 'operand');
    if (qualified && operand && operand.type === 'identifier') pkg = operand.text + '.';
    fn = field(fn, 'field');
  }
  if (!fn || (fn.type !== 'identifier' && fn.type !== 'field_identifier')) return null;
  const name = fn.text;
  if (name === 'new') return nameOf(field(value, 'arguments')?.namedChildren[0]);
  const m = /^New([A-Z]\w*)$/.exec(name);
  return m ? pkg + m[1]! : null;
}

/** Parameters, method receivers and named results: `a, b Foo`, `s *Site`. */
const parameterDecl: Visitor = (node, ctx) => {
  const owner = node.parent?.parent?.type;
  if (owner !== 'function_declaration' && owner !== 'method_declaration' && owner !== 'func_literal') return;
  const type = hintType(field(node, 'type'));
  if (!type) return;
  for (const n of node.childrenForFieldName('name')) {
    if (n) ctx.typeHint(n.text, type);
  }
};

/** `x := Foo{}`, `a, b := &Foo{}, new(Bar)` */
const shortVarDecl: Visitor = (node, ctx) => {
  const left = field(node, 'left');
  const right = field(node, 'right');
  if (!left || !right || left.namedChildCount !== right.namedChildCount) return;
  for (let i = 0; i < left.namedChildCount; i++) {
    const type = valueType(right.namedChildren[i], true);
    if (!type) continue;
    const name = left.namedChildren[i];
    if (name && name.type === 'identifier') ctx.typeHint(name.text, type);
  }
};

/** Type hints of `var x Foo` / `var x = Foo{}` (locals and package level). */
function varHints(node: Node, names: Node[], ctx: Ctx): void {
  const declared = field(node, 'type');
  if (declared) {
    const type = hintType(declared);
    if (type) for (const n of names) ctx.typeHint(n.text, type);
    return;
  }
  const values = field(node, 'value');
  if (!values || values.namedChildCount !== names.length) return;
  for (let i = 0; i < names.length; i++) {
    const type = valueType(values.namedChildren[i], true);
    if (type) ctx.typeHint(names[i]!.text, type);
  }
}

/** Record `type implements iface` now, or when the type is declared later in the file. */
function assertImplements(type: string, iface: string, ctx: Ctx): void {
  if (type === iface) return;
  const st = state(ctx);
  const sym = st.types.get(type);
  if (sym !== undefined) {
    ctx.inherit(sym, iface, 'implements');
    return;
  }
  const list = st.asserted.get(type);
  if (list) list.push(iface);
  else st.asserted.set(type, [iface]);
}

/** `(*Engine)(nil)`, `&Engine{}`, `Engine{}`, `new(Engine)` -> Engine */
function assertedType(value: Node | null | undefined): string | null {
  if (!value) return null;
  if (value.type === 'call_expression') {
    let fn = field(value, 'function');
    if (fn && fn.type === 'parenthesized_expression') {
      fn = fn.namedChildren[0] ?? null;
      if (fn && fn.type === 'unary_expression') fn = field(fn, 'operand');
      if (fn && fn.type === 'selector_expression') fn = field(fn, 'field');
      return fn && (fn.type === 'identifier' || fn.type === 'field_identifier') ? fn.text : null;
    }
    return fn && fn.type === 'identifier' && fn.text === 'new' ? valueType(value) : null;
  }
  if (value.type === 'type_conversion_expression') return typeName(field(value, 'type'));
  return value.type === 'unary_expression' || value.type === 'composite_literal' ? valueType(value) : null;
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

function structFields(struct: Node, sym: number, own: string, ctx: Ctx): void {
  const list = struct.namedChildren.find(c => c && c.type === 'field_declaration_list');
  if (!list) return;
  for (const fd of list.namedChildren) {
    if (!fd || fd.type !== 'field_declaration') continue;
    const names = fd.childrenForFieldName('name');
    if (names.length === 0) {
      // Embedded field: `Base`, `*Base`, `pkg.Other`, `Gen[T]`
      const type = field(fd, 'type');
      const name = typeName(type);
      if (!name) continue;
      ctx.def(fd, { name, kind: 'field', body: null, scope: false, exported: isExported(name) });
      ctx.typeHint(name, hintType(type) ?? name);
      // `type ResponseWriter struct { http.ResponseWriter }` does not extend itself.
      // The package qualifier is kept (`page.ContentProvider`): it tells same-named types apart.
      if (name !== own || !isQualified(type)) ctx.inherit(sym, hintType(type) ?? name, 'extends');
      continue;
    }
    const type = hintType(field(fd, 'type'));
    for (const n of names) {
      if (!n) continue;
      ctx.def(fd, { name: n.text, kind: 'field', body: null, scope: false, exported: isExported(n.text) });
      if (type) ctx.typeHint(n.text, type);
    }
  }
}

function interfaceMembers(iface: Node, sym: number, own: string, ctx: Ctx): void {
  // `type ResponseWriter interface { http.ResponseWriter }` does not extend itself.
  const embed = (t: Node): void => {
    const name = typeName(t);
    if (name && (name !== own || !isQualified(t))) ctx.inherit(sym, hintType(t) ?? name, 'extends');
  };
  for (const m of iface.namedChildren) {
    if (!m) continue;
    if (m.type === 'method_elem' || m.type === 'method_spec') {
      const name = field(m, 'name');
      if (name) ctx.def(m, { name: name.text, kind: 'method', body: null, scope: false, exported: isExported(name.text) });
    } else if (m.type === 'type_elem' || m.type === 'constraint_elem') {
      // A single named type is an embedded interface; unions / ~T are constraints.
      if (m.namedChildCount !== 1) continue;
      const t = m.namedChildren[0];
      if (t && t.type !== 'negated_type') embed(t);
    } else if (m.type === 'type_identifier' || m.type === 'qualified_type' || m.type === 'generic_type') {
      embed(m);
    }
  }
}

/** Remember a type symbol and apply interface assertions seen before its declaration. */
function registerType(name: string, sym: number, ctx: Ctx): void {
  if (ctx.inCallable()) return; // local type
  const st = state(ctx);
  if (!st.types.has(name)) st.types.set(name, sym);
  const pending = st.asserted.get(name);
  if (!pending) return;
  st.asserted.delete(name);
  for (const iface of pending) ctx.inherit(sym, iface, 'implements');
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
    if (isStruct) {
      registerType(name, sym, ctx);
      structFields(type, sym, name, ctx);
    } else {
      interfaceMembers(type, sym, name, ctx);
    }
    return;
  }
  const sym = ctx.def(node, { name, kind: 'type', range, sig: prefix + slice(ctx, range.startIndex, range.endIndex), exported });
  if (node.type === 'type_spec') registerType(name, sym, ctx);
};

/** Package-level `const` / `var` specs. Locals are never symbols. */
const valueSpec = (kind: 'constant' | 'variable'): Visitor => (node, ctx) => {
  let decl = node.parent;
  if (decl && decl.type === 'var_spec_list') decl = decl.parent;
  const names = node.childrenForFieldName('name').filter((n): n is Node => !!n);
  if (names.length === 0) return;
  if (kind === 'variable') varHints(node, names, ctx);
  if (!decl || decl.parent?.type !== 'source_file') return;
  const range = specRange(node);
  const prefix = range === node ? (kind === 'constant' ? 'const ' : 'var ') : '';

  const values = field(node, 'value');
  const value = names.length === 1 && values && values.namedChildCount === 1 ? values.namedChildren[0] : null;
  if (kind === 'variable' && value && names[0]!.text === '_') {
    // Interface satisfaction assertion: `var _ IRouter = (*Engine)(nil)` / `= &Engine{}`
    const iface = typeName(field(node, 'type'));
    const type = iface ? assertedType(value) : null;
    if (iface && type && !BUILTINS.has(iface)) assertImplements(type, hintType(field(node, 'type')) ?? iface, ctx);
    return;
  }
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
        // Always a receiver ('?' for call chains etc.): a member call is never a bare call.
        ctx.call(field(fn, 'field')?.text, node, simpleReceiver(field(fn, 'operand')) ?? '?');
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
  lowercaseTypes: true,
  packageTypes: true,
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
    parameter_declaration: parameterDecl,
    short_var_declaration: shortVarDecl,
  },
};

import type { Node } from 'web-tree-sitter';
import type { LangSpec, Visitor } from '../spec.js';
import { field, isConstName, lastSegment, simpleReceiver } from '../spec.js';

function docstring(node: Node): string | null {
  const body = field(node, 'body');
  const first = body?.namedChildren[0];
  if (!first || first.type !== 'expression_statement') return null;
  const str = first.namedChildren[0];
  if (!str || str.type !== 'string') return null;
  const raw = str.text.replace(/^[a-zA-Z]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
  const lines = raw.split(/\r?\n/);
  const indent = Math.min(
    ...lines.slice(1).filter(l => l.trim()).map(l => l.length - l.trimStart().length),
    Infinity
  );
  return lines
    .map((l, i) => (i === 0 ? l.trim() : l.slice(Number.isFinite(indent) ? indent : 0).trimEnd()))
    .join('\n')
    .trim();
}

/** Signature: decorators + header up to and including the colon (no trailing comments). */
function header(node: Node, ctx: { src: string }): string | undefined {
  const start = outer(node).startIndex;
  const body = field(node, 'body');
  if (!body) return undefined;
  let end = body.startIndex;
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (c && c.type === ':' && c.endIndex <= body.startIndex) { end = c.endIndex; break; }
  }
  return ctx.src.slice(start, end);
}

function outer(node: Node): Node {
  return node.parent && node.parent.type === 'decorated_definition' ? node.parent : node;
}

const functionDef: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const pk = ctx.parentKind();
  ctx.def(node, {
    name: name.text,
    kind: pk === 'class' ? 'method' : 'function',
    range: outer(node),
    sig: header(node, ctx),
    doc: docstring(node),
    exported: !name.text.startsWith('_') && ctx.depth() <= 1,
  });
};

const classDef: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const sym = ctx.def(node, {
    name: name.text,
    kind: 'class',
    range: outer(node),
    sig: header(node, ctx),
    doc: docstring(node),
    exported: !name.text.startsWith('_') && ctx.depth() === 0,
  });
  const supers = field(node, 'superclasses');
  if (supers) {
    for (const s of supers.namedChildren) {
      if (!s || s.type === 'keyword_argument') continue;
      if (s.type === 'call') {
        // Dynamic base built from a class: `class Manager(BaseManager.from_queryset(QuerySet))`.
        const fn = field(s, 'function');
        if (fn && fn.type === 'attribute') ctx.inherit(sym, field(fn, 'object')?.text, 'extends');
        continue;
      }
      // Keep the module qualifier (`forms.CharField`): it tells same-named classes apart.
      ctx.inherit(sym, s.text.replace(/\[.*$/s, ''), 'extends');
    }
  }
};

/** Type of an assignment: its annotation, or the class being instantiated (`x = Foo(...)`). */
function assignedType(node: Node): string | null {
  const annotation = field(node, 'type');
  if (annotation) return annotation.text;
  const right = field(node, 'right');
  if (right && right.type === 'call') {
    const fn = field(right, 'function');
    const callee = fn?.type === 'attribute' ? field(fn, 'attribute') : fn;
    if (callee && callee.type === 'identifier' && /^[A-Z]/.test(callee.text)) return callee.text;
  }
  return null;
}

/** Module-level and class-level assignments become variables / fields. */
const assignment: Visitor = (node, ctx) => {
  const left = field(node, 'left');
  if (!left) return;
  const stmt = node.parent;

  // self.attr = ... inside a method: an instance attribute of the enclosing class.
  if (left.type === 'attribute') {
    const obj = field(left, 'object');
    const attr = field(left, 'attribute');
    if (!obj || !attr || obj.text !== 'self' || !ctx.inCallable()) return;
    // self.repo = Repo(...) or self.repo = repo (a typed parameter)
    const right = field(node, 'right');
    ctx.typeHint(attr.text, assignedType(node) ?? (right?.type === 'identifier' ? ctx.typeOf(right.text) : null), true);
    if (stmt && stmt.type === 'expression_statement') {
      ctx.def(node, {
        name: attr.text, kind: 'field', range: stmt, body: null, scope: false, inContainer: true,
        exported: !attr.text.startsWith('_'),
      });
    }
    return;
  }
  if (left.type !== 'identifier') return;
  ctx.typeHint(left.text, assignedType(node));

  if (ctx.inCallable()) return;
  if (!stmt || stmt.type !== 'expression_statement') return;
  const name = left.text;
  const pk = ctx.parentKind();
  if (pk !== null && pk !== 'class') return;
  ctx.def(node, {
    name,
    kind: pk === 'class' ? 'field' : isConstName(name) ? 'constant' : 'variable',
    range: stmt,
    body: null,
    exported: pk === null && !name.startsWith('_'),
  });
};

const call: Visitor = (node, ctx) => {
  const fn = field(node, 'function');
  if (!fn) return;
  if (fn.type === 'identifier') ctx.call(fn.text, node);
  else if (fn.type === 'attribute') {
    const obj = field(fn, 'object');
    // super().method() is a call on the parent class, not on an unknown expression.
    const isSuper = obj?.type === 'call' && field(obj, 'function')?.text === 'super';
    ctx.call(field(fn, 'attribute')?.text, node, isSuper ? 'super' : simpleReceiver(obj));
  }
};

/** `def f(x: Foo, y: Bar = ...)` */
const typedParameter: Visitor = (node, ctx) => {
  const type = field(node, 'type');
  const name = field(node, 'name') ?? node.namedChildren[0];
  if (type && name && name.type === 'identifier') ctx.typeHint(name.text, type.text);
};

/** Applying a decorator calls it: `@register.filter` / `@cached_property`. (`@foo(...)` is a call already.) */
const decorator: Visitor = (node, ctx) => {
  const expr = node.namedChildren[0];
  if (!expr) return;
  if (expr.type === 'identifier') ctx.call(expr.text, node);
  else if (expr.type === 'attribute') {
    ctx.call(field(expr, 'attribute')?.text, node, simpleReceiver(field(expr, 'object')));
  }
};

const importStatement: Visitor = (node, ctx) => {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'dotted_name') ctx.imp(c.text, node, [lastSegment(c.text)]);
    else if (c.type === 'aliased_import') {
      const name = field(c, 'name');
      if (name) ctx.imp(name.text, node, [field(c, 'alias')?.text ?? lastSegment(name.text)]);
    }
  }
};

const importFrom: Visitor = (node, ctx) => {
  const mod = field(node, 'module_name');
  if (!mod) return;
  const names: string[] = [];
  for (const c of node.childrenForFieldName('name')) {
    if (!c) continue;
    // The name bound in this module is the alias when there is one.
    if (c.type === 'aliased_import') {
      const original = field(c, 'name')?.text ?? c.text;
      const alias = field(c, 'alias')?.text;
      names.push(alias && alias !== original ? `${alias}=${original}` : original);
    }
    else names.push(c.text);
  }
  ctx.imp(mod.text, node, names);
};

export const python: LangSpec = {
  id: 'python',
  grammar: 'python',
  extensions: ['.py', '.pyi', '.pyw'],
  identifiers: ['identifier'],
  visit: {
    function_definition: functionDef,
    class_definition: classDef,
    assignment,
    typed_parameter: typedParameter,
    typed_default_parameter: typedParameter,
    decorator,
    call,
    import_statement: importStatement,
    import_from_statement: importFrom,
  },
};

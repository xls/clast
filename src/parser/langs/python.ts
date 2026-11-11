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
      ctx.inherit(sym, lastSegment(s.text.replace(/\[.*$/s, '')), 'extends');
    }
  }
};

/** Module-level and class-level assignments become variables / fields. */
const assignment: Visitor = (node, ctx) => {
  if (ctx.inCallable()) return;
  const stmt = node.parent;
  if (!stmt || stmt.type !== 'expression_statement') return;
  const left = field(node, 'left');
  if (!left || left.type !== 'identifier') return;
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
    ctx.call(field(fn, 'attribute')?.text, node, simpleReceiver(field(fn, 'object')));
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
    if (c.type === 'aliased_import') names.push(field(c, 'name')?.text ?? c.text);
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
    call,
    import_statement: importStatement,
    import_from_statement: importFrom,
  },
};

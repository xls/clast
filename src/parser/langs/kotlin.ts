import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { childOfType, field, isConstName, lastSegment, simpleReceiver } from '../spec.js';

const MAX_SIG = 400;

function modifiersOf(node: Node): Node | null {
  return childOfType(node, 'modifiers');
}

/** True when the modifiers contain this keyword (`private`, `override`, `const`, `enum`, ...). */
function hasModifier(mods: Node | null, keyword: string): boolean {
  if (!mods) return false;
  for (const c of mods.namedChildren) {
    if (c && c.type !== 'annotation' && c.text === keyword) return true;
  }
  return false;
}

/** Kotlin is public by default. */
function isExported(mods: Node | null): boolean {
  return !hasModifier(mods, 'private') && !hasModifier(mods, 'internal');
}

/** Offset where the signature starts: after leading annotations. */
function sigStart(node: Node, mods: Node | null): number {
  if (!mods) return node.startIndex;
  for (const c of mods.namedChildren) {
    if (c && c.type !== 'annotation') return c.startIndex;
  }
  return mods.nextSibling ? mods.nextSibling.startIndex : node.startIndex;
}

function signature(ctx: Ctx, node: Node, mods: Node | null, body: Node | null): string {
  const start = sigStart(node, mods);
  let end = body && body.startIndex > start ? body.startIndex : node.endIndex;
  if (end - start > MAX_SIG) end = start + MAX_SIG;
  return ctx.src.slice(start, end).replace(/\s*[{=]\s*$/, '').replace(/\s+/g, ' ').trim();
}

/** Raw text of a declared type for ctx.typeHint: `Repo`, `List<Repo>`, `Repo?`. */
function typeText(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'nullable_type') return typeText(node.namedChild(0));
  if (node.type !== 'user_type') return null;
  return node.endIndex - node.startIndex > 120 ? simpleType(node) : node.text;
}

/** Simple name of a user_type: `a.b.Foo<T>` -> Foo. */
function simpleType(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'nullable_type') return simpleType(node.namedChild(0));
  if (node.type === 'identifier') return node.text;
  if (node.type !== 'user_type') return null;
  let last: string | null = null;
  for (const c of node.namedChildren) if (c && c.type === 'identifier') last = c.text;
  return last ?? lastSegment(node.text.replace(/<.*$/s, ''));
}

/** First child that denotes a type (the grammar has no field name for it). */
function typeChild(node: Node): Node | null {
  return childOfType(node, 'user_type', 'nullable_type');
}

/** `Foo(...)` with a capitalised callee constructs a Foo. */
function constructedType(value: Node | null | undefined): string | null {
  if (!value || value.type !== 'call_expression') return null;
  const callee = value.namedChild(0);
  return callee && callee.type === 'identifier' && /^[A-Z]/.test(callee.text) ? callee.text : null;
}

function enclosingClass(node: Node): Node | null {
  let n: Node | null = node.parent;
  for (let i = 0; n && i < 8; i++, n = n.parent) {
    if (n.type === 'class_declaration' || n.type === 'object_declaration') return n;
  }
  return null;
}

const classDeclaration: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || !name.text) return; // a missing name is a recovered parse error
  const mods = modifiersOf(node);
  const kind = childOfType(node, 'interface') || node.children.some(c => c?.type === 'interface')
    ? 'interface'
    : hasModifier(mods, 'enum') ? 'enum' : 'class';
  const body = childOfType(node, 'class_body', 'enum_class_body');
  const sym = ctx.def(node, { name: name.text, kind, sig: signature(ctx, node, mods, body), exported: isExported(mods) });

  // `: Base(args), Shape`: a constructor call names the superclass, a bare type an interface.
  for (const spec of childOfType(node, 'delegation_specifiers')?.namedChildren ?? []) {
    const inner = spec?.namedChild(0);
    if (!inner) continue;
    if (inner.type === 'constructor_invocation') ctx.inherit(sym, simpleType(inner.namedChild(0)), 'extends');
    else if (inner.type === 'user_type') ctx.inherit(sym, simpleType(inner), kind === 'interface' ? 'extends' : 'implements');
    else if (inner.type === 'explicit_delegation') ctx.inherit(sym, simpleType(inner.namedChild(0)), 'implements');
  }

  // Primary constructor: `val` / `var` parameters are properties; all of them are in scope of the class.
  for (const p of childOfType(childOfType(node, 'primary_constructor'), 'class_parameters')?.namedChildren ?? []) {
    if (!p || p.type !== 'class_parameter') continue;
    const pName = childOfType(p, 'identifier');
    if (!pName) continue;
    const type = typeText(typeChild(p));
    if (p.children.some(c => c?.type === 'val' || c?.type === 'var')) {
      ctx.def(p, {
        name: pName.text, kind: 'field', sig: p.text.replace(/\s+/g, ' ').slice(0, 200), scope: false,
        exported: isExported(modifiersOf(p)),
      });
    }
    if (type) ctx.typeHint(pName.text, type, true);
  }
};

const objectDeclaration: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || !name.text) return; // a missing name is a recovered parse error
  const mods = modifiersOf(node);
  const sym = ctx.def(node, {
    name: name.text, kind: 'class', sig: signature(ctx, node, mods, childOfType(node, 'class_body')), exported: isExported(mods),
  });
  for (const spec of childOfType(node, 'delegation_specifiers')?.namedChildren ?? []) {
    const inner = spec?.namedChild(0);
    if (!inner) continue;
    if (inner.type === 'constructor_invocation') ctx.inherit(sym, simpleType(inner.namedChild(0)), 'extends');
    else if (inner.type === 'user_type') ctx.inherit(sym, simpleType(inner), 'implements');
  }
};

const functionDeclaration: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || !name.text) return; // a missing name is a recovered parse error
  const mods = modifiersOf(node);
  // Extension function `fun Type.name()`: the receiver type comes before the name.
  let receiver: string | null = null;
  for (const c of node.namedChildren) {
    if (!c || c.startIndex >= name.startIndex) break;
    if (c.type === 'user_type' || c.type === 'nullable_type') receiver = simpleType(c);
  }
  const parent = ctx.parentKind();
  const member = parent === 'class' || parent === 'interface' || parent === 'enum';
  ctx.def(node, {
    name: name.text,
    kind: member || receiver ? 'method' : 'function',
    sig: signature(ctx, node, mods, childOfType(node, 'function_body')),
    qualifier: member ? null : receiver,
    exported: isExported(mods),
  });
};

const secondaryConstructor: Visitor = (node, ctx) => {
  const cls = enclosingClass(node);
  const name = cls ? field(cls, 'name') : null;
  if (!name || !name.text) return; // a missing name is a recovered parse error
  const mods = modifiersOf(node);
  ctx.def(node, {
    name: name.text, kind: 'method', sig: signature(ctx, node, mods, childOfType(node, 'block')), exported: isExported(mods),
  });
};

/** `this(...)` / `super(...)` after a secondary constructor's parameter list. */
const constructorDelegation: Visitor = (node, ctx) => {
  const cls = enclosingClass(node);
  if (!cls) return;
  if (node.children.some(c => c?.type === 'this')) {
    ctx.call(field(cls, 'name')?.text, node);
    return;
  }
  for (const spec of childOfType(cls, 'delegation_specifiers')?.namedChildren ?? []) {
    const inner = spec?.namedChild(0);
    if (inner?.type === 'constructor_invocation' || inner?.type === 'user_type') {
      ctx.call(simpleType(inner.type === 'user_type' ? inner : inner.namedChild(0)), node);
      return;
    }
  }
};

const parameter: Visitor = (node, ctx) => {
  ctx.typeHint(childOfType(node, 'identifier')?.text, typeText(typeChild(node)));
};

/** Properties are symbols at file and class level; locals only say what type a receiver has. */
const propertyDeclaration: Visitor = (node, ctx) => {
  const decl = childOfType(node, 'variable_declaration');
  const nameNode = childOfType(decl, 'identifier');
  if (!decl || !nameNode) return; // destructuring declaration
  const name = nameNode.text;
  let value: Node | null = null;
  for (const c of node.namedChildren) {
    if (c && c.startIndex > decl.endIndex && c.type !== 'getter' && c.type !== 'setter' && c.type !== 'property_delegate') {
      value = c;
      break;
    }
  }
  const type = typeText(typeChild(decl)) ?? constructedType(value);
  const container = node.parent?.type;
  const topLevel = container === 'source_file';
  if (!topLevel && container !== 'class_body' && container !== 'enum_class_body') {
    if (type) ctx.typeHint(name, type);
    return;
  }
  const mods = modifiersOf(node);
  const isConst = hasModifier(mods, 'const') || (topLevel && isConstName(name));
  const end = value && node.endIndex - node.startIndex > 120 ? value.startIndex : node.endIndex;
  ctx.def(node, {
    name,
    kind: isConst ? 'constant' : topLevel ? 'variable' : 'field',
    sig: ctx.src.slice(sigStart(node, mods), Math.min(end, sigStart(node, mods) + MAX_SIG)).replace(/\s*=\s*$/, '').replace(/\s+/g, ' ').trim(),
    exported: isExported(mods),
    scope: false,
  });
  if (type) ctx.typeHint(name, type, !topLevel);
};

const enumEntry: Visitor = (node, ctx) => {
  const name = childOfType(node, 'identifier');
  if (!name || !name.text) return; // a missing name is a recovered parse error
  ctx.def(node, { name: name.text, kind: 'constant', sig: name.text, exported: true, scope: false });
};

const typeAlias: Visitor = (node, ctx) => {
  const name = field(node, 'type') ?? childOfType(node, 'identifier');
  if (!name || !name.text) return; // a missing name is a recovered parse error
  ctx.def(node, { name: name.text, kind: 'type', sig: node.text.replace(/\s+/g, ' ').slice(0, 200), exported: isExported(modifiersOf(node)) });
};

const callExpression: Visitor = (node, ctx) => {
  const callee = node.namedChild(0);
  if (!callee) return;
  if (callee.type === 'identifier') {
    ctx.call(callee.text, node);
    return;
  }
  if (callee.type !== 'navigation_expression') return;
  // `receiver.name(...)`: the name is the last identifier, the receiver everything before the last dot.
  const name = callee.namedChild(callee.namedChildCount - 1);
  const recv = callee.namedChild(0);
  if (!name || name.type !== 'identifier' || !recv || recv === name) return;
  const receiver =
    recv.type === 'this_expression' ? 'this' : recv.type === 'super_expression' ? 'super' : simpleReceiver(recv);
  ctx.call(name.text, node, receiver);
};

/** `Foo::bar` and `::bar` pass a function as a value: count it as a use of `bar`. */
const callableReference: Visitor = (node, ctx) => {
  const member = node.namedChild(node.namedChildCount - 1);
  if (!member || member.type !== 'identifier') return;
  const target = node.namedChildCount > 1 ? node.namedChild(0) : null;
  ctx.call(member.text, node, target ? simpleReceiver(target) : undefined);
};

const importDirective: Visitor = (node, ctx) => {
  const path = childOfType(node, 'qualified_identifier');
  if (!path) return;
  const source = path.text.replace(/\s+/g, '');
  if (node.text.trimEnd().endsWith('*')) {
    ctx.imp(source + '.*', node, ['*']);
    return;
  }
  // `import a.b.W as V`: the alias follows the path.
  let alias: string | null = null;
  for (const c of node.namedChildren) if (c && c.type === 'identifier' && c.startIndex > path.endIndex) alias = c.text;
  const original = lastSegment(source);
  ctx.imp(source, node, [alias ? `${alias}=${original}` : original]);
};

export const kotlin: LangSpec = {
  id: 'kotlin',
  grammar: 'kotlin',
  extensions: ['.kt', '.kts'],
  identifiers: ['identifier'],
  visit: {
    class_declaration: classDeclaration,
    object_declaration: objectDeclaration,
    function_declaration: functionDeclaration,
    secondary_constructor: secondaryConstructor,
    constructor_delegation_call: constructorDelegation,
    parameter,
    property_declaration: propertyDeclaration,
    enum_entry: enumEntry,
    type_alias: typeAlias,
    call_expression: callExpression,
    callable_reference: callableReference,
    import: importDirective,
  },
};

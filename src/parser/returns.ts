import { typeName } from './spec.js';

/**
 * Best-effort return type of a function from its signature text. Used to
 * type call chains (`a.b().c()`): the receiver of `c` is whatever `b`
 * returns. Purely syntactic; returns null when unsure.
 *
 * `selfType` is the enclosing class, substituted for Self / self / static /
 * this (fluent builders).
 */
export function returnTypeOf(
  signature: string,
  name: string,
  lang: string,
  selfType: string | null,
  allowLowercase: boolean
): string | null {
  const raw = rawReturnType(signature, name, lang);
  if (!raw) return null;
  const text = raw.trim();
  if (/^(&\s*(mut\s+)?)?(Self|self|static|\$this|this)\b/.test(text)) return selfType;
  // Result<T, E> / (T, error): the interesting part is T.
  const result = /^(?:\w+::)*Result\s*<\s*(.+)$/s.exec(text);
  const inner = result ? firstTypeArg(result[1]!) : text.startsWith('(') ? firstTypeArg(text.slice(1)) : text;
  if (/^(&\s*(mut\s+)?)?(Self|self|static)\b/.test(inner.trim())) return selfType;
  return typeName(inner, allowLowercase);
}

function firstTypeArg(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') {
      if (depth === 0) return text.slice(0, i);
      depth--;
    } else if (ch === ',' && depth === 0) return text.slice(0, i);
  }
  return text;
}

/** Index just past the parameter list that follows `name` in `sig`, or -1. */
function afterParams(sig: string, name: string): number {
  let from = 0;
  for (;;) {
    const at = sig.indexOf(name, from);
    if (at === -1) return -1;
    let i = at + name.length;
    // optional generic parameters between the name and '('
    while (i < sig.length && /\s/.test(sig[i]!)) i++;
    if (sig[i] === '<' || sig[i] === '[') {
      const open = sig[i]!;
      const close = open === '<' ? '>' : ']';
      let depth = 0;
      for (; i < sig.length; i++) {
        if (sig[i] === open) depth++;
        else if (sig[i] === close && --depth === 0) { i++; break; }
      }
      while (i < sig.length && /\s/.test(sig[i]!)) i++;
    }
    if (sig[i] === '(') {
      let depth = 0;
      for (; i < sig.length; i++) {
        if (sig[i] === '(') depth++;
        else if (sig[i] === ')' && --depth === 0) return i + 1;
      }
      return -1;
    }
    from = at + name.length;
  }
}

function rawReturnType(sig: string, name: string, lang: string): string | null {
  switch (lang) {
    case 'python': {
      const m = /->\s*([^:]+?)\s*:?\s*$/.exec(sig);
      return m ? m[1]!.replace(/^["']|["']$/g, '') : null;
    }
    case 'rust':
    case 'swift': {
      const end = afterParams(sig, name);
      if (end === -1) return null;
      const m = /^\s*->\s*(.+?)(?:\s+where\b.*)?$/s.exec(sig.slice(end));
      return m ? m[1]! : null;
    }
    case 'typescript':
    case 'tsx':
    case 'php':
    case 'kotlin': {
      const end = afterParams(sig, name);
      const tail = end !== -1 ? sig.slice(end) : (/\)\s*(:.*)$/s.exec(sig)?.[1] ?? '');
      const m = /^\s*:\s*([^={]+?)\s*(=>)?\s*$/s.exec(tail);
      return m ? m[1]! : null;
    }
    case 'go': {
      const end = afterParams(sig, name);
      if (end === -1) return null;
      const rest = sig.slice(end).trim();
      return rest ? rest : null;
    }
    case 'java':
    case 'csharp':
    case 'dart':
    case 'c':
    case 'cpp': {
      // <modifiers> <ReturnType> [Class::]name(...)
      const at = sig.search(new RegExp('(?:[\\w~]+\\s*::\\s*)*\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:<[^()]*>)?\\s*\\('));
      if (at <= 0) return null;
      let head = sig
        .slice(0, at)
        .replace(/@\w+(\([^)]*\))?/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\btemplate\s*<[^>]*>/g, ' ')
        .trim();
      if (!head) return null;
      // The trailing type expression, balancing <>.
      let depth = 0;
      let i = head.length - 1;
      for (; i >= 0; i--) {
        const ch = head[i]!;
        if (ch === '>') depth++;
        else if (ch === '<') depth--;
        else if (/\s/.test(ch) && depth === 0) break;
      }
      head = head.slice(i + 1);
      if (/^(public|private|protected|static|final|virtual|inline|override|async|abstract|explicit|constexpr|new|return|void)$/.test(head)) {
        return null;
      }
      return head;
    }
    default:
      return null;
  }
}

/**
 * Parameter counts read from a signature, used to tell overloads apart and to
 * reject call sites that cannot be calls of a definition (`info.partition()`
 * is not `Partitioner.partition(topic, key, keyBytes, value, valueBytes, cluster)`).
 *
 * Everything here is conservative: when a signature cannot be read with
 * confidence the result is null, which callers treat as "anything fits".
 */
export interface ParamRange {
  /** Required parameters. */
  min: number;
  /** All parameters; Infinity for variadic functions. */
  max: number;
  /** C# extension method: the first (`this`) parameter is the receiver when called as a member. */
  ext: boolean;
}

/** Languages whose signatures are checked. Others (PHP, Ruby, JavaScript, Swift, Dart) accept any count. */
export const ARITY_LANGS = new Set(['java', 'csharp', 'go', 'c', 'cpp', 'typescript', 'tsx', 'python', 'rust']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index of the `)` matching the `(` at `open`, or -1. Skips string literals. */
function closing(sig: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    const ch = sig[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = sig.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split a parameter list on top-level commas. */
function splitParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = list.indexOf(ch, i + 1);
      if (end === -1) break;
      i = end;
    } else if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '>') {
      // Not the arrow of `=>` / `->`.
      const prev = list[i - 1];
      if (prev !== '=' && prev !== '-') depth--;
    } else if (ch === ',' && depth <= 0) {
      out.push(list.slice(start, i));
      start = i + 1;
      depth = 0;
    }
  }
  out.push(list.slice(start));
  return out.map(p => p.trim()).filter(Boolean);
}

/** True when the parameter has a default value (`x = 1`, `x: int = 1`) at its top level. */
function hasDefault(param: string): boolean {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const ch = param[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && param[i - 1] !== '=' && param[i - 1] !== '-')) depth--;
    else if (ch === '=' && depth <= 0) {
      const next = param[i + 1];
      const prev = param[i - 1];
      if (next !== '=' && next !== '>' && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>') return true;
    }
  }
  return false;
}

export function paramRange(signature: string, name: string, lang: string): ParamRange | null {
  if (!ARITY_LANGS.has(lang) || !signature || !name) return null;
  let sig = signature;
  if (lang === 'go') {
    // func (r *T) Name(...): skip the receiver.
    const recv = /^func\s*\(/.exec(sig);
    if (recv) {
      const end = closing(sig, recv[0].length - 1);
      if (end === -1) return null;
      sig = sig.slice(end + 1);
    }
  }
  const m = new RegExp('(?:^|[^\\w$])' + escapeRe(name) + '\\s*(?=[<\\[(])').exec(sig);
  if (!m) return null;
  let i = m.index + m[0].length;
  // Type parameters: <T, U> or Go [T any].
  if (sig[i] === '<' || sig[i] === '[') {
    const open = sig[i];
    const close = open === '<' ? '>' : ']';
    let depth = 0;
    for (; i < sig.length; i++) {
      if (sig[i] === open) depth++;
      else if (sig[i] === close && sig[i - 1] !== '=' && sig[i - 1] !== '-' && --depth === 0) { i++; break; }
    }
    while (sig[i] === ' ') i++;
  }
  if (sig[i] !== '(') return null;
  const end = closing(sig, i);
  if (end === -1) return null; // truncated signature
  let params = splitParams(sig.slice(i + 1, end));

  if (lang === 'c' || lang === 'cpp') {
    if (params.length === 1 && params[0] === 'void') params = [];
    // `int f()` in C says nothing about the parameters.
    else if (params.length === 0 && lang === 'c') return null;
  }
  if (lang === 'python') {
    if (params.length && /^(self|cls)\b/.test(params[0]!)) params = params.slice(1);
  } else if (lang === 'rust') {
    if (params.length && /^(&\s*('\w+\s+)?)?(mut\s+)?self\b/.test(params[0]!)) params = params.slice(1);
  } else if (lang === 'typescript' || lang === 'tsx') {
    if (params.length && /^this\s*:/.test(params[0]!)) params = params.slice(1);
  }

  let min = 0;
  let max = 0;
  let variadic = false;
  let ext = false;
  for (let k = 0; k < params.length; k++) {
    const p = params[k]!;
    if (lang === 'python') {
      if (p === '*' || p === '/') continue; // keyword-only / positional-only markers
      if (p.startsWith('*')) { variadic = true; continue; }
    }
    if (p.includes('...') || (lang === 'csharp' && /^(\[[^\]]*\]\s*)*params\s/.test(p))) {
      variadic = true;
      continue;
    }
    if (lang === 'csharp' && k === 0 && /^(\[[^\]]*\]\s*)*this\s/.test(p)) ext = true;
    max++;
    const optional =
      hasDefault(p) ||
      ((lang === 'typescript' || lang === 'tsx') && /^[\w$]+\?\s*(:|$)/.test(p));
    if (!optional) min++;
  }
  return { min, max: variadic ? Infinity : max, ext };
}

/**
 * Can a call with `argc` arguments be a call of a function with this range?
 * `unbound` marks calls written through a type name (`Base.save(self, x)`,
 * `Type::method(value, x)`), which pass the receiver as an argument.
 */
export function arityFits(range: ParamRange | null, argc: number, lang: string, unbound: boolean): boolean {
  if (!range || argc < 0) return true;
  if (argc >= range.min && argc <= range.max) return true;
  // Extension method called as a member: the receiver fills the `this` parameter.
  if (range.ext && argc + 1 >= range.min && argc + 1 <= range.max) return true;
  if (unbound && (lang === 'python' || lang === 'rust') && argc - 1 >= range.min && argc - 1 <= range.max) return true;
  // Go: f(g()) forwards all results of g.
  if (lang === 'go' && argc === 1 && range.min > 1) return true;
  return false;
}

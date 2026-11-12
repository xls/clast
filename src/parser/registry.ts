import type { LangSpec } from './spec.js';
import { javascript, typescript, tsx } from './langs/typescript.js';
import { python } from './langs/python.js';
import { go } from './langs/go.js';
import { rust } from './langs/rust.js';
import { java } from './langs/java.js';
import { csharp } from './langs/csharp.js';
import { c, cpp } from './langs/c.js';
import { ruby } from './langs/ruby.js';
import { php } from './langs/php.js';
import { swift } from './langs/swift.js';
import { dart } from './langs/dart.js';

/**
 * All language specs. To add a language: create `langs/<name>.ts` exporting a
 * LangSpec and add it here. The grammar must exist in @repomix/tree-sitter-wasms.
 */
export const SPECS: LangSpec[] = [
  typescript,
  tsx,
  javascript,
  python,
  go,
  rust,
  java,
  csharp,
  c,
  cpp,
  ruby,
  php,
  swift,
  dart,
];

const BY_ID = new Map<string, LangSpec>();
const BY_EXT = new Map<string, LangSpec>();

function rebuild(): void {
  BY_ID.clear();
  BY_EXT.clear();
  for (const spec of SPECS) {
    BY_ID.set(spec.id, spec);
    for (const ext of spec.extensions) {
      if (!BY_EXT.has(ext)) BY_EXT.set(ext, spec);
    }
  }
}
rebuild();

export function registerSpec(spec: LangSpec): void {
  const i = SPECS.findIndex(s => s.id === spec.id);
  if (i >= 0) SPECS[i] = spec;
  else SPECS.push(spec);
  rebuild();
}

export function specById(id: string): LangSpec | undefined {
  return BY_ID.get(id);
}

export function specForExtension(ext: string): LangSpec | undefined {
  return BY_EXT.get(ext.toLowerCase());
}

/**
 * Config language names map to spec ids; a few names enable several specs
 * ("typescript" also enables tsx, "c" and "cpp" share headers).
 */
export function enabledSpecs(languages: string[] | undefined): LangSpec[] {
  if (!languages || languages.length === 0) return SPECS;
  const want = new Set(languages.map(l => l.toLowerCase()));
  if (want.has('typescript')) want.add('tsx');
  if (want.has('c++')) want.add('cpp');
  if (want.has('c#')) want.add('csharp');
  return SPECS.filter(s => want.has(s.id));
}

export function supportedExtensions(languages?: string[]): Set<string> {
  const out = new Set<string>();
  for (const spec of enabledSpecs(languages)) {
    for (const ext of spec.extensions) out.add(ext);
  }
  return out;
}

export function allLanguageIds(): string[] {
  return SPECS.map(s => s.id);
}

import { Parser, Language, type Tree } from 'web-tree-sitter';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Extraction } from '../types.js';
import type { LangSpec } from './spec.js';
import { compileSpec, extract, type CompiledSpec } from './extractor.js';
import { specById, specForExtension } from './registry.js';

let initPromise: Promise<void> | null = null;

function grammarPath(grammar: string): string | null {
  const file = `tree-sitter-${grammar}.wasm`;
  const candidates: string[] = [];
  if (process.env.CLAST_GRAMMARS_DIR) candidates.push(join(process.env.CLAST_GRAMMARS_DIR, file));
  try {
    const require = createRequire(import.meta.url);
    const pkg = dirname(require.resolve('@repomix/tree-sitter-wasms/package.json'));
    candidates.push(join(pkg, 'out', file));
  } catch {
    // package not resolvable; fall through to local grammar dirs
  }
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(here, '..', '..', 'grammars', file));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Owns one tree-sitter parser and lazily loaded grammars. One instance per
 * thread (the main thread and each indexing worker have their own).
 */
export class SourceParser {
  private parser: Parser | null = null;
  private compiled = new Map<string, CompiledSpec | null>();

  async init(): Promise<void> {
    initPromise ??= Parser.init();
    await initPromise;
    this.parser ??= new Parser();
  }

  /** Load (once) and compile the spec's grammar. Returns null if unavailable. */
  async load(spec: LangSpec): Promise<CompiledSpec | null> {
    const cached = this.compiled.get(spec.id);
    if (cached !== undefined) return cached;
    await this.init();
    let result: CompiledSpec | null = null;
    const path = grammarPath(spec.grammar);
    if (!path) {
      console.error(`[clast] No grammar found for ${spec.id} (tree-sitter-${spec.grammar}.wasm)`);
    } else {
      try {
        const language = await Language.load(path);
        result = compileSpec(spec, language);
        if (result.unknownTypes.length && process.env.CLAST_DEBUG) {
          console.error(`[clast] ${spec.id}: node types not in grammar: ${result.unknownTypes.join(', ')}`);
        }
      } catch (err) {
        console.error(`[clast] Failed to load grammar for ${spec.id}:`, err);
      }
    }
    this.compiled.set(spec.id, result);
    return result;
  }

  /** Resolve the spec for a path (+ content sniffing), or undefined. */
  specFor(path: string, source?: string): LangSpec | undefined {
    const spec = specForExtension(extname(path));
    if (spec && spec.sniff && source !== undefined) {
      const alt = spec.sniff(source, path);
      if (alt) return specById(alt) ?? spec;
    }
    return spec;
  }

  /** Parse and extract a single source text. Returns null for unsupported files. */
  async extract(path: string, source: string): Promise<Extraction | null> {
    const spec = this.specFor(path, source);
    if (!spec) return null;
    const compiled = await this.load(spec);
    if (!compiled || !this.parser) return null;
    this.parser.setLanguage(compiled.language);
    if (spec.preprocess) source = spec.preprocess(source, path);
    const tree = this.parser.parse(source);
    if (!tree) return null;
    try {
      return extract(tree, source, compiled);
    } finally {
      tree.delete();
    }
  }

  /** Parse a text as the given language. The caller deletes the tree. Null if the grammar is unavailable. */
  async parseAs(specId: string, source: string, path?: string): Promise<Tree | null> {
    const spec = specById(specId);
    if (!spec) return null;
    if (path && spec.preprocess) source = spec.preprocess(source, path);
    const compiled = await this.load(spec);
    if (!compiled || !this.parser) return null;
    this.parser.setLanguage(compiled.language);
    return this.parser.parse(source);
  }

  /** Debug helper: S-expression-ish dump of the tree with field names. */
  async dumpTree(path: string, source: string, maxDepth = 40): Promise<string> {
    const spec = this.specFor(path, source);
    if (!spec) return `unsupported file type: ${path}`;
    const compiled = await this.load(spec);
    if (!compiled || !this.parser) return `grammar unavailable for ${spec.id}`;
    this.parser.setLanguage(compiled.language);
    const tree = this.parser.parse(source);
    if (!tree) return 'parse failed';
    const out: string[] = [];
    const cursor = tree.walk();
    const walk = (depth: number): void => {
      if (cursor.nodeIsNamed) {
        const f = cursor.currentFieldName;
        const pos = cursor.startPosition;
        let line = `${'  '.repeat(depth)}${f ? f + ': ' : ''}${cursor.nodeType} [${pos.row + 1}:${pos.column}]`;
        const node = cursor.currentNode;
        if (node.namedChildCount === 0) line += ` ${JSON.stringify(node.text.slice(0, 60))}`;
        out.push(line);
      }
      if (depth < maxDepth && cursor.gotoFirstChild()) {
        do walk(depth + (cursor.nodeIsNamed ? 1 : 1)); while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    walk(0);
    cursor.delete();
    tree.delete();
    return out.join('\n');
  }
}

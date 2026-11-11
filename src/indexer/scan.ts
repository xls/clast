import ignoreFactory, { type Ignore } from 'ignore';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ClastConfig } from '../config/index.js';
import { supportedExtensions } from '../parser/registry.js';

// `ignore` is CJS; under NodeNext the default import may be the module object.
const createIgnore: () => Ignore =
  (ignoreFactory as unknown as { default?: () => Ignore }).default ?? (ignoreFactory as unknown as () => Ignore);

export interface ScannedFile {
  abs: string;
  /** Project-relative path with forward slashes. */
  rel: string;
  mtime: number;
  size: number;
}

interface Rule {
  /** Directory prefix this rule set is relative to ('' or 'a/b/'). */
  base: string;
  ig: Ignore;
}

/**
 * Ignore decisions shared by the scanner and the watcher: config patterns plus
 * (optionally) every .gitignore from the project root down to the file.
 */
export class IgnoreRules {
  private readonly root: string;
  private readonly useGitignore: boolean;
  private readonly rootRule: Rule;
  private readonly dirRules = new Map<string, Rule | null>();
  readonly extensions: Set<string>;
  readonly maxFileSize: number;

  constructor(root: string, config: ClastConfig) {
    this.root = root;
    this.useGitignore = config.respectGitignore;
    this.rootRule = { base: '', ig: createIgnore().add(config.ignoredPaths) };
    this.extensions = supportedExtensions(config.languages);
    this.maxFileSize = config.maxFileSize;
  }

  /** Forget cached .gitignore contents (call when a .gitignore changes). */
  invalidate(): void {
    this.dirRules.clear();
  }

  /** Rule for the .gitignore inside `dirRel` ('' or 'a/b/'), if any. */
  private ruleFor(dirRel: string): Rule | null {
    if (!this.useGitignore) return null;
    let rule = this.dirRules.get(dirRel);
    if (rule !== undefined) return rule;
    rule = null;
    const file = join(this.root, dirRel, '.gitignore');
    try {
      if (existsSync(file)) {
        rule = { base: dirRel, ig: createIgnore().add(readFileSync(file, 'utf-8')) };
      }
    } catch {
      rule = null;
    }
    this.dirRules.set(dirRel, rule);
    return rule;
  }

  private static test(rules: Rule[], rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of rules) {
      const sub = rel.slice(r.base.length) + (isDir ? '/' : '');
      if (!sub) continue;
      const t = r.ig.test(sub);
      if (t.ignored) ignored = true;
      else if (t.unignored) ignored = false;
    }
    return ignored;
  }

  /** Full check for an arbitrary project-relative path (used by the watcher). */
  isIgnored(rel: string): boolean {
    const parts = rel.split('/');
    const rules: Rule[] = [this.rootRule];
    const rootGit = this.ruleFor('');
    if (rootGit) rules.push(rootGit);
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isDir = i < parts.length - 1;
      if (isDir && name.startsWith('.')) return true;
      const path = prefix + name;
      if (IgnoreRules.test(rules, path, isDir)) return true;
      if (isDir) {
        prefix = path + '/';
        const r = this.ruleFor(prefix);
        if (r) rules.push(r);
      }
    }
    return false;
  }

  isSupported(rel: string): boolean {
    return this.extensions.has(extname(rel).toLowerCase());
  }

  /** Walk the project and return every indexable file. */
  async scan(): Promise<ScannedFile[]> {
    const candidates: string[] = [];
    const rules: Rule[] = [this.rootRule];
    this.walk('', rules, candidates, 0);

    // stat() dominates a warm start (especially on Windows); run it on the
    // libuv thread pool instead of serially on the main thread.
    const out: ScannedFile[] = new Array(candidates.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        const i = next++;
        const rel = candidates[i]!;
        const abs = join(this.root, rel);
        try {
          const st = await stat(abs);
          if (st.size <= this.maxFileSize) out[i] = { abs, rel, mtime: st.mtimeMs, size: st.size };
        } catch {
          // vanished between readdir and stat
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(32, candidates.length) }, worker));
    return out.filter(Boolean);
  }

  private walk(dirRel: string, parentRules: Rule[], out: string[], depth: number): void {
    if (depth > 40) return;
    const rule = this.ruleFor(dirRel);
    const rules = rule ? [...parentRules, rule] : parentRules;

    let entries;
    try {
      entries = readdirSync(join(this.root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const name = e.name;
      if (e.isDirectory()) {
        if (name.startsWith('.')) continue;
        const rel = dirRel + name;
        if (IgnoreRules.test(rules, rel, true)) continue;
        this.walk(rel + '/', rules, out, depth + 1);
      } else if (e.isFile()) {
        if (!this.extensions.has(extname(name).toLowerCase())) continue;
        const rel = dirRel + name;
        if (IgnoreRules.test(rules, rel, false)) continue;
        out.push(rel);
      }
      // Symlinks are skipped: they cause cycles and duplicate symbols.
    }
  }
}

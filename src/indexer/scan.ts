import ignoreFactory, { type Ignore } from 'ignore';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ClastConfig } from '../config/index.js';
import { supportedExtensions } from '../parser/registry.js';

/** A project has thousands of directories; a home, temp or system directory has hundreds of thousands. */
const MAX_DIRS = 150_000;

// `ignore` is CJS; under NodeNext the default import may be the module object.
const createIgnore: () => Ignore =
  (ignoreFactory as unknown as { default?: () => Ignore }).default ?? (ignoreFactory as unknown as () => Ignore);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.psd', '.svgz', '.pdf', '.zip', '.gz',
  '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war', '.class', '.exe', '.dll', '.so', '.dylib', '.a',
  '.o', '.obj', '.lib', '.pdb', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov',
  '.avi', '.wav', '.ogg', '.flac', '.webm', '.bin', '.dat', '.db', '.sqlite', '.pyc', '.pyo', '.node', '.snap',
  '.map', '.min.js', '.icns', '.cur', '.keystore', '.p12', '.pfx', '.der', '.nupkg', '.dmg', '.iso', '.blend',
]);
const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'poetry.lock',
  'go.sum', 'bun.lockb', 'npm-shrinkwrap.json',
]);

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
    this.maxFiles = config.maxFiles;
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

  /** Files skipped by the last scan because they exceed maxFileSize. */
  skippedLarge = 0;
  /** True when the last scan stopped at the maxFiles cap or the directory cap. */
  truncated = false;
  /** True when the last scan stopped because the tree has more directories than a project plausibly has. */
  tooBroad = false;
  private dirsWalked = 0;
  private sliceStart = 0;
  private readonly maxFiles: number;

  /**
   * Project-relative paths of text-like files that are NOT indexed (config,
   * docs, data, unsupported languages) but pass the ignore rules. Used by
   * text search so it can replace a plain grep.
   */
  otherTextFiles(limit = 60000): string[] {
    const out: string[] = [];
    const visit = (dirRel: string, parentRules: Rule[], depth: number): void => {
      if (depth > 40 || out.length >= limit) return;
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
          if (name.startsWith('.') && name !== '.github') continue;
          const rel = dirRel + name;
          if (IgnoreRules.test(rules, rel, true)) continue;
          visit(rel + '/', rules, depth + 1);
        } else if (e.isFile()) {
          const ext = extname(name).toLowerCase();
          if (this.extensions.has(ext) || BINARY_EXTENSIONS.has(ext) || LOCK_FILES.has(name)) continue;
          const rel = dirRel + name;
          if (IgnoreRules.test(rules, rel, false)) continue;
          out.push(rel);
          if (out.length >= limit) return;
        }
      }
    };
    visit('', [this.rootRule], 0);
    return out;
  }

  /** Walk the project and return every indexable file. */
  async scan(): Promise<ScannedFile[]> {
    const candidates: string[] = [];
    this.skippedLarge = 0;
    this.truncated = false;
    this.tooBroad = false;
    this.dirsWalked = 0;
    this.sliceStart = performance.now();
    const rules: Rule[] = [this.rootRule];
    await this.walk('', rules, candidates, 0);

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
          else this.skippedLarge++;
        } catch {
          // vanished between readdir and stat
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(32, candidates.length) }, worker));
    return out.filter(Boolean);
  }

  /**
   * Reads directories synchronously (fastest for a normal project) but hands the event loop back every
   * few milliseconds: the walk starts right after the server connects, and a client that gets no answer
   * to its first request gives up. A tree far larger than a project (a home or temp directory) is cut off.
   */
  private async walk(dirRel: string, parentRules: Rule[], out: string[], depth: number): Promise<void> {
    if (depth > 40 || this.truncated) return;
    if (out.length >= this.maxFiles) {
      this.truncated = true;
      return;
    }
    if (++this.dirsWalked > MAX_DIRS) {
      this.truncated = true;
      this.tooBroad = true;
      return;
    }
    if (performance.now() - this.sliceStart > 15) {
      await new Promise<void>(done => setImmediate(done));
      this.sliceStart = performance.now();
    }
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
        await this.walk(rel + '/', rules, out, depth + 1);
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

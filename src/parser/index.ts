import TreeSitter from 'web-tree-sitter';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { getLanguageForExtension, getGrammarWasmPath, getSupportedExtensions } from './languages.js';
import { extractFromTree } from './extractor.js';
import { resolveCallEdges } from './call-resolver.js';
import type { ClastDatabase } from '../db/index.js';
import type { ClastConfig } from '../config/index.js';
import type { AstNodeRow } from '../db/types.js';

export class ParserManager {
  private parser: TreeSitter | null = null;
  private languages = new Map<string, TreeSitter.Language>();
  private config: ClastConfig;
  private initialized = false;

  constructor(config: ClastConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await TreeSitter.init();
    this.parser = new TreeSitter();
    this.initialized = true;
  }

  private async getLanguage(langName: string): Promise<TreeSitter.Language | null> {
    if (this.languages.has(langName)) {
      return this.languages.get(langName)!;
    }

    const wasmPath = getGrammarWasmPath(langName);
    if (!wasmPath) {
      console.error(`[clast] No WASM grammar found for ${langName}`);
      return null;
    }

    try {
      const language = await TreeSitter.Language.load(wasmPath);
      this.languages.set(langName, language);
      return language;
    } catch (err) {
      console.error(`[clast] Failed to load grammar for ${langName}:`, err);
      return null;
    }
  }

  async parseSource(source: string, langName: string): Promise<TreeSitter.Tree | null> {
    await this.init();
    if (!this.parser) return null;

    const language = await this.getLanguage(langName);
    if (!language) return null;

    this.parser.setLanguage(language);
    return this.parser.parse(source);
  }

  async parseAndStore(filePath: string, projectRoot: string, db: ClastDatabase): Promise<boolean> {
    const ext = extname(filePath);
    const langEntry = getLanguageForExtension(ext);
    if (!langEntry) return false;

    const relPath = relative(projectRoot, filePath).replace(/\\/g, '/');

    let source: string;
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      return false;
    }

    const hash = createHash('sha256').update(source).digest('hex');
    const existingHash = db.queries.getFileHash(relPath);
    if (existingHash === hash) return false;

    const tree = await this.parseSource(source, langEntry.name);
    if (!tree) return false;

    const result = extractFromTree(
      tree,
      relPath,
      langEntry.name,
      source,
      this.config.maxBodySize
    );

    // Delete old data for this file and upsert file record BEFORE inserting nodes
    // (nodes have a FK to files.file_path)
    db.queries.deleteNodesForFile(relPath);
    db.queries.upsertFile(relPath, hash, langEntry.name, result.nodes.length);

    // Insert nodes
    const nodeRows: Omit<AstNodeRow, 'id'>[] = result.nodes.map(n => ({
      file_path: n.filePath,
      name: n.name,
      type: n.type,
      signature: n.signature,
      start_line: n.startLine,
      end_line: n.endLine,
      start_col: n.startCol,
      end_col: n.endCol,
      parent_id: n.parentId,
      language: n.language,
      body_text: n.bodyText,
    }));

    const nodeIds = db.queries.insertNodes(nodeRows);

    // Insert edges
    const edgeRows = result.edges
      .filter(e => nodeIds[e.callerNodeIndex] !== undefined)
      .map(e => ({
        caller_id: nodeIds[e.callerNodeIndex]!,
        callee_id: null as number | null,
        callee_name: e.calleeName,
        file_path: relPath,
        line: e.line,
      }));

    if (edgeRows.length > 0) {
      db.queries.insertEdges(edgeRows);
    }

    // Insert comments
    for (const c of result.comments) {
      const dbId = nodeIds[c.nodeIndex];
      if (dbId !== undefined) {
        db.queries.insertComment(dbId, c.text, c.source);
      }
    }

    // Save DB periodically
    db.save();

    return true;
  }

  async fullIndex(
    projectRoot: string,
    db: ClastDatabase,
    onProgress?: (file: string, current: number, total: number) => void
  ): Promise<{ filesProcessed: number; nodesFound: number; edgesResolved: number; durationMs: number }> {
    await this.init();

    const start = Date.now();
    const supportedExts = new Set(getSupportedExtensions(this.config.languages));
    const files = this.collectFiles(projectRoot, supportedExts);

    let filesProcessed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      onProgress?.(file, i + 1, files.length);
      if (await this.parseAndStore(file, projectRoot, db)) {
        filesProcessed++;
      }
    }

    const edgesResolved = resolveCallEdges(db.queries);

    // Final save
    db.save();

    const status = db.queries.getStatus();
    return {
      filesProcessed,
      nodesFound: status.total_nodes,
      edgesResolved,
      durationMs: Date.now() - start,
    };
  }

  async incrementalUpdate(filePath: string, projectRoot: string, db: ClastDatabase): Promise<boolean> {
    const parsed = await this.parseAndStore(filePath, projectRoot, db);
    if (parsed) {
      resolveCallEdges(db.queries);
      db.save();
    }
    return parsed;
  }

  removeFile(filePath: string, projectRoot: string, db: ClastDatabase): void {
    const relPath = relative(projectRoot, filePath).replace(/\\/g, '/');
    db.queries.deleteFile(relPath);
    db.save();
  }

  private collectFiles(dir: string, supportedExts: Set<string>, depth: number = 0): string[] {
    if (depth > 20) return [];

    const files: string[] = [];
    let entries: string[];

    try {
      entries = readdirSync(dir);
    } catch {
      return files;
    }

    for (const entry of entries) {
      if (this.config.ignoredPaths.includes(entry)) continue;
      if (entry.startsWith('.')) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        files.push(...this.collectFiles(fullPath, supportedExts, depth + 1));
      } else if (stat.isFile()) {
        const ext = extname(entry);
        if (supportedExts.has(ext)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }
}

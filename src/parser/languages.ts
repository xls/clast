import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

interface LanguageEntry {
  name: string;
  extensions: string[];
  wasmFile: string;
}

const LANGUAGES: LanguageEntry[] = [
  { name: 'typescript', extensions: ['.ts'], wasmFile: 'tree-sitter-typescript.wasm' },
  { name: 'tsx', extensions: ['.tsx'], wasmFile: 'tree-sitter-tsx.wasm' },
  { name: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], wasmFile: 'tree-sitter-javascript.wasm' },
  { name: 'python', extensions: ['.py', '.pyw'], wasmFile: 'tree-sitter-python.wasm' },
  { name: 'java', extensions: ['.java'], wasmFile: 'tree-sitter-java.wasm' },
  { name: 'csharp', extensions: ['.cs'], wasmFile: 'tree-sitter-c_sharp.wasm' },
  { name: 'go', extensions: ['.go'], wasmFile: 'tree-sitter-go.wasm' },
  { name: 'rust', extensions: ['.rs'], wasmFile: 'tree-sitter-rust.wasm' },
  { name: 'c', extensions: ['.c', '.h'], wasmFile: 'tree-sitter-c.wasm' },
  { name: 'cpp', extensions: ['.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx'], wasmFile: 'tree-sitter-cpp.wasm' },
  { name: 'ruby', extensions: ['.rb'], wasmFile: 'tree-sitter-ruby.wasm' },
  { name: 'php', extensions: ['.php'], wasmFile: 'tree-sitter-php.wasm' },
];

// Extension → language entry mapping
const EXT_MAP = new Map<string, LanguageEntry>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) {
    EXT_MAP.set(ext, lang);
  }
}

export function getLanguageForExtension(ext: string): LanguageEntry | undefined {
  return EXT_MAP.get(ext.toLowerCase());
}

export function getGrammarWasmPath(langName: string): string | null {
  const entry = LANGUAGES.find(l => l.name === langName);
  if (!entry) return null;

  // Try to resolve from tree-sitter-wasms npm package first
  const require = createRequire(import.meta.url);
  try {
    const wasmsDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
    const npmPath = join(wasmsDir, 'out', entry.wasmFile);
    if (existsSync(npmPath)) return npmPath;
  } catch {
    // tree-sitter-wasms not installed, try fallbacks
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Check grammars/ directory relative to project
  const candidates = [
    // Custom grammars dir (env override)
    process.env.CLAST_GRAMMARS_DIR ? join(process.env.CLAST_GRAMMARS_DIR, entry.wasmFile) : null,
    // Plugin root
    process.env.CLAUDE_PLUGIN_ROOT ? join(process.env.CLAUDE_PLUGIN_ROOT, 'grammars', entry.wasmFile) : null,
    // Relative to dist/
    join(__dirname, '..', '..', 'grammars', entry.wasmFile),
    // CWD
    join(process.cwd(), 'grammars', entry.wasmFile),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function getSupportedExtensions(enabledLanguages?: string[]): string[] {
  const result: string[] = [];
  for (const lang of LANGUAGES) {
    if (!enabledLanguages || enabledLanguages.includes(lang.name)) {
      result.push(...lang.extensions);
    }
  }
  return result;
}

export function getAllLanguageNames(): string[] {
  return LANGUAGES.map(l => l.name);
}

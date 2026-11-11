export interface ClastConfig {
  /** Language ids to index. Empty = all supported languages. */
  languages: string[];
  /** Directory / file names (or gitignore-style patterns) to skip. */
  ignoredPaths: string[];
  /** Honour .gitignore files (root and nested). */
  respectGitignore: boolean;
  /** Index location, relative to the project root unless absolute. */
  dbPath: string;
  /** Files larger than this many bytes are skipped (generated / vendored blobs). */
  maxFileSize: number;
  /** Parser worker threads for bulk indexing. 0 = auto, 1 = no workers. */
  workers: number;
  llm: {
    endpoint: string;
    model: string;
    apiKey: string;
    maxConcurrent: number;
    alwaysGenerate: boolean;
  };
  watch: {
    debounceMs: number;
    enabled: boolean;
  };
}

export const DEFAULT_IGNORED = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.clast',
  'vendor',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.idea',
  '.vscode-test',
  '.gradle',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'bower_components',
  'Pods',
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.d.ts.map',
];

export const DEFAULT_CONFIG: ClastConfig = {
  languages: [],
  ignoredPaths: DEFAULT_IGNORED,
  respectGitignore: true,
  dbPath: '.clast/index.db',
  maxFileSize: 1_000_000,
  workers: 0,
  llm: {
    endpoint: 'http://localhost:11434/v1',
    model: '',
    apiKey: '',
    maxConcurrent: 3,
    alwaysGenerate: false,
  },
  watch: {
    debounceMs: 200,
    enabled: true,
  },
};

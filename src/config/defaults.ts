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
  /** Safety cap on the number of source files indexed (e.g. when started in a home directory). */
  maxFiles: number;
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
  /** Search by meaning (off by default). */
  embeddings: {
    enabled: boolean;
    /** "local" runs the model on this machine; "endpoint" calls an OpenAI-compatible /embeddings API. */
    provider: 'local' | 'endpoint';
    /** Model id: a Hugging Face repository with ONNX weights (local) or the model name of the endpoint. */
    model: string;
    /** Local only: "cpu", or "dml" / "cuda" for a graphics card. */
    device: string;
    endpoint: string;
    apiKey: string;
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
  maxFiles: 150_000,
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
  embeddings: {
    enabled: false,
    provider: 'local',
    model: 'jinaai/jina-embeddings-v2-base-code',
    device: 'cpu',
    endpoint: '',
    apiKey: '',
  },
};

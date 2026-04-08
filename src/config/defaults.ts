export interface ClastConfig {
  languages: string[];
  ignoredPaths: string[];
  dbPath: string;
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
  maxBodySize: number;
}

export const DEFAULT_CONFIG: ClastConfig = {
  languages: [
    'typescript',
    'javascript',
    'python',
    'java',
    'csharp',
    'go',
    'rust',
    'c',
    'cpp',
    'ruby',
    'php',
  ],
  ignoredPaths: [
    'node_modules',
    '.git',
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
    'coverage',
  ],
  dbPath: '.clast/clast.db',
  llm: {
    endpoint: 'http://localhost:11434/v1',
    model: '',
    apiKey: '',
    maxConcurrent: 3,
    alwaysGenerate: false,
  },
  watch: {
    debounceMs: 300,
    enabled: true,
  },
  maxBodySize: 2000,
};

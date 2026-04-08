import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse .gitignore files into glob patterns suitable for chokidar's `ignored` option.
 */
export function loadGitignorePatterns(projectRoot: string): string[] {
  const patterns: string[] = [];
  const gitignorePath = join(projectRoot, '.gitignore');

  if (!existsSync(gitignorePath)) return patterns;

  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Negation patterns are not supported by chokidar's simple ignored
      if (trimmed.startsWith('!')) continue;

      patterns.push(trimmed);
    }
  } catch {
    // Silently ignore read errors
  }

  return patterns;
}

/**
 * Build the full ignored patterns list combining .gitignore and config.
 */
export function buildIgnorePatterns(
  projectRoot: string,
  configIgnored: string[]
): string[] {
  const gitignorePatterns = loadGitignorePatterns(projectRoot);
  // Deduplicate
  const all = new Set([...configIgnored, ...gitignorePatterns]);
  return Array.from(all);
}

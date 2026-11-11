const LANGUAGE_COMMENT_STYLES: Record<string, { docPrefix: string; example: string }> = {
  typescript: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
  tsx: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
  javascript: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
  python: {
    docPrefix: '"""',
    example: '"""Calculates the total price including tax."""',
  },
  java: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
  csharp: {
    docPrefix: '///',
    example: '/// <summary>Calculates the total price including tax.</summary>',
  },
  go: {
    docPrefix: '//',
    example: '// CalculateTotal calculates the total price including tax.',
  },
  rust: {
    docPrefix: '///',
    example: '/// Calculates the total price including tax.',
  },
  c: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
  cpp: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
  ruby: {
    docPrefix: '#',
    example: '# Calculates the total price including tax.',
  },
  php: {
    docPrefix: '/**',
    example: '/** Calculates the total price including tax. */',
  },
};

export function buildFunctionCommentPrompt(
  signature: string,
  bodyText: string,
  language: string
): { system: string; user: string } {
  const style = LANGUAGE_COMMENT_STYLES[language] ?? LANGUAGE_COMMENT_STYLES['typescript']!;

  const system = `You are a code documentation expert. Generate a concise, clear documentation comment for the given function or method. Use the ${language} documentation style. Output ONLY the comment text (no code fences, no extra explanation). Keep it brief: 1-3 sentences describing what the function does, its parameters, and return value if applicable.`;

  const user = `Language: ${language}
Comment style example: ${style.example}

Signature:
${signature}

Body:
${bodyText.slice(0, 1500)}

Generate a documentation comment for this function.`;

  return { system, user };
}

export function buildClassCommentPrompt(
  name: string,
  signature: string,
  methodNames: string[],
  language: string
): { system: string; user: string } {
  const style = LANGUAGE_COMMENT_STYLES[language] ?? LANGUAGE_COMMENT_STYLES['typescript']!;

  const system = `You are a code documentation expert. Generate a concise, clear documentation comment for the given class or type. Use the ${language} documentation style. Output ONLY the comment text (no code fences, no extra explanation). Keep it brief: 1-3 sentences describing the class purpose and responsibilities.`;

  const user = `Language: ${language}
Comment style example: ${style.example}

Class: ${name}
Signature: ${signature}
Methods: ${methodNames.join(', ') || 'none'}

Generate a documentation comment for this class.`;

  return { system, user };
}

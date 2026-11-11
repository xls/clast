export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class LlmClient {
  private endpoint: string;
  private model: string;
  private apiKey: string;

  constructor(endpoint: string, model: string, apiKey: string = '') {
    // Ensure endpoint doesn't have trailing slash
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  get isConfigured(): boolean {
    return this.model.length > 0;
  }

  async complete(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number } = {}
  ): Promise<LlmResponse> {
    const { temperature = 0.3, maxTokens = 500 } = options;

    const url = `${this.endpoint}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`LLM API error ${response.status}: ${body}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = data.choices?.[0]?.message?.content ?? '';
      return {
        content,
        model: data.model ?? this.model,
        usage: data.usage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

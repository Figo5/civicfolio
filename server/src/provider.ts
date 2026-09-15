// The app's only LLM provider boundary.
//
// Everything above this file (chat, research agent, fund reflections) asks for
// "text" or "an object matching this schema" and never sees OpenAI request
// syntax, headers, or the API key. OpenAI is the only provider; configuration
// is server-side env only — the browser can neither set nor observe it.

import OpenAI from 'openai';

export interface ProviderConfig {
  /** An AI path can run when a key is present. */
  enabled: boolean;
  model: string;
  /** Presence only. The key value itself never appears on this object. */
  hasKey: boolean;
}

// Small, current, cheap, and supports both temperature and structured outputs.
// Override with OPENAI_MODEL (see .env.example).
export const DEFAULT_MODEL = 'gpt-4o-mini';

export function getProviderConfig(): ProviderConfig {
  const hasKey = (process.env.OPENAI_API_KEY ?? '').trim() !== '';
  return {
    enabled: hasKey,
    model: (process.env.OPENAI_MODEL ?? '').trim() || DEFAULT_MODEL,
    hasKey,
  };
}

// ---- the boundary ---------------------------------------------------------

export interface GenerateRequest {
  system: string;
  user: string;
  /** Honoured when the model supports it; silently ignored by models that don't. */
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Token accounting for one request, as reported by the provider.
 *
 * Reported, never derived: an estimate that looks like a measurement is worse
 * than an absent number. `cached_input` is the prompt-cache hit portion when
 * the provider reports it.
 */
export interface Usage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
}

export type TextResult =
  | { ok: true; content: string; model: string; usage?: Usage }
  | { ok: false; error: string };

export type StructuredResult =
  | { ok: true; data: unknown; model: string; usage?: Usage }
  | { ok: false; error: string };

export interface LLMProvider {
  readonly model: string;
  generateText(req: GenerateRequest): Promise<TextResult>;
  /**
   * Schema-constrained generation. Returns parsed JSON; callers still validate
   * values, types, and bounds before using them. Fails closed on anything the
   * provider returns that is not a complete JSON object for the schema — no
   * JSON repair, because a repaired object is a guess about what the model
   * meant, and guesses about research figures are the thing to avoid.
   */
  generateStructured(req: GenerateRequest & { schemaName: string; schema: Record<string, unknown> }): Promise<StructuredResult>;
}

export const MISSING_KEY_ERROR =
  'AI is not configured on this server: set OPENAI_API_KEY in .env or ~/.civicfolio/env (server-side only, never in the browser).';

/** Requests routinely take 60-120s; a shorter ceiling aborts mid-answer. */
const TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;

class OpenAIProvider implements LLMProvider {
  readonly model: string;
  private readonly client: Pick<OpenAI, 'responses'>;

  constructor(model: string, client: Pick<OpenAI, 'responses'>) {
    this.model = model;
    this.client = client;
  }

  async generateText(req: GenerateRequest): Promise<TextResult> {
    try {
      const res = await this.client.responses.create({
        model: this.model,
        instructions: req.system,
        input: req.user,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
      });
      if (res.status === 'incomplete') return { ok: false, error: INCOMPLETE_RESPONSE_ERROR };
      const content = (res.output_text ?? '').trim();
      if (content === '') return { ok: false, error: 'The model returned an empty answer.' };
      return { ok: true, content, model: res.model ?? this.model, usage: readUsage(res) };
    } catch (err) {
      return { ok: false, error: mapProviderError(err, this.model) };
    }
  }

  async generateStructured(
    req: GenerateRequest & { schemaName: string; schema: Record<string, unknown> },
  ): Promise<StructuredResult> {
    let res;
    try {
      res = await this.client.responses.create({
        model: this.model,
        instructions: req.system,
        input: req.user,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
        text: { format: { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: true } },
      });
    } catch (err) {
      return { ok: false, error: mapProviderError(err, this.model) };
    }
    // An incomplete response is a truncated object: parsing it would mean
    // repairing it, so refuse instead.
    if (res.status === 'incomplete') {
      return { ok: false, error: INCOMPLETE_RESPONSE_ERROR };
    }
    const text = (res.output_text ?? '').trim();
    if (text === '') return { ok: false, error: MALFORMED_STRUCTURED_ERROR };
    try {
      const data = JSON.parse(text) as unknown;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, error: MALFORMED_STRUCTURED_ERROR };
      }
      return { ok: true, data, model: res.model ?? this.model, usage: readUsage(res) };
    } catch {
      return { ok: false, error: MALFORMED_STRUCTURED_ERROR };
    }
  }
}

/**
 * Read the provider's own usage numbers. Absent fields stay null rather than
 * becoming 0, so "not reported" is never displayed as "free".
 */
function readUsage(res: unknown): Usage {
  const u = (res as { usage?: Record<string, unknown> } | null)?.usage;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const details = (u?.input_tokens_details ?? null) as Record<string, unknown> | null;
  return {
    input_tokens: n(u?.input_tokens),
    cached_input_tokens: n(details?.cached_tokens),
    output_tokens: n(u?.output_tokens),
  };
}

export const MALFORMED_STRUCTURED_ERROR =
  'The model returned malformed structured output; the answer was discarded rather than guessed at.';

const INCOMPLETE_RESPONSE_ERROR =
  'The model ran out of room before finishing its answer (context or output limit).';

/** Provider that refuses everything, used when no key is configured. */
const disabledProvider: LLMProvider = {
  model: 'none',
  generateText: async () => ({ ok: false, error: MISSING_KEY_ERROR }),
  generateStructured: async () => ({ ok: false, error: MISSING_KEY_ERROR }),
};

let cached: { provider: LLMProvider; key: string; model: string } | null = null;
let injected: LLMProvider | null = null;

/**
 * The provider for the current server config. Memoized per (key, model) so a
 * chat request does not rebuild a client every time.
 */
export function getProvider(): LLMProvider {
  if (injected) return injected;
  const key = (process.env.OPENAI_API_KEY ?? '').trim();
  const cfg = getProviderConfig();
  if (!cfg.enabled) return disabledProvider;
  if (cached && cached.key === key && cached.model === cfg.model) return cached.provider;
  const client = new OpenAI({
    apiKey: key,
    // Pin the official endpoint explicitly: the SDK otherwise honors an
    // ambient endpoint override, which would silently re-enable other providers.
    baseURL: 'https://api.openai.com/v1',
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
  const provider = new OpenAIProvider(cfg.model, client);
  cached = { provider, key, model: cfg.model };
  return provider;
}

/**
 * Can an AI path run at all? Use this before doing expensive setup work (a web
 * search, a data fetch) so a missing key fails immediately and for free.
 * Respects an injected provider, so tests exercise the real path.
 */
export function isProviderConfigured(): boolean {
  return injected !== null || getProviderConfig().enabled;
}

/** Test seam: force a provider (or pass null to go back to the real one). */
export function setProviderForTests(p: LLMProvider | null): void {
  injected = p;
}

/** Test seam: drop the memoized client so env changes take effect. */
export function resetProviderForTests(): void {
  injected = null;
  cached = null;
}

/** Build a provider over an injected client. Tests only — no network. */
export function createProviderForTests(model: string, client: Pick<OpenAI, 'responses'>): LLMProvider {
  return new OpenAIProvider(model, client);
}

// ---- error mapping --------------------------------------------------------

/**
 * Turn any provider failure into one sanitized, actionable sentence.
 *
 * Nothing from the request — key, headers, endpoint, or prompt — may reach the
 * client. Unknown upstream text is never relayed because it can echo request
 * data.
 */
export function mapProviderError(err: unknown, model: string): string {
  const e = err as { status?: number; code?: string; name?: string; message?: string } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const name = e?.name ?? '';

  if (name === 'APIConnectionTimeoutError' || code === 'ETIMEDOUT' || /timed? ?out/i.test(e?.message ?? '')) {
    return 'The AI request timed out. Try again, or ask a narrower question.';
  }
  if (name === 'APIConnectionError' || name === 'APIUserAbortError' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return 'Could not reach the AI provider (network error). Check connectivity and retry.';
  }
  if (code === 'context_length_exceeded' || /context length|too many tokens|maximum context/i.test(e?.message ?? '')) {
    return 'The request was too large for the model context window. Shorten the question or clear the thread.';
  }

  switch (e?.status) {
    case 401:
      return 'OpenAI rejected the API key. Check OPENAI_API_KEY in server env.';
    case 403:
      return 'This OpenAI key is not permitted to use that model or endpoint.';
    case 404:
      return `Model "${model}" is not available to this account. Set OPENAI_MODEL to one you can use.`;
    case 429:
      return 'OpenAI rate limit or quota reached. Wait a moment and retry.';
    case 400:
    case 422:
      return 'OpenAI rejected the request. Check that the selected model supports the requested response format and that the input fits its limits.';
    default:
      break;
  }
  if (typeof e?.status === 'number' && e.status >= 500) {
    return `OpenAI service error (${e.status}). This is upstream — retry shortly.`;
  }
  return 'AI request failed. Retry or check the server configuration.';
}

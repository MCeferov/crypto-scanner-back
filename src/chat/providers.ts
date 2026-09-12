/**
 * Free LLM providers, behind one interface.
 *
 * Every provider here speaks the OpenAI `/chat/completions` shape, which is the
 * closest thing this space has to a standard: Gemini, Groq, OpenRouter, Mistral
 * and Cerebras all expose it. That means one client covers all of them, and
 * switching provider is an environment variable rather than a rewrite — which
 * matters more than usual when the reason you picked one was that it was free
 * today.
 *
 * Selection is by which key is present, so a deployment turns a provider on by
 * adding its key and nothing else.
 */

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  /** Base URL up to but not including /chat/completions. */
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Environment variable holding this provider's key. */
  readonly keyEnv: string;
  /** Free-tier note, surfaced in logs and docs rather than guessed at later. */
  readonly freeTier: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    // Google's OpenAI-compatibility layer, not the native Interactions API —
    // same models, standard request shape.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // Flash is free of charge on the free tier and is the strongest of the
    // free options at Azerbaijani, Russian and Turkish, which is what this
    // panel actually has to answer in.
    defaultModel: "gemini-3.8-flash",
    keyEnv: "GEMINI_API_KEY",
    freeTier: "free tier, no card required",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyEnv: "GROQ_API_KEY",
    freeTier: "free tier, ~30 req/min",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    // The :free suffix is OpenRouter's marker for zero-cost models.
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    keyEnv: "OPENROUTER_API_KEY",
    freeTier: "free models, ~20 req/min and 50/day",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    keyEnv: "MISTRAL_API_KEY",
    freeTier: "free experimental tier",
  },
];

export interface ResolvedProvider {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Pick the provider to use.
 *
 * CHAT_BASE_URL is the escape hatch for anything not listed — another
 * OpenAI-compatible host, or a local Ollama — so being unlisted never means
 * being unusable.
 */
export function resolveProvider(): ResolvedProvider | null {
  const custom = process.env.CHAT_BASE_URL?.trim();
  if (custom) {
    return {
      id: "custom",
      label: "custom",
      baseUrl: custom.replace(/\/+$/, ""),
      model: process.env.CHAT_MODEL?.trim() || "gpt-4o-mini",
      // A local model needs no key; send a placeholder so the header is valid.
      apiKey: process.env.CHAT_API_KEY?.trim() || "not-required",
    };
  }

  const requested = process.env.CHAT_PROVIDER?.trim().toLowerCase();
  const candidates = requested
    ? PROVIDERS.filter(p => p.id === requested)
    : PROVIDERS;

  for (const preset of candidates) {
    const apiKey = process.env[preset.keyEnv]?.trim();
    if (!apiKey) continue;
    return {
      id: preset.id,
      label: preset.label,
      baseUrl: preset.baseUrl,
      model: process.env.CHAT_MODEL?.trim() || preset.defaultModel,
      apiKey,
    };
  }

  return null;
}

/** For diagnostics: which providers this deployment could use. Never the keys. */
export function providerStatus(): { id: string; label: string; configured: boolean; freeTier: string }[] {
  return PROVIDERS.map(p => ({
    id: p.id,
    label: p.label,
    configured: Boolean(process.env[p.keyEnv]?.trim()),
    freeTier: p.freeTier,
  }));
}

import { envInt } from "../middleware/rateLimit.js";
import { resolveProvider, type ResolvedProvider } from "./providers.js";
import { contextPrompt, stableSystemPrompt } from "./systemPrompt.js";
import { trimHistory, type ChatContext, type ChatMessage } from "./types.js";

/** A help panel wants a few sentences, not an essay — and long answers cost more. */
const DEFAULT_MAX_TOKENS = 1024;

/** How many turns of history reach the model. */
export const HISTORY_LIMIT = envInt("CHAT_HISTORY_LIMIT", 12);

/** False when no provider key is configured — the route answers 503. */
export function isChatConfigured(): boolean {
  return resolveProvider() !== null;
}

export interface ChatParams {
  messages: ChatMessage[];
  context?: ChatContext;
}

interface CompletionsBody {
  model: string;
  max_tokens: number;
  temperature: number;
  stream: boolean;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

function buildBody(provider: ResolvedProvider, { messages, context }: ChatParams, stream: boolean): CompletionsBody {
  return {
    model: provider.model,
    max_tokens: envInt("CHAT_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    // Low but not zero: explanations of a fixed UI should be consistent, and
    // some providers reject an exact 0.
    temperature: 0.3,
    stream,
    messages: [
      {
        role: "system",
        // Stable knowledge first, per-request context after it. Providers that
        // cache implicitly key on the prompt prefix, so keeping the volatile
        // half last is what lets the stable half be reused.
        content: `${stableSystemPrompt()}\n\n${contextPrompt(context)}`,
      },
      ...trimHistory(messages, HISTORY_LIMIT).map(m => ({
        role: m.role,
        content: m.content,
      })),
    ],
  };
}

function headers(provider: ResolvedProvider): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
  if (provider.id === "openrouter") {
    // OpenRouter attributes free-tier traffic to an app; omitting these is
    // allowed but gets stricter limits.
    base["HTTP-Referer"] = process.env.FRONTEND_URL?.split(",")[0]?.trim() ?? "";
    base["X-Title"] = "Crypto Scanner";
  }
  return base;
}

/** Upstream failures carry provider detail, so they never reach the caller verbatim. */
class UpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

async function post(
  provider: ResolvedProvider,
  body: CompletionsBody,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(provider),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(envInt("CHAT_TIMEOUT_MS", 60_000)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new UpstreamError(res.status, `${provider.id} HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res;
}

interface CompletionChoice {
  delta?: { content?: string | null };
  message?: { content?: string | null };
}

interface CompletionChunk {
  choices?: CompletionChoice[];
}

/**
 * Text deltas from an OpenAI-style SSE stream.
 *
 * Providers differ in the padding around the payload — keep-alive comments,
 * role-only first deltas, a trailing `[DONE]`, chunks split across TCP reads —
 * so the parser buffers on the blank-line frame boundary and ignores anything
 * that is not a content delta rather than assuming one frame per read.
 */
export async function* streamChatDeltas(
  params: ChatParams,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const provider = resolveProvider();
  if (!provider) return;

  const res = await post(provider, buildBody(provider, params, true), signal);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let chunk: CompletionChunk;
          try {
            chunk = JSON.parse(payload) as CompletionChunk;
          } catch {
            continue; // a partial or non-JSON keep-alive
          }
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Non-streaming call, for clients that asked for a plain JSON reply. */
export async function createChatReply(params: ChatParams): Promise<string> {
  const provider = resolveProvider();
  if (!provider) return "";

  const res = await post(provider, buildBody(provider, params, false), undefined);
  const body = (await res.json()) as CompletionChunk;
  return (body.choices?.[0]?.message?.content ?? "").trim();
}

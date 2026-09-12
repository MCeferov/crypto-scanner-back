import Anthropic from "@anthropic-ai/sdk";
import { envInt } from "../middleware/rateLimit.js";
import { contextPrompt, stableSystemPrompt } from "./systemPrompt.js";
import { trimHistory, type ChatContext, type ChatMessage } from "./types.js";

/**
 * Haiku 4.5 is the right size for this: the assistant explains a UI it has
 * already been told about, which is recall and phrasing rather than reasoning.
 * CHAT_MODEL swaps it without a deploy if deeper questions justify the cost.
 */
const DEFAULT_MODEL = "claude-haiku-4-5";

/** A help panel wants a few sentences, not an essay — and long answers cost more. */
const DEFAULT_MAX_TOKENS = 1024;

/** How many turns of history reach the model. */
export const HISTORY_LIMIT = envInt("CHAT_HISTORY_LIMIT", 12);

let client: Anthropic | null = null;

/** False when no key is configured — the route answers 503 rather than crashing. */
export function isChatConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      // An interactive panel should fail fast and let the user retry rather
      // than hold a request open for the SDK's ten-minute default.
      timeout: envInt("CHAT_TIMEOUT_MS", 60_000),
      maxRetries: 1,
    });
  }
  return client;
}

export interface ChatParams {
  messages: ChatMessage[];
  context?: ChatContext;
}

// Typed as the non-streaming variant so `create()` resolves to a Message
// rather than the create/stream union; `stream()` accepts the same shape.
function buildParams({ messages, context }: ChatParams): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: process.env.CHAT_MODEL ?? DEFAULT_MODEL,
    max_tokens: envInt("CHAT_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    system: [
      {
        type: "text",
        text: stableSystemPrompt(),
        // Identical on every request, so it is the natural cache prefix. Note
        // that Haiku 4.5 only caches prefixes of 4096 tokens or more and this
        // block is shorter, so on the default model this is a silent no-op —
        // it starts paying off if CHAT_MODEL is pointed at a larger model,
        // where the minimum drops to 512-1024 tokens.
        cache_control: { type: "ephemeral" },
      },
      {
        // After the breakpoint: this changes on every navigation and must not
        // be allowed to invalidate the block above it.
        type: "text",
        text: contextPrompt(context),
      },
    ],
    messages: trimHistory(messages, HISTORY_LIMIT).map(m => ({
      role: m.role,
      content: m.content,
    })),
  };
}

/** Streaming call. Caller owns the SSE framing; `signal` aborts on disconnect. */
export function createChatStream(params: ChatParams, signal: AbortSignal) {
  return getClient().messages.stream(buildParams(params), { signal });
}

/** Non-streaming call, for clients that asked for a plain JSON reply. */
export async function createChatReply(params: ChatParams): Promise<string> {
  const response = await getClient().messages.create(buildParams(params));
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();
}

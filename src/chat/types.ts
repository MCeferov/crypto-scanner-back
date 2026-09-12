import { z } from "zod";
import { SUPPORTED_LOCALES } from "./systemPrompt.js";

/**
 * Wire format for POST /api/chat — what the frontend's chatApi.ts sends.
 * Every field is treated as untrusted: this endpoint spends money per call.
 */
export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

export const chatContextSchema = z.object({
  path: z.string().max(200).optional(),
  symbol: z.string().max(24).optional(),
  locale: z.string().max(12).optional(),
});

export const chatRequestSchema = z.object({
  // The cap is on what will be accepted at all; only the tail is sent upstream.
  messages: z.array(chatMessageSchema).min(1).max(100),
  context: chatContextSchema.optional(),
  /** Opt out of streaming and get { reply } instead. */
  stream: z.boolean().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatContext = z.infer<typeof chatContextSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Trim the conversation to the last `limit` turns, then drop any leading
 * assistant messages.
 *
 * The second step is the one that matters: the API rejects a conversation whose
 * first message is from the assistant, and slicing a tail lands on one roughly
 * half the time. Without this the endpoint would fail intermittently once a
 * conversation grew past the window, which is the worst kind of bug to chase.
 */
export function trimHistory(messages: ChatMessage[], limit: number): ChatMessage[] {
  const tail = messages.slice(-limit);
  const firstUser = tail.findIndex(m => m.role === "user");
  return firstUser <= 0 ? tail : tail.slice(firstUser);
}

/** Normalise the UI locale, ignoring anything we have no wording for. */
export function normalizeLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  const short = locale.trim().toLowerCase().slice(0, 2);
  return SUPPORTED_LOCALES.includes(short) ? short : undefined;
}

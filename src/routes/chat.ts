import { Router, type IRouter, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { envInt, rateLimit } from "../middleware/rateLimit.js";
import { logger } from "../lib/logger.js";
import {
  createChatReply,
  HISTORY_LIMIT,
  isChatConfigured,
  streamChatDeltas,
} from "../chat/service.js";
import { providerStatus } from "../chat/providers.js";
import { chatRequestSchema, normalizeLocale } from "../chat/types.js";

const router: IRouter = Router();

/**
 * Every call here costs money at a third party, so the budget is tighter than
 * anywhere else in the API and it is keyed on the authenticated user — the
 * rate limiter prefers req.user.userId over the IP, and auth runs first, so
 * rotating X-Forwarded-For buys nothing. globalMax is the ceiling on the whole
 * endpoint: a compromised account cannot run up an unbounded bill on its own.
 */
const chatLimiter = rateLimit({
  windowMs: envInt("CHAT_RATE_WINDOW_SECONDS", 60) * 1000,
  max: envInt("CHAT_RATE_MAX", 15),
  globalMax: envInt("CHAT_RATE_GLOBAL_MAX", 300),
  keyPrefix: "chat",
});

/**
 * Shown to the user when the assistant cannot answer. The frontend renders the
 * `error` field of an SSE frame directly, so it is written for a reader and
 * carries nothing about what actually failed.
 */
const FAILURE_TEXT: Record<string, string> = {
  az: "Köməkçi hazırda cavab verə bilmir. Bir az sonra yenidən cəhd edin.",
  en: "The assistant is unavailable right now. Please try again shortly.",
  ru: "Помощник сейчас недоступен. Попробуйте позже.",
  tr: "Asistan şu anda yanıt veremiyor. Lütfen biraz sonra tekrar deneyin.",
};

function failureText(locale: string | undefined): string {
  return FAILURE_TEXT[locale ?? "en"] ?? FAILURE_TEXT.en;
}

/** The client asked for a single JSON body rather than a stream. */
function wantsJson(req: Request): boolean {
  if (req.body?.stream === false) return true;
  const accept = String(req.headers.accept ?? "");
  return accept.includes("application/json") && !accept.includes("text/event-stream");
}

/**
 * POST /api/chat — LLM proxy for the in-app help assistant.
 *
 * Authenticated because it spends money: an unauthenticated LLM proxy is a
 * bill waiting to be run up by anyone who finds the URL.
 */
router.post("/", authMiddleware, chatLimiter, async (req: Request, res: Response) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { messages, context } = parsed.data;
  const locale = normalizeLocale(context?.locale);
  const params = { messages, context: context ? { ...context, locale } : undefined };

  if (!isChatConfigured()) {
    // A deployment without a key is a configuration gap, not a caller error.
    logger.error({ event: "chat_not_configured" }, "No LLM provider key is configured — see .env.example");
    res.status(503).json({ error: failureText(locale) });
    return;
  }

  logger.info(
    {
      event: "chat_request",
      userId: req.user?.userId,
      locale,
      path: context?.path,
      symbol: context?.symbol,
      // Message text is never logged: it is user content, and a help panel
      // collects plenty of it.
      turns: Math.min(messages.length, HISTORY_LIMIT),
      streaming: !wantsJson(req),
    },
    "Chat request",
  );

  if (wantsJson(req)) {
    try {
      const reply = await createChatReply(params);
      res.json({ reply });
    } catch (err) {
      logger.error({ err, event: "chat_failed" }, "Chat completion failed");
      res.status(502).json({ error: failureText(locale) });
    }
    return;
  }

  // ── SSE ──
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Railway's edge and most reverse proxies buffer responses by default, which
  // would hold the whole answer back and defeat the point of streaming.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const abort = new AbortController();
  let clientGone = false;
  // Listen on the response, not the request. On a POST the request stream is
  // already finished by the time this handler runs — express.json() consumed
  // it — so req's "close" fires immediately and would abort the call before it
  // was ever made. The response closes only when the reply ends or the client
  // actually goes away.
  res.on("close", () => {
    if (res.writableEnded) return; // normal completion
    clientGone = true;
    // Stop paying for tokens nobody will read.
    abort.abort();
  });

  const send = (payload: unknown): void => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    for await (const delta of streamChatDeltas(params, abort.signal)) {
      if (clientGone) break;
      send({ delta });
    }
    send({ done: true });
  } catch (err) {
    if (clientGone) {
      // The abort we asked for — not a failure worth reporting.
    } else {
      logger.error({ err, event: "chat_stream_failed" }, "Chat stream failed");
      send({ error: failureText(locale) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/**
 * Which LLM providers this deployment could use, and which one is live.
 * Booleans and labels only — never a key. Authenticated, because the answer
 * describes our own configuration.
 */
router.get("/providers", authMiddleware, chatLimiter, (_req: Request, res: Response) => {
  res.json({ providers: providerStatus(), configured: isChatConfigured() });
});

export default router;

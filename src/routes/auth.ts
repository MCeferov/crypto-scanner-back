import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { authMiddleware } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { envInt, rateLimit } from "../middleware/rateLimit";
import { checkAccountLock, recordAuthFailure, recordAuthSuccess } from "../middleware/bruteForce";
import { AppError, toErrorResponse } from "../lib/errors";
import { logger } from "../lib/logger";
import { sanitizeEmail } from "../lib/sanitize";
import { loginSchema, signupSchema } from "../validators/auth";
import * as authService from "../services/authService";

const router: IRouter = Router();

/**
 * Two layers, because they fail in different ways.
 *
 * The per-client budget is keyed on req.ip, which is derived from a header the
 * caller controls — it stops casual hammering, not a determined attacker. The
 * globalMax ceiling and the per-account lock in bruteForce.ts are the controls
 * that survive a forged X-Forwarded-For.
 *
 * Signup gets a longer window and a tighter count: nobody legitimately creates
 * accounts in bursts, and automated signup is the abuse this endpoint attracts.
 */
const loginLimiter = rateLimit({
  windowMs: envInt("AUTH_RATE_WINDOW_SECONDS", 900) * 1000,
  max: envInt("AUTH_RATE_MAX", 10),
  globalMax: envInt("AUTH_RATE_GLOBAL_MAX", 600),
  keyPrefix: "auth:login",
});

const signupLimiter = rateLimit({
  windowMs: envInt("SIGNUP_RATE_WINDOW_SECONDS", 3600) * 1000,
  max: envInt("SIGNUP_RATE_MAX", 5),
  globalMax: envInt("SIGNUP_RATE_GLOBAL_MAX", 100),
  keyPrefix: "auth:signup",
});

/**
 * Correlates repeated attempts against one account in the logs without writing
 * the address itself — an email is personal data and log stores are rarely
 * treated as carefully as a database.
 */
function accountTag(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 12);
}

async function handleSignup(req: import("express").Request, res: import("express").Response) {
  try {
    const result = await authService.signup(req.body);
    res.status(201).json({
      message: "Account created successfully",
      user: result.user,
      token: result.token,
    });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  }
}

async function handleLogin(req: import("express").Request, res: import("express").Response) {
  const accountId = sanitizeEmail(String(req.body?.email ?? ""));

  const lock = checkAccountLock(accountId);
  if (lock.locked) {
    res.setHeader("Retry-After", String(lock.retryAfterSec));
    // Deliberately the same wording whether or not the account exists: the
    // lock is applied to unknown addresses too, so it reveals nothing.
    res.status(429).json({ message: "Too many failed attempts. Try again later." });
    return;
  }

  try {
    const result = await authService.login(req.body);
    recordAuthSuccess(accountId);
    res.json({
      message: "Login successful",
      user: result.user,
      token: result.token,
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 401) {
      recordAuthFailure(accountId);
      logger.warn(
        { event: "auth_login_failed", account: accountTag(accountId), ip: req.ip },
        "Failed login attempt",
      );
    }
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  }
}

router.post("/signup", signupLimiter, validateBody(signupSchema), handleSignup);
router.post("/sign-up", signupLimiter, validateBody(signupSchema), handleSignup);

router.post("/login", loginLimiter, validateBody(loginSchema), handleLogin);
router.post("/sign-in", loginLimiter, validateBody(loginSchema), handleLogin);

router.post("/logout", authMiddleware, (_req, res) => {
  res.json({ message: "Logged out successfully" });
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    // Scoped to the caller's own id from the verified token — never a
    // client-supplied identifier, so there is no object to enumerate here.
    const user = await authService.getUserById(req.user!.userId);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ user });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  }
});

export default router;

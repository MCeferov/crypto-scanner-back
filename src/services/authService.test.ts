import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.NODE_ENV = "test";

const { createAuthService } = await import("./authService");
const { AppError } = await import("../lib/errors");
const { verifyToken } = await import("../lib/jwt");

import type { AuthDb } from "./authService";
import type { MailMessage } from "../mail/mailer";

/** Minimal in-memory stand-in for the slice of Prisma the service uses. */
function createFakeDb() {
  type U = {
    id: string;
    username: string;
    email: string;
    passwordHash: string;
    emailVerifiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  type V = { userId: string; codeHash: string; expiresAt: Date; attempts: number; lastSentAt: Date };
  const users = new Map<string, U>();
  const verifs = new Map<string, V>();
  let seq = 0;

  const uniq = () => Object.assign(new Error("unique"), { code: "P2002" });

  const db = {
    user: {
      findUnique: async ({ where }: any) =>
        [...users.values()].find(
          (u) =>
            (where.id && u.id === where.id) ||
            (where.email && u.email === where.email) ||
            (where.username && u.username === where.username),
        ) ?? null,
      create: async ({ data }: any) => {
        for (const u of users.values()) if (u.email === data.email || u.username === data.username) throw uniq();
        const u: U = {
          id: `u${++seq}`,
          emailVerifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        users.set(u.id, u);
        return u;
      },
      update: async ({ where, data }: any) => {
        const u = users.get(where.id)!;
        Object.assign(u, data);
        return u;
      },
      delete: async ({ where }: any) => {
        users.delete(where.id);
        verifs.delete(where.id);
      },
    },
    emailVerification: {
      findUnique: async ({ where }: any) => verifs.get(where.userId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const cur = verifs.get(where.userId);
        const next = cur ? { ...cur, ...update } : { ...create };
        verifs.set(where.userId, next);
        return next;
      },
      update: async ({ where, data }: any) => {
        const v = verifs.get(where.userId)!;
        if (data.attempts?.increment) v.attempts += data.attempts.increment;
        return { ...v };
      },
      deleteMany: async ({ where }: any) => {
        verifs.delete(where.userId);
      },
    },
  };
  return { db: db as unknown as AuthDb, users, verifs };
}

function setup(overrides: { failMail?: boolean } = {}) {
  const fake = createFakeDb();
  const sent: MailMessage[] = [];
  let clock = new Date("2026-01-01T00:00:00Z");
  const svc = createAuthService({
    db: fake.db,
    mailer: () => ({
      send: async (m) => {
        if (overrides.failMail) throw new Error("smtp down");
        sent.push(m);
      },
    }),
    now: () => clock,
    otpTtlMinutes: 10,
    maxAttempts: 3,
    resendCooldownSeconds: 60,
  });
  return {
    ...fake,
    svc,
    sent,
    advance: (sec: number) => (clock = new Date(clock.getTime() + sec * 1000)),
    lastCode: () => /\b(\d{6})\b/.exec(sent.at(-1)!.text)![1],
  };
}

const signupInput = { username: "alice", email: "Alice@Example.com", password: "password123" };

async function rejectsWith(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
    assert.equal(e.statusCode, status);
    assert.equal(e.code, code);
    return true;
  });
}

describe("signup", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it("creates an unverified user, emails a code and issues NO token", async () => {
    const res = await t.svc.signup(signupInput);
    assert.equal(res.user.emailVerified, false);
    assert.equal(res.user.email, "alice@example.com");
    assert.equal("token" in res, false);
    assert.equal(res.verification.verificationRequired, true);
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].to, "alice@example.com");
    assert.match(t.lastCode(), /^\d{6}$/);
  });

  it("never stores the code in plaintext", async () => {
    await t.svc.signup(signupInput);
    const rec = [...t.verifs.values()][0];
    assert.notEqual(rec.codeHash, t.lastCode());
    assert.match(rec.codeHash, /^[0-9a-f]{64}$/);
  });

  it("rejects an email that is already verified", async () => {
    await t.svc.signup(signupInput);
    await t.svc.verifyEmail({ email: signupInput.email, code: t.lastCode() });
    await rejectsWith(t.svc.signup({ ...signupInput, username: "other" }), 409, "EMAIL_EXISTS");
  });

  it("rejects a username held by a verified user", async () => {
    await t.svc.signup(signupInput);
    await t.svc.verifyEmail({ email: signupInput.email, code: t.lastCode() });
    await rejectsWith(t.svc.signup({ ...signupInput, email: "b@example.com" }), 409, "USERNAME_EXISTS");
  });

  it("lets a new signup take over an unverified email (no squatting) with the new password", async () => {
    await t.svc.signup(signupInput);
    t.advance(61);
    await t.svc.signup({ ...signupInput, password: "newpassword99" });
    assert.equal(t.users.size, 1);
    await t.svc.verifyEmail({ email: signupInput.email, code: t.lastCode() });
    const res = await t.svc.login({ email: signupInput.email, password: "newpassword99" });
    assert.ok(res.token);
    await rejectsWith(t.svc.login({ email: signupInput.email, password: "password123" }), 401, "INVALID_CREDENTIALS");
  });

  it("lets a new signup take an unverified username", async () => {
    await t.svc.signup(signupInput);
    await t.svc.signup({ ...signupInput, email: "b@example.com" });
    assert.equal(t.users.size, 1);
    assert.equal([...t.users.values()][0].email, "b@example.com");
  });

  it("blocks mail-bombing: re-signup inside the cooldown is refused", async () => {
    await t.svc.signup(signupInput);
    await assert.rejects(t.svc.signup(signupInput), (e: any) => {
      assert.equal(e.code, "VERIFICATION_COOLDOWN");
      assert.ok(e.retryAfterSec > 0);
      return true;
    });
    assert.equal(t.sent.length, 1);
  });

  it("surfaces a mail failure and clears the code so the user can retry at once", async () => {
    const f = setup({ failMail: true });
    await rejectsWith(f.svc.signup(signupInput), 502, "EMAIL_SEND_FAILED");
    assert.equal(f.verifs.size, 0);
  });
});

describe("verifyEmail", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.svc.signup(signupInput);
  });

  it("verifies with the right code and returns a valid JWT", async () => {
    const res = await t.svc.verifyEmail({ email: "ALICE@example.com", code: t.lastCode() });
    assert.equal(res.user.emailVerified, true);
    const payload = verifyToken(res.token);
    assert.equal(payload.email, "alice@example.com");
    assert.equal(t.verifs.size, 0, "code is single-use");
  });

  it("the code cannot be reused", async () => {
    const code = t.lastCode();
    await t.svc.verifyEmail({ email: signupInput.email, code });
    await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code }), 400, "INVALID_CODE");
  });

  it("rejects a wrong code", async () => {
    const wrong = t.lastCode() === "000000" ? "111111" : "000000";
    await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code: wrong }), 400, "INVALID_CODE");
  });

  it("rejects an expired code", async () => {
    const code = t.lastCode();
    t.advance(10 * 60 + 1);
    await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code }), 400, "CODE_EXPIRED");
  });

  it("locks the code after too many wrong guesses, even if the right one follows", async () => {
    const code = t.lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code: wrong }), 400, "INVALID_CODE");
    }
    await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code }), 429, "TOO_MANY_ATTEMPTS");
    await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code }), 400, "INVALID_CODE");
  });

  it("right code on the last allowed attempt still works", async () => {
    const code = t.lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 2; i++) {
      await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code: wrong }), 400, "INVALID_CODE");
    }
    const res = await t.svc.verifyEmail({ email: signupInput.email, code });
    assert.equal(res.user.emailVerified, true);
  });

  it("answers an unknown email exactly like a wrong code", async () => {
    await rejectsWith(t.svc.verifyEmail({ email: "nobody@example.com", code: "123456" }), 400, "INVALID_CODE");
  });

  it("a newer code invalidates the older one", async () => {
    const first = t.lastCode();
    t.advance(61);
    await t.svc.resendVerification({ email: signupInput.email });
    const second = t.lastCode();
    if (first !== second) {
      await rejectsWith(t.svc.verifyEmail({ email: signupInput.email, code: first }), 400, "INVALID_CODE");
    }
    const res = await t.svc.verifyEmail({ email: signupInput.email, code: second });
    assert.equal(res.user.emailVerified, true);
  });
});

describe("resendVerification", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.svc.signup(signupInput);
  });

  it("sends a fresh code after the cooldown", async () => {
    t.advance(61);
    await t.svc.resendVerification({ email: signupInput.email });
    assert.equal(t.sent.length, 2);
  });

  it("enforces the cooldown with a retry hint", async () => {
    t.advance(20);
    await assert.rejects(t.svc.resendVerification({ email: signupInput.email }), (e: any) => {
      assert.equal(e.statusCode, 429);
      assert.equal(e.retryAfterSec, 40);
      return true;
    });
    assert.equal(t.sent.length, 1);
  });

  it("is a silent no-op for unknown emails (no enumeration, no mail)", async () => {
    const res = await t.svc.resendVerification({ email: "ghost@example.com" });
    assert.equal(res.verificationRequired, true);
    assert.equal(t.sent.length, 1);
  });

  it("sends nothing to an already verified account", async () => {
    await t.svc.verifyEmail({ email: signupInput.email, code: t.lastCode() });
    t.advance(120);
    await t.svc.resendVerification({ email: signupInput.email });
    assert.equal(t.sent.length, 1);
  });

  it("uses the requested language", async () => {
    t.advance(61);
    await t.svc.resendVerification({ email: signupInput.email, locale: "ru" });
    assert.match(t.sent.at(-1)!.subject, /код подтверждения/);
  });
});

describe("login", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.svc.signup(signupInput);
  });

  it("refuses an unverified account with EMAIL_NOT_VERIFIED and mails a fresh code", async () => {
    t.advance(61);
    await rejectsWith(
      t.svc.login({ email: signupInput.email, password: "password123" }),
      403,
      "EMAIL_NOT_VERIFIED",
    );
    assert.equal(t.sent.length, 2);
  });

  it("does not spam: login inside the cooldown still answers 403 without a second mail", async () => {
    await rejectsWith(
      t.svc.login({ email: signupInput.email, password: "password123" }),
      403,
      "EMAIL_NOT_VERIFIED",
    );
    assert.equal(t.sent.length, 1);
  });

  it("a wrong password stays 401 and never reveals verification status", async () => {
    await rejectsWith(t.svc.login({ email: signupInput.email, password: "nope-nope" }), 401, "INVALID_CREDENTIALS");
    await rejectsWith(t.svc.login({ email: "no@example.com", password: "nope-nope" }), 401, "INVALID_CREDENTIALS");
  });

  it("works after verification", async () => {
    await t.svc.verifyEmail({ email: signupInput.email, code: t.lastCode() });
    const res = await t.svc.login({ email: signupInput.email, password: "password123" });
    assert.equal(res.user.emailVerified, true);
    assert.ok(verifyToken(res.token));
  });
});

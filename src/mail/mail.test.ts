import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrevoApiMailer, ConsoleMailer, createMailerFromEnv, parseAddress } from "./mailer";
import { renderVerificationEmail } from "./templates";

describe("renderVerificationEmail", () => {
  for (const locale of ["az", "en", "ru", "tr"] as const) {
    it(`contains the code and TTL in ${locale}`, () => {
      const m = renderVerificationEmail(locale, "042917", 10);
      assert.ok(m.text.includes("042917") && m.html.includes("042917"));
      assert.ok(m.text.includes("10"));
      assert.ok(!m.text.includes("{minutes}"));
      assert.ok(m.subject.length > 0);
    });
  }
});

describe("createMailerFromEnv", () => {
  it("falls back to the console mailer outside production", () => {
    assert.ok(createMailerFromEnv({ NODE_ENV: "development" }) instanceof ConsoleMailer);
  });

  it("refuses to pretend in production without SMTP", async () => {
    const m = createMailerFromEnv({ NODE_ENV: "production" });
    await assert.rejects(m.send({ to: "a@b.c", subject: "s", text: "t", html: "h" }), (e: any) => {
      assert.equal(e.code, "EMAIL_NOT_CONFIGURED");
      return true;
    });
  });

  it("builds an SMTP mailer when SMTP_HOST is set", () => {
    const m = createMailerFromEnv({ NODE_ENV: "production", SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p" });
    assert.ok(!(m instanceof ConsoleMailer));
  });
});

describe("parseAddress", () => {
  it("splits name and email", () => {
    assert.deepEqual(parseAddress('Crypto Scanner <no-reply@cryptoanalyze.az>'), { name: "Crypto Scanner", email: "no-reply@cryptoanalyze.az" });
    assert.deepEqual(parseAddress('"Crypto Scanner" <a@b.co>'), { name: "Crypto Scanner", email: "a@b.co" });
  });
  it("accepts a bare address", () => {
    assert.deepEqual(parseAddress("a@b.co"), { email: "a@b.co" });
  });
});

describe("BrevoApiMailer", () => {
  const msg = { to: "user@example.com", subject: "s", text: "t", html: "<b>h</b>" };
  const ok = () => new Response('{"messageId":"x"}', { status: 201 });

  it("posts to the Brevo API with key, sender and recipient", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const m = new BrevoApiMailer("KEY", "Crypto Scanner <no-reply@cryptoanalyze.az>", (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return ok();
    }) as typeof fetch);
    await m.send(msg);
    assert.equal(seen!.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal((seen!.init.headers as Record<string, string>)["api-key"], "KEY");
    const body = JSON.parse(String(seen!.init.body));
    assert.deepEqual(body.sender, { name: "Crypto Scanner", email: "no-reply@cryptoanalyze.az" });
    assert.deepEqual(body.to, [{ email: "user@example.com" }]);
    assert.equal(body.textContent, "t");
  });

  it("retries once on a network error then succeeds", async () => {
    let calls = 0;
    const m = new BrevoApiMailer("K", "a@b.co", (async () => {
      if (++calls === 1) throw new Error("fetch failed");
      return ok();
    }) as typeof fetch);
    await m.send(msg);
    assert.equal(calls, 2);
  });

  it("does not retry a 4xx (e.g. unverified sender) and reports EMAIL_SEND_FAILED", async () => {
    let calls = 0;
    const m = new BrevoApiMailer("K", "a@b.co", (async () => {
      calls++;
      return new Response('{"message":"sender not valid"}', { status: 400 });
    }) as typeof fetch);
    await assert.rejects(m.send(msg), (e: any) => e.code === "EMAIL_SEND_FAILED" && e.statusCode === 502);
    assert.equal(calls, 1);
  });

  it("gives up after a second 5xx", async () => {
    let calls = 0;
    const m = new BrevoApiMailer("K", "a@b.co", (async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as typeof fetch);
    await assert.rejects(m.send(msg), (e: any) => e.code === "EMAIL_SEND_FAILED");
    assert.equal(calls, 2);
  });
});

describe("createMailerFromEnv with BREVO_API_KEY", () => {
  it("prefers the HTTPS API over SMTP", () => {
    const m = createMailerFromEnv({ NODE_ENV: "production", BREVO_API_KEY: "k", SMTP_HOST: "smtp.example.com", MAIL_FROM: "a@b.co" });
    assert.ok(m instanceof BrevoApiMailer);
  });
});

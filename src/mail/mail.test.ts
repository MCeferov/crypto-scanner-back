import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConsoleMailer, createMailerFromEnv } from "./mailer";
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

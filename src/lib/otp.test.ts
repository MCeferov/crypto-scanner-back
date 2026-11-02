import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123456";

const { OTP_LENGTH, codeMatches, generateCode, hashCode } = await import("./otp");

describe("otp", () => {
  it("generates zero-padded numeric codes of fixed length", () => {
    for (let i = 0; i < 500; i++) assert.match(generateCode(), new RegExp(`^\\d{${OTP_LENGTH}}$`));
  });

  it("is not constant", () => {
    const seen = new Set(Array.from({ length: 50 }, generateCode));
    assert.ok(seen.size > 40);
  });

  it("matches only the right code for the right user", () => {
    const h = hashCode("u1", "123456");
    assert.equal(codeMatches("u1", "123456", h), true);
    assert.equal(codeMatches("u1", "123457", h), false);
    assert.equal(codeMatches("u2", "123456", h), false);
  });

  it("tolerates a corrupt stored hash without throwing", () => {
    assert.equal(codeMatches("u1", "123456", "zz"), false);
    assert.equal(codeMatches("u1", "123456", ""), false);
  });
});

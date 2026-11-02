import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development fallback when no SMTP server is configured: the message is
 * written to the log instead of being delivered. Never used in production,
 * where a missing SMTP config must fail loudly rather than silently swallow
 * verification codes.
 */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    logger.info({ event: "mail_console", to: message.to }, `[DEV MAIL] ${message.subject}\n${message.text}`);
  }
}

class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(
    private readonly from: string,
    options: SMTPTransport.Options,
  ) {
    // Without these a reset or silent connection stalls the signup request for
    // nodemailer's two-minute defaults; fail fast so the client can retry.
    this.transport = nodemailer.createTransport({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      ...options,
    });
  }

  async send(message: MailMessage): Promise<void> {
    const info = await this.sendWithRetry(message);
    // The server's reply is the only evidence of what happened to the message
    // once it leaves us, so keep it — "the code never arrived" is otherwise
    // undiagnosable. The recipient is deliberately not logged.
    logger.info(
      { event: "mail_sent", accepted: info.accepted.length, rejected: info.rejected.length, response: info.response },
      "Verification email handed to SMTP server",
    );
    if (info.rejected.length > 0) {
      throw new AppError(502, "Email address was rejected by the mail server", "EMAIL_REJECTED");
    }
  }

  /**
   * One retry on connection-level failures and 4xx (temporary) SMTP replies.
   * Resets and timeouts happen before the server accepts the message, so a
   * retry cannot deliver it twice. 5xx replies are permanent and not retried.
   */
  private async sendWithRetry(message: MailMessage) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transport.sendMail({ from: this.from, ...message });
      } catch (err) {
        const e = err as { code?: string; responseCode?: number; message?: string };
        const transient =
          (e.code !== undefined && TRANSIENT_SMTP_CODES.has(e.code)) ||
          (e.responseCode !== undefined && e.responseCode >= 400 && e.responseCode < 500);
        logger.warn(
          { event: "mail_send_error", attempt, code: e.code, responseCode: e.responseCode, reason: e.message },
          "SMTP send failed",
        );
        if (!transient || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}

const TRANSIENT_SMTP_CODES = new Set(["ESOCKET", "ECONNECTION", "ETIMEDOUT", "ECONNRESET", "EDNS"]);

/** "Name <a@b.c>" or "a@b.c" -> { name?, email } */
export function parseAddress(raw: string): { name?: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1] || undefined, email: m[2].trim() };
  return { email: raw.trim() };
}

/**
 * Brevo transactional API over HTTPS. Hosts such as Railway block outbound SMTP
 * ports (25/465/587) on most plans, so SMTP times out there no matter how it is
 * configured; port 443 is never blocked.
 */
export class BrevoApiMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const sender = parseAddress(this.from);
    const body = JSON.stringify({
      sender,
      to: [{ email: message.to }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    });

    for (let attempt = 1; ; attempt++) {
      let status: number | undefined;
      let detail = "";
      try {
        const res = await this.fetchImpl("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        const text = await res.text();
        if (res.ok) {
          logger.info({ event: "mail_sent", provider: "brevo-api", status }, "Verification email handed to Brevo");
          return;
        }
        detail = text.slice(0, 300);
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }

      logger.warn({ event: "mail_send_error", provider: "brevo-api", attempt, status, reason: detail }, "Brevo API send failed");
      // 4xx (bad key, unverified sender, invalid address) will not improve on retry.
      const transient = status === undefined || status >= 500 || status === 429;
      if (!transient || attempt >= 2) {
        throw new AppError(502, "Could not send the verification email. Try again.", "EMAIL_SEND_FAILED");
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

class UnconfiguredMailer implements Mailer {
  async send(): Promise<void> {
    logger.error({ event: "mail_not_configured" }, "Neither BREVO_API_KEY nor SMTP_HOST is set; cannot send verification email");
    throw new AppError(503, "Email delivery is not configured", "EMAIL_NOT_CONFIGURED");
  }
}

export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  // HTTPS API wins when configured: it is the only transport that works on
  // hosts which block SMTP.
  if (env.BREVO_API_KEY) {
    return new BrevoApiMailer(env.BREVO_API_KEY, env.MAIL_FROM ?? env.SMTP_USER ?? "no-reply@localhost");
  }
  const host = env.SMTP_HOST;
  if (host) {
    const port = Number(env.SMTP_PORT ?? 587);
    const user = env.SMTP_USER;
    return new SmtpMailer(env.MAIL_FROM ?? user ?? "no-reply@localhost", {
      host,
      port,
      // 465 is implicit TLS; 587/25 upgrade via STARTTLS.
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
      auth: user ? { user, pass: env.SMTP_PASS } : undefined,
    });
  }
  return env.NODE_ENV === "production" ? new UnconfiguredMailer() : new ConsoleMailer();
}

let shared: Mailer | undefined;

/** Lazy so tests and scripts that never send mail don't build a transport. */
export function getMailer(): Mailer {
  shared ??= createMailerFromEnv();
  return shared;
}

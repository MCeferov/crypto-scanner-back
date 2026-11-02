import nodemailer from "nodemailer";
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
    options: Parameters<typeof nodemailer.createTransport>[0],
  ) {
    this.transport = nodemailer.createTransport(options);
  }

  async send(message: MailMessage): Promise<void> {
    const info = await this.transport.sendMail({ from: this.from, ...message });
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
}

class UnconfiguredMailer implements Mailer {
  async send(): Promise<void> {
    logger.error({ event: "mail_not_configured" }, "SMTP_HOST is not set; cannot send verification email");
    throw new AppError(503, "Email delivery is not configured", "EMAIL_NOT_CONFIGURED");
  }
}

export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
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

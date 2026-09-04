import { logger } from "./logger.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toErrorResponse(err: unknown): { status: number; body: { message: string; code?: string } } {
  if (err instanceof AppError) {
    // Deliberate, caller-facing errors carry their own safe wording.
    return { status: err.statusCode, body: { message: err.message, code: err.code } };
  }

  // Anything else is a bug or an upstream failure. The detail goes to the
  // server log through pino (which applies the redaction rules); the client is
  // told only that something broke. Driver text routinely names tables,
  // columns, hosts and file paths, none of which a caller should learn.
  logger.error({ err, event: "unhandled_service_error" }, "Unhandled service error");
  return { status: 500, body: { message: "Internal server error" } };
}

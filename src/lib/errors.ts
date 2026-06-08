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
    return { status: err.statusCode, body: { message: err.message, code: err.code } };
  }
  console.error(err);
  return { status: 500, body: { message: "Internal server error" } };
}

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodSchema } from "zod";
import { formatZodError } from "../validators/auth";

export function validateBody<T>(schema: ZodSchema<T>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ message: formatZodError(result.error) });
      return;
    }
    req.body = result.data;
    next();
  };
}

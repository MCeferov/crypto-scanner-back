import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

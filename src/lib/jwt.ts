import jwt, { type SignOptions } from "jsonwebtoken";

export interface JwtPayload {
  userId: string;
  email: string;
  username: string;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return secret;
}

function getExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN ?? "7d";
}

export function signToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: getExpiresIn() as SignOptions["expiresIn"] };
  return jwt.sign(payload, getSecret(), options);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as JwtPayload;
}

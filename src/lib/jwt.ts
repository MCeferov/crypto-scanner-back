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
  const decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
  // Reject structurally-invalid payloads: a token signed with the same secret
  // but a different shape would otherwise produce userId === undefined and
  // crash downstream Prisma lookups.
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as JwtPayload).userId !== "string" ||
    typeof (decoded as JwtPayload).email !== "string"
  ) {
    throw new jwt.JsonWebTokenError("Malformed token payload");
  }
  return decoded as JwtPayload;
}

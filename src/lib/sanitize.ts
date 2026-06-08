export function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function sanitizeUsername(username: string): string {
  return username.trim();
}

export function sanitizeText(input: string): string {
  return input.trim().replace(/[\x00-\x1F\x7F]/g, "");
}

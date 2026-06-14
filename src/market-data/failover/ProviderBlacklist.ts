export class ProviderBlacklist {
  private readonly until = new Map<string, number>();
  private readonly defaultBanMs: number;

  constructor(defaultBanMs = 5 * 60_000) {
    this.defaultBanMs = defaultBanMs;
  }

  isBlacklisted(provider: string): boolean {
    const t = this.until.get(provider);
    if (!t) return false;
    if (Date.now() >= t) {
      this.until.delete(provider);
      return false;
    }
    return true;
  }

  blacklist(provider: string, ms = this.defaultBanMs): void {
    this.until.set(provider, Date.now() + ms);
  }

  getUntil(provider: string): number | null {
    const t = this.until.get(provider);
    if (!t || Date.now() >= t) return null;
    return t;
  }

  clear(provider: string): void {
    this.until.delete(provider);
  }
}

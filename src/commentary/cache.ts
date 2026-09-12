/**
 * TTL cache with in-flight de-duplication.
 *
 * The de-duplication matters more than the caching here: when a detail page is
 * opened by fifty people at once, the first request should do the upstream work
 * and the other forty-nine should wait on that same promise rather than each
 * starting their own sweep of six feeds.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 300,
  ) {}

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.prune();
  }

  async load(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;

    const running = this.inflight.get(key);
    if (running) return running;

    // Failures are deliberately not cached here: the caller decides how to back
    // off, and a transient upstream blip should not pin an empty result for the
    // whole TTL.
    const pending = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return pending;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Per-source failure backoff. A feed that is down stays skipped for a while
 * instead of costing every request a connection timeout — which is what turns
 * one broken upstream into a slow endpoint for everybody.
 */
export class Cooldown {
  private readonly until = new Map<string, number>();
  private readonly strikes = new Map<string, number>();

  constructor(
    private readonly baseMs = 60_000,
    private readonly maxMs = 900_000,
  ) {}

  isCooling(key: string): boolean {
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(key: string): void {
    const strikes = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, strikes);
    this.until.set(key, Date.now() + Math.min(this.maxMs, this.baseMs * 2 ** (strikes - 1)));
  }

  recordSuccess(key: string): void {
    this.strikes.delete(key);
    this.until.delete(key);
  }
}

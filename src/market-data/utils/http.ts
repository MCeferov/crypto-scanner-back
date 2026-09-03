const DEFAULT_TIMEOUT_MS = 8_000;

export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: opts.headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      (err as Error & { status: number }).status = res.status;
      throw err;
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export function classifyHttpError(status: number): import('../types.js').ProviderErrorCode {
  if (status === 418 || status === 403) return 'IP_BAN';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'NETWORK';
  return 'INVALID_DATA';
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Map with a bounded number of in-flight tasks, preserving input order.
 * The default lists are large enough now (24 stocks, 22 forex pairs, 18
 * commodities) that a plain Promise.all would open one upstream connection per
 * symbol and invite a rate limit.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

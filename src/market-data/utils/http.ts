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

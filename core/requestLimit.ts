export interface RequestWindow {
  windowMs: number;
  max: number;
}

export class RequestLimiter {
  private hits: number[] = [];
  private readonly windows: RequestWindow[];
  private readonly now: () => number;

  constructor(windows: RequestWindow[], now: () => number = Date.now) {
    if (windows.length === 0 || windows.some((window) => window.windowMs <= 0 || window.max <= 0)) {
      throw new Error("Request limits must be positive.");
    }
    this.windows = windows;
    this.now = now;
  }

  tryAcquire(): { ok: true } | { ok: false; retryAfterMs: number } {
    const current = this.now();
    const longest = Math.max(...this.windows.map((window) => window.windowMs));
    this.hits = this.hits.filter((hit) => current - hit < longest);
    for (const window of this.windows) {
      const inWindow = this.hits.filter((hit) => current - hit < window.windowMs);
      if (inWindow.length >= window.max) {
        return { ok: false, retryAfterMs: Math.max(1, window.windowMs - (current - inWindow[0])) };
      }
    }
    this.hits.push(current);
    return { ok: true };
  }
}

export function localRequestLimiter(): RequestLimiter {
  const shared = globalThis as typeof globalThis & { __ultronRequestLimit?: RequestLimiter };
  shared.__ultronRequestLimit ??= new RequestLimiter([
    { windowMs: 60_000, max: 30 },
    { windowMs: 24 * 60 * 60_000, max: 500 },
  ]);
  return shared.__ultronRequestLimit;
}

/**
 * Daily upload window in local time (container TZ). Supports windows that
 * cross midnight (e.g. 22:00 → 06:00). No window, or start == end, means
 * uploads are always allowed.
 */
export class UploadWindow {
  private readonly startMin: number | null;
  private readonly endMin: number | null;

  constructor(
    readonly start: string | null,
    readonly end: string | null,
  ) {
    this.startMin = start ? parseHHMM(start) : null;
    this.endMin = end ? parseHHMM(end) : null;
  }

  get alwaysOpen(): boolean {
    return this.startMin === null || this.endMin === null || this.startMin === this.endMin;
  }

  isOpen(at: Date = new Date()): boolean {
    if (this.alwaysOpen) return true;
    const m = at.getHours() * 60 + at.getMinutes();
    const s = this.startMin!;
    const e = this.endMin!;
    return s < e ? m >= s && m < e : m >= s || m < e;
  }

  /** Milliseconds until the window next opens (0 if open now). */
  msUntilOpen(at: Date = new Date()): number {
    if (this.isOpen(at)) return 0;
    const next = new Date(at);
    next.setHours(Math.floor(this.startMin! / 60), this.startMin! % 60, 0, 0);
    if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - at.getTime();
  }

  /** Next opening time, or null if currently open. */
  nextOpen(at: Date = new Date()): Date | null {
    return this.isOpen(at) ? null : new Date(at.getTime() + this.msUntilOpen(at));
  }

  describe(): string {
    return this.alwaysOpen ? 'always' : `${this.start}-${this.end}`;
  }
}

export function parseHHMM(v: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  if (!m) throw new Error(`Invalid time "${v}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Exponential backoff: base, 2·base, 4·base, … capped at max. `attempt` starts at 1. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(baseMs * 2 ** exp, maxMs);
}

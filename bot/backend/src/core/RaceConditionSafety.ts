/**
 * RACE CONDITION SAFETY
 * ══════════════════════════════════════════════════════════════════════════
 * يمنع race conditions عند معالجة نفس الرمز في نفس الوقت.
 *
 * المشكلة:
 *   Node.js single-threaded لكن async/await يسمح بـ "interleaving":
 *   - دورة 1 تبدأ معالجة EURUSD H1 → تنتظر fetchCandles (async)
 *   - دورة 2 تبدأ معالجة EURUSD H4 → تنتظر fetchCandles (async)
 *   - كلتاهما تحصل على إشارة BUY وتنفذان في نفس الوقت
 *
 * الحل:
 *   AsyncMutex لكل رمز — دورة واحدة فقط تعالج الرمز في أي لحظة.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Logger } from '../utils/Logger';

interface QueueEntry {
  resolve: (acquired: boolean) => void;
}

export class AsyncMutex {
  private locked = false;
  private queue: QueueEntry[] = [];

  async acquire(timeoutMs = 10_000): Promise<boolean> {
    if (!this.locked) {
      this.locked = true;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Remove from queue on timeout
        const idx = this.queue.findIndex(e => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false); // timeout — could not acquire
      }, timeoutMs);

      this.queue.push({
        resolve: (acquired: boolean) => {
          clearTimeout(timer);
          resolve(acquired);
        },
      });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve(true);
    } else {
      this.locked = false;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * Per-symbol race condition guard.
 * Usage:
 *   const guard = new RaceConditionSafety();
 *   const mutex = guard.getMutex('EURUSD');
 *   const acquired = await mutex.acquire();
 *   if (!acquired) return; // skip — symbol already being processed
 *   try { ... }
 *   finally { mutex.release(); }
 */
export class RaceConditionSafety {
  private readonly logger  = new Logger('RaceConditionSafety');
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly stats   = new Map<string, { skipped: number; timeouts: number }>();

  getMutex(symbol: string): AsyncMutex {
    const key = symbol.toUpperCase();
    if (!this.mutexes.has(key)) {
      this.mutexes.set(key, new AsyncMutex());
      this.stats.set(key, { skipped: 0, timeouts: 0 });
    }
    return this.mutexes.get(key)!;
  }

  /**
   * Try to acquire lock for a symbol.
   * Returns false immediately (non-blocking) if symbol is being processed.
   */
  tryAcquire(symbol: string): boolean {
    const mutex = this.getMutex(symbol);
    if (mutex.isLocked()) {
      const s = this.stats.get(symbol.toUpperCase())!;
      s.skipped++;
      this.logger.debug(`[${symbol}] Skipped — already processing (skips: ${s.skipped})`);
      return false;
    }
    // Acquire synchronously (we know it's not locked)
    mutex.acquire(0).catch(() => {}); // fire-and-forget the promise
    return true;
  }

  release(symbol: string): void {
    const mutex = this.mutexes.get(symbol.toUpperCase());
    if (mutex) mutex.release();
  }

  /**
   * Execute a function with per-symbol mutex protection.
   * If the symbol is already being processed, skip (return undefined).
   */
  async withLock<T>(
    symbol: string,
    fn: () => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T | undefined> {
    const mutex = this.getMutex(symbol);
    const acquired = await mutex.acquire(timeoutMs);

    if (!acquired) {
      const s = this.stats.get(symbol.toUpperCase())!;
      s.timeouts++;
      this.logger.warn(`[${symbol}] Lock timeout after ${timeoutMs}ms`);
      return undefined;
    }

    try {
      return await fn();
    } finally {
      mutex.release();
    }
  }

  getStats(): Record<string, { skipped: number; timeouts: number; locked: boolean }> {
    const out: Record<string, { skipped: number; timeouts: number; locked: boolean }> = {};
    for (const [key, mutex] of this.mutexes) {
      out[key] = { ...this.stats.get(key)!, locked: mutex.isLocked() };
    }
    return out;
  }

  /** Returns list of symbols currently being processed */
  getActiveLocks(): string[] {
    return Array.from(this.mutexes.entries())
      .filter(([, m]) => m.isLocked())
      .map(([k]) => k);
  }
}

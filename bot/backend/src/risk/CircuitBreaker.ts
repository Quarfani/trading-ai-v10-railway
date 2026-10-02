import { Logger } from '../utils/Logger';
import { TelegramBot } from '../notifications/TelegramBot';

interface CircuitBreakerStateStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

/**
 * Stops trading after N consecutive losses, then auto-resumes after cooldown.
 * Sends Telegram warning on trip.
 */
export class CircuitBreaker {
  private logger = new Logger('CircuitBreaker');
  private consecutiveLosses = 0;
  private trippedUntil = 0;
  private stateCorrupt = false;
  private readonly stateKey: string;

  constructor(
    private maxConsecutiveLosses: number,
    private cooldownMs: number,
    private telegram: TelegramBot | null,
    private readonly stateStore?: CircuitBreakerStateStore,
    accountKey = 'default',
  ) {
    this.stateKey =
      `circuit_breaker:${accountKey.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    this.loadState();
  }

  recordResult(profit: number) {
    if (!Number.isFinite(profit)) {
      this.stateCorrupt = true;
      this.logger.error('Non-finite circuit-breaker PnL — trading blocked');
      return;
    }
    if (profit > 0) {
      if (this.consecutiveLosses) this.logger.info(`Win — streak reset (was ${this.consecutiveLosses})`);
      this.consecutiveLosses = 0;
      this.trippedUntil = 0;
      this.persistState();
      return;
    }
    this.consecutiveLosses++;
    this.logger.warn(`Loss streak: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.trip();
    }
    this.persistState();
  }

  private trip() {
    this.trippedUntil = Date.now() + this.cooldownMs;
    const minutes = Math.round(this.cooldownMs / 60000);
    const msg = `🛑 <b>CIRCUIT BREAKER TRIPPED</b>\n` +
                `${this.consecutiveLosses} خسائر متتالية!\n` +
                `تم إيقاف التداول لمدة ${minutes} دقيقة.\n` +
                `يستأنف تلقائياً في ${new Date(this.trippedUntil).toLocaleTimeString()}`;
    this.logger.error(msg);
    this.persistState();
    this.telegram?.sendMessage(msg)?.catch(() => {});
  }

  canTrade(): boolean {
    if (
      !Number.isInteger(this.maxConsecutiveLosses) ||
      this.maxConsecutiveLosses <= 0 ||
      !Number.isFinite(this.cooldownMs) ||
      this.cooldownMs < 0 ||
      this.stateCorrupt
    ) {
      this.logger.error('Circuit breaker state/config invalid — trading blocked');
      return false;
    }

    if (Date.now() >= this.trippedUntil) {
      if (this.trippedUntil > 0) {
        this.logger.info('Cooldown ended — resuming trading');
        this.telegram.sendMessage('✅ <b>Cooldown ended</b> — استئناف التداول').catch(() => {});
        this.trippedUntil = 0;
        this.consecutiveLosses = 0;
        this.persistState();
      }
      return true;
    }
    return false;
  }

  cooldownRemainingMs(): number { return Math.max(0, this.trippedUntil - Date.now()); }

  getStatus(): string {
    if (this.trippedUntil > Date.now()) {
      const minutes = Math.ceil(this.cooldownRemainingMs() / 60000);
      return `TRIPPED (cooldown ${minutes}m, ${this.consecutiveLosses} losses)`;
    }
    return `OK (${this.consecutiveLosses}/${this.maxConsecutiveLosses} losses)`;
  }

  reset() {
    this.consecutiveLosses = 0;
    this.trippedUntil = 0;
    this.persistState();
  }

  private loadState(): void {
    if (!this.stateStore) return;
    try {
      const raw = this.stateStore.getSetting(this.stateKey);
      if (!raw) return;
      const state = JSON.parse(raw);
      if (
        Number.isFinite(Number(state?.consecutiveLosses)) &&
        Number(state.consecutiveLosses) >= 0
      ) {
        this.consecutiveLosses = Math.floor(Number(state.consecutiveLosses));
      }
      if (
        Number.isFinite(Number(state?.trippedUntil)) &&
        Number(state.trippedUntil) >= 0
      ) {
        this.trippedUntil = Number(state.trippedUntil);
      }
    } catch {
      this.stateCorrupt = true;
      this.logger.error('Circuit breaker persisted state is corrupt — trading blocked');
    }
  }

  private persistState(): void {
    if (!this.stateStore) return;
    try {
      this.stateStore.setSetting(
        this.stateKey,
        JSON.stringify({
          consecutiveLosses: this.consecutiveLosses,
          trippedUntil: this.trippedUntil,
          updatedAt: Date.now(),
        }),
      );
    } catch {
      // Non-persistence must not throw out of the trading pipeline.
    }
  }
}

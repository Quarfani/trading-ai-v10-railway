import { Logger } from '../utils/Logger';
import { TelegramBot } from '../notifications/TelegramBot';

/**
 * Stops trading after N consecutive losses, then auto-resumes after cooldown.
 * Sends Telegram warning on trip.
 */
export class CircuitBreaker {
  private logger = new Logger('CircuitBreaker');
  private consecutiveLosses = 0;
  private trippedUntil = 0;

  constructor(
    private maxConsecutiveLosses: number,
    private cooldownMs: number,
    private telegram: TelegramBot | null,
  ) {}

  recordResult(profit: number) {
    if (profit > 0) {
      if (this.consecutiveLosses) this.logger.info(`Win — streak reset (was ${this.consecutiveLosses})`);
      this.consecutiveLosses = 0;
      this.trippedUntil = 0;
      return;
    }
    this.consecutiveLosses++;
    this.logger.warn(`Loss streak: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.trip();
    }
  }

  private trip() {
    this.trippedUntil = Date.now() + this.cooldownMs;
    const minutes = Math.round(this.cooldownMs / 60000);
    const msg = `🛑 <b>CIRCUIT BREAKER TRIPPED</b>\n` +
                `${this.consecutiveLosses} خسائر متتالية!\n` +
                `تم إيقاف التداول لمدة ${minutes} دقيقة.\n` +
                `يستأنف تلقائياً في ${new Date(this.trippedUntil).toLocaleTimeString()}`;
    this.logger.error(msg);
    this.telegram?.sendMessage(msg)?.catch(() => {});
  }

  canTrade(): boolean {
    if (Date.now() >= this.trippedUntil) {
      if (this.trippedUntil > 0) {
        this.logger.info('Cooldown ended — resuming trading');
        this.telegram.sendMessage('✅ <b>Cooldown ended</b> — استئناف التداول').catch(() => {});
        this.trippedUntil = 0;
        this.consecutiveLosses = 0;
      this.trippedUntil = 0;
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

  reset() { this.consecutiveLosses = 0; this.trippedUntil = 0; }
}

import { TelegramBot } from '../notifications/TelegramBot';
import { Logger } from '../utils/Logger';

/**
 * EMERGENCY STOP SYSTEM
 *
 * Instant kill switch to halt all trading immediately.
 * Can be triggered by:
 * - Critical system errors
 * - Manual command (Telegram)
 * - Health monitor detecting critical failures
 *
 * Once activated:
 * - No new trades are placed
 * - Existing broker protective orders remain untouched
 * - System enters "safe mode"
 */
export class EmergencyStop {
  private logger = new Logger('EmergencyStop');
  private active = false;
  private activatedAt?: number;
  private reason?: string;
  private listeners: Array<(active: boolean, reason?: string) => void> = [];

  constructor(private telegram?: TelegramBot) {}

  /**
   * Activate emergency stop
   */
  async activate(reason: string) {
    if (this.active) return; // Already active

    this.active = true;
    this.activatedAt = Date.now();
    this.reason = reason;

    this.logger.error(`🛑 EMERGENCY STOP ACTIVATED: ${reason}`);

    // Notify
    const msg = `🛑 <b>EMERGENCY STOP</b>\n\nReason: ${reason}\n\nAll trading halted immediately.`;
    try {
      await this.telegram?.sendMessage(msg);
    } catch (e) {
      this.logger.error('Failed to send emergency alert', e);
    }

    // Notify all listeners
    this.listeners.forEach(fn => fn(true, reason));
  }

  /**
   * Deactivate emergency stop (manual reset)
   */
  async deactivate(approverMessage?: string) {
    if (!this.active) return;

    const duration = Date.now() - (this.activatedAt ?? Date.now());
    this.active = false;
    this.activatedAt = undefined;
    this.reason = undefined;

    this.logger.info(`🟢 EMERGENCY STOP DEACTIVATED (was active for ${Math.round(duration / 1000)}s)`);

    const msg = `🟢 <b>EMERGENCY STOP DEACTIVATED</b>\n\nApprover: ${approverMessage ?? 'system'}\n\nTrading resumed.`;
    try {
      await this.telegram?.sendMessage(msg);
    } catch (e) {
      this.logger.error('Failed to send resume alert', e);
    }

    // Notify listeners
    this.listeners.forEach(fn => fn(false));
  }

  /**
   * Check if emergency stop is active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get status details
   */
  getStatus() {
    return {
      active: this.active,
      activatedAt: this.activatedAt,
      reason: this.reason,
      duration: this.active ? Date.now() - (this.activatedAt ?? Date.now()) : 0,
    };
  }

  /**
   * Get the reason for emergency stop
   */
  getReason(): string | undefined {
    return this.reason;
  }

  /**
   * Subscribe to emergency stop changes
   */
  onStatusChange(listener: (active: boolean, reason?: string) => void) {
    this.listeners.push(listener);
  }
}

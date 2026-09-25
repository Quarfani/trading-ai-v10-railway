/**
 * TELEGRAM MESSAGE QUEUE — new module
 * ════════════════════════════════════════════════════════════════════
 * WHY THIS IS NEEDED:
 *   TelegramBot.sendMessage() fires directly. Under load (multiple
 *   simultaneous signals + risk events + circuit breaker) the bot
 *   bursts past Telegram's 30 msg/s limit, causing 429 errors and
 *   silently dropped critical notifications.
 *
 * HOW TO USE:
 *   Replace TelegramBot with QueuedTelegramBot everywhere in the bot.
 *   It has the same interface — no other changes needed.
 *
 *   const telegram = new QueuedTelegramBot(config);
 *   // ...same usage as TelegramBot
 * ════════════════════════════════════════════════════════════════════
 */
import TelegramBotAPI from 'node-telegram-bot-api';
import { SystemConfig } from '../types/trading.types';
import { Logger }       from '../utils/Logger';

const MIN_INTERVAL_MS = 50;   // 20 messages/second (well under the 30/s limit)
const MAX_QUEUE_SIZE  = 500;  // drop oldest if queue overflows

export class QueuedTelegramBot {
  private logger  = new Logger('TelegramBot');
  private bot:    TelegramBotAPI | null = null;
  private chatId: string;
  private queue:  Array<{ text: string; resolve: () => void; reject: (e: any) => void }> = [];
  private timer:  NodeJS.Timeout | null = null;
  private sending = false;

  constructor(config: SystemConfig) {
    this.chatId = String(config.telegram?.chatId ?? '');
    if (!config.telegram?.token) {
      this.logger.warn('Telegram token not configured — notifications disabled');
      return;
    }
    try {
      this.bot = new TelegramBotAPI(config.telegram.token);
      this.logger.info('Telegram queue ready');
    } catch (e: any) {
      this.logger.warn(`Telegram init failed: ${e.message}`);
    }
  }

  /** Drop-in replacement for TelegramBot.sendMessage() */
  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;

    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        // Drop oldest to prevent unbounded growth
        this.queue.shift();
        this.logger.warn('Telegram queue full — dropped oldest message');
      }
      this.queue.push({ text, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 0);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.sending || !this.queue.length) return;
    this.sending = true;

    while (this.queue.length) {
      const item = this.queue.shift()!;
      try {
        await this.bot!.sendMessage(this.chatId, item.text, { parse_mode: 'HTML' });
        item.resolve();
      } catch (e: any) {
        if (e.response?.statusCode === 429) {
          const retryAfter = (e.response?.body?.parameters?.retry_after ?? 10) * 1_000;
          this.logger.warn(`Telegram 429 — waiting ${retryAfter / 1000}s`);
          this.queue.unshift(item);  // put back at front
          await this.sleep(retryAfter);
          continue;
        }
        this.logger.warn(`Telegram error: ${e.message}`);
        item.reject(e);
      }
      // Rate limit: wait MIN_INTERVAL_MS between messages
      if (this.queue.length) await this.sleep(MIN_INTERVAL_MS);
    }

    this.sending = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}


/**
 * /CLOSEALL COMMAND — patch for TelegramCommands.ts
 * ════════════════════════════════════════════════════════════════════
 * Add this inside TelegramCommands.register() alongside the other commands.
 * It closes ALL open positions via the ExecutionGateway and reports results.
 *
 * USAGE in Telegram chat:
 *   /closeall          → closes all open trades
 *   /closeall EURUSD   → closes all EURUSD trades only
 *
 * PASTE THIS BLOCK into TelegramCommands.ts inside the register() method:
 * ════════════════════════════════════════════════════════════════════
 *
 *   b.onText(/\/closeall(.*)/, async m => {
 *     if (!auth(m)) return;
 *     const symbol = m.text?.split(' ')[1]?.trim().toUpperCase() ?? '';
 *     send(m.chat.id, `⏳ Closing all ${symbol || 'open'} positions...`);
 *
 *     const db     = (engine as any).db as DatabaseManager;
 *     const exec   = (engine as any).exec as ExecutionGateway;
 *     const config = engine.config;
 *     const open   = db.getOpenTrades();
 *     const targets = symbol ? open.filter(t => t.symbol === symbol) : open;
 *
 *     if (!targets.length) { send(m.chat.id, '✅ No open trades to close.'); return; }
 *
 *     let closed = 0, failed = 0;
 *     for (const t of targets) {
 *       try {
 *         if (config.mode === 'mt5' && t.ticket) {
 *           await axios.post(`${config.mt5.bridgeUrl}/close`, { ticket: t.ticket }, { timeout: 8000 });
 *           db.updateTradeClose(t.id!, 0, Date.now(), 'manual_closeall');
 *           closed++;
 *         } else if (config.mode === 'paper') {
 *           db.updateTradeClose(t.id!, 0, Date.now(), 'manual_closeall');
 *           closed++;
 *         } else if (config.mode === 'binance') {
 *           // Binance: close position via ExecutionGateway
 *           const r = await (exec as any).binance?.closePosition(t.symbol);
 *           if (r) { db.updateTradeClose(t.id!, 0, Date.now(), 'manual_closeall'); closed++; }
 *           else failed++;
 *         }
 *       } catch { failed++; }
 *     }
 *     send(m.chat.id, `✅ Closed: ${closed} | ❌ Failed: ${failed}`);
 *   });
 */
export {};  // keeps TypeScript happy as a module

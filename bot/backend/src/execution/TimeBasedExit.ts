/**
 * TIME-BASED EXIT
 * يغلق الصفقات التي بقيت مفتوحة أكثر من MAX_HOLD_HOURS دون وصول TP/SL
 * يعمل في MT5 + Binance + Paper
 */
import { SystemConfig, Trade } from '../types/trading.types';
import { DatabaseManager }  from '../database/DatabaseManager';
import { ExecutionGateway } from './ExecutionGateway';
import { MarketScanner }    from '../core/MarketScanner';
import { TelegramBot }      from '../notifications/TelegramBot';
import { Logger }           from '../utils/Logger';

// Max hours a trade can stay open before forced exit
const MAX_HOLD_HOURS: Record<string, number> = {
  M1:  8,   M5:  16,   M15: 24,
  M30: 36,  H1:  48,   H4:  120, D1: 240,
};
const DEFAULT_MAX_HOURS = 48;

export class TimeBasedExit {
  private logger   = new Logger('TimeExit');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private config:   SystemConfig,
    private db:       DatabaseManager,
    private exec:     ExecutionGateway,
    private scanner:  MarketScanner,
    private telegram: TelegramBot,
  ) {}

  start() {
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 15 * 60_000); // every 15 min
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async tick() {
    const open = this.db.getOpenTrades();
    const now  = Date.now();

    for (const t of open) {
      const tf       = (t as any).timeframe ?? 'H1';
      const maxMs    = (MAX_HOLD_HOURS[tf] ?? DEFAULT_MAX_HOURS) * 3_600_000;
      const ageMs    = now - t.openedAt;
      if (ageMs < maxMs) continue;

      const ageH = (ageMs / 3_600_000).toFixed(1);
      this.logger.info(`TimeExit: ${t.symbol} id=${t.id} age=${ageH}h > max=${maxMs/3_600_000}h — closing`);

      try {
        await this.closeByMode(t);
        await this.telegram.sendMessage(
          `⏱ <b>TIME EXIT</b> ${t.symbol} ${t.side}\n` +
          `Trade open ${ageH}h (max ${maxMs/3_600_000}h)\nForced close at market.`
        ).catch(() => {});
      } catch (e: any) {
        this.logger.error(`TimeExit close failed ${t.symbol}: ${e.message}`);
      }
    }
  }

  private async closeByMode(t: Trade) {
    const candles = await this.scanner.fetchCandles(t.symbol, 'M5', 2).catch(() => []);
    const exitPrice = candles.length ? candles[candles.length - 1].close : t.entry;
    const result = await this.exec.closeAtMarket(t, exitPrice, 'TIMEOUT');
    if(!result.ok) throw new Error(`Execution gateway refused TIMEOUT close for ${t.symbol}`);
  }
}

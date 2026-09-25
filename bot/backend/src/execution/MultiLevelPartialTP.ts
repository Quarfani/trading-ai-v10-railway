/**
 * MULTI-LEVEL PARTIAL TP MANAGER — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُغلق الصفقة على 3 مراحل بدلاً من مرة واحدة:
 *
 *   Level 1 @ 1.0R → يُغلق 30% + ينقل SL إلى BE
 *   Level 2 @ 2.0R → يُغلق 30% + يُحرّك SL إلى +0.5R
 *   Level 3 @ TP   → يُغلق الـ 40% المتبقية (trailing)
 *
 * الهدف:
 *   - تأمين الأرباح المبكرة (يرفع win rate psychologically)
 *   - السماح للرابحات بالاستمرار (يرفع average win)
 *   - لا يترك الصفقة تنقلب من ربح إلى خسارة
 *
 * [FIX vs القديم] PartialTPManager القديم:
 *   - كان يُغلق 50% فقط عند 1R
 *   - لم يكن لديه Level 2 أو Trailing بعد Level 1
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SystemConfig, Trade } from '../types/trading.types';
import { DatabaseManager }     from '../database/DatabaseManager';
import { ExecutionGateway }    from './ExecutionGateway';
import { MarketScanner }       from '../core/MarketScanner';
import { Logger }              from '../utils/Logger';

interface LevelRecord {
  tradeId: number;
  l1Done:  boolean;
  l2Done:  boolean;
  l3Done:  boolean;
}

export class MultiLevelPartialTP {
  private logger   = new Logger('MultiTP');
  private interval: NodeJS.Timeout | null = null;
  private records  = new Map<number, LevelRecord>();
  private static readonly STATE_KEY = 'multi_level_partial_tp';

  constructor(
    private config:  SystemConfig,
    private db:      DatabaseManager,
    private exec:    ExecutionGateway,
    private scanner: MarketScanner,
  ) {}

  start() {
    this.loadState();
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.logger.info('MultiLevelPartialTP started');
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async tick() {
    const open = this.db.getOpenTrades();

    for (const t of open) {
      if (!t.id) continue;

      // Init record if needed
      if (!this.records.has(t.id)) {
        this.records.set(t.id, { tradeId: t.id, l1Done: false, l2Done: false, l3Done: false });
        this.saveState();
      }

      const rec = this.records.get(t.id)!;
      if (rec.l1Done && rec.l2Done) continue; // all levels done → trailing handles the rest

      try {
        const candles = await this.scanner.fetchCandles(t.symbol, 'M5', 5).catch(() => []);
        if (!candles.length) continue;

        const price = candles[candles.length - 1].close;
        const risk  = Math.abs(t.entry - t.sl);
        if (risk === 0) continue;

        const profit_R = (t.side === 'BUY' ? price - t.entry : t.entry - price) / risk;

        // Level 1: 1R → close 30% + move to BE
        if (!rec.l1Done && profit_R >= 1.0) {
          await this.executeLevel(t, 1, 0.30, price, risk);
          await this.moveSL(t, t.entry); // SL → Breakeven
          rec.l1Done = true;
          this.saveState();
          this.logger.info(`[${t.symbol}] L1 partial TP at ${profit_R.toFixed(1)}R — closed 30%`);
        }

        // Level 2: 2R → close another 30% + SL to +0.5R
        if (rec.l1Done && !rec.l2Done && profit_R >= 2.0) {
          await this.executeLevel(t, 2, 0.30, price, risk);
          const sl05R = t.side === 'BUY' ? t.entry + risk * 0.5 : t.entry - risk * 0.5;
          await this.moveSL(t, sl05R);
          rec.l2Done = true;
          this.saveState();
          this.logger.info(`[${t.symbol}] L2 partial TP at ${profit_R.toFixed(1)}R — closed 30%`);
        }

        // Cleanup closed trades
        const current = this.db.getOpenTrades().find(x => x.id === t.id);
        if (!current) { this.records.delete(t.id); this.saveState(); }

      } catch (e: any) {
        this.logger.warn(`MultiTP ${t.symbol}: ${e.message}`);
      }
    }
  }

  private async executeLevel(t: Trade, level: number, fraction: number, price: number, _risk: number) {
    if (!t.id) throw new Error('Trade ID is required for partial TP');
    const volume=+(t.volume*fraction).toFixed(8);
    if (!(volume>0) || volume>=t.volume) throw new Error(`Invalid partial volume ${volume}`);
    const result=await this.exec.closePartial(t,volume,price,`LEVEL_${level}`);
    if (!result.ok) throw new Error(`Partial level ${level} execution failed`);
    this.logger.info(`[${t.symbol}] Level ${level} partial: ${volume} closed, remaining=${result.remainingVolume}, pnl=${result.profit.toFixed(2)}`);
  }

  private async moveSL(t: Trade, newSl: number) {
    const better = t.side === 'BUY' ? newSl > t.sl : newSl < t.sl;
    if (!better) return;
    const ok=await this.exec.modifySLTP(t,newSl,t.tp);
    if(!ok) throw new Error(`SL modification failed for ${t.symbol}`);
    this.logger.debug(`[${t.symbol}] SL moved to ${newSl.toFixed(5)}`);
  }

  private loadState() {
    try {
      const raw=this.db.getSetting(MultiLevelPartialTP.STATE_KEY);
      if(!raw) return;
      const list=JSON.parse(raw) as LevelRecord[];
      for(const r of list) if(r?.tradeId) this.records.set(r.tradeId,{tradeId:r.tradeId,l1Done:!!r.l1Done,l2Done:!!r.l2Done,l3Done:!!r.l3Done});
      this.logger.info(`Loaded ${this.records.size} multi-level TP states`);
    } catch { /* recover from corrupt state */ }
  }

  private saveState() {
    try { this.db.setSetting(MultiLevelPartialTP.STATE_KEY, JSON.stringify([...this.records.values()])); }
    catch { /* non-critical */ }
  }

}

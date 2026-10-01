/**
 * SCALE-IN MANAGER — v2.0
 * FIX: scaled Set was in-memory only — reset on every bot restart.
 * Trades that already received a scale-in got a second scale-in after restart.
 * Fix: persist scaled IDs to SQLite using db.setSetting().
 */
import { SystemConfig }        from '../types/trading.types';
import { DatabaseManager }     from '../database/DatabaseManager';
import { ExecutionGateway }    from './ExecutionGateway';
import { getMarketDefinition } from '../market/MarketCatalog';
import { resolveQuoteToAccount } from '../market/CurrencyConverter';
import { CurrencyConversionProvider } from '../market/CurrencyConversionProvider';
import { Logger }              from '../utils/Logger';
import { MarketScanner }       from '../core/MarketScanner';
import { Signal }               from '../types/trading.types';

const SCALE_DB_KEY = 'scalein_taken';

export class ScaleInManager {
  private logger   = new Logger('ScaleIn');
  private interval: NodeJS.Timeout | null = null;

  // FIX: persisted across restarts
  private scaled = new Set<number>();

  constructor(
    private config: SystemConfig,
    private db:     DatabaseManager,
    private exec:   ExecutionGateway,
    private scanner: MarketScanner,
    private currencyRates: CurrencyConversionProvider,
  ) {}

  start() {
    // FIX: load previously-scaled IDs from DB on startup
    this.loadScaled();
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private loadScaled(): void {
    try {
      const raw = this.db.getSetting(SCALE_DB_KEY);
      if (raw) {
        const ids: number[] = JSON.parse(raw);
        ids.forEach(id => this.scaled.add(id));
        this.logger.info(`Loaded ${ids.length} scale-in records from DB`);
      }
    } catch { /* fresh start */ }
  }

  private saveScaled(): void {
    try {
      this.db.setSetting(SCALE_DB_KEY, JSON.stringify([...this.scaled]));
    } catch { /* non-critical */ }
  }

  private async tick() {
    const open = this.db.getOpenTrades();

    for (const t of open) {
      if (!t.id || this.scaled.has(t.id)) continue;

      const price = await this.getCurrentPrice(t.symbol);
      if (!price) continue;

      const r     = Math.abs(t.entry - t.sl);
      const moved = t.side === 'BUY' ? price - t.entry : t.entry - price;

      // Scale in at 1.5R
      if (moved < r * 1.5) continue;

      try {
        await this.doScaleIn(t, price);
        this.scaled.add(t.id);
        this.saveScaled(); // persist immediately
        this.logger.info(
          `Scale-in ${t.symbol} id=${t.id} at 1.5R (price=${price.toFixed(5)})`
        );
      } catch (e: any) {
        this.logger.warn(`Scale-in failed ${t.symbol}: ${e.message}`);
      }
    }

    // Prune closed trades from the set
    const openIds = new Set(open.map((t: any) => t.id!));
    for (const id of this.scaled) {
      if (!openIds.has(id)) this.scaled.delete(id);
    }
    this.saveScaled();
  }

  private async doScaleIn(t:any,currentPrice:number){
    const market = getMarketDefinition(t.symbol);
    if (!market) throw new Error(`No broker-confirmed market definition for ${t.symbol}`);

    const rates = await this.currencyRates.getRates(market.quoteCurrency);
    if (market.quoteCurrency.toUpperCase() !== (this.config.accountCurrency ?? 'USD').toUpperCase() && !rates) {
      throw new Error(`FX conversion unavailable for ${market.quoteCurrency}->${this.config.accountCurrency ?? 'USD'}`);
    }
    const livePrices = rates ?? {};
    const quoteToAccount = resolveQuoteToAccount(
      market.quoteCurrency,
      this.config.accountCurrency ?? 'USD',
      livePrices,
    );
    if (quoteToAccount == null) throw new Error('Scale-in FX conversion failed');

    const equity = await this.exec.getCurrentEquity();
    if (!(equity && equity > 0 && Number.isFinite(equity))) {
      throw new Error('Scale-in equity unavailable');
    }

    const economics = market.economics;
    const existingRisk = Math.abs(t.entry - t.sl) * economics.contractSize * quoteToAccount * t.volume;
    const addRiskPerVolume = Math.abs(currentPrice - t.sl) * economics.contractSize * quoteToAccount;
    const riskBudget = equity * 0.02 - existingRisk;
    if (!(riskBudget > 0) || !(addRiskPerVolume > 0)) {
      throw new Error('Scale-in would exceed aggregate 2% stop-risk budget');
    }

    const requested = t.volume * 0.5;
    const maxAdditional = riskBudget / addRiskPerVolume;
    let addVolume = Math.min(requested, maxAdditional, economics.maxVolume);
    addVolume = Math.floor(addVolume / economics.volumeStep + 1e-12) * economics.volumeStep;
    addVolume = +addVolume.toFixed(8);
    if (!(addVolume >= economics.minVolume) || !Number.isFinite(addVolume)) {
      throw new Error(`Scale-in volume below broker minimum for ${t.symbol}`);
    }

    const signal: Signal = {
      symbol:t.symbol, side:t.side, price:currentPrice, confidence:1, sl:t.sl, tp:t.tp,
      source:`SCALE_IN:${t.source}`, reason:`Scale-in at 1.5R from trade ${t.id}`,
      timestamp:Date.now(), timeframe:t.timeframe,
    };
    const result=await this.exec.execute(signal,addVolume,t.timeframe??'H1');
    if(!result.success)throw new Error(result.error??'scale-in failed');
  }

  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const candles = await this.scanner.fetchCandles(symbol, 'M5', 1);
      return candles?.[candles.length - 1]?.close ?? null;
    } catch { return null; }
  }
}

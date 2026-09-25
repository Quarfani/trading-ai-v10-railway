/**
 * HISTORICAL DATA DOWNLOADER — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُحمّل بيانات تاريخية حقيقية (سنة أو سنتين) من مصادر مجانية:
 *
 *   Binance API  → Crypto (BTC, ETH, BNB, SOL, XRP)
 *   Yahoo Finance → Forex + Metals + Indices
 *   Stooq        → Forex backup (EURUSD, GBPUSD, USDJPY...)
 *
 * المخرجات:
 *   - ملفات CSV في مجلد data/historical/{symbol}_{tf}.csv
 *   - SQLite cache في data/historical.db
 *   - تقرير مفصّل عن كل رمز تم تحميله
 *
 * الاستخدام:
 *   npm run download-history
 *   npm run download-history -- --symbols EURUSD,GBPUSD --years 2 --tf H1
 * ══════════════════════════════════════════════════════════════════════════
 */
import axios   from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface HistoricalBar {
  time:   number;  // Unix ms
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface DownloadResult {
  symbol:    string;
  timeframe: string;
  bars:      number;
  from:      string;
  to:        string;
  source:    string;
  filePath:  string;
  ok:        boolean;
  error?:    string;
}

// ─── Symbol → source routing ──────────────────────────────────────────────

const BINANCE_SYMBOLS: Record<string, string> = {
  BTCUSDT: 'BTCUSDT', ETHUSDT: 'ETHUSDT', BNBUSDT: 'BNBUSDT',
  SOLUSDT: 'SOLUSDT', XRPUSDT: 'XRPUSDT', ADAUSDT: 'ADAUSDT',
};

const YAHOO_SYMBOLS: Record<string, string> = {
  EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'JPY=X',
  AUDUSD: 'AUDUSD=X', USDCAD: 'CAD=X',    USDCHF: 'CHF=X',
  NZDUSD: 'NZDUSD=X', EURGBP: 'EURGBP=X', EURJPY: 'EURJPY=X',
  GBPJPY: 'GBPJPY=X',
  XAUUSD: 'GC=F',     XAGUSD: 'SI=F',
  US30:   'YM=F',     SPX500: 'ES=F',     NAS100: 'NQ=F',
};

const STOOQ_SYMBOLS: Record<string, string> = {
  EURUSD: 'eurusd', GBPUSD: 'gbpusd', USDJPY: 'usdjpy',
  AUDUSD: 'audusd', USDCAD: 'usdcad', USDCHF: 'usdchf',
};

// ─── Binance timeframe mapping ────────────────────────────────────────────
const BINANCE_TF: Record<string, string> = {
  M1:'1m', M5:'5m', M15:'15m', M30:'30m', H1:'1h', H4:'4h', D1:'1d'
};

// ─── Yahoo Finance interval mapping ──────────────────────────────────────
const YAHOO_TF: Record<string, { interval: string; range: string }> = {
  M1:  { interval: '1m',  range: '7d'  },  // Yahoo only 7 days for M1
  M5:  { interval: '5m',  range: '60d' },
  M15: { interval: '15m', range: '60d' },
  M30: { interval: '30m', range: '60d' },
  H1:  { interval: '1h',  range: '730d' },
  H4:  { interval: '1h',  range: '730d' }, // Yahoo has no 4h — we resample
  D1:  { interval: '1d',  range: '730d' },
};

export class HistoricalDataDownloader {
  private db:      Database.Database | null = null;
  private dataDir: string;

  constructor(private outputDir = './data') {
    this.dataDir = path.join(outputDir, 'historical');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.initDB();
  }

  private initDB(): void {
    const dbPath = path.join(this.outputDir, 'historical.db');
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bars (
        symbol    TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        time      INTEGER NOT NULL,
        open      REAL NOT NULL,
        high      REAL NOT NULL,
        low       REAL NOT NULL,
        close     REAL NOT NULL,
        volume    REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol, timeframe, time)
      );
      CREATE INDEX IF NOT EXISTS idx_bars_symbol_tf_time
        ON bars (symbol, timeframe, time);
    `);
    console.log(`📦 DB: ${dbPath}`);
  }

  // ─── Main download orchestrator ──────────────────────────────────────────

  async download(
    symbols:   string[],
    timeframe: string,
    years:     number,
  ): Promise<DownloadResult[]> {
    const results: DownloadResult[] = [];
    const fromMs   = Date.now() - years * 365 * 24 * 3_600_000;
    const fromDate = new Date(fromMs).toISOString().slice(0, 10);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`HISTORICAL DATA DOWNLOAD — ${timeframe} | ${years} year(s)`);
    console.log(`From: ${fromDate} → Now`);
    console.log(`Symbols: ${symbols.join(', ')}`);
    console.log(`${'═'.repeat(60)}\n`);

    for (const symbol of symbols) {
      process.stdout.write(`  ⏳ ${symbol.padEnd(10)} ${timeframe}... `);
      const result = await this.downloadOne(symbol, timeframe, fromMs);
      results.push(result);

      if (result.ok) {
        console.log(`✅ ${result.bars.toLocaleString()} bars [${result.from} → ${result.to}] via ${result.source}`);
      } else {
        console.log(`❌ ${result.error}`);
      }

      await this.sleep(500); // rate limit
    }

    return results;
  }

  async downloadOne(symbol: string, tf: string, fromMs: number): Promise<DownloadResult> {
    const sym = symbol.toUpperCase();

    // Try sources in order of quality
    let bars: HistoricalBar[] | null = null;
    let source = '';

    // 1. Binance (best for crypto, real OHLCV)
    if (BINANCE_SYMBOLS[sym]) {
      bars   = await this.fetchBinance(BINANCE_SYMBOLS[sym], tf, fromMs);
      source = 'Binance';
    }

    // 2. Yahoo Finance (forex, metals, indices)
    if (!bars?.length && YAHOO_SYMBOLS[sym]) {
      bars   = await this.fetchYahoo(YAHOO_SYMBOLS[sym], tf, fromMs);
      source = 'Yahoo Finance';
    }

    // 3. Stooq (forex backup)
    if (!bars?.length && STOOQ_SYMBOLS[sym]) {
      bars   = await this.fetchStooq(STOOQ_SYMBOLS[sym.toLowerCase()], tf, fromMs);
      source = 'Stooq';
    }

    if (!bars || bars.length < 10) {
      return { symbol: sym, timeframe: tf, bars: 0, from: '', to: '', source: '', filePath: '', ok: false, error: 'No data from any source' };
    }

    // Filter to requested time range and sort
    bars = bars
      .filter(b => b.time >= fromMs)
      .sort((a, b) => a.time - b.time);

    if (bars.length < 10) {
      return { symbol: sym, timeframe: tf, bars: 0, from: '', to: '', source, filePath: '', ok: false, error: `Only ${bars.length} bars after filtering` };
    }

    // Save to CSV and DB
    const filePath = await this.saveBars(sym, tf, bars);
    this.saveToDb(sym, tf, bars);

    return {
      symbol: sym, timeframe: tf,
      bars:   bars.length,
      from:   new Date(bars[0].time).toISOString().slice(0, 10),
      to:     new Date(bars[bars.length - 1].time).toISOString().slice(0, 10),
      source, filePath, ok: true,
    };
  }

  // ─── Binance ─────────────────────────────────────────────────────────────

  private async fetchBinance(symbol: string, tf: string, fromMs: number): Promise<HistoricalBar[]> {
    const interval = BINANCE_TF[tf];
    if (!interval) return [];

    const allBars: HistoricalBar[] = [];
    let startTime = fromMs;
    const limit   = 1000; // Binance max per request

    while (startTime < Date.now()) {
      try {
        const res = await axios.get('https://api.binance.com/api/v3/klines', {
          params: { symbol, interval, startTime, limit },
          timeout: 10_000,
        });

        if (!res.data?.length) break;

        const batch: HistoricalBar[] = res.data.map((k: any[]) => ({
          time:   k[0],
          open:   parseFloat(k[1]),
          high:   parseFloat(k[2]),
          low:    parseFloat(k[3]),
          close:  parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));

        allBars.push(...batch);
        const lastTime = batch[batch.length - 1].time;
        if (batch.length < limit) break; // got all available
        startTime = lastTime + 1;

        await this.sleep(100); // rate limit
      } catch (e: any) {
        console.error(`    Binance error: ${e.message}`);
        break;
      }
    }

    return allBars;
  }

  // ─── Yahoo Finance ────────────────────────────────────────────────────────

  private async fetchYahoo(ticker: string, tf: string, fromMs: number): Promise<HistoricalBar[]> {
    const cfg = YAHOO_TF[tf];
    if (!cfg) return [];

    const fromSec = Math.floor(fromMs / 1000);
    const toSec   = Math.floor(Date.now() / 1000);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;
      const res = await axios.get(url, {
        params: { period1: fromSec, period2: toSec, interval: cfg.interval },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15_000,
      });

      const result  = res.data?.chart?.result?.[0];
      if (!result) return [];

      const timestamps = result.timestamp as number[];
      const quote      = result.indicators?.quote?.[0];
      if (!timestamps || !quote) return [];

      const bars: HistoricalBar[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (!quote.open?.[i] || !quote.close?.[i]) continue;
        bars.push({
          time:   timestamps[i] * 1000,
          open:   quote.open[i],
          high:   quote.high?.[i]   ?? quote.close[i],
          low:    quote.low?.[i]    ?? quote.close[i],
          close:  quote.close[i],
          volume: quote.volume?.[i] ?? 0,
        });
      }

      // If H4 requested, resample from H1
      if (tf === 'H4' && bars.length > 0) {
        return this.resampleToH4(bars);
      }

      return bars;
    } catch (e: any) {
      return [];
    }
  }

  // ─── Stooq ───────────────────────────────────────────────────────────────

  private async fetchStooq(symbol: string, tf: string, fromMs: number): Promise<HistoricalBar[]> {
    // Stooq only provides daily data reliably
    if (tf !== 'D1' && tf !== 'H1') return [];

    const from = new Date(fromMs).toISOString().slice(0, 10).replace(/-/g, '');
    const to   = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    try {
      const url = `https://stooq.com/q/d/l/?s=${symbol}&d1=${from}&d2=${to}&i=d`;
      const res = await axios.get(url, { timeout: 10_000 });

      const lines = res.data.split('\n').filter((l: string) => l.trim() && !l.startsWith('Date'));
      const bars: HistoricalBar[] = [];

      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 5) continue;
        const [date, open, high, low, close, volume] = parts;
        bars.push({
          time:   new Date(date.trim()).getTime(),
          open:   parseFloat(open),
          high:   parseFloat(high),
          low:    parseFloat(low),
          close:  parseFloat(close),
          volume: parseFloat(volume || '0'),
        });
      }

      return bars;
    } catch { return []; }
  }

  // ─── Resample H1 → H4 ────────────────────────────────────────────────────

  private resampleToH4(h1Bars: HistoricalBar[]): HistoricalBar[] {
    const h4: HistoricalBar[] = [];
    let current: HistoricalBar | null = null;
    let count = 0;

    for (const bar of h1Bars) {
      const h  = new Date(bar.time).getUTCHours();
      const is4hStart = h % 4 === 0;

      if (is4hStart || !current) {
        if (current) h4.push(current);
        current = { ...bar };
        count   = 1;
      } else {
        current.high   = Math.max(current.high, bar.high);
        current.low    = Math.min(current.low, bar.low);
        current.close  = bar.close;
        current.volume += bar.volume;
        count++;
      }
    }
    if (current) h4.push(current);
    return h4;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private async saveBars(symbol: string, tf: string, bars: HistoricalBar[]): Promise<string> {
    const fileName = `${symbol}_${tf}.csv`;
    const filePath = path.join(this.dataDir, fileName);

    const csv = ['time,open,high,low,close,volume',
      ...bars.map(b => `${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`)
    ].join('\n');

    fs.writeFileSync(filePath, csv, 'utf8');
    return filePath;
  }

  private saveToDb(symbol: string, tf: string, bars: HistoricalBar[]): void {
    if (!this.db) return;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO bars (symbol, timeframe, time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = this.db.transaction((bs: HistoricalBar[]) => {
      for (const b of bs) insert.run(symbol, tf, b.time, b.open, b.high, b.low, b.close, b.volume);
    });
    insertAll(bars);
  }

  // ─── Read from cache ──────────────────────────────────────────────────────

  loadBars(symbol: string, tf: string, fromMs?: number): HistoricalBar[] {
    if (!this.db) return [];
    const sql = fromMs
      ? `SELECT * FROM bars WHERE symbol=? AND timeframe=? AND time>=? ORDER BY time`
      : `SELECT * FROM bars WHERE symbol=? AND timeframe=? ORDER BY time`;
    const args = fromMs ? [symbol, tf, fromMs] : [symbol, tf];
    return this.db.prepare(sql).all(...args) as HistoricalBar[];
  }

  getAvailableData(): Array<{ symbol: string; tf: string; count: number; from: string; to: string }> {
    if (!this.db) return [];
    return (this.db.prepare(`
      SELECT symbol, timeframe tf,
             COUNT(*) count,
             datetime(MIN(time)/1000, 'unixepoch') "from",
             datetime(MAX(time)/1000, 'unixepoch') "to"
      FROM bars GROUP BY symbol, timeframe ORDER BY symbol, timeframe
    `).all()) as any[];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

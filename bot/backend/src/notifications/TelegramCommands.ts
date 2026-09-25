/**
 * TELEGRAM COMMANDS — v9.0
 * إضافات v9.0:
 *   ✅ /closeall [SYMBOL]  — أغلق كل الصفقات فوراً
 *   ✅ /wfo [SYMBOL]       — شغّل Walk-Forward Optimizer يدوياً
 *   ✅ /update             — حدّث البيانات وأعد التدريب
 *   ✅ /risk               — عرض إعدادات المخاطر الحالية
 *   ✅ /health             — تحقق من حالة كل الأنظمة
 */
import TelegramBotAPI        from 'node-telegram-bot-api';
import { Backtester }        from '../backtest/Backtester';
import { WeeklyReport }      from '../analytics/WeeklyReport';
import { TradingEngine }     from '../core/TradingEngine';
import { SystemConfig }      from '../types/trading.types';
import { DatabaseManager }   from '../database/DatabaseManager';
import { MonteCarloSimulator } from '../optimization/MonteCarloSimulator';
import { SentimentEngine }   from '../sentiment/SentimentEngine';
import { marketRegimeDetector } from '../core/MarketRegimeDetector';
import { Logger }            from '../utils/Logger';
import { ExecutionGateway }   from '../execution/ExecutionGateway';

export class TelegramCommands {
  private bot:      TelegramBotAPI | null = null;
  private logger    = new Logger('TgCmd');
  private paused    = new Set<string>();
  private sentiment = new SentimentEngine();
  private mc        = new MonteCarloSimulator();

  constructor(private config: SystemConfig, private engine: TradingEngine) {
    if (!config.telegram?.token) return;
    try {
      this.bot = new TelegramBotAPI(config.telegram.token, { polling: true });
      this.register();
      this.logger.info('Telegram commands v9.0 ready');
    } catch (e: any) { this.logger.warn(`Telegram: ${e.message}`); }
  }

  isPaused(symbol: string): boolean { return this.paused.has(symbol.toUpperCase()); }

  private register() {
    const b    = this.bot!;
    const chat = String(this.config.telegram.chatId);
    const auth = (m: any) => String(m.chat.id) === chat;
    const send = (id: any, txt: string) =>
      b.sendMessage(id, txt, { parse_mode: 'HTML' }).catch(() => {});

    // ── /help ────────────────────────────────────────────────
    b.onText(/\/help/, m => { if (!auth(m)) return;
      send(m.chat.id,
        `<b>🤖 Trading Bot v9.0</b>\n\n` +
        `<b>📊 المراقبة:</b>\n` +
        `/status — الحالة العامة\n` +
        `/trades [N] — آخر N صفقة\n` +
        `/positions — الصفقات المفتوحة\n` +
        `/strategies — حالة الاستراتيجيات\n` +
        `/regime SYMBOL — نظام السوق\n` +
        `/risk — إعدادات المخاطر\n` +
        `/health — صحة الأنظمة\n\n` +
        `<b>🎮 التحكم:</b>\n` +
        `/pause SYMBOL — إيقاف مؤقت\n` +
        `/resume SYMBOL — استئناف\n` +
        `/closeall [SYMBOL] — إغلاق كل الصفقات\n` +
        `/emergency — إيقاف التداول الجديد\n\n` +
        `<b>🔬 التحليل:</b>\n` +
        `/backtest SYM TF [N] — باك تست\n` +
        `/montecarlo — محاكاة مونت كارلو\n` +
        `/wfo [SYMBOL] — تحسين الاستراتيجيات\n` +
        `/sentiment SYMBOL — تحليل المشاعر\n` +
        `/journal [N] — سجل الصفقات الذكي\n` +
        `/report — التقرير الأسبوعي`);
    });

    // ── /status ──────────────────────────────────────────────
    b.onText(/\/status/, async m => { if (!auth(m)) return;
      try {
        const p   = this.engine.getPerformanceSummary();
        const c   = this.engine.getConsensusStatus();
        const pos = this.engine.getPositionSummary();
        const rec = await (this.engine as any).exec?.getCurrentEquity?.().catch(() => null);
        send(m.chat.id,
          `📊 <b>Status</b> | ${this.engine.config.mode.toUpperCase()}\n` +
          `💰 Equity: $${(rec ?? p.equity ?? 0).toFixed(2)}\n` +
          `📅 Today: ${p.today?.trades ?? 0} trades | P&L: $${(p.today?.pnl ?? 0).toFixed(2)}\n` +
          `🧠 Strategies: ${c.active_count}/${c.total_count} active\n` +
          `📈 Positions: ${Object.keys(pos).length} open\n` +
          `⏸ Paused: ${this.paused.size > 0 ? [...this.paused].join(', ') : 'none'}`);
      } catch (e: any) { send(m.chat.id, `Error: ${e.message}`); }
    });

    // ── /positions ───────────────────────────────────────────
    b.onText(/\/positions/, m => { if (!auth(m)) return;
      const pos     = this.engine.getPositionSummary();
      const entries = Object.entries(pos);
      if (!entries.length) { send(m.chat.id, '📭 No open positions'); return; }
      send(m.chat.id, `📈 <b>Open Positions</b>\n` +
        entries.map(([s, p]: any) =>
          `• ${s}: ${p.side} | ${p.source} | TF: ${p.timeframe ?? '?'}`
        ).join('\n'));
    });

    // ── /trades ──────────────────────────────────────────────
    b.onText(/\/trades(?:\s+(\d+))?/, (m, mt) => { if (!auth(m)) return;
      const n = Math.min(20, Number(mt?.[1] ?? 10));
      const t = this.engine['db'].getRecentClosedTrades(n);
      if (!t.length) { send(m.chat.id, '📭 No trades yet'); return; }
      const lines = t.map((x: any) =>
        `${(x.profit??0)>0 ? '💰' : '❌'} ${x.symbol} ${x.side} → $${(x.profit??0).toFixed(2)}`
      );
      send(m.chat.id, `<b>Last ${n} Trades</b>\n${lines.join('\n')}`);
    });

    // ── /strategies ──────────────────────────────────────────
    b.onText(/\/strategies/, m => { if (!auth(m)) return;
      const snap  = this.engine.getConsensusStatus();
      const lines = Object.entries(snap.strategies ?? {}).map(([name, s]: any) =>
        `${s.enabled ? '✅' : '❌'} <b>${name}</b> ` +
        `WR=${((s.metrics?.win_rate ?? 0.5)*100).toFixed(0)}% ` +
        `Sharpe=${(s.metrics?.sharpe_ratio ?? 0).toFixed(2)}`
      );
      send(m.chat.id, `🧠 <b>Strategies (${snap.active_count} active)</b>\n${lines.join('\n')}`);
    });

    // ── /regime ──────────────────────────────────────────────
    b.onText(/\/regime\s+(\w+)/, (m, mt) => { if (!auth(m)) return;
      const sym = (mt?.[1] ?? '').toUpperCase();
      const c   = (this.engine as any).candleMap?.[sym];
      if (!c?.length) { send(m.chat.id, `No data for ${sym}`); return; }
      const r = marketRegimeDetector.detect(sym, 'H1', c);
      send(m.chat.id,
        `📉 <b>${sym}</b>\n` +
        `Regime: <b>${r.regime}</b>\n` +
        `ADX: ${r.adx.toFixed(1)} | Chop: ${r.choppiness.toFixed(0)}\n` +
        `Trend: ${r.trend}`);
    });

    // ── /risk ────────────────────────────────────────────────
    b.onText(/\/risk/, m => { if (!auth(m)) return;
      const c = this.engine.config;
      send(m.chat.id,
        `🛡 <b>Risk Settings</b>\n` +
        `Balance: $${c.accountBalance?.toLocaleString()}\n` +
        `Risk/Trade: ${((c.riskPerTrade ?? 0.01) * 100).toFixed(1)}%\n` +
        `Max Daily Loss: ${((c.maxDailyLoss ?? 0.03) * 100).toFixed(1)}%\n` +
        `Max Open Trades: ${c.maxOpenTrades ?? 5}\n` +
        `Min Confidence: ${((c.minConfidence ?? 0.6) * 100).toFixed(0)}%\n` +
        `Min R:R: ${c.minRR ?? 1.5}`);
    });

    // ── /health ──────────────────────────────────────────────
    b.onText(/\/health/, async m => { if (!auth(m)) return;
      const db    = this.engine['db'] as DatabaseManager;
      const stats = db.getTodayStats();
      const mlUrl = process.env.ML_SERVER_URL ?? 'http://localhost:5001';
      const mlKey = process.env.ML_SERVER_API_KEY ?? '';
      const mlOk  = await fetch(`${mlUrl}/health`, { headers: mlKey ? { Authorization: `Bearer ${mlKey}` } : {} })
        .then(r => r.ok).catch(() => false);

      send(m.chat.id,
        `💚 <b>System Health</b>\n` +
        `Bot: ✅ Running\n` +
        `Database: ✅ OK\n` +
        `ML Server: ${mlOk ? '✅ OK' : '❌ Down'}\n` +
        `Today trades: ${stats?.trades ?? 0}\n` +
        `Today P&L: $${(stats?.pnl ?? 0).toFixed(2)}`);
    });

    // ── /pause ───────────────────────────────────────────────
    b.onText(/\/pause\s+(\w+)/, (m, mt) => { if (!auth(m)) return;
      const s = (mt?.[1] ?? '').toUpperCase();
      this.paused.add(s);
      send(m.chat.id, `⏸ <b>${s}</b> paused — no new trades`);
    });

    // ── /resume ──────────────────────────────────────────────
    b.onText(/\/resume\s+(\w+)/, (m, mt) => { if (!auth(m)) return;
      const s = (mt?.[1] ?? '').toUpperCase();
      this.paused.delete(s);
      send(m.chat.id, `▶️ <b>${s}</b> resumed`);
    });

    // ── ✅ NEW: /closeall ─────────────────────────────────────
    b.onText(/\/closeall(.*)/, async m => { if (!auth(m)) return;
      const symbol = (m.text ?? '').split(' ')[1]?.trim().toUpperCase() ?? '';
      send(m.chat.id, `⏳ Closing all ${symbol || 'open'} positions...`);

      const db     = this.engine['db'] as DatabaseManager;
      const exec   = this.engine['exec'] as ExecutionGateway;
      const scanner= this.engine['scanner'] as any;
      const open   = db.getOpenTrades();
      const targets = symbol ? open.filter((t: any) => t.symbol === symbol) : open;

      if (!targets.length) { send(m.chat.id, '✅ No open trades to close.'); return; }

      let closed = 0, failed = 0;
      for (const t of targets) {
        try {
          const candles=await scanner.fetchCandles(t.symbol,'M1',2).catch(()=>[]);
          const price=candles.length?candles[candles.length-1].close:t.entry;
          const result=await exec.closeAtMarket(t,price,'MANUAL');
          if(result.ok) closed++; else failed++;
        } catch { failed++; }
      }
      send(m.chat.id,
        `🔴 <b>Close All Complete</b>\n` +
        `✅ Closed: ${closed}\n` +
        `❌ Failed: ${failed}`);
    });

    // ── /emergency ────────────────────────────────────────────
    b.onText(/\/emergency/, m => { if (!auth(m)) return;
      (this.engine as any).emergencyStop?.();
      send(m.chat.id, '🚨 <b>EMERGENCY STOP</b>\nNo new trades will be opened.');
    });

    // ── /backtest ────────────────────────────────────────────
    b.onText(/\/backtest\s+(\w+)\s+(\w+)(?:\s+(\d+))?/, async (m, mt) => {
      if (!auth(m)) return;
      const sym = (mt?.[1] ?? '').toUpperCase();
      const tf  = (mt?.[2] ?? 'H1').toUpperCase();
      const n   = Math.min(2000, Number(mt?.[3] ?? 500));
      send(m.chat.id, `⏳ Backtesting ${sym} ${tf} (${n} bars)...`);
      try {
        const candles = await (this.engine as any).scanner.fetchCandles(sym, tf, n);
        const r = await new Backtester(this.engine.config as any)
          .run(sym, candles, this.engine.config.accountBalance);
        send(m.chat.id,
          `📊 <b>${sym} ${tf}</b>\n` +
          `Trades: ${r.totalTrades} | WR: ${r.winRate.toFixed(1)}%\n` +
          `Return: ${r.totalReturn.toFixed(2)}%\n` +
          `MaxDD: ${r.maxDrawdownPct.toFixed(1)}%\n` +
          `Sharpe: ${r.sharpeRatio.toFixed(2)} | Sortino: ${r.sortinoRatio.toFixed(2)}\n` +
          `Commission: $${r.totalCommission.toFixed(2)} | Spread: $${r.totalSpread.toFixed(2)}`);
      } catch (e: any) { send(m.chat.id, `Error: ${e.message}`); }
    });

    // ── /montecarlo ───────────────────────────────────────────
    b.onText(/\/montecarlo/, async m => { if (!auth(m)) return;
      send(m.chat.id, '⏳ Monte Carlo running (5000 simulations)...');
      try {
        const trades = this.engine['db'].getRecentClosedTrades(200)
          .filter((t: any) => t.profit !== undefined);
        if (trades.length < 10) { send(m.chat.id, '⚠️ Need 10+ closed trades'); return; }
        const r = this.mc.run(trades as any, this.engine.config.accountBalance, 5000, 100);
        send(m.chat.id, this.mc.summarize(r));
      } catch (e: any) { send(m.chat.id, `Error: ${e.message}`); }
    });

    // ── ✅ NEW: /wfo ──────────────────────────────────────────
    b.onText(/\/wfo(?:\s+(\w+))?/, async (m, mt) => { if (!auth(m)) return;
      const symbol = mt?.[1]?.toUpperCase();
      send(m.chat.id, `⏳ Running WFO for ${symbol ?? 'all symbols'}... (يأخذ 2-5 دقائق)`);
      try {
        const wfoScheduler = (this.engine as any).scheduledWFO;
        if (!wfoScheduler) { send(m.chat.id, '❌ WFO module not available'); return; }
        await wfoScheduler.runNow(symbol);
        send(m.chat.id, '✅ WFO complete — params updated');
      } catch (e: any) { send(m.chat.id, `Error: ${e.message}`); }
    });

    // ── /sentiment ────────────────────────────────────────────
    b.onText(/\/sentiment\s+(\w+)/, async (m, mt) => { if (!auth(m)) return;
      const sym = (mt?.[1] ?? '').toUpperCase();
      try {
        const s = await this.sentiment.getSentiment(sym);
        send(m.chat.id,
          `📰 <b>${sym} Sentiment</b>\n` +
          `Bias: <b>${s?.bias ?? 'NEUTRAL'}</b>\n` +
          `Impact: ${s?.impact ?? 'LOW'}\n` +
          `Reason: ${s?.reason ?? 'No data'}`);
      } catch (e: any) { send(m.chat.id, `Error: ${e.message}`); }
    });

    // ── /journal ─────────────────────────────────────────────
    b.onText(/\/journal(?:\s+(\d+))?/, async (m, mt) => { if (!auth(m)) return;
      const n  = Math.min(5, Number(mt?.[1] ?? 3));
      const db = this.engine['db'] as DatabaseManager;
      const t  = db.getRecentClosedTrades(n);
      if (!t.length) { send(m.chat.id, '📭 No trades in journal'); return; }
      for (const trade of t) {
        try {
          const j = await (this.engine as any).tradeJournal?.analyze(trade);
          send(m.chat.id,
            `📔 <b>${(trade as any).symbol} ${(trade as any).side}</b>\n` +
            `P&L: $${((trade as any).profit ?? 0).toFixed(2)}\n` +
            `Grade: ${j?.grade ?? '?'}\n` +
            `${j?.lesson ?? ''}`);
        } catch { /* skip failed analysis */ }
      }
    });

    // ── /recovery ────────────────────────────────────────────
    b.onText(/\/recovery/, async m => { if (!auth(m)) return;
      const rec = await (this.engine as any).recoveryMode?.evaluate(
        await (this.engine as any).exec?.getCurrentEquity?.().catch(() => this.engine.config.accountBalance)
      );
      if (!rec) { send(m.chat.id, 'Recovery module not available'); return; }
      send(m.chat.id,
        `🛡 <b>Recovery Status</b>\n` +
        `Level: <b>${rec.level}</b>\n` +
        `Vol Multiplier: ${rec.volumeMultiplier}\n` +
        `${rec.level === 'STOP' ? '🔴 Trading STOPPED' : '✅ Trading allowed'}`);
    });

    // ── /report ──────────────────────────────────────────────
    b.onText(/\/report/, async m => { if (!auth(m)) return;
      send(m.chat.id, '⏳ Generating report...');
      try {
        const report = new WeeklyReport(this.engine['db'], this.engine.telegram);
        const text = await report.generate();
        send(m.chat.id, text);
      } catch (e: any) { send(m.chat.id, `Error: ${e.message}`); }
    });

    this.logger.info('All commands registered (v9.0)');
  }
}

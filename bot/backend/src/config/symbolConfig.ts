/**
 * SYMBOL CONFIG — v7.1
 * [FIX] أضاف pipValue و lotSize المطلوبَين من PositionSizer للـ hard cap
 * [NEW] أضاف أزواج EURxxx/GBPxxx المفقودة
 * [NEW] envOverride يدعم pipValue و lotSize أيضاً
 */
export interface SymbolSpec {
  pip:           number;
  contractSize:  number;
  minVolume:     number;
  maxVolume:     number;
  volumeStep:    number;
  spreadMaxPips: number;
  atrMult:       number;
  tpRatio:       number;
  pipValue:      number;   // [FIX] USD value per pip per 1 standard lot
  lotSize:       number;   // [FIX] alias for contractSize (for PositionSizer)
}

const DEFAULTS: SymbolSpec = {
  pip: 0.0001, contractSize: 100_000, minVolume: 0.01,
  maxVolume: 100, volumeStep: 0.01, spreadMaxPips: 3,
  atrMult: 1.5, tpRatio: 2,
  pipValue: 10,       // $10 per pip per standard lot (forex default)
  lotSize: 100_000,   // = contractSize
};

const MAP: Record<string, Partial<SymbolSpec>> = {
  // ── Major Forex ──────────────────────────────────────────────────────────
  EURUSD: { spreadMaxPips: 1.5, pipValue: 10 },
  GBPUSD: { spreadMaxPips: 2.5, pipValue: 10 },
  AUDUSD: { spreadMaxPips: 2.0, pipValue: 10 },
  NZDUSD: { spreadMaxPips: 3.0, pipValue: 10 },
  USDCAD: { spreadMaxPips: 2.5, pipValue: 10 },
  USDCHF: { spreadMaxPips: 2.5, pipValue: 10 },
  USDJPY: { pip: 0.01, spreadMaxPips: 1.5, pipValue: 9.2, lotSize: 100_000 },

  // ── Cross Pairs ──────────────────────────────────────────────────────────
  EURGBP: { spreadMaxPips: 2.0, pipValue: 13 },
  EURJPY: { pip: 0.01, spreadMaxPips: 2.0, pipValue: 7.1 },
  GBPJPY: { pip: 0.01, spreadMaxPips: 3.0, pipValue: 7.1 },
  AUDJPY: { pip: 0.01, spreadMaxPips: 2.5, pipValue: 7.1 },
  CADJPY: { pip: 0.01, spreadMaxPips: 2.5, pipValue: 7.1 },
  CHFJPY: { pip: 0.01, spreadMaxPips: 2.5, pipValue: 7.1 },
  EURCHF: { spreadMaxPips: 3.0, pipValue: 11 },
  EURCAD: { spreadMaxPips: 3.5, pipValue: 7.4 },
  GBPAUD: { spreadMaxPips: 4.0, pipValue: 6.5 },
  GBPCAD: { spreadMaxPips: 4.0, pipValue: 7.4 },
  GBPCHF: { spreadMaxPips: 3.5, pipValue: 11 },
  AUDCAD: { spreadMaxPips: 3.5, pipValue: 7.4 },
  AUDCHF: { spreadMaxPips: 3.5, pipValue: 11 },
  AUDNZD: { spreadMaxPips: 4.5, pipValue: 6.2 },
  NZDJPY: { pip: 0.01, spreadMaxPips: 3.0, pipValue: 7.1 },
  NZDCAD: { spreadMaxPips: 4.0, pipValue: 7.4 },

  // ── Metals ───────────────────────────────────────────────────────────────
  XAUUSD: {
    pip: 0.1, contractSize: 100, spreadMaxPips: 35,
    atrMult: 2.0, tpRatio: 2.5, minVolume: 0.01, maxVolume: 50,
    pipValue: 10, lotSize: 100,
  },
  XAGUSD: {
    pip: 0.01, contractSize: 5_000, spreadMaxPips: 5,
    atrMult: 2.0, tpRatio: 2.0, pipValue: 50, lotSize: 5_000,
  },

  // ── Crypto ───────────────────────────────────────────────────────────────
  BTCUSDT: {
    pip: 1, contractSize: 1, minVolume: 0.001, maxVolume: 10,
    volumeStep: 0.001, spreadMaxPips: 100, atrMult: 2.5, tpRatio: 2.5,
    pipValue: 1, lotSize: 1,
  },
  ETHUSDT: {
    pip: 0.1, contractSize: 1, minVolume: 0.01, maxVolume: 100,
    volumeStep: 0.01, spreadMaxPips: 50, atrMult: 2.0, tpRatio: 2.0,
    pipValue: 1, lotSize: 1,
  },
  BNBUSDT: {
    pip: 0.01, contractSize: 1, minVolume: 0.01, maxVolume: 200,
    volumeStep: 0.01, spreadMaxPips: 30, atrMult: 2.0, tpRatio: 2.0,
    pipValue: 1, lotSize: 1,
  },
  SOLUSDT: {
    pip: 0.01, contractSize: 1, minVolume: 0.1, maxVolume: 1000,
    volumeStep: 0.1, spreadMaxPips: 30, atrMult: 2.0, tpRatio: 2.0,
    pipValue: 1, lotSize: 1,
  },
  XRPUSDT: {
    pip: 0.0001, contractSize: 1, minVolume: 1, maxVolume: 100_000,
    volumeStep: 1, spreadMaxPips: 10, atrMult: 2.0, tpRatio: 2.0,
    pipValue: 1, lotSize: 1,
  },

  // ── Indices ──────────────────────────────────────────────────────────────
  US30:   { pip: 1, contractSize: 1, spreadMaxPips: 3, atrMult: 2.0, tpRatio: 2.5, pipValue: 1, lotSize: 1 },
  SPX500: { pip: 0.25, contractSize: 1, spreadMaxPips: 1, atrMult: 2.0, tpRatio: 2.5, pipValue: 1, lotSize: 1 },
  NAS100: { pip: 1, contractSize: 1, spreadMaxPips: 3, atrMult: 2.0, tpRatio: 2.5, pipValue: 1, lotSize: 1 },
  GER40:  { pip: 1, contractSize: 1, spreadMaxPips: 3, atrMult: 2.0, tpRatio: 2.5, pipValue: 1, lotSize: 1 },
};

function envOverride(symbol: string): Partial<SymbolSpec> {
  const o: Partial<SymbolSpec> = {};
  const get = (k: string) => process.env[`SPEC_${symbol}_${k}`];
  if (get('SPREAD_MAX_PIPS')) o.spreadMaxPips = Number(get('SPREAD_MAX_PIPS'));
  if (get('ATR_MULT'))        o.atrMult       = Number(get('ATR_MULT'));
  if (get('TP_RATIO'))        o.tpRatio       = Number(get('TP_RATIO'));
  if (get('MIN_VOLUME'))      o.minVolume     = Number(get('MIN_VOLUME'));
  if (get('PIP_VALUE'))       o.pipValue      = Number(get('PIP_VALUE'));
  if (get('LOT_SIZE'))        o.lotSize       = Number(get('LOT_SIZE'));
  return o;
}

export function getBaseSymbolSpec(symbol: string): SymbolSpec {
  const base = { ...DEFAULTS, ...(MAP[symbol.toUpperCase()] ?? {}) };
  if (!base.lotSize) base.lotSize = base.contractSize;
  return base;
}

export function getSymbolSpec(symbol: string): SymbolSpec {
  const base = getBaseSymbolSpec(symbol);
  return { ...base, ...envOverride(symbol.toUpperCase()) };
}

import { getSymbolSpec } from '../config/symbolConfig';

export class SpreadFilter {
  /** Returns true if spread is acceptable. */
  check(symbol: string, bid: number, ask: number): { ok: boolean; spreadPips: number } {
    const spec = getSymbolSpec(symbol);
    const spreadPips = Math.abs(ask - bid) / spec.pip;
    return { ok: spreadPips <= spec.spreadMaxPips, spreadPips };
  }
}

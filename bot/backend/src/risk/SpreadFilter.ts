import { getMarketDefinition } from '../market/MarketCatalog';
import { getSymbolSpec } from '../config/symbolConfig';


export class SpreadFilter {
  /** Returns true if spread is acceptable. */
  check(symbol: string, bid: number, ask: number): { ok: boolean; spreadPips: number } {
    const market = getMarketDefinition(symbol);
    if (!market || !(market.economics.priceIncrement > 0)) {
      return { ok: false, spreadPips: Infinity };
    }

    // Spread threshold remains a strategy/config policy, but the pip/point
    // conversion is always broker/canonical-market aware.
    const policySymbol = market.symbol;
    const policy = getSymbolSpec(policySymbol);
    const spreadPips = Math.abs(ask - bid) / market.economics.priceIncrement;
    return { ok: spreadPips <= policy.spreadMaxPips, spreadPips };
  }
}

import { getBrokerMarketDefinition, getMarketDefinition } from '../market/MarketCatalog';
import { getSymbolSpec, hasExplicitSpreadPolicy } from '../config/symbolConfig';
import { Timeframe } from '../market/market.types';


export class SpreadFilter {
  /** Returns true if spread is acceptable. */
  check(
    symbol: string,
    bid: number,
    ask: number,
    timeframe: Timeframe = 'H1',
    requireBrokerContract = false,
  ): { ok: boolean; spreadPips: number } {
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      !(bid > 0) ||
      !(ask > 0) ||
      ask < bid
    ) {
      return { ok: false, spreadPips: Infinity };
    }

    const market = requireBrokerContract
      ? getBrokerMarketDefinition(symbol, timeframe)
      : getMarketDefinition(symbol, timeframe);
    if (!market || !(market.economics.priceIncrement > 0)) {
      return { ok: false, spreadPips: Infinity };
    }

    // Spread threshold remains a strategy/config policy, but the pip/point
    // conversion is always broker/canonical-market aware.
    const policySymbol = market.symbol;
    if (!hasExplicitSpreadPolicy(policySymbol, timeframe)) {
      return { ok: false, spreadPips: Infinity };
    }
    const policy = getSymbolSpec(policySymbol, timeframe);
    const unit = market.economics.pipSize ?? market.economics.priceIncrement;
    if (!(unit > 0) || !Number.isFinite(unit)) {
      return { ok: false, spreadPips: Infinity };
    }
    const spreadPips = Math.abs(ask - bid) / unit;
    return { ok: spreadPips <= policy.spreadMaxPips, spreadPips };
  }
}

/**
 * MARKET ECONOMICS — account-currency neutral calculations.
 *
 * All outputs are deterministic. Conversion rates are explicit inputs so live
 * risk never silently assumes that every quote currency is USD.
 */

export interface CurrencyConversion {
  /** quote-currency units -> account-currency units. */
  quoteToAccount: number;
}

export interface MarketExposureInput {
  price: number;
  volume: number;
  contractSize: number;
}

export interface StopRiskInput extends MarketExposureInput {
  stopDistance: number;
}

export interface MarginInput {
  exposureInAccountCurrency: number;
  leverage: number;
}

function finitePositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[MarketEconomics] ${name} must be finite and > 0`);
  }
  return value;
}

/** Gross position notional in the quote currency. */
export function calculateNotionalInQuote(input: MarketExposureInput): number {
  const price = finitePositive('price', input.price);
  const volume = finitePositive('volume', input.volume);
  const contractSize = finitePositive('contractSize', input.contractSize);
  return price * volume * contractSize;
}

/**
 * Converts quote-currency notional into account currency using an explicit
 * conversion factor. If quote == account currency, pass 1.
 */
export function calculateExposureInAccount(
  input: MarketExposureInput & CurrencyConversion,
): number {
  const notional = calculateNotionalInQuote(input);
  const quoteToAccount = finitePositive('quoteToAccount', input.quoteToAccount);
  return notional * quoteToAccount;
}

/**
 * Risk at the protective stop in account currency.
 *
 * Example:
 *   EURGBP 1 lot, 10 pip-equivalent stop, GBPUSD 1.25
 *   => quote-currency stop loss × GBPUSD conversion.
 */
export function calculateStopRiskInAccount(
  input: StopRiskInput & CurrencyConversion,
): number {
  const stopDistance = finitePositive('stopDistance', input.stopDistance);
  const volume = finitePositive('volume', input.volume);
  const contractSize = finitePositive('contractSize', input.contractSize);
  const quoteToAccount = finitePositive('quoteToAccount', input.quoteToAccount);
  return stopDistance * volume * contractSize * quoteToAccount;
}

export function calculateRequiredMargin(
  input: MarginInput,
): number {
  const exposure = finitePositive(
    'exposureInAccountCurrency',
    input.exposureInAccountCurrency,
  );
  const leverage = finitePositive('leverage', input.leverage);
  return exposure / leverage;
}

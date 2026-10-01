/**
 * BROKER-CONFIRMED CONTRACT REGISTRY
 *
 * External contract economics must carry provenance and be fully validated
 * before they can be consumed by the market/risk layers.
 *
 * No default Oil/CFD assumptions live here.
 */
import {
  AssetClass,
  ContractType,
  MarketDefinition,
  MarketVenue,
  MarginModel,
  Timeframe,
} from './market.types';

export interface BrokerContractDefinition {
  symbol: string;
  baseAsset: string;
  quoteCurrency: string;
  assetClass: AssetClass;
  contractType: ContractType;
  venue: MarketVenue;
  contractSize: number;
  priceIncrement: number;
  pipSize?: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  marginModel: MarginModel;
  tickSize?: number;
  tickValue?: number;
  tickValueLoss?: number;
  tickValueProfit?: number;
  volumeLimit?: number;
  tradeMode?: number;
  tradeExecutionMode?: number;
  stopsLevel?: number;
  freezeLevel?: number;
  marginInitial?: number;
  marginMaintenance?: number;
  leverage?: number;
  quoteCurrencyPerAccountCurrency?: number;
  source: string;
  observedAt: number;
  expiresAt?: number;
  verified: boolean;
  supportedTimeframes?: Timeframe[];
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[ContractRegistry] ${name} must be finite and > 0`);
  }
}

export function validateBrokerContract(
  definition: BrokerContractDefinition,
  now = Date.now(),
): string[] {
  const errors: string[] = [];

  if (!definition.symbol?.trim()) errors.push('symbol required');
  if (!definition.baseAsset?.trim()) errors.push('baseAsset required');
  if (!definition.quoteCurrency?.trim()) errors.push('quoteCurrency required');
  if (!definition.source?.trim()) errors.push('source required');
  if (!Number.isFinite(definition.observedAt) || definition.observedAt <= 0) {
    errors.push('observedAt must be a positive timestamp');
  }

  const numeric: Array<[string, number]> = [
    ['contractSize', definition.contractSize],
    ['priceIncrement', definition.priceIncrement],
    ['minVolume', definition.minVolume],
    ['maxVolume', definition.maxVolume],
    ['volumeStep', definition.volumeStep],
  ];

  for (const [name, value] of numeric) {
    try {
      positive(name, value);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (definition.maxVolume < definition.minVolume) {
    errors.push('maxVolume must be >= minVolume');
  }

  if (definition.expiresAt != null) {
    if (definition.expiresAt <= now) {
      errors.push('contract definition is expired');
    }
    if (
      Number.isFinite(definition.observedAt) &&
      definition.expiresAt <= definition.observedAt
    ) {
      errors.push('expiresAt must be later than observedAt');
    }
  }

  if (!definition.verified) {
    errors.push('contract definition is not verified');
  }

  const optionalPositive: Array<[string, number | undefined]> = [
    ['pipSize', definition.pipSize],
    ['tickSize', definition.tickSize],
    ['tickValue', definition.tickValue],
    ['tickValueLoss', definition.tickValueLoss],
    ['tickValueProfit', definition.tickValueProfit],
    ['volumeLimit', definition.volumeLimit],
    ['stopsLevel', definition.stopsLevel],
    ['freezeLevel', definition.freezeLevel],
    ['marginInitial', definition.marginInitial],
    ['marginMaintenance', definition.marginMaintenance],
  ];
  for (const [name, value] of optionalPositive) {
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      errors.push(name + ' must be finite and >= 0');
    }
  }

  if (definition.tradeMode != null && (!Number.isInteger(definition.tradeMode) || definition.tradeMode < 0 || definition.tradeMode > 4)) {
    errors.push('tradeMode must be an integer between 0 and 4');
  }
  if (definition.tradeExecutionMode != null && (!Number.isInteger(definition.tradeExecutionMode) || definition.tradeExecutionMode < 0)) {
    errors.push('tradeExecutionMode must be a non-negative integer');
  }

  if (
    definition.leverage != null &&
    (!Number.isFinite(definition.leverage) || definition.leverage <= 0)
  ) {
    errors.push('leverage must be finite and > 0');
  }

  return errors;
}

export function toMarketDefinition(
  definition: BrokerContractDefinition,
): MarketDefinition {
  const errors = validateBrokerContract(definition);

  if (errors.length) {
    throw new Error(
      `[ContractRegistry] Refusing ${definition.symbol}: ${errors.join('; ')}`,
    );
  }

  const brokerSymbol = definition.symbol.trim();
  return {
    symbol: brokerSymbol.replace(/[^A-Z0-9]/g, '').toUpperCase(),
    brokerSymbol,
    baseAsset: definition.baseAsset.trim().toUpperCase(),
    quoteCurrency: definition.quoteCurrency.trim().toUpperCase(),
    assetClass: definition.assetClass,
    supportedVenues: [definition.venue],
    supportedTimeframes: definition.supportedTimeframes
      ? [...definition.supportedTimeframes]
      : undefined,
    economics: {
      contractType: definition.contractType,
      contractSize: definition.contractSize,
      priceIncrement: definition.priceIncrement,
      pipSize: definition.pipSize,
      minVolume: definition.minVolume,
      maxVolume: definition.maxVolume,
      volumeStep: definition.volumeStep,
      marginModel: definition.marginModel,
      tickSize: definition.tickSize,
      tickValue: definition.tickValue,
      tickValueLoss: definition.tickValueLoss,
      tickValueProfit: definition.tickValueProfit,
      volumeLimit: definition.volumeLimit,
      tradeMode: definition.tradeMode,
      tradeExecutionMode: definition.tradeExecutionMode,
      stopsLevel: definition.stopsLevel,
      freezeLevel: definition.freezeLevel,
      marginInitial: definition.marginInitial,
      marginMaintenance: definition.marginMaintenance,
    },
  };
}

export class BrokerContractRegistry {
  private readonly definitions = new Map<string, BrokerContractDefinition>();

  register(definition: BrokerContractDefinition): void {
    const normalized = definition.symbol.trim().toUpperCase();

    const errors = validateBrokerContract(definition);

    if (errors.length) {
      throw new Error(
        `[ContractRegistry] Refusing ${normalized}: ${errors.join('; ')}`,
      );
    }

    const existing = this.definitions.get(normalized);
    if (existing && existing.observedAt >= definition.observedAt) {
      return;
    }

    this.definitions.set(normalized, {
      ...definition,
      symbol: definition.symbol.trim(),
    });
  }

  get(symbol: string): BrokerContractDefinition | null {
    const normalized = symbol.trim().toUpperCase();
    const definition = this.definitions.get(normalized);
    if (!definition) return null;

    if (!definition.verified) return null;
    if (
      definition.expiresAt != null &&
      definition.expiresAt <= Date.now()
    ) {
      this.definitions.delete(normalized);
      return null;
    }

    return definition;
  }

  getMarketDefinition(symbol: string): MarketDefinition | null {
    const definition = this.get(symbol);
    return definition ? toMarketDefinition(definition) : null;
  }

  findSymbolsByCurrencies(baseCurrency: string, quoteCurrency: string): string[] {
    const base = baseCurrency.trim().toUpperCase();
    const quote = quoteCurrency.trim().toUpperCase();
    if (!base || !quote) return [];

    return [...this.definitions.values()]
      .filter(definition =>
        definition.verified &&
        definition.baseAsset.trim().toUpperCase() === base &&
        definition.quoteCurrency.trim().toUpperCase() === quote &&
        (definition.expiresAt == null || definition.expiresAt > Date.now())
      )
      .sort((a, b) => b.observedAt - a.observedAt)
      .map(definition => definition.symbol);
  }

  hasVerified(symbol: string): boolean {
    return this.get(symbol)?.verified === true;
  }

  status(symbols?: string[]): {
    ready: boolean;
    count: number;
    contracts: Array<{
      symbol: string;
      assetClass: AssetClass;
      quoteCurrency: string;
      verified: boolean;
      observedAt: number;
      expiresAt: number | null;
      supportedTimeframes?: Timeframe[];
    }>;
  } {
    const selected = symbols?.length
      ? symbols.map(symbol => symbol.trim().toUpperCase())
      : [...this.definitions.keys()];

    const contracts = selected.map(symbol => {
      const definition = this.definitions.get(symbol);
      return definition
        ? {
            symbol: definition.symbol,
            assetClass: definition.assetClass,
            quoteCurrency: definition.quoteCurrency.trim().toUpperCase(),
            verified: definition.verified,
            observedAt: definition.observedAt,
            expiresAt: definition.expiresAt ?? null,
            supportedTimeframes: definition.supportedTimeframes
              ? [...definition.supportedTimeframes]
              : undefined,
          }
        : null;
    }).filter((value): value is NonNullable<typeof value> => value !== null);

    return {
      ready: selected.length > 0 && contracts.length === selected.length &&
        contracts.every(contract =>
          contract.verified &&
          (contract.expiresAt == null || contract.expiresAt > Date.now())
        ),
      count: contracts.length,
      contracts,
    };
  }

  clear(): void {
    this.definitions.clear();
  }
}

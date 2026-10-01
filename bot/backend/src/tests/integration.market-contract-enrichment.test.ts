import {
  clearBrokerContracts,
  getMarketDefinition,
  registerBrokerContract,
} from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = Date.now();
clearBrokerContracts();

assert(
  getMarketDefinition("USOIL") === null,
  "Oil must not inherit an implicit generic contract",
);

registerBrokerContract({
  symbol: "USOIL",
  baseAsset: "OIL",
  quoteCurrency: "USD",
  assetClass: "ENERGY",
  contractType: "CFD",
  venue: "MT5",
  contractSize: 1000,
  priceIncrement: 0.01,
  minVolume: 0.01,
  maxVolume: 20,
  volumeStep: 0.01,
  marginModel: "BROKER_DEFINED",
  source: "mt5-symbol-info:test-broker",
  observedAt: now,
  expiresAt: now + 60_000,
  verified: true,
  supportedTimeframes: ["M1", "M5", "M15", "M30", "H1", "H4", "D1"],
});

const oil = getMarketDefinition("USOIL");
assert(oil !== null, "verified Oil contract must become a market definition");
assert(oil!.assetClass === "ENERGY", "Oil asset class must remain ENERGY");
assert(oil!.economics.contractSize === 1000, "Oil contract size must come from broker metadata");
assert(oil!.economics.marginModel === "BROKER_DEFINED", "Oil margin model must remain broker-defined");

clearBrokerContracts();

registerBrokerContract({
  symbol: "USOIL",
  baseAsset: "OIL",
  quoteCurrency: "USD",
  assetClass: "ENERGY",
  contractType: "CFD",
  venue: "MT5",
  contractSize: 1000,
  priceIncrement: 0.01,
  minVolume: 0.01,
  maxVolume: 20,
  volumeStep: 0.01,
  marginModel: "BROKER_DEFINED",
  source: "mt5-symbol-info:test-broker",
  observedAt: now,
  expiresAt: now - 1,
  verified: true,
});

assert(
  getMarketDefinition("USOIL") === null,
  "expired Oil contract must fail closed",
);

console.log("Result: 6 passed, 0 failed");

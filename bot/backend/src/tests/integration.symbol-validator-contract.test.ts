import {
  buildMT5BrokerContractDefinition,
  inferMT5AssetClass,
} from "../utils/SymbolValidator";
import { clearBrokerContracts, getMarketDefinition, registerBrokerContract } from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = Date.now();
const observedAt = Math.floor(now / 1000) * 1000;

assert(
  inferMT5AssetClass("EURUSD.a", "Euro vs US Dollar", "EUR", "USD") === "FOREX",
  "broker-suffixed Forex symbol should be recognized from currencies",
);
assert(
  inferMT5AssetClass("XAUUSD.a", "Gold Spot", "XAU", "USD") === "METAL",
  "Gold broker symbol should be recognized as METAL",
);
assert(
  inferMT5AssetClass("WTI.cash", "West Texas Intermediate Oil", "WTI", "USD") === "ENERGY",
  "Oil broker symbol should be recognized as ENERGY",
);

const definition = buildMT5BrokerContractDefinition("EURUSD.a", {
  symbol: "EURUSD.a",
  description: "Euro vs US Dollar",
  currency_base: "EUR",
  currency_profit: "USD",
  trade_contract_size: 100000,
  point: 0.00001,
  digits: 5,
  volume_min: 0.01,
  volume_max: 100,
  volume_step: 0.01,
  time: Math.floor(observedAt / 1000),
}, now);

assert(definition.symbol === "EURUSD.a", "broker symbol must be preserved");
assert(definition.assetClass === "FOREX", "payload must produce FOREX definition");
assert(definition.contractSize === 100000, "contract size must be mapped");
assert(definition.volumeStep === 0.01, "volume step must be mapped");
assert(definition.pipSize === 0.0001, "5-digit Forex broker point must map to a 0.0001 pip");
assert(definition.observedAt === observedAt, "broker observation timestamp must be preserved");
assert(definition.expiresAt === observedAt + 24 * 3_600_000, "fresh broker payload must expire 24h after observation");

clearBrokerContracts();
registerBrokerContract(definition);
assert(getMarketDefinition("EURUSD.a")?.economics.contractSize === 100000, "mapped broker definition must register");
clearBrokerContracts();

let invalidRejected = false;
try {
  registerBrokerContract(buildMT5BrokerContractDefinition("EURUSD.a", {
    symbol: "EURUSD.a",
    description: "Euro vs US Dollar",
    currency_base: "EUR",
    currency_profit: "USD",
    trade_contract_size: 0,
    point: 0.00001,
    volume_min: 0.01,
    volume_max: 100,
    volume_step: 0.01,
  }, now));
} catch {
  invalidRejected = true;
}
const stale = buildMT5BrokerContractDefinition("EURUSD.a", {
  symbol: "EURUSD.a",
  description: "Euro vs US Dollar",
  currency_base: "EUR",
  currency_profit: "USD",
  trade_contract_size: 100000,
  point: 0.00001,
  volume_min: 0.01,
  volume_max: 100,
  volume_step: 0.01,
  time: Math.floor((now - 25 * 3_600_000) / 1000),
}, now);
assert(stale.expiresAt <= now, "broker metadata observed over 24h ago must already be expired");
assert(invalidRejected, "invalid contract economics must be rejected");
assert(getMarketDefinition("EURUSD.a") === null, "invalid broker metadata must never remain active");

console.log("Result: 10 passed, 0 failed");

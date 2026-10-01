import {
  buildMT5BrokerContractDefinition,
  inferMT5AssetClass,
} from "../utils/SymbolValidator";
import { clearBrokerContracts, getMarketDefinition, registerBrokerContract } from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = Date.now();

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
  volume_min: 0.01,
  volume_max: 100,
  volume_step: 0.01,
  time: Math.floor(now / 1000),
}, now);

assert(definition.symbol === "EURUSD.a", "broker symbol must be preserved");
assert(definition.assetClass === "FOREX", "payload must produce FOREX definition");
assert(definition.contractSize === 100000, "contract size must be mapped");
assert(definition.volumeStep === 0.01, "volume step must be mapped");
assert(definition.expiresAt === now + 24 * 3_600_000, "broker payload must receive bounded TTL");

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
assert(invalidRejected, "invalid contract economics must be rejected");
assert(getMarketDefinition("EURUSD.a") === null, "invalid broker metadata must never remain active");

console.log("Result: 9 passed, 0 failed");

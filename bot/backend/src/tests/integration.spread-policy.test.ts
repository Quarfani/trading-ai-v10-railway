import { clearBrokerContracts, registerBrokerContract } from "../market/MarketCatalog";
import { SpreadFilter } from "../risk/SpreadFilter";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

clearBrokerContracts();

registerBrokerContract({
  symbol: "USOIL",
  baseAsset: "WTI",
  quoteCurrency: "USD",
  assetClass: "ENERGY",
  contractType: "CFD",
  venue: "MT5",
  contractSize: 1000,
  priceIncrement: 0.01,
  minVolume: 0.01,
  maxVolume: 50,
  volumeStep: 0.01,
  marginModel: "BROKER_DEFINED",
  source: "spread-policy-test",
  observedAt: Date.now(),
  verified: true,
});

const sf = new SpreadFilter();

const withoutPolicy = sf.check("USOIL", 80.00, 80.02, "H1");
assert(
  !withoutPolicy.ok,
  "broker-only asset without explicit spread policy must fail closed",
);

const old = process.env.SPEC_USOIL_SPREAD_MAX_PIPS;
process.env.SPEC_USOIL_SPREAD_MAX_PIPS = "3";

try {
  const withPolicy = sf.check("USOIL", 80.00, 80.02, "H1");
  assert(withPolicy.ok, "explicit Oil spread policy should enable policy evaluation");
  assert(Math.abs(withPolicy.spreadPips - 2) < 1e-9, "Oil spread should use broker price increment");
} finally {
  if (old == null) delete process.env.SPEC_USOIL_SPREAD_MAX_PIPS;
  else process.env.SPEC_USOIL_SPREAD_MAX_PIPS = old;
  clearBrokerContracts();
}

console.log("Result: 3 passed, 0 failed");

import { CircuitBreaker } from "../risk/CircuitBreaker";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const state = new Map<string, string>();
const store = {
  getSetting: (key: string) => state.get(key) ?? null,
  setSetting: (key: string, value: string) => state.set(key, value),
};

const first = new CircuitBreaker(3, 60_000, null, store, "acct-A");
first.recordResult(-10);
first.recordResult(-20);

const restored = new CircuitBreaker(3, 60_000, null, store, "acct-A");
assert(
  restored.getStatus().includes("2/3"),
  "loss streak must survive circuit breaker restart",
);

restored.recordResult(-30);

const tripped = new CircuitBreaker(3, 60_000, null, store, "acct-A");
assert(!tripped.canTrade(), "tripped circuit must remain blocked after restart");
assert(tripped.cooldownRemainingMs() > 0, "persisted cooldown must remain active");

const otherAccount = new CircuitBreaker(3, 60_000, null, store, "acct-B");
assert(otherAccount.canTrade(), "circuit state must be isolated per account");

const invalidState = new Map<string, string>([
  ["circuit_breaker:acct-C", "{not-json"],
]);
const invalidStore = {
  getSetting: (key: string) => invalidState.get(key) ?? null,
  setSetting: (key: string, value: string) => invalidState.set(key, value),
};
const corrupt = new CircuitBreaker(3, 60_000, null, invalidStore, "acct-C");
assert(!corrupt.canTrade(), "corrupt persisted circuit state must fail closed");

const nonFinite = new CircuitBreaker(3, 60_000, null, store, "acct-D");
nonFinite.recordResult(Number.NaN);
assert(!nonFinite.canTrade(), "non-finite PnL must block circuit breaker trading");

console.log("Result: 6 passed, 0 failed");

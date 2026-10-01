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

console.log("Result: 4 passed, 0 failed");

import {
  normalizedConfidenceThreshold,
  passesMinimumSignalConfidence,
} from "../risk/SignalConfidenceGate";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(normalizedConfidenceThreshold(0.7) === 0.7, "threshold should preserve valid values");
assert(normalizedConfidenceThreshold(2) === 1, "threshold should clamp above 1");
assert(normalizedConfidenceThreshold(-1) === 0, "threshold should clamp below 0");
assert(normalizedConfidenceThreshold("bad", 0.6) === 0.6, "invalid threshold should use explicit default");

assert(passesMinimumSignalConfidence(0.8, 0.7), "signal above threshold must pass");
assert(passesMinimumSignalConfidence(0.7, 0.7), "signal at threshold must pass");
assert(!passesMinimumSignalConfidence(0.69, 0.7), "signal below threshold must block");
assert(!passesMinimumSignalConfidence("bad", 0.7), "non-finite confidence must block");

console.log("Result: 8 passed, 0 failed");

export function normalizedConfidenceThreshold(value: unknown, defaultValue = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Math.min(1, Math.max(0, defaultValue));
  }
  return Math.min(1, Math.max(0, numeric));
}

export function passesMinimumSignalConfidence(
  confidence: unknown,
  minimum: unknown,
): boolean {
  const c = Number(confidence);
  const min = Number(minimum);
  return Number.isFinite(c) && Number.isFinite(min) && c >= min;
}

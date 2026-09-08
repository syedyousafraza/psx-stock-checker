const freeze = (value) => Object.freeze(value);

export function dataVerification({ sourceSignatures, dataPointCount, divergenceScore = 0, timestamp = Date.now() }) {
  return freeze({
    epochMs: timestamp,
    sourceSignatures: freeze([...sourceSignatures]),
    dataPointCount,
    divergenceScore,
  });
}

export function immutableContract(payload) {
  return freeze({ ...payload });
}

export function assertFiniteSeries(values, name = 'series') {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(Number(value)))) {
    throw new TypeError(`${name} must be a non-empty finite numeric array`);
  }
}

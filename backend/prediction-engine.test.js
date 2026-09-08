import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastPrices } from './prediction-engine.js';

test('returns a bounded, non-actionable baseline forecast', () => {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    timestamp: index,
    close: 100 + index * 0.4,
    volume: 1_000,
  }));
  const result = forecastPrices(bars, { horizonBars: 2 });
  assert.equal(result.modelStatus, 'BASELINE_UNCALIBRATED');
  assert.equal(result.actionable, false);
  assert.ok(result.lowerBound < result.expectedPrice);
  assert.ok(result.expectedPrice < result.upperBound);
});

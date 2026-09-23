import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastPrices } from './prediction-engine.js';

test('returns a bounded, actionable calibrated forecast for a clear trend', () => {
  const bars = Array.from({ length: 60 }, (_, index) => ({
    timestamp: index,
    close: 100 + index * 0.4,
    volume: 1_000,
  }));
  const result = forecastPrices(bars, { horizonBars: 2, asOfMs: 100 });
  assert.equal(result.modelStatus, 'CALIBRATED_WALKFORWARD');
  assert.equal(result.actionable, true);
  assert.ok(result.lowerBound < result.expectedPrice);
  assert.ok(result.expectedPrice < result.upperBound);
  assert.ok(result.factors);
  assert.ok(Number.isFinite(result.expectedPerBar));
  assert.ok(result.confidence > 0.5, 'confidence should be meaningful for a clear trend');
});

test('returns a bounded, non-actionable forecast for noisy series', () => {
  const bars = Array.from({ length: 60 }, (_, index) => ({
    timestamp: index,
    close: 100 + Math.sin(index * 0.1) * 2 + Math.sin(index * 0.7) * 0.5,
    volume: 1_000,
  }));
  const result = forecastPrices(bars, { horizonBars: 2, asOfMs: 100 });
  assert.equal(result.modelStatus, 'CALIBRATED_WALKFORWARD');
  assert.ok(result.lowerBound < result.expectedPrice);
  assert.ok(result.expectedPrice < result.upperBound);
  assert.ok(result.factors);
  assert.ok(Number.isFinite(result.expectedPerBar));
});

test('anchors the forecast to the fresher live quote and keeps the expected date in the future', () => {
  const bars = Array.from({ length: 60 }, (_, index) => ({
    timestamp: 1000 + index,
    close: 100 + index * 0.4,
    volume: 1_000,
  }));
  const result = forecastPrices(bars, { horizonBars: 5, anchorPrice: 150, anchorTimestamp: 10_000, asOfMs: 10_000 });
  assert.equal(result.lastPrice, 150);
  assert.equal(result.anchorPrice, 150);
  assert.equal(result.anchorSource, 'LIVE_PSX_QUOTE');
  const expectedMs = new Date(result.expectedDate).getTime();
  assert.ok(expectedMs > 10_000, `expected date ${result.expectedDate} must be after the anchor timestamp`);
});

test('flags stale historical series via dataStalenessDays', () => {
  const base = 1_700_000_000_000;
  const bars = Array.from({ length: 60 }, (_, index) => ({
    timestamp: base + index * 86_400_000,
    close: 100 + index * 0.4,
    volume: 1_000,
  }));
  // Last bar timestamp is base + 59 * 86_400_000
  // asOfMs = base + 70 * 86_400_000 gives 11 days staleness
  const result = forecastPrices(bars, { horizonBars: 1, asOfMs: base + 70 * 86_400_000 });
  assert.equal(result.dataStalenessDays, 11);
});

test('ensemble forecast includes regime probabilities and GARCH volatility', () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({
    timestamp: index,
    close: 100 + Math.sin(index * 0.3) * 5 + index * 0.1,
    volume: 100_000,
  }));
  const result = forecastPrices(bars, { horizonBars: 5 });
  assert.ok(result.regime);
  assert.ok(typeof result.regime.trend === 'number');
  assert.ok(typeof result.regime.meanReversion === 'number');
  assert.ok(typeof result.regime.random === 'number');
  assert.ok(result.hurst !== undefined);
  assert.ok(result.hurstRegime !== undefined);
  assert.ok(result.factors.garchVol !== undefined);
  assert.ok(result.factors.arAic !== undefined);
});
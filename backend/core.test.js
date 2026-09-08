import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorporateActions, filterBadPrints, reconcileStreams } from './data-engine.js';
import { HurstExponent, KalmanFilter } from './math-agents.js';

const bars = Array.from({ length: 32 }, (_, index) => ({ timestamp: index, close: 100 + index, volume: 1000 }));

test('reconciles divergent closes to the official baseline', () => {
  const result = reconcileStreams([{ timestamp: 1, close: 100, volume: 5 }], [{ timestamp: 1, close: 102, volume: 5 }]);
  assert.equal(result.bars[0].close, 102);
  assert.equal(result.bars[0].fallbackSource, 'PSX_OFFICIAL_LEDGER');
  assert.equal(result.bars[0].dataFeedAnomaly, true);
  assert.ok(result.dataVerification.epochMs);
});

test('rejects a three-sigma bad print without volume confirmation', () => {
  const input = [...bars.slice(0, 20), { timestamp: 20, close: 200, volume: 1000 }];
  const result = filterBadPrints(input);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.bars.at(-1).close, 119);
});

test('applies split factor backward to prices and forward to volume', () => {
  const result = applyCorporateActions([{ timestamp: 1, close: 100, volume: 10 }, { timestamp: 3, close: 110, volume: 20 }], [{ timestamp: 2, factor: 2 }]);
  assert.deepEqual(result.bars.map(({ close, volume }) => ({ close, volume })), [{ close: 50, volume: 20 }, { close: 110, volume: 20 }]);
});

test('returns an immutable Kalman track with verification', () => {
  const result = KalmanFilter([100, 101, 102, 101]);
  assert.equal(result.track.length, 4);
  assert.ok(result.track.at(-1).filteredPrice > 100);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.dataVerification.dataPointCount, 4);
});

test('classifies a persistent synthetic series above random walk', () => {
  let price = 100;
  const path = [price];
  for (let index = 1; index < 256; index += 1) {
    price += (Math.floor(index / 16) % 2 ? 0.4 : -0.2) + Math.sin(index) * 0.03;
    path.push(price);
  }
  const result = HurstExponent(path);
  assert.ok(result.value > 0.5);
  assert.equal(result.regime, 'PERSISTENT_TREND');
});

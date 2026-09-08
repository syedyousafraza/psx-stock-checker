import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSignal } from './decision-engine.js';

const bars = Array.from({ length: 40 }, (_, index) => ({ close: 100 + index, timestamp: index, volume: 100_000 }));
const base = { bars, hurst: { value: 0.7, regime: 'PERSISTENT_TREND' }, adf: { stationary: false }, prediction: { volatility: 0.01, expectedReturn: 0.01, horizonBars: 1 }, risk: { authorized: true }, quote: { bid: 100, ask: 100.01 } };

test('emits a paper BUY only when trend and edge clear the threshold', () => {
  const signal = generateSignal(base);
  assert.equal(signal.signal, 'BUY');
  assert.equal(signal.paperOnly, true);
  assert.equal(signal.executionAuthorized, false);
});

test('emits a paper SELL for a persistent negative edge', () => {
  const signal = generateSignal({ ...base, prediction: { ...base.prediction, expectedReturn: -0.01 } });
  assert.equal(signal.signal, 'SELL');
});

test('blocks a weak edge as NO_TRADE', () => {
  const signal = generateSignal({ ...base, prediction: { ...base.prediction, expectedReturn: 0.001 } });
  assert.equal(signal.signal, 'NO_TRADE');
});

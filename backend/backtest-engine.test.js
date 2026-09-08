import test from 'node:test';
import assert from 'node:assert/strict';
import { walkForwardBacktest } from './backtest-engine.js';

const bars = Array.from({ length: 80 }, (_, index) => ({
  timestamp: index,
  close: 100 + index * 0.4 + Math.sin(index * 1.7),
  volume: 100_000,
}));

test('walk-forward backtest uses only prior bars and scores future outcomes', () => {
  const result = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 32, step: 5 });
  assert.ok(result.observations.length > 0);
  assert.ok(result.observations.every((row) => row.cutoffTimestamp < row.targetTimestamp));
  assert.ok(result.metrics.directionalAccuracy >= 0 && result.metrics.directionalAccuracy <= 1);
  assert.ok(result.dataVerification.sourceSignatures.includes('WALK_FORWARD_NO_LOOKAHEAD'));
});

test('backtest reports profitability summary with portfolio, performance, and win/loss breakdown', () => {
  const result = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 32, step: 5 });
  assert.ok(Number.isFinite(result.portfolio.startingCapital));
  assert.ok(Number.isFinite(result.portfolio.endingCapital));
  assert.ok(Number.isFinite(result.portfolio.totalReturn));
  assert.ok(Number.isFinite(result.portfolio.annualizedReturn));
  assert.ok(result.portfolio.totalTrades >= 0);
  assert.equal(result.equityCurve.length, result.observations.length + 1);
  assert.equal(result.equityCurve[0], result.portfolio.startingCapital);
  assert.ok(Object.hasOwn(result.performance, 'sharpeRatio'));
  assert.ok(Object.hasOwn(result.performance, 'sortinoRatio'));
  assert.ok(Object.hasOwn(result.performance, 'maxDrawdown'));
  assert.ok(Object.hasOwn(result.performance, 'calmarRatio'));
  assert.ok(Object.hasOwn(result.winLoss, 'winRate'));
  assert.ok(Object.hasOwn(result.winLoss, 'profitFactor'));
  assert.ok(Object.hasOwn(result.winLoss, 'expectancy'));
  assert.ok(Object.hasOwn(result.winLoss, 'averageWin'));
  assert.ok(Object.hasOwn(result.winLoss, 'averageLoss'));
  assert.equal(result.tradeLog.length, result.observations.length);
  assert.ok(['STRONG_EDGE', 'PROFITABLE', 'MARGINALLY_PROFITABLE', 'BREAKEVEN', 'NOT_PROFITABLE'].includes(result.verdict));
  assert.ok(Array.isArray(result.verdictReasons));
});

test('a rising deterministic series produces a profitable backtest', () => {
  const upward = Array.from({ length: 120 }, (_, index) => ({
    timestamp: index,
    close: 100 * Math.pow(1.002, index),
    volume: 100_000,
  }));
  const result = walkForwardBacktest(upward, { horizonBars: 5, minimumTrainingBars: 32, step: 5 });
  assert.ok(result.portfolio.totalReturn > 0, `expected positive total return, got ${result.portfolio.totalReturn}`);
  assert.ok(result.winLoss.winRate > 0.5);
  assert.equal(result.verdict, 'STRONG_EDGE');
  assert.ok(result.winLoss.profitFactor > 1);
});

test('a random flat series produces no strong edge', () => {
  let seed = 42;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * max;
  };
  const flat = Array.from({ length: 120 }, (_, index) => ({
    timestamp: index,
    close: 100 + random(4) - 2,
    volume: 100_000,
  }));
  const result = walkForwardBacktest(flat, { horizonBars: 5, minimumTrainingBars: 32, step: 5 });
  assert.ok(result.verdict !== 'STRONG_EDGE');
  assert.ok(Number.isFinite(result.performance.sharpeRatio));
  assert.ok(Number.isFinite(result.performance.maxDrawdown));
});

test('transaction costs reduce net returns below gross returns', () => {
  const noCost = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 32, step: 5, transactionCostBps: 0 });
  const highCost = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 32, step: 5, transactionCostBps: 200 });
  assert.ok(highCost.portfolio.totalReturn <= noCost.portfolio.totalReturn);
  assert.ok(highCost.portfolio.totalTransactionCosts >= noCost.portfolio.totalTransactionCosts);
});

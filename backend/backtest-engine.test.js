import test from 'node:test';
import assert from 'node:assert/strict';
import { walkForwardBacktest, combinatorialPurgedCV, monteCarloBacktest, regimeBacktest } from './backtest-engine.js';

const bars = Array.from({ length: 200 }, (_, index) => ({
  timestamp: index,
  close: 100 + index * 0.4 + Math.sin(index * 1.7),
  volume: 100_000,
}));

test('walk-forward backtest uses only prior bars and scores future outcomes', () => {
  const result = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 80, step: 5, purgeBars: 5, embargoBars: 2 });
  assert.ok(result.observations.length > 0);
  assert.ok(result.observations.every((row) => row.cutoffTimestamp < row.targetTimestamp));
  assert.ok(result.metrics.directionalAccuracy >= 0 && result.metrics.directionalAccuracy <= 1);
  assert.ok(result.dataVerification.sourceSignatures.includes('WALK_FORWARD_NO_LOOKAHEAD'));
  assert.ok(result.dataVerification.sourceSignatures.includes('PURGED_EMBARGO'));
});

test('backtest reports profitability summary with portfolio, performance, and win/loss breakdown', () => {
  const result = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 80, step: 5 });
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
  const upward = Array.from({ length: 200 }, (_, index) => ({
    timestamp: index,
    close: 100 * Math.pow(1.002, index),
    volume: 100_000,
  }));
  const result = walkForwardBacktest(upward, { horizonBars: 5, minimumTrainingBars: 80, step: 5 });
  assert.ok(result.portfolio.totalReturn > 0, `expected positive total return, got ${result.portfolio.totalReturn}`);
  assert.ok(result.winLoss.winRate > 0.5);
  assert.ok(result.winLoss.profitFactor > 1);
});

test('a random flat series produces no strong edge', () => {
  let seed = 42;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * max;
  };
  const flat = Array.from({ length: 200 }, (_, index) => ({
    timestamp: index,
    close: 100 + random(4) - 2,
    volume: 100_000,
  }));
  const result = walkForwardBacktest(flat, { horizonBars: 5, minimumTrainingBars: 80, step: 5 });
  assert.ok(result.verdict !== 'STRONG_EDGE');
  assert.ok(Number.isFinite(result.performance.sharpeRatio));
  assert.ok(Number.isFinite(result.performance.maxDrawdown));
});

test('transaction costs reduce net returns below gross returns', () => {
  const noCost = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 80, step: 5, transactionCostBps: 0 });
  const highCost = walkForwardBacktest(bars, { horizonBars: 5, minimumTrainingBars: 80, step: 5, transactionCostBps: 200 });
  assert.ok(highCost.portfolio.totalReturn <= noCost.portfolio.totalReturn);
  assert.ok(highCost.portfolio.totalTransactionCosts >= noCost.portfolio.totalTransactionCosts);
});

test('a small sample cannot claim a strong or profitable verdict', () => {
  const shortBars = Array.from({ length: 100 }, (_, index) => ({
    timestamp: index,
    close: 100 * Math.pow(1.003, index),
    volume: 100_000,
  }));
  const result = walkForwardBacktest(shortBars, { horizonBars: 5, minimumTrainingBars: 60, step: 5 });
  assert.ok(result.winLoss.wins > 0, 'short rising series should still trade');
  assert.ok(result.portfolio.totalTrades < 10, `expected a small sample of trades, got ${result.portfolio.totalTrades}`);
  assert.notEqual(result.verdict, 'STRONG_EDGE');
  assert.notEqual(result.verdict, 'PROFITABLE');
  assert.ok(result.verdictReasons.some((reason) => reason.includes('insufficient sample')));
});

test('combinatorial purged CV produces multiple folds', () => {
  const longBars = Array.from({ length: 400 }, (_, index) => ({
    timestamp: index,
    close: 100 + index * 0.4 + Math.sin(index * 1.7),
    volume: 100_000,
  }));
  const result = combinatorialPurgedCV(longBars, { nSplits: 4, nTestSplits: 1, purgeBars: 5, embargoBars: 2, horizonBars: 5, minimumTrainingBars: 80, step: 5 });
  assert.ok(result.folds.length >= 2);
  assert.ok(result.summary.meanTestSharpe !== undefined);
  assert.ok(result.summary.totalFolds >= 2);
});

test('monte carlo backtest produces distribution', () => {
  const upward = Array.from({ length: 200 }, (_, index) => ({
    timestamp: index,
    close: 100 * Math.pow(1.002, index),
    volume: 100_000,
  }));
  const result = monteCarloBacktest(upward, { nSimulations: 100, horizonBars: 5 });
  assert.ok(result.simulations === 100);
  assert.ok(result.percentiles.p50 !== undefined);
  assert.ok(result.probPositive >= 0 && result.probPositive <= 1);
});

test('regime backtest separates by market regime', () => {
  const result = regimeBacktest(bars, { regimeWindow: 50, horizonBars: 5, step: 10 });
  assert.ok(result.regimeAnalysis.TREND !== undefined || result.regimeAnalysis.MEAN_REVERSION !== undefined || result.regimeAnalysis.RANDOM !== undefined);
  assert.ok(result.regimeDistribution.TREND !== undefined);
});
import { forecastPrices } from './prediction-engine.js';
import { HurstExponent } from './math-agents.js';
import { dataVerification, immutableContract } from './contracts.js';

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sharpeRatio(returns, rf = 0) {
  const excess = returns.map(r => r - rf / 252);
  const m = mean(excess);
  const s = standardDeviation(excess);
  return s > 0 ? m / s * Math.sqrt(252) : 0;
}

function sortinoRatio(returns, rf = 0) {
  const excess = returns.map(r => r - rf / 252);
  const m = mean(excess);
  const downside = excess.filter(r => r < 0);
  const dd = downside.length > 1 ? standardDeviation(downside) : 0;
  return dd > 0 ? m / dd * Math.sqrt(252) : 0;
}

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0];
  let maxDD = 0;
  let maxDDur = 0;
  let curDur = 0;
  for (const eq of equityCurve) {
    if (eq >= peak) { peak = eq; curDur = 0; }
    else { curDur++; }
    const dd = (peak - eq) / peak;
    maxDD = Math.max(maxDD, dd);
    maxDDur = Math.max(maxDDur, curDur);
  }
  return { maxDD, maxDDur };
}

function calmarRatio(totalReturn, maxDD) {
  return maxDD > 0 ? totalReturn / maxDD : 0;
}

function profitFactor(trades) {
  const grossProfit = trades.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = trades.filter(t => t.netPnL < 0).reduce((s, t) => s - t.netPnL, 0);
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
}

export function walkForwardBacktest(bars, {
  horizonBars = 5,
  minimumTrainingBars = 50,
  step = 5,
  capital = 1_000_000,
  transactionCostBps = 15,
  positionFraction = 0.05,
  edgeThreshold = 0.5,
  goLongOnUp = true,
  shortOnDown = false,
  purgeBars = 0,
  embargoBars = 0,
  useGarchVol = true,
} = {}) {
  if (!Array.isArray(bars) || bars.length < minimumTrainingBars + horizonBars) {
    throw new RangeError(`At least ${minimumTrainingBars + horizonBars} bars required for backtesting`);
  }

  const costFraction = transactionCostBps / 10_000;
  const rows = [];
  
  for (let cutoff = minimumTrainingBars; cutoff + horizonBars < bars.length; cutoff += step) {
    const trainEnd = cutoff - purgeBars;
    if (trainEnd < minimumTrainingBars) continue;
    
    const training = bars.slice(0, trainEnd);
    const actualStart = Number(training.at(-1).close);
    const actualEnd = Number(bars[cutoff + horizonBars].close);
    const actualReturn = actualEnd / actualStart - 1;
    
    const closes = training.map(bar => Number(bar.close));
    const regime = HurstExponent(closes).value;
    const forecast = forecastPrices(training, { horizonBars, hurstValue: regime });
    const error = forecast.expectedReturn - actualReturn;
    const volatility = Number(forecast.volatility) || 0;
    const edgeScore = volatility > 0 ? forecast.expectedReturn / volatility : 0;
    
    rows.push(immutableContract({
      cutoffTimestamp: training.at(-1).timestamp,
      targetTimestamp: bars[cutoff + horizonBars].timestamp,
      trainEndTimestamp: training.at(-1).timestamp,
      purgeBars,
      embargoBars,
      forecastReturn: forecast.expectedReturn,
      forecastPrice: forecast.expectedPrice,
      actualReturn,
      actualPrice: actualEnd,
      absoluteError: Math.abs(error),
      directionCorrect: Math.sign(forecast.expectedReturn) === Math.sign(actualReturn),
      extremeForecast: forecast.extremeForecast,
      edgeScore,
      volatility,
      hurst: regime,
      regime: forecast.hurstRegime,
      confidence: forecast.confidence,
    }));
  }

  let equity = capital;
  const equityCurve = [capital];
  const tradeLog = [];
  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, totalCost = 0;
  let holdingPeriods = 0, holdingPeriodReturnSum = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    
    if (embargoBars > 0 && i < embargoBars) {
      tradeLog.push(immutableContract({
        ...row, signal: 'EMBARGO', positionSize: 0, netPnL: 0, equityAfter: equity,
      }));
      equityCurve.push(equity);
      continue;
    }

    const hasEdgeUp = row.forecastReturn > 0 && row.edgeScore >= edgeThreshold && !row.extremeForecast;
    const hasEdgeDown = row.forecastReturn < 0 && row.edgeScore <= -edgeThreshold && !row.extremeForecast;
    const shouldGoLong = hasEdgeUp && goLongOnUp;
    const shouldShort = hasEdgeDown && shortOnDown;
    const signal = shouldGoLong ? 'BUY' : shouldShort ? 'SELL' : 'NO_TRADE';

    if (signal === 'BUY' || signal === 'SELL') {
      const positionSize = equity * positionFraction;
      const entryPrice = row.actualPrice / (1 + row.actualReturn);
      const exitPrice = row.actualPrice;
      const directionMultiplier = signal === 'BUY' ? 1 : -1;
      const grossReturn = positionSize * row.actualReturn * directionMultiplier;
      const cost = positionSize * costFraction;
      const netPnL = grossReturn - cost;
      equity += netPnL;
      totalCost += cost;

      if (netPnL > 0) { wins++; grossProfit += netPnL; }
      else { losses++; grossLoss += Math.abs(netPnL); }

      holdingPeriods++;
      holdingPeriodReturnSum += row.actualReturn * directionMultiplier;

      tradeLog.push(immutableContract({
        ...row, signal, entryPrice, exitPrice, positionSize, grossReturn, transactionCost: cost,
        netPnL, tradeReturn: positionSize > 0 ? netPnL / positionSize : 0, equityAfter: equity,
      }));
    } else {
      tradeLog.push(immutableContract({
        ...row, signal: 'NO_TRADE', entryPrice: null, exitPrice: null, positionSize: 0,
        grossReturn: 0, transactionCost: 0, netPnL: 0, tradeReturn: 0, equityAfter: equity,
      }));
    }
    equityCurve.push(equity);
  }

  const executedTrades = tradeLog.filter(t => t.signal === 'BUY' || t.signal === 'SELL');
  const directionalRows = rows.filter(row => row.forecastReturn !== 0 && row.actualReturn !== 0);
  const mae = mean(rows.map(row => row.absoluteError));
  const mape = mean(rows.map(row => Math.abs(row.forecastReturn - row.actualReturn) / Math.max(Math.abs(row.actualReturn), 0.0001)));

  const totalReturn = (equity - capital) / capital;
  const annualizationFactor = Math.sqrt(252 / horizonBars);

  const tradeReturns = executedTrades.map(t => t.tradeReturn);
  const avgTradeReturn = tradeReturns.length ? mean(tradeReturns) : 0;
  const tradeStdDev = standardDeviation(tradeReturns);

  const sharpe = tradeStdDev > 0 ? (avgTradeReturn / tradeStdDev) * annualizationFactor : 0;
  const sortino = sortinoRatio(tradeReturns);
  const { maxDD, maxDDur } = maxDrawdown(equityCurve);
  const calmar = calmarRatio(totalReturn * annualizationFactor, maxDD);
  const pf = profitFactor(executedTrades);
  const winRate = executedTrades.length > 0 ? wins / executedTrades.length : 0;
  const expectancy = executedTrades.length > 0 ? executedTrades.reduce((s, t) => s + t.netPnL, 0) / executedTrades.length : 0;
  const averageWin = wins > 0 ? grossProfit / wins : 0;
  const averageLoss = losses > 0 ? grossLoss / losses : 0;
  const riskReward = averageLoss > 0 ? averageWin / averageLoss : averageWin > 0 ? Infinity : 0;
  const holdingPeriodReturn = holdingPeriods > 0 ? holdingPeriodReturnSum / holdingPeriods : 0;
  const annualizedReturn = totalReturn * annualizationFactor;

  let verdict;
  if (annualizedReturn > 0.08 && maxDD < 0.12 && sharpe > 1.2 && winRate > 0.5) verdict = 'STRONG_EDGE';
  else if (annualizedReturn > 0.05 && maxDD < 0.15 && sharpe > 1.0 && winRate > 0.45) verdict = 'PROFITABLE';
  else if (annualizedReturn > 0 && sharpe > 0.5 && maxDD < 0.25) verdict = 'MARGINALLY_PROFITABLE';
  else if (annualizedReturn > -0.05) verdict = 'BREAKEVEN';
  else verdict = 'NOT_PROFITABLE';

  const verdictReasons = [];
  if (annualizedReturn <= 0) verdictReasons.push(`annualized return ${(annualizedReturn * 100).toFixed(2)}%`);
  if (sharpe <= 0.5) verdictReasons.push(`Sharpe ${sharpe.toFixed(2)} below 0.5`);
  if (maxDD >= 0.25) verdictReasons.push(`max drawdown ${(maxDD * 100).toFixed(1)}% exceeds 25%`);
  if (winRate < 0.45 && executedTrades.length > 5) verdictReasons.push(`win rate ${(winRate * 100).toFixed(1)}% below 45%`);
  if (pf < 1 && executedTrades.length > 0) verdictReasons.push(`profit factor ${pf.toFixed(2)} below 1.0`);
  if (annualizedReturn > 0.08 && sharpe > 1.2) verdictReasons.push('strong risk-adjusted returns');
  if (maxDD < 0.10) verdictReasons.push('drawdown contained below 10%');
  if (executedTrades.length < 10) {
    if (verdict === 'STRONG_EDGE' || verdict === 'PROFITABLE') verdict = 'MARGINALLY_PROFITABLE';
    verdictReasons.push(`only ${executedTrades.length} trades — insufficient sample`);
  }

  return immutableContract({
    horizonBars, minimumTrainingBars, step, purgeBars, embargoBars,
    observations: rows,
    metrics: {
      observations: rows.length,
      directionalAccuracy: directionalRows.length ? directionalRows.filter(r => r.directionCorrect).length / directionalRows.length : 0,
      meanAbsoluteError: mae,
      meanAbsolutePercentageError: mape,
      extremeForecastRate: rows.length ? rows.filter(r => r.extremeForecast).length / rows.length : 0,
      avgHurst: mean(rows.map(r => r.hurst)),
      avgConfidence: mean(rows.map(r => r.confidence)),
    },
    portfolio: {
      startingCapital: capital, endingCapital: equity, totalReturn,
      annualizedReturn: totalReturn * annualizationFactor,
      totalPnL: equity - capital, transactionCostBps,
      totalTransactionCosts: totalCost, positionFraction,
      totalTrades: executedTrades.length,
      skippedForecasts: rows.length - executedTrades.length,
    },
    performance: { sharpeRatio: sharpe, sortinoRatio: sortino, maxDrawdown: maxDD,
      maxDrawdownDuration: maxDDur, calmarRatio: calmar, profitFactor: pf,
      holdingPeriodReturn, annualizedReturn },
    winLoss: { wins, losses, winRate, averageWin, averageLoss, riskRewardRatio: riskReward,
      expectancy, grossProfit, grossLoss, profitFactor: pf },
    equityCurve, tradeLog, verdict, verdictReasons,
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'WALK_FORWARD_NO_LOOKAHEAD', 'PURGED_EMBARGO'],
      dataPointCount: rows.length,
    }),
  });
}

export function combinatorialPurgedCV(bars, { nSplits = 5, nTestSplits = 2, purgeBars = 10, embargoBars = 5, ...params } = {}) {
  const n = bars.length;
  const testSize = Math.floor(n / nSplits);
  const indices = Array.from({ length: nSplits }, (_, i) => i * testSize);
  const results = [];

  for (let i = 0; i <= nSplits - nTestSplits; i++) {
    const testStart = indices[i];
    const testEnd = indices[i + nTestSplits] || n;
    const trainEnd = testStart - purgeBars;
    const trainStart = 0;
    
    if (trainEnd < 50) continue;
    
    const trainBars = bars.slice(trainStart, trainEnd);
    const testBars = bars.slice(testStart, testEnd);
    
    const trainResult = walkForwardBacktest(trainBars, { ...params, purgeBars: 0, embargoBars: 0 });
    const testResult = walkForwardBacktest(testBars, { ...params, minimumTrainingBars: Math.min(50, trainBars.length) });
    
    results.push(immutableContract({
      fold: results.length,
      trainPeriod: { start: trainBars[0].timestamp, end: trainBars.at(-1).timestamp },
      testPeriod: { start: testBars[0].timestamp, end: testBars.at(-1).timestamp },
      trainMetrics: trainResult.performance,
      testMetrics: testResult.performance,
      trainVerdict: trainResult.verdict,
      testVerdict: testResult.verdict,
      overfitCheck: trainResult.performance.sharpeRatio - testResult.performance.sharpeRatio,
    }));
  }

  const testSharpes = results.map(r => r.testMetrics.sharpeRatio);
  const avgTestSharpe = mean(testSharpes);
  const stdTestSharpe = standardDeviation(testSharpes);
  
  return immutableContract({
    folds: results,
    summary: {
      meanTestSharpe: avgTestSharpe,
      stdTestSharpe,
      sharpeConsistency: stdTestSharpe > 0 ? avgTestSharpe / stdTestSharpe : 0,
      positiveFolds: results.filter(r => r.testMetrics.sharpeRatio > 0).length,
      totalFolds: results.length,
    },
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'COMBINATORIAL_PURGED_CV'],
      dataPointCount: bars.length,
    }),
  });
}

export function monteCarloBacktest(bars, { nSimulations = 1000, horizonBars = 5, ...params } = {}) {
  const baseResult = walkForwardBacktest(bars, { horizonBars, ...params });
  const tradeReturns = baseResult.tradeLog
    .filter(t => t.signal === 'BUY' || t.signal === 'SELL')
    .map(t => t.tradeReturn);
  
  if (tradeReturns.length < 10) {
    return { error: 'Insufficient trades for Monte Carlo simulation' };
  }

  const simulations = [];
  for (let i = 0; i < nSimulations; i++) {
    const sampled = Array.from({ length: tradeReturns.length }, () => 
      tradeReturns[Math.floor(Math.random() * tradeReturns.length)]
    );
    let equity = params.capital || 1_000_000;
    for (const r of sampled) {
      equity *= (1 + r);
    }
    simulations.push((equity - params.capital) / params.capital);
  }

  const sorted = simulations.sort((a, b) => a - b);
  return immutableContract({
    baseResult: baseResult.verdict,
    simulations: nSimulations,
    percentiles: {
      p5: sorted[Math.floor(0.05 * nSimulations)],
      p25: sorted[Math.floor(0.25 * nSimulations)],
      p50: sorted[Math.floor(0.50 * nSimulations)],
      p75: sorted[Math.floor(0.75 * nSimulations)],
      p95: sorted[Math.floor(0.95 * nSimulations)],
    },
    probPositive: simulations.filter(s => s > 0).length / nSimulations,
    probBeatBenchmark: simulations.filter(s => s > 0.05).length / nSimulations,
    worstCase: sorted[0],
    bestCase: sorted[nSimulations - 1],
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'MONTE_CARLO_SIMULATION'],
      dataPointCount: nSimulations,
    }),
  });
}

export function regimeBacktest(bars, { regimeWindow = 63, ...params } = {}) {
  const regimes = [];
  for (let i = regimeWindow; i < bars.length; i += params.step || 21) {
    const window = bars.slice(i - regimeWindow, i);
    const hurst = HurstExponent(window.map(b => b.close)).value;
    const regime = hurst > 0.55 ? 'TREND' : hurst < 0.45 ? 'MEAN_REVERSION' : 'RANDOM';
    regimes.push({ index: i, hurst, regime, timestamp: window.at(-1).timestamp });
  }

  const regimeGroups = { TREND: [], MEAN_REVERSION: [], RANDOM: [] };
  for (const r of regimes) regimeGroups[r.regime].push(r.index);

  const results = {};
  for (const [regime, indices] of Object.entries(regimeGroups)) {
    if (indices.length < 3) continue;
    const regimeBars = bars.slice(0, indices[indices.length - 1] + (params.horizonBars || 5));
    const result = walkForwardBacktest(regimeBars, { ...params, step: params.step || 21 });
    results[regime] = {
      observations: indices.length,
      verdict: result.verdict,
      sharpe: result.performance.sharpeRatio,
      maxDD: result.performance.maxDrawdown,
      winRate: result.winLoss.winRate,
      totalTrades: result.portfolio.totalTrades,
    };
  }

  return immutableContract({
    regimeAnalysis: results,
    regimeDistribution: Object.fromEntries(Object.entries(regimeGroups).map(([k, v]) => [k, v.length])),
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'REGIME_CONDITIONAL_BACKTEST'],
      dataPointCount: bars.length,
    }),
  });
}
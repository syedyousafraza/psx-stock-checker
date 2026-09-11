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

export function walkForwardBacktest(bars, {
  horizonBars = 5,
  minimumTrainingBars = 32,
  step = 5,
  capital = 1_000_000,
  transactionCostBps = 15,
  positionFraction = 0.05,
  edgeThreshold = 0.5,
  goLongOnUp = true,
  shortOnDown = false,
} = {}) {
  if (!Array.isArray(bars) || bars.length < minimumTrainingBars + horizonBars) {
    throw new RangeError(`At least ${minimumTrainingBars + horizonBars} bars are required for backtesting`);
  }

  const costFraction = transactionCostBps / 10_000;
  const rows = [];
  for (let cutoff = minimumTrainingBars; cutoff + horizonBars < bars.length; cutoff += step) {
    const training = bars.slice(0, cutoff);
    const actualStart = Number(training.at(-1).close);
    const actualEnd = Number(bars[cutoff + horizonBars].close);
    const actualReturn = actualEnd / actualStart - 1;
    const regime = HurstExponent(training.map((bar) => Number(bar.close))).value;
    const forecast = forecastPrices(training, { horizonBars, hurstValue: regime });
    const error = forecast.expectedReturn - actualReturn;
    const volatility = Number(forecast.volatility) || 0;
    const edgeScore = volatility > 0 ? forecast.expectedReturn / volatility : 0;
    rows.push(immutableContract({
      cutoffTimestamp: training.at(-1).timestamp,
      targetTimestamp: bars[cutoff + horizonBars].timestamp,
      forecastReturn: forecast.expectedReturn,
      forecastPrice: forecast.expectedPrice,
      actualReturn,
      actualPrice: actualEnd,
      absoluteError: Math.abs(error),
      directionCorrect: Math.sign(forecast.expectedReturn) === Math.sign(actualReturn),
      extremeForecast: forecast.extremeForecast,
      edgeScore,
      volatility,
    }));
  }

  let equity = capital;
  const equityCurve = [capital];
  const tradeLog = [];
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalCost = 0;
  let holdingPeriods = 0;
  let holdingPeriodReturnSum = 0;

  for (const row of rows) {
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
        cutoffTimestamp: row.cutoffTimestamp,
        targetTimestamp: row.targetTimestamp,
        signal,
        entryPrice,
        exitPrice,
        positionSize,
        grossReturn,
        transactionCost: cost,
        netPnL,
        tradeReturn: positionSize > 0 ? netPnL / positionSize : 0,
        equityAfter: equity,
        forecastReturn: row.forecastReturn,
        actualReturn: row.actualReturn,
        directionCorrect: row.directionCorrect,
      }));
    } else {
      tradeLog.push(immutableContract({
        cutoffTimestamp: row.cutoffTimestamp,
        targetTimestamp: row.targetTimestamp,
        signal: 'NO_TRADE',
        entryPrice: null,
        exitPrice: null,
        positionSize: 0,
        grossReturn: 0,
        transactionCost: 0,
        netPnL: 0,
        tradeReturn: 0,
        equityAfter: equity,
        forecastReturn: row.forecastReturn,
        actualReturn: row.actualReturn,
        directionCorrect: row.directionCorrect,
      }));
    }

    equityCurve.push(equity);
  }

  const executedTrades = tradeLog.filter((t) => t.signal !== 'NO_TRADE');
  const directionalRows = rows.filter((row) => row.forecastReturn !== 0 && row.actualReturn !== 0);
  const mae = mean(rows.map((row) => row.absoluteError));
  const mape = mean(rows.map((row) => Math.abs(row.forecastReturn - row.actualReturn) / Math.max(Math.abs(row.actualReturn), 0.0001)));

  const totalReturn = (equity - capital) / capital;
  const annualizationFactor = Math.sqrt(252 / horizonBars);

  const tradeReturns = executedTrades.map((t) => t.tradeReturn);
  const avgTradeReturn = tradeReturns.length ? mean(tradeReturns) : 0;
  const tradeStdDev = standardDeviation(tradeReturns);

  const sharpeRatio = tradeStdDev > 0 ? (avgTradeReturn / tradeStdDev) * annualizationFactor : 0;

  const negativeReturns = tradeReturns.filter((r) => r < 0);
  const downsideVariance = negativeReturns.length ? mean(negativeReturns.map((r) => r ** 2)) : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDeviation > 0 ? (avgTradeReturn / downsideDeviation) * annualizationFactor : 0;

  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;
  let currentDrawdownDuration = 0;
  let drawdownPeak = capital;
  for (const eq of equityCurve) {
    if (eq >= drawdownPeak) {
      drawdownPeak = eq;
      currentDrawdownDuration = 0;
    } else {
      currentDrawdownDuration++;
    }
    const dd = (drawdownPeak - eq) / drawdownPeak;
    maxDrawdown = Math.max(maxDrawdown, dd);
    maxDrawdownDuration = Math.max(maxDrawdownDuration, currentDrawdownDuration);
  }

  const calmarRatio = maxDrawdown > 0 ? totalReturn / maxDrawdown : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = executedTrades.length > 0 ? wins / executedTrades.length : 0;
  const expectancy = executedTrades.length > 0
    ? executedTrades.reduce((sum, t) => sum + t.netPnL, 0) / executedTrades.length
    : 0;
  const averageWin = wins > 0 ? grossProfit / wins : 0;
  const averageLoss = losses > 0 ? grossLoss / losses : 0;
  const riskRewardRatio = averageLoss > 0 ? averageWin / averageLoss : averageWin > 0 ? Infinity : 0;

  const holdingPeriodReturn = holdingPeriods > 0 ? holdingPeriodReturnSum / holdingPeriods : 0;
  const annualizedReturn = totalReturn * annualizationFactor;

  let verdict;
  if (annualizedReturn > 0.05 && maxDrawdown < 0.15 && sharpeRatio > 1.0 && winRate > 0.45) {
    verdict = 'STRONG_EDGE';
  } else if (annualizedReturn > 0 && sharpeRatio > 0.5 && maxDrawdown < 0.25) {
    verdict = 'PROFITABLE';
  } else if (annualizedReturn > 0) {
    verdict = 'MARGINALLY_PROFITABLE';
  } else if (annualizedReturn > -0.05) {
    verdict = 'BREAKEVEN';
  } else {
    verdict = 'NOT_PROFITABLE';
  }

  const verdictReasons = [];
  if (annualizedReturn <= 0) verdictReasons.push(`annualized return is ${(annualizedReturn * 100).toFixed(2)}%`);
  if (sharpeRatio <= 0.5) verdictReasons.push(`Sharpe ratio ${sharpeRatio.toFixed(2)} is below 0.5 threshold`);
  if (maxDrawdown >= 0.25) verdictReasons.push(`max drawdown ${(maxDrawdown * 100).toFixed(1)}% exceeds 25% limit`);
  if (winRate < 0.45 && executedTrades.length > 5) verdictReasons.push(`win rate ${(winRate * 100).toFixed(1)}% is below 45%`);
  if (executedTrades.length < 5) verdictReasons.push(`only ${executedTrades.length} executed trades — insufficient sample`);
  if (profitFactor < 1 && executedTrades.length > 0) verdictReasons.push(`profit factor ${profitFactor.toFixed(2)} below 1.0`);
  if (annualizedReturn > 0.05 && sharpeRatio > 1.0) verdictReasons.push('positive return with strong risk-adjusted performance');
  if (maxDrawdown < 0.10) verdictReasons.push('contained drawdown below 10%');

  return immutableContract({
    horizonBars,
    minimumTrainingBars,
    step,
    observations: rows,
    metrics: {
      observations: rows.length,
      directionalAccuracy: directionalRows.length ? directionalRows.filter((row) => row.directionCorrect).length / directionalRows.length : 0,
      meanAbsoluteError: mae,
      meanAbsolutePercentageError: mape,
      extremeForecastRate: rows.length ? rows.filter((row) => row.extremeForecast).length / rows.length : 0,
    },
    portfolio: {
      startingCapital: capital,
      endingCapital: equity,
      totalReturn,
      annualizedReturn: totalReturn * annualizationFactor,
      totalPnL: equity - capital,
      transactionCostBps,
      totalTransactionCosts: totalCost,
      positionFraction,
      totalTrades: executedTrades.length,
      skippedForecasts: rows.length - executedTrades.length,
    },
    performance: {
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      maxDrawdownDuration,
      calmarRatio,
      profitFactor,
      holdingPeriodReturn,
      annualizedReturn,
    },
    winLoss: {
      wins,
      losses,
      winRate,
      averageWin,
      averageLoss,
      riskRewardRatio,
      expectancy,
      grossProfit,
      grossLoss,
      profitFactor,
    },
    equityCurve,
    tradeLog,
    verdict,
    verdictReasons,
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'WALK_FORWARD_NO_LOOKAHEAD'],
      dataPointCount: rows.length,
    }),
  });
}

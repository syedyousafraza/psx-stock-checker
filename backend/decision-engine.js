import { dataVerification, immutableContract } from './contracts.js';
import { positionSizing } from './risk-engine.js';

function returnsFrom(bars) {
  return bars.slice(1).map((bar, index) => Math.log(Number(bar.close) / Number(bars[index].close)));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function regimeFromHurst(hurst) {
  if (hurst > 0.58) return 'STRONG_TREND';
  if (hurst > 0.52) return 'WEAK_TREND';
  if (hurst < 0.42) return 'STRONG_MEAN_REVERSION';
  if (hurst < 0.48) return 'WEAK_MEAN_REVERSION';
  return 'RANDOM_WALK';
}

function convictionScore(prediction, hurst, adf, risk, catalyst) {
  let score = 0;
  const factors = {};
  
  const edgeScore = prediction.volatility > 0 ? Math.abs(prediction.expectedReturn) / prediction.volatility : 0;
  factors.edge = Math.min(1, edgeScore / 2);
  score += factors.edge * 0.25;
  
  const hurstRegime = regimeFromHurst(hurst.value);
  const regimeAlign = prediction.factors?.regimeProb?.trend > 0.5 && hurstRegime.includes('TREND') ||
                      prediction.factors?.regimeProb?.meanReversion > 0.5 && hurstRegime.includes('MEAN_REVERSION');
  factors.regimeAlignment = regimeAlign ? 1 : 0.3;
  score += factors.regimeAlignment * 0.2;
  
  factors.stationarity = adf.stationary ? 0.8 : 0.4;
  score += factors.stationarity * 0.15;
  
  factors.riskAdjusted = risk.authorized ? 1 : 0;
  score += factors.riskAdjusted * 0.15;
  
  factors.extremeCheck = !prediction.extremeForecast ? 1 : 0;
  score += factors.extremeCheck * 0.1;
  
  const catalystDir = catalyst?.classification?.direction;
  const predDir = prediction.direction;
  const catalystAlign = (catalystDir === 'POSITIVE' && predDir === 'UP') || 
                        (catalystDir === 'NEGATIVE' && predDir === 'DOWN');
  factors.catalystAlignment = catalystDir === 'UNAVAILABLE' ? 0.5 : (catalystAlign ? 1 : 0);
  score += factors.catalystAlignment * 0.1;
  
  factors.confidence = prediction.confidence || 0.5;
  score += factors.confidence * 0.05;
  
  return { score: Math.min(1, score), factors };
}

function signalQuality(prediction, hurst, bars) {
  const volatility = prediction.volatility;
  const expectedReturn = Math.abs(prediction.expectedReturn);
  
  if (volatility === 0) return { quality: 0, reason: 'Zero volatility' };
  
  const sharpe = expectedReturn / volatility;
  const signalToNoise = sharpe;
  
  const regime = regimeFromHurst(hurst.value);
  let regimeBonus = 0;
  if (regime === 'STRONG_TREND' && prediction.direction !== 'UNCERTAIN') regimeBonus = 0.2;
  if (regime === 'STRONG_MEAN_REVERSION' && prediction.direction !== 'UNCERTAIN') regimeBonus = 0.1;
  
  const quality = Math.min(1, signalToNoise / 1.5 + regimeBonus);
  
  return { quality, signalToNoise, regime, regimeBonus };
}

function computeEntryExit(prediction, bars, signal) {
  const lastPrice = prediction.lastPrice;
  const expectedPrice = prediction.expectedPrice;
  const volatility = prediction.volatility;
  const horizon = prediction.horizonBars;
  
  const atr = volatility * Math.sqrt(horizon) * lastPrice;
  
  const entryPrice = lastPrice;
  const stopLoss = signal === 'BUY' ? entryPrice - 1.5 * atr : entryPrice + 1.5 * atr;
  const takeProfit = signal === 'BUY' ? entryPrice + 2.5 * atr : entryPrice - 2.5 * atr;
  
  const riskReward = Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss);
  
  return { entryPrice, stopLoss, takeProfit, riskReward, atr };
}

export function generateSignal({ bars, hurst, adf, prediction, risk, quote, catalyst }, { 
  minimumBars = 50, 
  threshold = 0.5, 
  minimumMedianVolume = 100_000, 
  allowPaperWithoutSpread = true,
  minConviction = 0.4,
  minQuality = 0.3,
  allowShort = false,
} = {}) {
  if (!Array.isArray(bars) || bars.length < minimumBars) {
    throw new RangeError(`At least ${minimumBars} verified bars are required for a signal`);
  }
  
  const returns = returnsFrom(bars);
  const volatility = Number(prediction?.volatility);
  const expectedReturn = Number(prediction?.expectedReturn);
  const edgeScore = volatility > 0 ? expectedReturn / volatility : 0;
  const persistence = Number(hurst?.value);
  const hurstRegime = regimeFromHurst(persistence);
  
  const conviction = convictionScore(prediction, hurst, adf, risk, catalyst);
  const quality = signalQuality(prediction, hurst, bars);
  
  const volumes = bars.map((bar) => Number(bar.volume)).filter(Number.isFinite).sort((a, b) => a - b);
  const medianVolume = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0;
  const liquidity = { medianVolume, minimumMedianVolume, pass: medianVolume >= minimumMedianVolume };
  
  const spread = {
    bid: Number.isFinite(Number(quote?.bid)) ? Number(quote.bid) : null,
    ask: Number.isFinite(Number(quote?.ask)) ? Number(quote.ask) : null,
    bps: Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)) && Number(quote.bid) > 0
      ? ((Number(quote.ask) - Number(quote.bid)) / Number(quote.bid)) * 10_000 : null,
    pass: Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)),
    status: Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)) ? 'VERIFIED' : 'UNAVAILABLE',
  };
  
  let directionalSignal = 'NO_TRADE';
  if (!prediction.extremeForecast && Math.abs(edgeScore) >= threshold) {
    if (edgeScore > 0 && (persistence > 0.52 || prediction.factors?.regimeProb?.trend > 0.5)) {
      directionalSignal = 'BUY';
    } else if (edgeScore < 0 && allowShort && (persistence > 0.52 || prediction.factors?.regimeProb?.meanReversion > 0.5)) {
      directionalSignal = 'SELL';
    }
  }
  
  const riskGate = Boolean(risk?.authorized) && liquidity.pass && (spread.pass || allowPaperWithoutSpread);
  const convictionGate = conviction.score >= minConviction;
  const qualityGate = quality.quality >= minQuality;
  const extremeGate = !prediction.extremeForecast;
  
  const direction = (directionalSignal !== 'NO_TRADE' && riskGate && convictionGate && qualityGate && extremeGate) 
    ? directionalSignal : 'NO_TRADE';
  
  let positionSize = null;
  let entryExit = null;
  if (direction !== 'NO_TRADE') {
    positionSize = positionSizing({
      signal: { direction, edgeScore, allowShort },
      volatility,
      capital: Number(process.env.PAPER_CAPITAL || 1_000_000),
      conviction: conviction.score,
    });
    entryExit = computeEntryExit(prediction, bars, direction);
  }
  
  const confidence = Math.min(0.99, conviction.score * quality.quality);
  
  const reasons = [
    `edge score ${edgeScore.toFixed(3)} (threshold ${threshold})`,
    `Hurst ${persistence.toFixed(3)} (${hurstRegime})`,
    `ADF ${adf.stationary ? 'stationary' : 'non-stationary'} (p=${adf.pValue?.toFixed(4) || 'N/A'})`,
    `conviction ${(conviction.score * 100).toFixed(1)}% (min ${(minConviction * 100).toFixed(0)}%)`,
    `signal quality ${(quality.quality * 100).toFixed(1)}% (min ${(minQuality * 100).toFixed(0)}%)`,
  ];
  
  if (directionalSignal === 'NO_TRADE') reasons.push('forecast edge below threshold or regime misaligned');
  if (prediction.extremeForecast) reasons.push('projected move outside conservative historical range');
  if (!risk?.authorized) reasons.push('VaR/CVaR or Kelly risk gate failed');
  if (!liquidity.pass) reasons.push(`median volume ${medianVolume.toFixed(0)} below ${minimumMedianVolume}`);
  if (!spread.pass) reasons.push('bid/ask spread unavailable from official PSX snapshot');
  if (!convictionGate) reasons.push(`conviction ${(conviction.score * 100).toFixed(1)}% below minimum`);
  if (!qualityGate) reasons.push(`signal quality ${(quality.quality * 100).toFixed(1)}% below minimum`);
  if (!allowShort && directionalSignal === 'SELL') reasons.push('short selling not permitted in current config');
  
  const signalObj = immutableContract({
    signal: direction,
    directionalSignal,
    conviction: conviction.score,
    convictionFactors: conviction.factors,
    quality: quality.quality,
    qualityDetails: quality,
    confidence,
    edgeScore,
    horizonBars: prediction.horizonBars,
    expectedReturn,
    expectedPrice: prediction.expectedPrice,
    paperOnly: true,
    executionAuthorized: false,
    riskGate,
    convictionGate,
    qualityGate,
    extremeGate,
    spreadGate: spread.pass,
    paperSignalWithoutSpread: allowPaperWithoutSpread && !spread.pass,
    positionSize,
    entryExit,
    risk,
    liquidity,
    spread,
    hurstRegime,
    regimeAlignment: conviction.factors.regimeAlignment,
    catalystAlignment: conviction.factors.catalystAlignment,
    reasons,
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX', 'PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT'],
      dataPointCount: bars.length,
      divergenceScore: 0,
    }),
  });
  
  return signalObj;
}

export function signalToOrder(signal, { 
  symbol, 
  accountId, 
  orderType = 'LIMIT',
  timeInForce = 'DAY',
} = {}) {
  if (signal.signal === 'NO_TRADE' || !signal.positionSize) return null;
  
  return immutableContract({
    symbol,
    accountId,
    side: signal.signal,
    quantity: Math.floor(signal.positionSize.notional / signal.entryExit.entryPrice),
    orderType,
    limitPrice: signal.entryExit.entryPrice,
    stopPrice: signal.entryExit.stopLoss,
    takeProfit: signal.entryExit.takeProfit,
    timeInForce,
    conviction: signal.conviction,
    quality: signal.quality,
    expectedReturn: signal.expectedReturn,
    horizonBars: signal.horizonBars,
    metadata: {
      edgeScore: signal.edgeScore,
      hurstRegime: signal.hurstRegime,
      riskReward: signal.entryExit.riskReward,
      reasons: signal.reasons,
    },
  });
}
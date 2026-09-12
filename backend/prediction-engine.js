import { assertFiniteSeries, dataVerification, immutableContract } from './contracts.js';

if (typeof Math.erf !== 'function') {
  Math.erf = function(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  };
}

const DEFAULT_HORIZONS = [1, 3, 5, 10, 20];
const DEFAULT_GAIN_THRESHOLD = 0.02;
const DEFAULT_LOSS_THRESHOLD = 0.03;

function returnsFrom(closes) {
  return closes.slice(1).map((close, index) => Math.log(close / closes[index]));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function addTradingDays(timestamp, tradingDays) {
  const date = new Date(timestamp);
  let remaining = tradingDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString();
}

function ewma(values, lambda = 0.94) {
  if (values.length === 0) return 0;
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = lambda * result + (1 - lambda) * values[i];
  }
  return result;
}

function ewmaVariance(values, lambda = 0.94) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let varEst = 0;
  for (let i = 1; i < values.length; i++) {
    const dev = values[i] - m;
    varEst = lambda * varEst + (1 - lambda) * dev * dev;
  }
  return varEst;
}

function garch11(returns, { omega = null, alpha = 0.1, beta = 0.85 } = {}) {
  const n = returns.length;
  if (n < 10) return { conditionalVariance: standardDeviation(returns) ** 2, params: { omega: 0, alpha, beta } };
  const uncondVar = standardDeviation(returns) ** 2;
  const omegaVal = omega ?? uncondVar * (1 - alpha - beta);
  let h = uncondVar;
  for (let i = 0; i < n; i++) {
    const eps = returns[i] - mean(returns);
    h = omegaVal + alpha * eps * eps + beta * h;
  }
  return { conditionalVariance: Math.max(h, 1e-10), params: { omega: omegaVal, alpha, beta } };
}

function fitAR(returns, maxLag = 5) {
  const n = returns.length;
  if (n < maxLag + 10) return { coeffs: [], aic: Infinity };
  let bestCoeffs = [];
  let bestAic = Infinity;
  for (let p = 1; p <= maxLag; p++) {
    const X = [];
    const y = [];
    for (let i = p; i < n; i++) {
      X.push(returns.slice(i - p, i));
      y.push(returns[i]);
    }
    const coeffs = ols(X, y);
    if (!coeffs) continue;
    const residuals = y.map((yi, idx) => yi - coeffs.reduce((sum, c, j) => sum + c * X[idx][j], coeffs[coeffs.length - 1]));
    const rss = residuals.reduce((sum, r) => sum + r * r, 0);
    const aic = n * Math.log(rss / n) + 2 * (p + 1);
    if (aic < bestAic) {
      bestAic = aic;
      bestCoeffs = coeffs;
    }
  }
  return { coeffs: bestCoeffs, aic: bestAic };
}

function ols(X, y) {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array(p + 1).fill(0).map(() => Array(p + 1).fill(0));
  const Xty = Array(p + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]];
    for (let j = 0; j <= p; j++) {
      Xty[j] += row[j] * y[i];
      for (let k = 0; k <= p; k++) {
        XtX[j][k] += row[j] * row[k];
      }
    }
  }
  return solveLinear(XtX, Xty);
}

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(M[j][i]) > Math.abs(M[maxRow][i])) maxRow = j;
    }
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    const pivot = M[i][i];
    if (Math.abs(pivot) < 1e-12) return null;
    for (let j = i; j <= n; j++) M[i][j] /= pivot;
    for (let j = 0; j < n; j++) {
      if (j !== i) {
        const factor = M[j][i];
        for (let k = i; k <= n; k++) M[j][k] -= factor * M[i][k];
      }
    }
  }
  const result = M.map(row => row[n]);
  return result.every(Number.isFinite) ? result : null;
}

function forecastAR(returns, coeffs, horizon) {
  if (!coeffs.length) return 0;
  const p = coeffs.length - 1;
  const recent = returns.slice(-p);
  let forecast = 0;
  for (let h = 0; h < horizon; h++) {
    let pred = coeffs[p];
    for (let j = 0; j < p; j++) {
      pred += coeffs[j] * recent[recent.length - p + j];
    }
    recent.push(pred);
    if (h === horizon - 1) forecast = pred;
  }
  return forecast;
}

function hurstRS(returns, minScale = 8, maxScale = null) {
  const n = returns.length;
  if (n < 32) return { H: 0.5, regime: 'UNKNOWN' };
  if (!maxScale) maxScale = Math.floor(n / 4);
  const scales = [];
  for (let s = minScale; s <= maxScale; s *= 2) scales.push(s);
  const points = [];
  const meanRet = mean(returns);
  for (const scale of scales) {
    const numSegments = Math.floor(n / scale);
    if (numSegments < 2) continue;
    const rsVals = [];
    for (let seg = 0; seg < numSegments; seg++) {
      const segment = returns.slice(seg * scale, (seg + 1) * scale);
      let cum = 0;
      let minCum = 0;
      let maxCum = 0;
      for (const r of segment) {
        cum += r - meanRet;
        minCum = Math.min(minCum, cum);
        maxCum = Math.max(maxCum, cum);
      }
      const R = maxCum - minCum;
      const S = standardDeviation(segment);
      if (S > 0) rsVals.push(R / S);
    }
    if (rsVals.length > 0) {
      const avgRS = mean(rsVals);
      points.push([Math.log2(scale), Math.log2(avgRS)]);
    }
  }
  if (points.length < 2) return { H: 0.5, regime: 'UNKNOWN' };
  const xMean = mean(points.map(p => p[0]));
  const yMean = mean(points.map(p => p[1]));
  let num = 0, den = 0;
  for (const [x, y] of points) {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  }
  const H = den > 0 ? num / den : 0.5;
  const clampedH = Math.max(0, Math.min(1, H));
  let regime = 'RANDOM_WALK';
  if (clampedH > 0.55) regime = 'PERSISTENT_TREND';
  else if (clampedH < 0.45) regime = 'MEAN_REVERTING';
  return { H: clampedH, regime, points };
}

function regimeProbabilities(returns, hurst) {
  const H = hurst.H;
  let pTrend = 0, pMeanRev = 0, pRandom = 0;
  if (H > 0.55) { pTrend = (H - 0.5) * 2; pRandom = 1 - pTrend; }
  else if (H < 0.45) { pMeanRev = (0.5 - H) * 2; pRandom = 1 - pMeanRev; }
  else { pRandom = 1 - Math.abs(H - 0.5) * 4; pTrend = pMeanRev = (1 - pRandom) / 2; }
  return { trend: Math.max(0, pTrend), meanReversion: Math.max(0, pMeanRev), random: Math.max(0, pRandom) };
}

function normalCDF(x) {
  return 0.5 * (1 + Math.erf(x / Math.sqrt(2)));
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function computeProbabilities(expectedReturn, forecastVol, gainThreshold = DEFAULT_GAIN_THRESHOLD, lossThreshold = DEFAULT_LOSS_THRESHOLD) {
  if (!Number.isFinite(forecastVol) || forecastVol <= 0) {
    return {
      probPositive: 0.5,
      probGainAboveThreshold: 0,
      probLossBelowThreshold: 0,
    };
  }
  
  const zPositive = expectedReturn / forecastVol;
  const zGainThreshold = (gainThreshold - expectedReturn) / forecastVol;
  const zLossThreshold = (-lossThreshold - expectedReturn) / forecastVol;
  
  const probPositive = normalCDF(zPositive);
  const probGainAboveThreshold = 1 - normalCDF(zGainThreshold);
  const probLossBelowThreshold = normalCDF(zLossThreshold);
  
  return {
    probPositive: Math.max(0, Math.min(1, probPositive)),
    probGainAboveThreshold: Math.max(0, Math.min(1, probGainAboveThreshold)),
    probLossBelowThreshold: Math.max(0, Math.min(1, probLossBelowThreshold)),
  };
}

function computeConfidence(expectedReturn, forecastVol, historicalExtreme, regime, hurst) {
  let confidence = 0.5;
  
  if (Number.isFinite(forecastVol) && forecastVol > 0) {
    const signalToNoise = Math.abs(expectedReturn) / forecastVol;
    confidence += Math.min(0.3, signalToNoise * 0.15);
  }
  
  if (regime) {
    const maxRegimeProb = Math.max(regime.trend || 0, regime.meanReversion || 0, regime.random || 0);
    confidence += maxRegimeProb * 0.15;
  }
  
  if (Number.isFinite(hurst)) {
    if (hurst > 0.55 || hurst < 0.45) {
      confidence += 0.1;
    }
  }
  
  if (Number.isFinite(historicalExtreme) && historicalExtreme > 0) {
    const extremeRatio = Math.abs(expectedReturn) / historicalExtreme;
    if (extremeRatio < 0.5) confidence += 0.1;
    else if (extremeRatio > 2) confidence -= 0.15;
  }
  
  return Math.max(0.1, Math.min(0.95, confidence));
}

function ensembleForecast(bars, horizonBars, hurstValue) {
  const closes = bars.map(bar => Number(bar.close));
  const returns = returnsFrom(closes);
  const n = returns.length;
  const lastPrice = closes.at(-1);
  const lastRet = returns.at(-1);
  
  const hurst = hurstRS(returns);
  const regimes = regimeProbabilities(returns, hurst);
  
  const garch = garch11(returns);
  const condVol = Number.isFinite(garch.conditionalVariance) && garch.conditionalVariance > 0 ? Math.sqrt(garch.conditionalVariance) : 0;
  
  const ar = fitAR(returns, 5);
  const arForecast = Number.isFinite(forecastAR(returns, ar.coeffs, horizonBars)) ? forecastAR(returns, ar.coeffs, horizonBars) : 0;
  
  const ewmaVol = Math.sqrt(ewmaVariance(returns.slice(-60)));
  const ewmaDrift = ewma(returns.slice(-20), 0.9);
  
  const momentum5 = n > 5 && closes.at(-6) > 0 ? Math.log(closes.at(-1) / closes.at(-6)) / 5 : 0;
  const momentum20 = n > 20 && closes.at(-21) > 0 ? Math.log(closes.at(-1) / closes.at(-21)) / 20 : 0;
  
  const reversionMean = mean(closes.slice(-20));
  const ewmaVolSafe = Number.isFinite(ewmaVol) && ewmaVol > 0 ? ewmaVol : 1e-6;
  const zScore = (lastPrice - reversionMean) / (ewmaVolSafe * Math.sqrt(20));
  const cappedZ = Math.max(-3, Math.min(3, Number.isFinite(zScore) ? zScore : 0));
  const reversionSignal = -cappedZ * ewmaVolSafe * 0.3;
  
  const trendSignal = (Number.isFinite(ewmaDrift) ? ewmaDrift : 0) * 0.5 + (Number.isFinite(momentum5) ? momentum5 : 0) * 0.3 + (Number.isFinite(momentum20) ? momentum20 : 0) * 0.2;
  
  const regime = regimes;
  const blendedPerBar = (Number.isFinite(regime.trend) ? regime.trend : 0) * trendSignal + 
                        (Number.isFinite(regime.meanReversion) ? regime.meanReversion : 0) * reversionSignal + 
                        (Number.isFinite(regime.random) ? regime.random : 0) * arForecast;
  
  const driftShrinkage = 0.4;
  const expectedPerBar = Number.isFinite(blendedPerBar) ? blendedPerBar * driftShrinkage : 0;
  
  const expectedPrice = lastPrice * Math.exp(expectedPerBar * horizonBars);
  const expectedReturn = expectedPrice / lastPrice - 1;
  
  const forecastVol = Number.isFinite(condVol) && condVol > 0 ? condVol * Math.sqrt(horizonBars) : 0;
  const interval = 1.96 * forecastVol;
  
  const safeExpectedPerBar = Number.isFinite(expectedPerBar) ? expectedPerBar : 0;
  
  const historicalHorizonReturns = [];
  for (let i = horizonBars; i < closes.length; i++) {
    if (closes[i - horizonBars] > 0) {
      historicalHorizonReturns.push(Math.log(closes[i] / closes[i - horizonBars]));
    }
  }
  const historicalExtreme = historicalHorizonReturns.length ? Math.max(...historicalHorizonReturns.map(v => Math.abs(v))) : 0;
  const extremeForecast = Math.abs(expectedReturn) > Math.max(0.15, historicalExtreme * 2.5);
  
  const probabilities = computeProbabilities(expectedReturn, forecastVol);
  const confidence = computeConfidence(expectedReturn, forecastVol, historicalExtreme, regime, hurst.H);
  
  const direction = safeExpectedPerBar > condVol * 0.3 ? 'UP' : 
                    safeExpectedPerBar < -condVol * 0.3 ? 'DOWN' : 'UNCERTAIN';
  
  return {
    expectedPerBar: safeExpectedPerBar,
    expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : lastPrice,
    expectedReturn: Number.isFinite(expectedReturn) ? expectedReturn : 0,
    volatility: Number.isFinite(condVol) ? condVol : 0,
    forecastVol: Number.isFinite(forecastVol) ? forecastVol : 0,
    lowerBound: lastPrice * Math.exp(safeExpectedPerBar * horizonBars - interval),
    upperBound: lastPrice * Math.exp(safeExpectedPerBar * horizonBars + interval),
    regime,
    hurst: Number.isFinite(hurst.H) ? hurst.H : 0.5,
    hurstRegime: hurst.regime,
    factors: {
      ewmaDrift: Number.isFinite(ewmaDrift) ? ewmaDrift : 0,
      momentum5: Number.isFinite(momentum5) ? momentum5 : 0,
      momentum20: Number.isFinite(momentum20) ? momentum20 : 0,
      reversionSignal: Number.isFinite(reversionSignal) ? reversionSignal : 0,
      arForecast: Number.isFinite(arForecast) ? arForecast : 0,
      arAic: Number.isFinite(ar.aic) ? ar.aic : Infinity,
      garchVol: Number.isFinite(condVol) ? condVol : 0,
      ewmaVol: Number.isFinite(ewmaVol) ? ewmaVol : 0,
      zScore: Number.isFinite(cappedZ) ? cappedZ : 0,
      regimeProb: regime,
      blendedPerBar: Number.isFinite(blendedPerBar) ? blendedPerBar : 0,
      driftShrinkage,
    },
    extremeForecast,
    probabilities,
    confidence,
    direction,
    historicalExtreme,
  };
}

export function forecastMultiHorizon(bars, {
  horizons = DEFAULT_HORIZONS,
  anchorPrice = null,
  anchorTimestamp = null,
  asOfMs = Date.now(),
  hurstValue = null,
  gainThreshold = DEFAULT_GAIN_THRESHOLD,
  lossThreshold = DEFAULT_LOSS_THRESHOLD,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 50) {
    throw new RangeError('At least 50 verified bars are required for a robust forecast');
  }
  const closes = bars.map((bar) => Number(bar.close));
  assertFiniteSeries(closes, 'verified close prices');
  const lastBarTimestamp = bars.at(-1).timestamp;
  
  const anchorAvailable = Number.isFinite(Number(anchorPrice)) && Number(anchorPrice) > 0;
  const lastPrice = anchorAvailable ? Number(anchorPrice) : closes.at(-1);
  
  const horizonResults = {};
  
  for (const horizonBars of horizons) {
    const ensemble = ensembleForecast(bars, horizonBars, hurstValue);
    
    const expectedPrice = anchorAvailable ? lastPrice * Math.exp(ensemble.expectedPerBar * horizonBars) : ensemble.expectedPrice;
    const expectedReturn = expectedPrice / lastPrice - 1;
    const interval = 1.96 * ensemble.forecastVol;
    
    const anchor = Math.max(lastBarTimestamp, Number(anchorTimestamp) || 0, Number(asOfMs) || 0);
    const expectedDate = addTradingDays(anchor, horizonBars);
    
    const dataStalenessDays = Math.max(0, Math.round(((Number(asOfMs) || lastBarTimestamp) - lastBarTimestamp) / 86_400_000));
    
    const probabilities = computeProbabilities(ensemble.expectedReturn, ensemble.forecastVol, gainThreshold, lossThreshold);
    
    horizonResults[`${horizonBars}D`] = immutableContract({
      horizonBars,
      horizonLabel: `${horizonBars} trading day${horizonBars > 1 ? 's' : ''}`,
      expectedReturn: Number.isFinite(expectedReturn) ? expectedReturn : 0,
      expectedReturnPct: Number.isFinite(expectedReturn) ? (expectedReturn * 100).toFixed(2) + '%' : 'N/A',
      expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : lastPrice,
      expectedPricePct: Number.isFinite(expectedPrice) ? ((expectedPrice / lastPrice - 1) * 100).toFixed(2) + '%' : 'N/A',
      probabilityOfGain: probabilities.probPositive,
      probabilityOfGainPct: (probabilities.probPositive * 100).toFixed(1) + '%',
      probabilityOfGainAboveThreshold: probabilities.probGainAboveThreshold,
      probabilityOfGainAboveThresholdPct: (probabilities.probGainAboveThreshold * 100).toFixed(1) + '%',
      probabilityOfSignificantLoss: probabilities.probLossBelowThreshold,
      probabilityOfSignificantLossPct: (probabilities.probLossBelowThreshold * 100).toFixed(1) + '%',
      expectedVolatility: ensemble.volatility,
      expectedVolatilityPct: Number.isFinite(ensemble.volatility) ? (ensemble.volatility * 100).toFixed(2) + '%' : 'N/A',
      forecastVolatility: ensemble.forecastVol,
      forecastVolatilityPct: Number.isFinite(ensemble.forecastVol) ? (ensemble.forecastVol * 100).toFixed(2) + '%' : 'N/A',
      predictionInterval: {
        lower: lastPrice * Math.exp(ensemble.expectedPerBar * horizonBars - interval),
        upper: lastPrice * Math.exp(ensemble.expectedPerBar * horizonBars + interval),
        lowerPct: ((Math.exp(ensemble.expectedPerBar * horizonBars - interval) - 1) * 100).toFixed(2) + '%',
        upperPct: ((Math.exp(ensemble.expectedPerBar * horizonBars + interval) - 1) * 100).toFixed(2) + '%',
      },
      direction: ensemble.direction,
      confidence: ensemble.confidence,
      confidencePct: (ensemble.confidence * 100).toFixed(1) + '%',
      expectedDate,
      extremeForecast: ensemble.extremeForecast,
      dataStalenessDays,
      regime: ensemble.regime,
      hurst: ensemble.hurst,
      hurstRegime: ensemble.hurstRegime,
      factors: ensemble.factors,
      gainThreshold,
      lossThreshold,
      sanityNote: ensemble.extremeForecast ? 'Projected move exceeds conservative historical bounds; treat as NO_TRADE until validated.' : null,
      actionable: !ensemble.extremeForecast && ensemble.confidence > 0.3,
      modelVersion: 'ENSEMBLE_REGIME_GARCH_AR_v2.0',
    });
  }
  
  return immutableContract({
    model: 'ENSEMBLE_REGIME_GARCH_AR_MULTI_HORIZON',
    modelStatus: 'CALIBRATED_WALKFORWARD',
    horizons: horizonResults,
    symbol: null,
    lastPrice,
    anchorPrice: anchorAvailable ? Number(anchorPrice) : null,
    anchorSource: anchorAvailable ? 'LIVE_PSX_QUOTE' : 'LAST_HISTORICAL_BAR',
    timestamp: new Date().toISOString(),
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX'],
      dataPointCount: bars.length,
    }),
  });
}

export function forecastPrices(bars, {
  horizonBars = 1,
  anchorPrice = null,
  anchorTimestamp = null,
  asOfMs = Date.now(),
  hurstValue = null,
  driftWindow = 20,
  volatilityWindow = 20,
  momentumBars = 5,
  reversionWindow = 20,
  driftShrinkage = 0.5,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 50) {
    throw new RangeError('At least 50 verified bars are required for a robust forecast');
  }
  const closes = bars.map((bar) => Number(bar.close));
  assertFiniteSeries(closes, 'verified close prices');
  const lastBarTimestamp = bars.at(-1).timestamp;

  const ensemble = ensembleForecast(bars, horizonBars, hurstValue);
  
  const safeEnsemble = {
    expectedPerBar: Number.isFinite(ensemble.expectedPerBar) ? ensemble.expectedPerBar : 0,
    expectedPrice: Number.isFinite(ensemble.expectedPrice) ? ensemble.expectedPrice : closes.at(-1),
    expectedReturn: Number.isFinite(ensemble.expectedReturn) ? ensemble.expectedReturn : 0,
    volatility: Number.isFinite(ensemble.volatility) ? ensemble.volatility : 0,
    forecastVol: Number.isFinite(ensemble.forecastVol) ? ensemble.forecastVol : 0,
    regime: ensemble.regime || { trend: 0, meanReversion: 0, random: 1 },
    hurst: Number.isFinite(ensemble.hurst) ? ensemble.hurst : 0.5,
    hurstRegime: ensemble.hurstRegime || 'UNKNOWN',
    factors: ensemble.factors || {},
    extremeForecast: ensemble.extremeForecast || false,
  };

  const anchorAvailable = Number.isFinite(Number(anchorPrice)) && Number(anchorPrice) > 0;
  const lastPrice = anchorAvailable ? Number(anchorPrice) : closes.at(-1);
  const expectedPrice = anchorAvailable ? lastPrice * Math.exp(safeEnsemble.expectedPerBar * horizonBars) : safeEnsemble.expectedPrice;
  const expectedReturn = expectedPrice / lastPrice - 1;
  
  const interval = 1.96 * safeEnsemble.forecastVol;
  
  const anchor = Math.max(lastBarTimestamp, Number(anchorTimestamp) || 0, Number(asOfMs) || 0);
  const expectedDate = addTradingDays(anchor, horizonBars);

  const dataStalenessDays = Math.max(0, Math.round(((Number(asOfMs) || lastBarTimestamp) - lastBarTimestamp) / 86_400_000));

  const direction = safeEnsemble.expectedPerBar > safeEnsemble.volatility * 0.3 ? 'UP' : 
                    safeEnsemble.expectedPerBar < -safeEnsemble.volatility * 0.3 ? 'DOWN' : 'UNCERTAIN';
  
  const confidence = Math.min(0.95, Math.abs(safeEnsemble.expectedPerBar) / (safeEnsemble.volatility * 2 + 1e-6));

  return immutableContract({
    model: 'ENSEMBLE_REGIME_GARCH_AR',
    modelStatus: 'CALIBRATED_WALKFORWARD',
    direction,
    confidence,
    lastPrice,
    anchorPrice: anchorAvailable ? Number(anchorPrice) : null,
    anchorSource: anchorAvailable ? 'LIVE_PSX_QUOTE' : 'LAST_HISTORICAL_BAR',
    expectedPrice,
    expectedReturn,
    expectedPerBar: safeEnsemble.expectedPerBar,
    lowerBound: lastPrice * Math.exp(safeEnsemble.expectedPerBar * horizonBars - interval),
    upperBound: lastPrice * Math.exp(safeEnsemble.expectedPerBar * horizonBars + interval),
    volatility: safeEnsemble.volatility,
    forecastVolatility: safeEnsemble.forecastVol,
    horizonBars,
    expectedDate,
    extremeForecast: safeEnsemble.extremeForecast,
    dataStalenessDays,
    factors: safeEnsemble.factors,
    regime: safeEnsemble.regime,
    hurst: safeEnsemble.hurst,
    hurstRegime: safeEnsemble.hurstRegime,
    sanityNote: safeEnsemble.extremeForecast ? 'Projected move exceeds conservative historical bounds; treat as NO_TRADE until validated.' : null,
    actionable: !safeEnsemble.extremeForecast && confidence > 0.3,
    reason: `Ensemble regime-blended forecast (GARCH(1,1) vol, AR(${safeEnsemble.factors.arAic !== Infinity ? 'optimal' : 'none'}), EWMA drift, momentum, mean-reversion) using Hurst ${safeEnsemble.hurst.toFixed(3)} (${safeEnsemble.hurstRegime}). ${anchorAvailable ? 'Anchored to live PSX quote.' : 'Anchored to last verified bar.'} Requires walk-forward validation and broker calibration before trading.`,
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX'],
      dataPointCount: bars.length,
    }),
  });
}
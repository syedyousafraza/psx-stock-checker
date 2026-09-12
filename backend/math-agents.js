import { assertFiniteSeries, dataVerification, immutableContract } from './contracts.js';

function pricesOf(priceArray) {
  const values = priceArray.map((item) => Number(typeof item === 'number' ? item : item.close));
  assertFiniteSeries(values, 'priceArray');
  return values;
}

function log2(value) {
  return Math.log(value) / Math.log(2);
}

export function HurstExponent(priceArray, { minScale = 8, maxScale = null, method = 'RS' } = {}) {
  const prices = pricesOf(priceArray);
  if (prices.length < 32) throw new RangeError('At least 32 prices are required for Hurst estimation');
  const logReturns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const n = logReturns.length;
  if (!maxScale) maxScale = Math.floor(n / 4);
  
  if (method === 'RS') {
    return hurstRS(logReturns, minScale, maxScale);
  } else if (method === 'DFA') {
    return hurstDFA(logReturns, minScale, maxScale);
  }
  return hurstRS(logReturns, minScale, maxScale);
}

function hurstRS(returns, minScale, maxScale) {
  const scales = [];
  for (let s = minScale; s <= maxScale; s *= 2) scales.push(s);
  const points = [];
  const meanRet = mean(returns);
  
  for (const scale of scales) {
    const numSegments = Math.floor(returns.length / scale);
    if (numSegments < 3) continue;
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
      if (S > 1e-10) rsVals.push(R / S);
    }
    if (rsVals.length >= 2) {
      const avgRS = mean(rsVals);
      points.push([Math.log2(scale), Math.log2(avgRS)]);
    }
  }
  
  if (points.length < 3) {
    return immutableContract({
      value: 0.5,
      regime: 'INSUFFICIENT_DATA',
      scales: points.map(([s]) => 2 ** s),
      confidence: 0,
      dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: returns.length + 1 }),
    });
  }
  
  const { slope, intercept, r2, se } = linearRegression(points);
  const H = Math.max(0, Math.min(1, slope));
  const regime = classifyHurstRegime(H);
  const confidence = Math.max(0, Math.min(1, r2));
  
  return immutableContract({
    value: H,
    regime,
    scales: points.map(([s]) => 2 ** s),
    regression: { slope, intercept, r2, se },
    confidence,
    method: 'RS',
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: returns.length + 1 }),
  });
}

function hurstDFA(returns, minScale, maxScale) {
  const scales = [];
  for (let s = minScale; s <= maxScale; s *= 2) scales.push(s);
  const points = [];
  const cumSum = [];
  let sum = 0;
  for (const r of returns) {
    sum += r;
    cumSum.push(sum);
  }
  const meanCum = mean(cumSum);
  const detrended = cumSum.map(v => v - meanCum);
  
  for (const scale of scales) {
    const numSegments = Math.floor(detrended.length / scale);
    if (numSegments < 3) continue;
    const f2Vals = [];
    for (let seg = 0; seg < numSegments; seg++) {
      const segment = detrended.slice(seg * scale, (seg + 1) * scale);
      const { coeffs } = fitPoly(segment, 1);
      if (!coeffs) continue;
      let rss = 0;
      for (let i = 0; i < segment.length; i++) {
        const fitted = coeffs[0] + coeffs[1] * i;
        rss += (segment[i] - fitted) ** 2;
      }
      f2Vals.push(rss / scale);
    }
    if (f2Vals.length >= 2) {
      const avgF2 = mean(f2Vals);
      points.push([Math.log2(scale), 0.5 * Math.log2(avgF2)]);
    }
  }
  
  if (points.length < 3) return hurstRS(returns, minScale, maxScale);
  
  const { slope, intercept, r2, se } = linearRegression(points);
  const H = Math.max(0, Math.min(1, slope));
  const regime = classifyHurstRegime(H);
  const confidence = Math.max(0, Math.min(1, r2));
  
  return immutableContract({
    value: H,
    regime,
    scales: points.map(([s]) => 2 ** s),
    regression: { slope, intercept, r2, se },
    confidence,
    method: 'DFA',
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: returns.length + 1 }),
  });
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function linearRegression(points) {
  const n = points.length;
  const xMean = mean(points.map(p => p[0]));
  const yMean = mean(points.map(p => p[1]));
  let num = 0, den = 0;
  for (const [x, y] of points) {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  let ssRes = 0, ssTot = 0;
  for (const [x, y] of points) {
    const yPred = slope * x + intercept;
    ssRes += (y - yPred) ** 2;
    ssTot += (y - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const se = n > 2 ? Math.sqrt(ssRes / (n - 2) / (den || 1)) : 0;
  return { slope, intercept, r2, se };
}

function fitPoly(y, degree) {
  const n = y.length;
  const X = Array.from({ length: n }, (_, i) => Array.from({ length: degree + 1 }, (_, d) => i ** d));
  const XtX = Array(degree + 1).fill(0).map(() => Array(degree + 1).fill(0));
  const Xty = Array(degree + 1).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= degree; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k <= degree; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }
  const coeffs = solveLinear(XtX, Xty);
  return { coeffs };
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
  return M.map(row => row[n]);
}

function classifyHurstRegime(H) {
  if (H > 0.58) return 'STRONG_PERSISTENT_TREND';
  if (H > 0.52) return 'PERSISTENT_TREND';
  if (H < 0.42) return 'STRONG_MEAN_REVERTING';
  if (H < 0.48) return 'MEAN_REVERTING';
  return 'RANDOM_WALK';
}

export function adfStatistic(priceArray, { maxLag = null, trend = 'c' } = {}) {
  const prices = pricesOf(priceArray);
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const n = returns.length;
  if (n < 20) throw new RangeError('At least 20 returns required for ADF test');
  
  const lag = maxLag ?? Math.min(12, Math.floor(Math.pow(n, 1/3)));
  const { statistic, pValue, lags, criticalValues } = adfTest(returns, lag, trend);
  const stationary = pValue < 0.05;
  
  return immutableContract({
    statistic,
    pValue,
    lags,
    criticalValues,
    stationary,
    trend,
    method: 'ADF',
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}

function adfTest(series, maxLag, trend) {
  const n = series.length;
  let bestAic = Infinity;
  let bestLag = 0;
  let bestStat = 0;
  let bestPVal = 1;
  
  for (let lag = 0; lag <= maxLag; lag++) {
    const { stat, pVal, aic } = adfRegression(series, lag, trend);
    if (aic < bestAic) {
      bestAic = aic;
      bestLag = lag;
      bestStat = stat;
      bestPVal = pVal;
    }
  }
  
  const cv = adfCriticalValues(n, trend);
  return { statistic: bestStat, pValue: bestPVal, lags: bestLag, criticalValues: cv };
}

function adfRegression(series, lag, trend) {
  const n = series.length;
  const y = series.slice(lag + 1);
  const yLag = series.slice(lag, -1);
  const diffY = series.slice(lag + 1).map((v, i) => v - series[lag + i]);
  
  const X = [];
  for (let i = 0; i < y.length; i++) {
    const row = [yLag[i]];
    if (trend.includes('c')) row.push(1);
    if (trend.includes('t')) row.push(i + 1);
    for (let l = 1; l <= lag; l++) {
      if (lag + i - l >= 0) row.push(series[lag + i] - series[lag + i - l]);
      else row.push(0);
    }
    X.push(row);
  }
  
  const { coeffs, residuals, rss } = olsWithStats(X, y);
  if (!coeffs) return { stat: 0, pVal: 1, aic: Infinity };
  
  const se = Math.sqrt(rss / (y.length - coeffs.length));
  const seBeta = se / Math.sqrt(yLag.reduce((s, v) => s + (v - mean(yLag)) ** 2, 0) || 1);
  const stat = coeffs[0] / (seBeta || 1);
  
  const pVal = adfPValue(stat, y.length, trend);
  const aic = y.length * Math.log(rss / y.length) + 2 * coeffs.length;
  
  return { stat, pVal, aic };
}

function olsWithStats(X, y) {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array(p).fill(0).map(() => Array(p).fill(0));
  const Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }
  const coeffs = solveLinear(XtX, Xty);
  if (!coeffs) return { coeffs: null, residuals: null, rss: Infinity };
  const residuals = y.map((yi, i) => yi - coeffs.reduce((s, c, j) => s + c * X[i][j], 0));
  const rss = residuals.reduce((s, r) => s + r * r, 0);
  return { coeffs, residuals, rss };
}

function adfPValue(stat, n, trend) {
  const cv = adfCriticalValues(n, trend);
  if (stat < cv['1%']) return 0.001;
  if (stat < cv['5%']) return 0.025;
  if (stat < cv['10%']) return 0.075;
  return 0.5;
}

function adfCriticalValues(n, trend) {
  const base = trend === 'nc' ? { '1%': -2.58, '5%': -1.95, '10%': -1.62 } :
               trend === 'c' ? { '1%': -3.43, '5%': -2.86, '10%': -2.57 } :
               { '1%': -3.96, '5%': -3.41, '10%': -3.13 };
  const finiteN = { '1%': 0.5 / Math.sqrt(n), '5%': 0.3 / Math.sqrt(n), '10%': 0.2 / Math.sqrt(n) };
  return {
    '1%': base['1%'] + finiteN['1%'],
    '5%': base['5%'] + finiteN['5%'],
    '10%': base['10%'] + finiteN['10%'],
  };
}

export function KalmanFilter(priceArray, { 
  processNoise = 1e-5, 
  measurementNoise = 1e-2,
  adaptive = true,
  minProcessNoise = 1e-8,
  maxProcessNoise = 1e-3,
} = {}) {
  const prices = pricesOf(priceArray);
  let estimate = prices[0];
  let covariance = 1;
  const track = [];
  
  for (let index = 0; index < prices.length; index++) {
    const price = prices[index];
    const volume = typeof priceArray[index] === 'number' ? 1 : Number(priceArray[index].volume) || 1;
    
    const predictionCovariance = covariance + processNoise * Math.max(1, volume);
    const gain = predictionCovariance / (predictionCovariance + measurementNoise);
    const innovation = price - estimate;
    estimate += gain * innovation;
    covariance = (1 - gain) * predictionCovariance;
    
    if (adaptive && index > 10) {
      const recentInnovations = track.slice(-10).map(t => t.innovation);
      const innovationVar = standardDeviation(recentInnovations) ** 2;
      const predictedInnovationVar = track.slice(-1).reduce((s, t) => s + t.predictionCovariance, 0) / Math.min(10, track.length);
      if (predictedInnovationVar > 0) {
        const ratio = innovationVar / predictedInnovationVar;
        processNoise = Math.max(minProcessNoise, Math.min(maxProcessNoise, processNoise * ratio));
      }
    }
    
    track.push(immutableContract({
      index,
      observedPrice: price,
      filteredPrice: estimate,
      gain,
      covariance,
      innovation,
      predictionCovariance,
      processNoise,
      measurementNoise,
      dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: index + 1 }),
    }));
  }
  
  const smoothed = rtsSmoother(track, prices);
  
  return immutableContract({
    track,
    smoothed,
    finalEstimate: track.at(-1).filteredPrice,
    finalCovariance: track.at(-1).covariance,
    processNoise,
    measurementNoise,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}

function rtsSmoother(track, prices) {
  const n = track.length;
  const smoothed = Array(n);
  smoothed[n - 1] = track[n - 1].filteredPrice;
  let smoothedCov = track[n - 1].covariance;
  
  for (let i = n - 2; i >= 0; i--) {
    const predCov = track[i].covariance + track[i].processNoise;
    const gain = track[i].covariance / predCov;
    smoothed[i] = track[i].filteredPrice + gain * (smoothed[i + 1] - track[i].filteredPrice);
    smoothedCov = track[i].covariance + gain * gain * (smoothedCov - predCov);
  }
  
  return smoothed.map((price, index) => immutableContract({
    index,
    smoothedPrice: price,
    smoothedCovariance: index === n - 1 ? track[index].covariance : smoothedCov,
  }));
}

export function varianceRatioTest(priceArray, { lags = [2, 4, 8, 16] } = {}) {
  const prices = pricesOf(priceArray);
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const n = returns.length;
  const var1 = standardDeviation(returns) ** 2;
  
  const results = lags.map(lag => {
    if (lag >= n) return { lag, vr: 1, stat: 0, pValue: 1 };
    const vrReturns = [];
    for (let i = 0; i + lag < n; i += lag) {
      vrReturns.push(returns.slice(i, i + lag).reduce((s, v) => s + v, 0));
    }
    const varLag = standardDeviation(vrReturns) ** 2;
    const vr = var1 > 0 ? varLag / (lag * var1) : 1;
    const se = Math.sqrt((2 * (2 * lag - 1) * (lag - 1)) / (3 * lag * n));
    const stat = (vr - 1) / se;
    const pValue = 2 * (1 - normalCDF(Math.abs(stat)));
    return { lag, vr, stat, pValue, se };
  });
  
  return immutableContract({
    results,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}

function normalCDF(x) {
  return 0.5 * (1 + Math.erf(x / Math.sqrt(2)));
}

export function halfLifeMeanReversion(priceArray) {
  const prices = pricesOf(priceArray);
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const y = returns.slice(1);
  const x = returns.slice(0, -1);
  const n = y.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((s, xi, i) => s + xi * y[i], 0);
  const sumXX = x.reduce((s, xi) => s + xi * xi, 0);
  const beta = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const alpha = (sumY - beta * sumX) / n;
  const halfLife = beta > 0 ? Math.log(2) / beta : Infinity;
  return immutableContract({
    halfLife,
    alpha,
    beta,
    meanReversionSpeed: beta,
    longRunMean: alpha / (1 - beta),
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}
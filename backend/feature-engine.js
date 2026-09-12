import { dataVerification, immutableContract } from './contracts.js';

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
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

function rollingApply(values, window, fn) {
  const result = [];
  for (let i = window - 1; i < values.length; i++) {
    result.push(fn(values.slice(i - window + 1, i + 1)));
  }
  return result;
}

function zscore(values, window = 20) {
  const rollingMean = rollingApply(values, window, mean);
  const rollingStd = rollingApply(values, window, standardDeviation);
  const result = [];
  for (let i = 0; i < rollingMean.length; i++) {
    result.push(rollingStd[i] > 0 ? (values[i + window - 1] - rollingMean[i]) / rollingStd[i] : 0);
  }
  return result;
}

function returnsFrom(closes) {
  return closes.slice(1).map((close, index) => Math.log(close / closes[index]));
}

export function computeFeatures(bars, { 
  windows = [5, 10, 20, 50, 100],
  returnWindows = [1, 2, 5, 10, 20],
  volumeWindows = [5, 10, 20, 50],
} = {}) {
  const minBars = Math.max(...windows, ...returnWindows, ...volumeWindows) + 10;
  if (!Array.isArray(bars) || bars.length < minBars) {
    return { features: {}, featureNames: [], featureMatrix: [], timestamps: [], returns: [], dataVerification: dataVerification({ sourceSignatures: ['FEATURE_ENGINEERING_PIPELINE'], dataPointCount: bars.length }) };
  }
  
  const closes = bars.map(b => Number(b.close));
  const volumes = bars.map(b => Number(b.volume));
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const opens = bars.map(b => Number(b.open));
  const returns = returnsFrom(closes);
  const logReturns = returns;
  
  const features = {
    timestamp: bars.slice(1).map(b => b.timestamp),
    returns: logReturns,
    
    // Return features
    returnLags: returnWindows.map(w => 
      rollingApply(logReturns, w, arr => arr[arr.length - 1])
    ),
    returnMean: returnWindows.map(w => rollingApply(logReturns, w, mean)),
    returnStd: returnWindows.map(w => rollingApply(logReturns, w, standardDeviation)),
    returnSkew: returnWindows.map(w => rollingApply(logReturns, w, skew)),
    returnKurt: returnWindows.map(w => rollingApply(logReturns, w, kurtosis)),
    
    // Volatility features
    realizedVol: windows.map(w => rollingApply(logReturns, w, standardDeviation)),
    ewmaVol: rollingApply(logReturns, 20, arr => Math.sqrt(ewmaVariance(arr))),
    garchVol: computeGarchVol(logReturns),
    parkinsonVol: windows.map(w => rollingApply(highs.slice(1), w, parkinsonVol)),
    garmanKlassVol: windows.map(w => rollingApply([highs.slice(1), lows.slice(1), opens.slice(1), closes.slice(1)], w, garmanKlass)),
    
    // Trend features
    sma: windows.map(w => rollingApply(closes, w, mean)),
    ema: windows.map(w => rollingApply(closes, w, arr => ewma(arr, 2 / (w + 1)))),
    macd: computeMACD(closes),
    adx: computeADX(highs, lows, closes, 14),
    aroon: computeAroon(highs, lows, 25),
    
    // Mean reversion features
    bollinger: computeBollinger(closes, 20, 2),
    rsi: computeRSI(closes, 14),
    stochRSI: computeStochRSI(closes, 14, 14),
    zscore: zscore(closes, 20),
    hurst: computeRollingHurst(logReturns, 100),
    
    // Volume features
    volumeMean: volumeWindows.map(w => rollingApply(volumes.slice(1), w, mean)),
    volumeStd: volumeWindows.map(w => rollingApply(volumes.slice(1), w, standardDeviation)),
    volumeZScore: zscore(volumes.slice(1), 20),
    obv: computeOBV(closes, volumes),
    vwap: computeVWAP(highs, lows, closes, volumes),
    volumePriceTrend: computeVPT(closes, volumes),
    mfi: computeMFI(highs, lows, closes, volumes, 14),
    
    // Microstructure features
    spread: computeSpread(highs, lows, closes),
    amihud: computeAmihud(returns, volumes.slice(1)),
    rollSpread: computeRollSpread(returns),
    
    // Time features
    dayOfWeek: bars.slice(1).map(b => new Date(b.timestamp).getUTCDay()),
    monthOfYear: bars.slice(1).map(b => new Date(b.timestamp).getUTCMonth()),
    quarterOfYear: bars.slice(1).map(b => Math.floor(new Date(b.timestamp).getUTCMonth() / 3)),
  };
  
  const featureNames = Object.keys(features).filter(k => k !== 'timestamp' && k !== 'returns');
  const featureMatrix = features.timestamp.map((_, i) => 
    featureNames.map(name => {
      const feat = features[name];
      if (Array.isArray(feat[0])) return feat.map(f => f[i] || 0);
      return feat[i] || 0;
    }).flat()
  );
  
  return immutableContract({
    features,
    featureNames,
    featureMatrix,
    timestamps: features.timestamp,
    returns: logReturns,
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX', 'FEATURE_ENGINEERING_PIPELINE'],
      dataPointCount: bars.length,
    }),
  });
}

function skew(values) {
  if (values.length < 3) return 0;
  const m = mean(values);
  const s = standardDeviation(values);
  if (s === 0) return 0;
  return mean(values.map(v => ((v - m) / s) ** 3));
}

function kurtosis(values) {
  if (values.length < 4) return 0;
  const m = mean(values);
  const s = standardDeviation(values);
  if (s === 0) return 0;
  return mean(values.map(v => ((v - m) / s) ** 4)) - 3;
}

function parkinsonVol(highs) {
  if (highs.length < 2) return 0;
  const sum = highs.slice(1).reduce((s, h, i) => s + Math.log(h / highs[i]) ** 2, 0);
  return Math.sqrt(sum / (4 * Math.log(2) * highs.length));
}

function garmanKlass(arrays) {
  const [highs, lows, opens, closes] = arrays;
  if (highs.length < 1) return 0;
  const sum = highs.reduce((s, h, i) => {
    const logHL = Math.log(h / lows[i]);
    const logCO = Math.log(closes[i] / opens[i]);
    return s + 0.5 * logHL ** 2 - (2 * Math.log(2) - 1) * logCO ** 2;
  }, 0);
  return Math.sqrt(Math.max(0, sum / highs.length));
}

function computeGarchVol(returns) {
  const n = returns.length;
  const uncondVar = standardDeviation(returns) ** 2;
  const alpha = 0.1, beta = 0.85;
  const omega = uncondVar * (1 - alpha - beta);
  let h = uncondVar;
  const result = [];
  for (let i = 0; i < n; i++) {
    const eps = returns[i] - mean(returns);
    h = omega + alpha * eps * eps + beta * h;
    result.push(Math.sqrt(Math.max(h, 1e-10)));
  }
  return result;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = rollingApply(closes, fast, arr => ewma(arr, 2 / (fast + 1)));
  const emaSlow = rollingApply(closes, slow, arr => ewma(arr, 2 / (slow + 1)));
  const macd = emaFast.map((f, i) => f - emaSlow[i]);
  const macdSignal = rollingApply(macd, signal, arr => ewma(arr, 2 / (signal + 1)));
  const histogram = macd.map((m, i) => m - macdSignal[i]);
  return { macd, signal: macdSignal, histogram };
}

function computeADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const atr = rollingApply(tr, period, mean);
  const plusDI = rollingApply(plusDM, period, mean).map((v, i) => atr[i] > 0 ? 100 * v / atr[i] : 0);
  const minusDI = rollingApply(minusDM, period, mean).map((v, i) => atr[i] > 0 ? 100 * v / atr[i] : 0);
  const dx = plusDI.map((p, i) => p + minusDI[i] > 0 ? 100 * Math.abs(p - minusDI[i]) / (p + minusDI[i]) : 0);
  const adx = rollingApply(dx, period, mean);
  return { adx, plusDI, minusDI };
}

function computeAroon(highs, lows, period = 25) {
  const n = highs.length;
  const aroonUp = [], aroonDown = [];
  for (let i = period; i < n; i++) {
    const highSlice = highs.slice(i - period, i + 1);
    const lowSlice = lows.slice(i - period, i + 1);
    const highIdx = highSlice.indexOf(Math.max(...highSlice));
    const lowIdx = lowSlice.indexOf(Math.min(...lowSlice));
    aroonUp.push(100 * (period - highIdx) / period);
    aroonDown.push(100 * (period - lowIdx) / period);
  }
  return { aroonUp, aroonDown };
}

function computeBollinger(closes, period = 20, stdDev = 2) {
  const middle = rollingApply(closes, period, mean);
  const std = rollingApply(closes, period, standardDeviation);
  const upper = middle.map((m, i) => m + stdDev * std[i]);
  const lower = middle.map((m, i) => m - stdDev * std[i]);
  const bandwidth = upper.map((u, i) => (u - lower[i]) / middle[i]);
  const percentB = closes.slice(period - 1).map((c, i) => (c - lower[i]) / (upper[i] - lower[i]));
  return { upper, middle, lower, bandwidth, percentB };
}

function computeRSI(closes, period = 14) {
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = rollingApply(gains, period, mean);
  const avgLoss = rollingApply(losses, period, mean);
  const rs = avgGain.map((g, i) => avgLoss[i] > 0 ? g / avgLoss[i] : 100);
  return rs.map(r => 100 - 100 / (1 + r));
}

function computeStochRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
  const rsi = computeRSI(closes, rsiPeriod);
  const rsiSlice = rsi.slice(rsiPeriod - 1);
  const minRSI = rollingApply(rsiSlice, stochPeriod, Math.min);
  const maxRSI = rollingApply(rsiSlice, stochPeriod, Math.max);
  return minRSI.map((min, i) => maxRSI[i] > min ? (rsiSlice[i + stochPeriod - 1] - min) / (maxRSI[i] - min) : 0.5);
}

function computeRollingHurst(returns, window = 100) {
  const result = [];
  for (let i = window; i < returns.length; i++) {
    const windowReturns = returns.slice(i - window, i);
    const hurst = hurstRS(windowReturns);
    result.push(hurst.H);
  }
  return result;
}

function hurstRS(returns) {
  const scales = [8, 16, 32, 64].filter(s => s <= returns.length / 2);
  const points = [];
  const meanRet = mean(returns);
  for (const scale of scales) {
    const numSegments = Math.floor(returns.length / scale);
    if (numSegments < 2) continue;
    const rsVals = [];
    for (let seg = 0; seg < numSegments; seg++) {
      const segment = returns.slice(seg * scale, (seg + 1) * scale);
      let cum = 0, minCum = 0, maxCum = 0;
      for (const r of segment) {
        cum += r - meanRet;
        minCum = Math.min(minCum, cum);
        maxCum = Math.max(maxCum, cum);
      }
      const R = maxCum - minCum;
      const S = standardDeviation(segment);
      if (S > 0) rsVals.push(R / S);
    }
    if (rsVals.length >= 2) points.push([Math.log2(scale), Math.log2(mean(rsVals))]);
  }
  if (points.length < 2) return { H: 0.5 };
  const xMean = mean(points.map(p => p[0]));
  const yMean = mean(points.map(p => p[1]));
  let num = 0, den = 0;
  for (const [x, y] of points) {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  }
  return { H: Math.max(0, Math.min(1, den > 0 ? num / den : 0.5)) };
}

function computeOBV(closes, volumes) {
  let obv = 0;
  const result = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    result.push(obv);
  }
  return result;
}

function computeVWAP(highs, lows, closes, volumes) {
  const typicalPrice = highs.map((h, i) => (h + lows[i] + closes[i]) / 3);
  let cumPV = 0, cumV = 0;
  return typicalPrice.map((tp, i) => {
    cumPV += tp * volumes[i];
    cumV += volumes[i];
    return cumV > 0 ? cumPV / cumV : tp;
  });
}

function computeVPT(closes, volumes) {
  let vpt = 0;
  const result = [0];
  for (let i = 1; i < closes.length; i++) {
    const change = (closes[i] - closes[i - 1]) / closes[i - 1];
    vpt += volumes[i] * change;
    result.push(vpt);
  }
  return result;
}

function computeMFI(highs, lows, closes, volumes, period = 14) {
  const typicalPrice = highs.map((h, i) => (h + lows[i] + closes[i]) / 3);
  const rawMF = typicalPrice.map((tp, i) => tp * volumes[i]);
  const posMF = [], negMF = [];
  for (let i = 1; i < typicalPrice.length; i++) {
    if (typicalPrice[i] > typicalPrice[i - 1]) { posMF.push(rawMF[i]); negMF.push(0); }
    else if (typicalPrice[i] < typicalPrice[i - 1]) { posMF.push(0); negMF.push(rawMF[i]); }
    else { posMF.push(0); negMF.push(0); }
  }
  const posSum = rollingApply(posMF, period, arr => arr.reduce((a, b) => a + b, 0));
  const negSum = rollingApply(negMF, period, arr => arr.reduce((a, b) => a + b, 0));
  return posSum.map((p, i) => p + negSum[i] > 0 ? 100 * p / (p + negSum[i]) : 50);
}

function computeSpread(highs, lows, closes) {
  return highs.map((h, i) => (h - lows[i]) / closes[i]);
}

function computeAmihud(returns, volumes) {
  return returns.map((r, i) => volumes[i] > 0 ? Math.abs(r) / volumes[i] : 0);
}

function computeRollSpread(returns) {
  const cov = [];
  for (let i = 1; i < returns.length; i++) {
    cov.push(returns[i] * returns[i - 1]);
  }
  const avgCov = mean(cov);
  return avgCov < 0 ? 2 * Math.sqrt(-avgCov) : 0;
}

export function selectFeatures(featureMatrix, target, { method = 'mutual_info', k = 20 } = {}) {
  if (method === 'mutual_info') return mutualInfoSelect(featureMatrix, target, k);
  if (method === 'f_regression') return fRegressionSelect(featureMatrix, target, k);
  return { selected: featureMatrix[0].map((_, i) => i), scores: [] };
}

function mutualInfoSelect(X, y, k) {
  const nFeatures = X[0].length;
  const scores = [];
  for (let j = 0; j < nFeatures; j++) {
    const col = X.map(row => row[j]);
    scores.push({ index: j, score: mutualInfo(col, y) });
  }
  scores.sort((a, b) => b.score - a.score);
  return { selected: scores.slice(0, k).map(s => s.index), scores };
}

function mutualInfo(x, y) {
  const bins = 10;
  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  if (xMax === xMin || yMax === yMin) return 0;
  
  const joint = Array(bins).fill(0).map(() => Array(bins).fill(0));
  const mx = Array(bins).fill(0), my = Array(bins).fill(0);
  
  for (let i = 0; i < x.length; i++) {
    const xi = Math.min(bins - 1, Math.floor((x[i] - xMin) / (xMax - xMin) * bins));
    const yi = Math.min(bins - 1, Math.floor((y[i] - yMin) / (yMax - yMin) * bins));
    joint[xi][yi]++;
    mx[xi]++;
    my[yi]++;
  }
  
  let mi = 0;
  const n = x.length;
  for (let xi = 0; xi < bins; xi++) {
    for (let yi = 0; yi < bins; yi++) {
      if (joint[xi][yi] > 0) {
        const pxy = joint[xi][yi] / n;
        const px = mx[xi] / n;
        const py = my[yi] / n;
        mi += pxy * Math.log(pxy / (px * py));
      }
    }
  }
  return mi;
}

function fRegressionSelect(X, y, k) {
  const nFeatures = X[0].length;
  const yMean = mean(y);
  const yVar = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const scores = [];
  for (let j = 0; j < nFeatures; j++) {
    const col = X.map(row => row[j]);
    const xMean = mean(col);
    const cov = col.reduce((s, v, i) => s + (v - xMean) * (y[i] - yMean), 0);
    const xVar = col.reduce((s, v) => s + (v - xMean) ** 2, 0);
    const corr = xVar > 0 && yVar > 0 ? cov / Math.sqrt(xVar * yVar) : 0;
    const fStat = xVar > 0 ? (corr ** 2) * (X.length - 2) / (1 - corr ** 2) : 0;
    scores.push({ index: j, score: Math.max(0, fStat) });
  }
  scores.sort((a, b) => b.score - a.score);
  return { selected: scores.slice(0, k).map(s => s.index), scores };
}

export function normalizeFeatures(featureMatrix, { method = 'standard' } = {}) {
  const nFeatures = featureMatrix[0].length;
  const result = featureMatrix.map(row => [...row]);
  
  if (method === 'standard') {
    const means = Array(nFeatures).fill(0).map((_, j) => mean(featureMatrix.map(row => row[j])));
    const stds = Array(nFeatures).fill(0).map((_, j) => standardDeviation(featureMatrix.map(row => row[j])));
    for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < nFeatures; j++) {
        result[i][j] = stds[j] > 0 ? (result[i][j] - means[j]) / stds[j] : 0;
      }
    }
    return { normalized: result, means, stds };
  }
  
  if (method === 'robust') {
    const medians = Array(nFeatures).fill(0).map((_, j) => {
      const col = featureMatrix.map(row => row[j]).sort((a, b) => a - b);
      return col[Math.floor(col.length / 2)];
    });
    const iqrs = Array(nFeatures).fill(0).map((_, j) => {
      const col = featureMatrix.map(row => row[j]).sort((a, b) => a - b);
      const q1 = col[Math.floor(col.length * 0.25)];
      const q3 = col[Math.floor(col.length * 0.75)];
      return q3 - q1;
    });
    for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < nFeatures; j++) {
        result[i][j] = iqrs[j] > 0 ? (result[i][j] - medians[j]) / iqrs[j] : 0;
      }
    }
    return { normalized: result, medians, iqrs };
  }
  
  return { normalized: result };
}

export function pcaFeatures(featureMatrix, { nComponents = 10, varianceThreshold = 0.95 } = {}) {
  const n = featureMatrix.length;
  const p = featureMatrix[0].length;
  const centered = featureMatrix.map(row => {
    const means = Array(p).fill(0).map((_, j) => mean(featureMatrix.map(r => r[j])));
    return row.map((v, j) => v - means[j]);
  });
  
  const cov = Array(p).fill(0).map(() => Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += centered[k][i] * centered[k][j];
      cov[i][j] = cov[j][i] = sum / (n - 1);
    }
  }
  
  const { eigenvalues, eigenvectors } = eigenDecomposition(cov);
  const totalVar = eigenvalues.reduce((a, b) => a + b, 0);
  let cumVar = 0;
  let k = 0;
  for (let i = 0; i < eigenvalues.length; i++) {
    cumVar += eigenvalues[i] / totalVar;
    if (cumVar >= varianceThreshold || i >= nComponents - 1) { k = i + 1; break; }
  }
  
  const components = eigenvectors.slice(0, k);
  const transformed = centered.map(row => 
    components.map(comp => row.reduce((s, v, j) => s + v * comp[j], 0))
  );
  
  return { transformed, components, eigenvalues, explainedVariance: eigenvalues.slice(0, k).map(v => v / totalVar) };
}

function eigenDecomposition(A) {
  const n = A.length;
  let V = Array(n).fill(0).map((_, i) => Array(n).fill(0).map((_, j) => i === j ? 1 : 0));
  let A_k = A.map(row => [...row]);
  const eigenvalues = Array(n).fill(0);
  
  for (let iter = 0; iter < 50; iter++) {
    const { Q, R } = qrDecomposition(A_k);
    A_k = multiply(R, Q);
    V = multiply(V, Q);
    let converged = true;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (Math.abs(A_k[i][j]) > 1e-10) converged = false;
      }
    }
    if (converged) break;
  }
  
  for (let i = 0; i < n; i++) eigenvalues[i] = A_k[i][i];
  
  const idx = eigenvalues.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  return {
    eigenvalues: idx.map(x => x.v),
    eigenvectors: idx.map(x => V.map(row => row[x.i])),
  };
}

function qrDecomposition(A) {
  const n = A.length;
  const m = A[0].length;
  const Q = Array(n).fill(0).map(() => Array(n).fill(0));
  const R = Array(n).fill(0).map(() => Array(m).fill(0));
  const V = A.map(row => [...row]);
  
  for (let j = 0; j < m; j++) {
    let norm = 0;
    for (let i = 0; i < n; i++) norm += V[i][j] ** 2;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) { R[j][j] = 0; continue; }
    for (let i = 0; i < n; i++) Q[i][j] = V[i][j] / norm;
    for (let k = j; k < m; k++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Q[i][j] * A[i][k];
      R[j][k] = sum;
    }
    for (let k = j + 1; k < m; k++) {
      for (let i = 0; i < n; i++) V[i][k] -= R[j][k] * Q[i][j];
    }
  }
  return { Q, R };
}

function multiply(A, B) {
  const n = A.length;
  const p = A[0].length;
  const m = B[0].length;
  const C = Array(n).fill(0).map(() => Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let k = 0; k < p; k++) sum += A[i][k] * B[k][j];
      C[i][j] = sum;
    }
  }
  return C;
}

export function createMLDataset(bars, { horizon = 5, lookback = 100, targetType = 'return' } = {}) {
  const { featureMatrix, featureNames, timestamps, returns } = computeFeatures(bars);
  const n = featureMatrix.length;
  
  if (n < lookback + horizon) throw new RangeError('Insufficient data for ML dataset');
  
  const X = [];
  const y = [];
  const dates = [];
  
  for (let i = lookback; i < n - horizon; i++) {
    const features = featureMatrix.slice(i - lookback, i).flat();
    X.push(features);
    
    if (targetType === 'return') {
      y.push(returns.slice(i, i + horizon).reduce((a, b) => a + b, 0));
    } else if (targetType === 'direction') {
      const futRet = returns.slice(i, i + horizon).reduce((a, b) => a + b, 0);
      y.push(futRet > 0 ? 1 : 0);
    } else if (targetType === 'volatility') {
      y.push(standardDeviation(returns.slice(i, i + horizon)));
    }
    dates.push(timestamps[i]);
  }
  
  return immutableContract({
    X, y, dates, featureNames: Array(lookback).fill(0).flatMap((_, i) => featureNames.map(n => `${n}_t-${lookback - i}`)),
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX', 'ML_DATASET_CREATION'],
      dataPointCount: X.length,
    }),
  });
}
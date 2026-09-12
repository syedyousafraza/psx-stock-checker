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

export function validateModel(predictions, actuals, { horizon = 1 } = {}) {
  if (predictions.length !== actuals.length) {
    throw new Error('Predictions and actuals must have same length');
  }
  const n = predictions.length;
  if (n < 10) throw new Error('At least 10 observations required for validation');
  
  const errors = predictions.map((p, i) => p - actuals[i]);
  const absErrors = errors.map(e => Math.abs(e));
  const pctErrors = errors.map((e, i) => actuals[i] !== 0 ? Math.abs(e / actuals[i]) : 0);
  
  const directionCorrect = predictions.map((p, i) => Math.sign(p) === Math.sign(actuals[i]) ? 1 : 0);
  
  const mae = mean(absErrors);
  const mse = mean(errors.map(e => e ** 2));
  const rmse = Math.sqrt(mse);
  const mape = mean(pctErrors);
  const directionalAccuracy = mean(directionCorrect);
  
  const bias = mean(errors);
  const overprediction = errors.filter(e => e > 0).length / n;
  const underprediction = errors.filter(e => e < 0).length / n;
  
  const hitRate = directionalAccuracy;
  const precision = directionCorrect.filter((d, i) => d === 1 && predictions[i] > 0).length / 
                    Math.max(1, predictions.filter(p => p > 0).length);
  const recall = directionCorrect.filter((d, i) => d === 1 && actuals[i] > 0).length / 
                 Math.max(1, actuals.filter(a => a > 0).length);
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  
  const corr = correlation(predictions, actuals);
  const r2 = corr ** 2;
  
  const theilU = rmse / (Math.sqrt(mean(predictions.map(p => p ** 2))) + Math.sqrt(mean(actuals.map(a => a ** 2))));
  
  const residuals = errors;
  const ljungBox = ljungBoxTest(residuals, 10);
  const jarqueBera = jarqueBeraTest(residuals);
  
  return immutableContract({
    n,
    horizon,
    mae,
    mse,
    rmse,
    mape,
    directionalAccuracy,
    hitRate,
    precision,
    recall,
    f1Score: f1,
    correlation: corr,
    rSquared: r2,
    theilU,
    bias,
    overpredictionRate: overprediction,
    underpredictionRate: underprediction,
    residuals: {
      mean: mean(residuals),
      std: standardDeviation(residuals),
      skew: skew(residuals),
      kurtosis: kurtosis(residuals),
      ljungBox,
      jarqueBera,
    },
    dataVerification: dataVerification({
      sourceSignatures: ['MODEL_VALIDATION'],
      dataPointCount: n,
    }),
  });
}

function correlation(x, y) {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    denX += (x[i] - mx) ** 2;
    denY += (y[i] - my) ** 2;
  }
  return denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0;
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

function ljungBoxTest(residuals, lags = 10) {
  const n = residuals.length;
  const meanRes = mean(residuals);
  const acf = [];
  for (let k = 1; k <= lags; k++) {
    let num = 0, den = 0;
    for (let i = k; i < n; i++) {
      num += (residuals[i] - meanRes) * (residuals[i - k] - meanRes);
    }
    for (let i = 0; i < n; i++) den += (residuals[i] - meanRes) ** 2;
    acf.push(den > 0 ? num / den : 0);
  }
  let stat = 0;
  for (let k = 1; k <= lags; k++) {
    stat += (acf[k - 1] ** 2) / (n - k);
  }
  stat *= n * (n + 2);
  return { statistic: stat, lags, acf, pValue: 1 - chiSquareCDF(stat, lags) };
}

function jarqueBeraTest(residuals) {
  const n = residuals.length;
  const s = skew(residuals);
  const k = kurtosis(residuals);
  const stat = n / 6 * (s ** 2 + k ** 2 / 4);
  return { statistic: stat, skew: s, kurtosis: k, pValue: 1 - chiSquareCDF(stat, 2) };
}

function chiSquareCDF(x, df) {
  if (x <= 0) return 0;
  const a = df / 2;
  const y = x / 2;
  let sum = 0, term = 1;
  for (let k = 0; k < 100; k++) {
    if (k > 0) term *= y / k;
    sum += term / (a + k);
    if (term < 1e-15) break;
  }
  return sum * Math.exp(-y + a * Math.log(y) - logGamma(a));
}

function logGamma(z) {
  const coef = [76.18009173, -86.50532033, 24.01409822, -1.231739516, 0.120858003e-2, -0.536382e-5];
  let x = z, y = z;
  let tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let i = 0; i < 6; i++) ser += coef[i] / ++y;
  return Math.log(2.5066282746310005 * ser / x) - tmp;
}

export function monitorModelDrift(referencePredictions, referenceActuals, currentPredictions, currentActuals, { 
  window = 50, 
  thresholds = { psi: 0.2, ks: 0.05, mae: 1.5 }
} = {}) {
  if (referencePredictions.length < window || currentPredictions.length < window) {
    throw new Error('Insufficient data for drift monitoring');
  }
  
  const refWindow = referencePredictions.slice(-window);
  const curWindow = currentPredictions.slice(-window);
  const refActuals = referenceActuals.slice(-window);
  const curActuals = currentActuals.slice(-window);
  
  const psi = populationStabilityIndex(refWindow, curWindow);
  const ks = kolmogorovSmirnov(refWindow, curWindow);
  
  const refMae = mean(refWindow.map((p, i) => Math.abs(p - refActuals[i])));
  const curMae = mean(curWindow.map((p, i) => Math.abs(p - curActuals[i])));
  const maeRatio = refMae > 0 ? curMae / refMae : 1;
  
  const refDir = refWindow.map((p, i) => Math.sign(p) === Math.sign(refActuals[i]) ? 1 : 0);
  const curDir = curWindow.map((p, i) => Math.sign(p) === Math.sign(curActuals[i]) ? 1 : 0);
  const dirAccRatio = mean(curDir) / Math.max(0.001, mean(refDir));
  
  const driftDetected = psi > thresholds.psi || ks.pValue < thresholds.ks || maeRatio > thresholds.mae;
  
  return immutableContract({
    window,
    populationStabilityIndex: psi,
    kolmogorovSmirnov: ks,
    maeRatio,
    directionalAccuracyRatio: dirAccRatio,
    driftDetected,
    thresholds,
    alerts: [
      ...(psi > thresholds.psi ? [`PSI ${psi.toFixed(3)} exceeds threshold ${thresholds.psi}`] : []),
      ...(ks.pValue < thresholds.ks ? [`KS test p-value ${ks.pValue.toFixed(4)} below threshold ${thresholds.ks}`] : []),
      ...(maeRatio > thresholds.mae ? [`MAE ratio ${maeRatio.toFixed(2)} exceeds threshold ${thresholds.mae}`] : []),
    ],
    dataVerification: dataVerification({
      sourceSignatures: ['MODEL_DRIFT_MONITORING'],
      dataPointCount: window,
    }),
  });
}

function populationStabilityIndex(ref, cur, bins = 10) {
  const minVal = Math.min(...ref, ...cur);
  const maxVal = Math.max(...ref, ...cur);
  if (maxVal === minVal) return 0;
  
  const binEdges = Array(bins + 1).fill(0).map((_, i) => minVal + (maxVal - minVal) * i / bins);
  
  const refHist = Array(bins).fill(0);
  const curHist = Array(bins).fill(0);
  
  for (const v of ref) {
    const idx = Math.min(bins - 1, Math.floor((v - minVal) / (maxVal - minVal) * bins));
    refHist[idx]++;
  }
  for (const v of cur) {
    const idx = Math.min(bins - 1, Math.floor((v - minVal) / (maxVal - minVal) * bins));
    curHist[idx]++;
  }
  
  const refPct = refHist.map(c => c / ref.length);
  const curPct = curHist.map(c => c / cur.length);
  
  let psi = 0;
  for (let i = 0; i < bins; i++) {
    const r = refPct[i] || 0.0001;
    const c = curPct[i] || 0.0001;
    psi += (c - r) * Math.log(c / r);
  }
  return psi;
}

function kolmogorovSmirnov(ref, cur) {
  const sortedRef = [...ref].sort((a, b) => a - b);
  const sortedCur = [...cur].sort((a, b) => a - b);
  const all = [...sortedRef, ...sortedCur].sort((a, b) => a - b);
  
  let maxDiff = 0;
  for (const v of all) {
    const cdfRef = sortedRef.filter(x => x <= v).length / sortedRef.length;
    const cdfCur = sortedCur.filter(x => x <= v).length / sortedCur.length;
    maxDiff = Math.max(maxDiff, Math.abs(cdfRef - cdfCur));
  }
  
  const n = sortedRef.length * sortedCur.length / (sortedRef.length + sortedCur.length);
  const stat = maxDiff * Math.sqrt(n);
  const pValue = 2 * Math.exp(-2 * stat * stat);
  
  return { statistic: stat, pValue, maxDiff };
}

export function predictionIntervalCoverage(predictions, actuals, intervals, { confidence = 0.95 } = {}) {
  if (predictions.length !== actuals.length || predictions.length !== intervals.length) {
    throw new Error('All arrays must have same length');
  }
  
  const n = predictions.length;
  let covered = 0;
  const widths = [];
  
  for (let i = 0; i < n; i++) {
    const [lower, upper] = intervals[i];
    widths.push(upper - lower);
    if (actuals[i] >= lower && actuals[i] <= upper) covered++;
  }
  
  const coverage = covered / n;
  const expectedCoverage = confidence;
  const coverageDiff = coverage - expectedCoverage;
  
  const avgWidth = mean(widths);
  const widthStd = standardDeviation(widths);
  
  const conditionalCoverage = [];
  for (let i = 1; i < n; i++) {
    const prevCovered = actuals[i - 1] >= intervals[i - 1][0] && actuals[i - 1] <= intervals[i - 1][1];
    const currCovered = actuals[i] >= intervals[i][0] && actuals[i] <= intervals[i][1];
    conditionalCoverage.push(prevCovered === currCovered ? 1 : 0);
  }
  const conditionalCoverageRate = conditionalCoverage.length ? mean(conditionalCoverage) : 0;
  
  return immutableContract({
    n,
    confidence,
    coverage,
    expectedCoverage,
    coverageDiff,
    averageWidth: avgWidth,
    widthStd,
    conditionalCoverageRate,
    undercovered: coverage < expectedCoverage,
    dataVerification: dataVerification({
      sourceSignatures: ['PREDICTION_INTERVAL_VALIDATION'],
      dataPointCount: n,
    }),
  });
}

export function backtestModelValidation(forecastFn, bars, { 
  horizonBars = 5, 
  minimumTrainingBars = 100, 
  step = 5,
  validationWindows = [20, 50, 100]
} = {}) {
  const results = [];
  
  for (let cutoff = minimumTrainingBars; cutoff + horizonBars < bars.length; cutoff += step) {
    const training = bars.slice(0, cutoff);
    const testBars = bars.slice(cutoff, cutoff + horizonBars);
    
    const forecast = forecastFn(training, { horizonBars });
    const actualReturn = Math.log(testBars.at(-1).close / training.at(-1).close);
    
    results.push({
      cutoff: training.at(-1).timestamp,
      predicted: forecast.expectedReturn,
      actual: actualReturn,
      lower: (forecast.lowerBound - training.at(-1).close) / training.at(-1).close,
      upper: (forecast.upperBound - training.at(-1).close) / training.at(-1).close,
      volatility: forecast.volatility,
      extreme: forecast.extremeForecast,
    });
  }
  
  const predictions = results.map(r => r.predicted);
  const actuals = results.map(r => r.actual);
  const intervals = results.map(r => [r.lower, r.upper]);
  
  const validation = validateModel(predictions, actuals, { horizon: horizonBars });
  const intervalValidation = predictionIntervalCoverage(predictions, actuals, intervals);
  
  const windowValidations = validationWindows.map(w => {
    if (results.length < w) return null;
    const recent = results.slice(-w);
    return validateModel(
      recent.map(r => r.predicted),
      recent.map(r => r.actual),
      { horizon: horizonBars }
    );
  }).filter(Boolean);
  
  return immutableContract({
    overall: validation,
    intervals: intervalValidation,
    rollingWindows: windowValidations,
    observations: results.length,
    dataVerification: dataVerification({
      sourceSignatures: ['BACKTEST_MODEL_VALIDATION', 'WALK_FORWARD'],
      dataPointCount: results.length,
    }),
  });
}

export function modelPerformanceReport(validation, { benchmarkReturn = 0 } = {}) {
  const { directionalAccuracy, correlation, rSquared, theilU, mae, rmse, hitRate, f1Score } = validation;
  
  let rating = 'POOR';
  if (directionalAccuracy > 0.55 && correlation > 0.3 && theilU < 0.8) rating = 'GOOD';
  if (directionalAccuracy > 0.6 && correlation > 0.5 && theilU < 0.6) rating = 'EXCELLENT';
  if (directionalAccuracy < 0.5 || correlation < 0.1 || theilU > 1.2) rating = 'FAILING';
  
  return immutableContract({
    rating,
    metrics: {
      directionalAccuracy,
      correlation,
      rSquared,
      theilU,
      mae,
      rmse,
      hitRate,
      f1Score,
    },
    benchmarks: {
      randomDirectional: 0.5,
      randomCorrelation: 0,
      randomTheilU: 1,
    },
    interpretation: {
      directional: directionalAccuracy > 0.55 ? 'Better than random' : 'No better than random',
      correlation: correlation > 0.3 ? 'Meaningful linear relationship' : 'Weak linear relationship',
      theilU: theilU < 1 ? 'Better than naive forecast' : 'Worse than naive forecast',
    },
    recommendations: [
      ...(directionalAccuracy < 0.55 ? ['Consider regime-specific models'] : []),
      ...(correlation < 0.3 ? ['Add more predictive features'] : []),
      ...(theilU > 1 ? ['Reduce forecast variance, increase shrinkage'] : []),
      ...(validation.mape > 0.05 ? ['High percentage errors - check for outliers'] : []),
    ],
  });
}
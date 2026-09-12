import { dataVerification, immutableContract } from './contracts.js';
import { computeFeatures, normalizeFeatures, selectFeatures, pcaFeatures, createMLDataset } from './feature-engine.js';
import { forecastPrices } from './prediction-engine.js';
import { HurstExponent } from './math-agents.js';

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

function normalCDF(x) {
  return 0.5 * (1 + Math.erf(x / Math.sqrt(2)));
}

function computeProbabilities(expectedReturn, forecastVol, gainThreshold = 0.02, lossThreshold = 0.03) {
  if (!Number.isFinite(forecastVol) || forecastVol <= 0) {
    return { probPositive: 0.5, probGainAboveThreshold: 0, probLossBelowThreshold: 0 };
  }
  const zPositive = expectedReturn / forecastVol;
  const zGainThreshold = (gainThreshold - expectedReturn) / forecastVol;
  const zLossThreshold = (-lossThreshold - expectedReturn) / forecastVol;
  return {
    probPositive: Math.max(0, Math.min(1, normalCDF(zPositive))),
    probGainAboveThreshold: Math.max(0, Math.min(1, 1 - normalCDF(zGainThreshold))),
    probLossBelowThreshold: Math.max(0, Math.min(1, normalCDF(zLossThreshold))),
  };
}

function createModelPipeline({ usePCA = false, nComponents = 10, featureSelection = 'mutual_info', nFeatures = 20 } = {}) {
  let normalizer = null;
  let selector = null;
  let pca = null;
  let isFitted = false;
  
  return {
    fit(X, y) {
      if (!X.length || X[0].length === 0) return this;
      
      const normResult = normalizeFeatures(X, { method: 'robust' });
      normalizer = { means: normResult.means, stds: normResult.stds };
      let normalizedX = normResult.normalized;
      
      if (usePCA && normalizedX[0].length > nComponents) {
        const pcaResult = pcaFeatures(normalizedX, { nComponents, varianceThreshold: 0.95 });
        pca = { components: pcaResult.components, means: pcaResult.components[0].map(() => 0) };
        normalizedX = pcaResult.transformed;
      }
      
      if (featureSelection && normalizedX[0].length > nFeatures) {
        const selResult = selectFeatures(normalizedX, y, { method: featureSelection, k: nFeatures });
        selector = { selectedIndices: selResult.selected };
        normalizedX = normalizedX.map(row => selResult.selected.map(idx => row[idx]));
      }
      
      isFitted = true;
      return { normalizedX, featureCount: normalizedX[0].length };
    },
    
    transform(X) {
      if (!isFitted) return X;
      
      let transformed = X.map((row, i) => 
        row.map((val, j) => normalizer.stds[j] > 0 ? (val - normalizer.means[j]) / normalizer.stds[j] : 0)
      );
      
      if (pca) {
        transformed = transformed.map(row => 
          pca.components.map(comp => row.reduce((sum, val, j) => sum + val * comp[j], 0))
        );
      }
      
      if (selector) {
        transformed = transformed.map(row => selector.selectedIndices.map(idx => row[idx]));
      }
      
      return transformed;
    },
    
    isFitted,
  };
}

function simpleLinearRegression(X, y) {
  const n = X.length;
  const p = X[0].length;
  
  if (p === 0 || n < p + 1) {
    return { coeffs: Array(p + 1).fill(0), predict: () => 0 };
  }
  
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
  
  const coeffs = solveLinearSafe(XtX, Xty);
  
  return {
    coeffs: coeffs || Array(p + 1).fill(0),
    predict: (x) => {
      if (!coeffs) return 0;
      return coeffs[0] + x.reduce((sum, val, j) => sum + val * coeffs[j + 1], 0);
    }
  };
}

function solveLinearSafe(A, b) {
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

export function walkForwardMLValidation(bars, {
  horizonBars = 5,
  minimumTrainingBars = 100,
  step = 5,
  purgeBars = 5,
  embargoBars = 2,
  modelPipeline = {},
  targetType = 'return',
  gainThreshold = 0.02,
  lossThreshold = 0.03,
  ...forecastOpts
} = {}) {
  if (!Array.isArray(bars) || bars.length < minimumTrainingBars + horizonBars) {
    throw new RangeError(`At least ${minimumTrainingBars + horizonBars} bars required for walk-forward ML validation`);
  }
  
  const { featureMatrix, featureNames, timestamps, returns } = computeFeatures(bars);
  const mlDataset = createMLDataset(bars, { horizon: horizonBars, lookback: 60, targetType });
  
  const results = [];
  
  for (let cutoff = minimumTrainingBars; cutoff + horizonBars < bars.length; cutoff += step) {
    const trainEnd = cutoff - purgeBars;
    if (trainEnd < minimumTrainingBars) continue;
    
    const trainData = mlDataset.X.slice(0, trainEnd - 60);
    const trainTarget = mlDataset.y.slice(0, trainEnd - 60);
    const trainTimestamps = mlDataset.dates.slice(0, trainEnd - 60);
    
    const testIdx = cutoff - 60;
    if (testIdx < 0 || testIdx >= mlDataset.X.length) continue;
    
    const testData = mlDataset.X[testIdx];
    const testTarget = mlDataset.y[testIdx];
    const testTimestamp = mlDataset.dates[testIdx];
    const actualPrice = bars[cutoff + horizonBars].close;
    const trainLastPrice = bars[trainEnd - 1].close;
    
    const pipeline = createModelPipeline(modelPipeline);
    const fitResult = pipeline.fit(trainData, trainTarget);
    
    if (!fitResult || !fitResult.normalizedX.length) {
      results.push(immutableContract({
        cutoffTimestamp: bars[trainEnd - 1].timestamp,
        targetTimestamp: bars[cutoff + horizonBars].timestamp,
        trainSize: trainData.length,
        testSize: 1,
        status: 'INSUFFICIENT_TRAINING_DATA',
        modelFitted: false,
      }));
      continue;
    }
    
    const model = simpleLinearRegression(fitResult.normalizedX, trainTarget);
    const testTransformed = pipeline.transform([testData]);
    const predictedTarget = model.predict(testTransformed[0]);
    
    let predictedReturn, expectedPrice, probabilities;
    
    if (targetType === 'return') {
      predictedReturn = predictedTarget;
      expectedPrice = trainLastPrice * Math.exp(predictedReturn);
    } else if (targetType === 'direction') {
      predictedReturn = predictedTarget > 0.5 ? 0.01 : -0.01;
      expectedPrice = trainLastPrice * Math.exp(predictedReturn);
    } else {
      predictedReturn = 0;
      expectedPrice = trainLastPrice;
    }
    
    const actualReturn = testTarget;
    
    const closes = bars.slice(0, trainEnd).map(b => b.close);
    const hurst = HurstExponent(closes).value;
    const forecast = forecastPrices(bars.slice(0, trainEnd), { horizonBars, hurstValue: hurst, ...forecastOpts });
    
    const forecastVol = forecast.forecastVolatility || forecast.volatility * Math.sqrt(horizonBars) || 0;
    probabilities = computeProbabilities(predictedReturn, forecastVol, gainThreshold, lossThreshold);
    
    const direction = predictedReturn > forecastVol * 0.3 ? 'UP' : predictedReturn < -forecastVol * 0.3 ? 'DOWN' : 'UNCERTAIN';
    const actualDirection = actualReturn > 0 ? 'UP' : actualReturn < 0 ? 'DOWN' : 'FLAT';
    const directionCorrect = direction === actualDirection || (direction === 'UNCERTAIN' && actualDirection === 'FLAT');
    
    const interval = 1.96 * forecastVol;
    const lowerBound = expectedPrice * Math.exp(-interval);
    const upperBound = expectedPrice * Math.exp(interval);
    const withinInterval = actualPrice >= lowerBound && actualPrice <= upperBound;
    
    const error = predictedReturn - actualReturn;
    
    results.push(immutableContract({
      cutoffTimestamp: bars[trainEnd - 1].timestamp,
      targetTimestamp: bars[cutoff + horizonBars].timestamp,
      trainSize: trainData.length,
      testSize: 1,
      modelFitted: true,
      featuresUsed: fitResult.featureCount,
      predictedReturn,
      predictedReturnPct: (predictedReturn * 100).toFixed(2) + '%',
      actualReturn,
      actualReturnPct: (actualReturn * 100).toFixed(2) + '%',
      expectedPrice,
      actualPrice,
      error,
      absoluteError: Math.abs(error),
      squaredError: error * error,
      direction,
      actualDirection,
      directionCorrect,
      probabilityOfGain: probabilities.probPositive,
      probabilityOfGainAboveThreshold: probabilities.probGainAboveThreshold,
      probabilityOfSignificantLoss: probabilities.probLossBelowThreshold,
      predictionInterval: { lower: lowerBound, upper: upperBound },
      withinInterval,
      hurst,
      regime: forecast.hurstRegime,
      confidence: forecast.confidence,
      modelPipeline: { usePCA: modelPipeline.usePCA, nComponents: modelPipeline.nComponents, featureSelection: modelPipeline.featureSelection, nFeatures: modelPipeline.nFeatures },
    }));
  }
  
  const validResults = results.filter(r => r.modelFitted);
  const predictions = validResults.map(r => r.predictedReturn);
  const actuals = validResults.map(r => r.actualReturn);
  const directions = validResults.map(r => r.directionCorrect ? 1 : 0);
  const intervals = validResults.map(r => r.withinInterval ? 1 : 0);
  const errors = validResults.map(r => r.error);
  const absErrors = validResults.map(r => r.absoluteError);
  const squaredErrors = validResults.map(r => r.squaredError);
  
  const directionalAccuracy = directions.length ? mean(directions) : 0;
  const intervalCoverage = intervals.length ? mean(intervals) : 0;
  const mae = absErrors.length ? mean(absErrors) : 0;
  const mse = squaredErrors.length ? mean(squaredErrors) : 0;
  const rmse = Math.sqrt(mse);
  
  const hitRate = directionalAccuracy;
  const upPredictions = validResults.filter(r => r.direction === 'UP');
  const downPredictions = validResults.filter(r => r.direction === 'DOWN');
  const precision = upPredictions.length ? upPredictions.filter(r => r.directionCorrect).length / upPredictions.length : 0;
  const recall = validResults.filter(r => r.actualDirection === 'UP').length ? 
    validResults.filter(r => r.actualDirection === 'UP' && r.directionCorrect).length / 
    validResults.filter(r => r.actualDirection === 'UP').length : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  
  let verdict = 'INSUFFICIENT_DATA';
  if (validResults.length >= 10) {
    if (directionalAccuracy > 0.55 && rmse < 0.03 && intervalCoverage > 0.8) verdict = 'EXCELLENT';
    else if (directionalAccuracy > 0.52 && rmse < 0.05 && intervalCoverage > 0.7) verdict = 'GOOD';
    else if (directionalAccuracy > 0.5) verdict = 'MARGINAL';
    else verdict = 'POOR';
  }
  
  return immutableContract({
    horizonBars,
    minimumTrainingBars,
    step,
    purgeBars,
    embargoBars,
    targetType,
    modelPipeline,
    observations: results,
    metrics: {
      totalObservations: results.length,
      validObservations: validResults.length,
      directionalAccuracy,
      intervalCoverage,
      meanAbsoluteError: mae,
      meanSquaredError: mse,
      rootMeanSquaredError: rmse,
      hitRate,
      precision,
      recall,
      f1Score: f1,
      avgConfidence: validResults.length ? mean(validResults.map(r => r.confidence)) : 0,
    },
    verdict,
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'WALK_FORWARD_ML_VALIDATION', 'PURGED_EMBARGO', 'NO_LOOKAHEAD'],
      dataPointCount: validResults.length,
    }),
  });
}

export function purgedKFoldCV(bars, {
  nSplits = 5,
  nTestSplits = 1,
  purgeBars = 10,
  embargoBars = 5,
  horizonBars = 5,
  minimumTrainingBars = 100,
  step = 5,
  modelPipeline = {},
  targetType = 'return',
  ...forecastOpts
} = {}) {
  const n = bars.length;
  const testSize = Math.floor(n / nSplits);
  const indices = Array.from({ length: nSplits }, (_, i) => i * testSize);
  const folds = [];
  
  for (let i = 0; i <= nSplits - nTestSplits; i++) {
    const testStart = indices[i];
    const testEnd = indices[i + nTestSplits] || n;
    const trainEnd = testStart - purgeBars;
    const trainStart = 0;
    
    if (trainEnd < minimumTrainingBars) continue;
    
    const trainBars = bars.slice(trainStart, trainEnd);
    const testBars = bars.slice(testStart, testEnd);
    
    const trainResult = walkForwardMLValidation(trainBars, {
      horizonBars,
      minimumTrainingBars,
      step,
      purgeBars: 0,
      embargoBars: 0,
      modelPipeline,
      targetType,
      ...forecastOpts
    });
    
    const testResult = walkForwardMLValidation(testBars, {
      horizonBars,
      minimumTrainingBars: Math.min(minimumTrainingBars, trainBars.length),
      step,
      purgeBars: 0,
      embargoBars: 0,
      modelPipeline,
      targetType,
      ...forecastOpts
    });
    
    folds.push(immutableContract({
      fold: folds.length,
      trainPeriod: { start: trainBars[0].timestamp, end: trainBars.at(-1).timestamp },
      testPeriod: { start: testBars[0].timestamp, end: testBars.at(-1).timestamp },
      trainSize: trainResult.metrics.validObservations,
      testSize: testResult.metrics.validObservations,
      trainMetrics: trainResult.metrics,
      testMetrics: testResult.metrics,
      trainVerdict: trainResult.verdict,
      testVerdict: testResult.verdict,
      overfitCheck: {
        directionalAccuracyDiff: trainResult.metrics.directionalAccuracy - testResult.metrics.directionalAccuracy,
        rmseDiff: trainResult.metrics.rootMeanSquaredError - testResult.metrics.rootMeanSquaredError,
        intervalCoverageDiff: trainResult.metrics.intervalCoverage - testResult.metrics.intervalCoverage,
      },
    }));
  }
  
  const testDirectionalAccuracies = folds.map(f => f.testMetrics.directionalAccuracy);
  const testRmses = folds.map(f => f.testMetrics.rootMeanSquaredError);
  const testIntervalCoverages = folds.map(f => f.testMetrics.intervalCoverage);
  
  return immutableContract({
    folds,
    summary: {
      meanTestDirectionalAccuracy: mean(testDirectionalAccuracies),
      stdTestDirectionalAccuracy: standardDeviation(testDirectionalAccuracies),
      meanTestRMSE: mean(testRmses),
      stdTestRMSE: standardDeviation(testRmses),
      meanTestIntervalCoverage: mean(testIntervalCoverages),
      stdTestIntervalCoverage: standardDeviation(testIntervalCoverages),
      positiveDirectionalFolds: folds.filter(f => f.testMetrics.directionalAccuracy > 0.5).length,
      totalFolds: folds.length,
      consistencyScore: standardDeviation(testDirectionalAccuracies) > 0 ? 
        mean(testDirectionalAccuracies) / standardDeviation(testDirectionalAccuracies) : 0,
    },
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'PURGED_KFOLD_CV', 'NO_LOOKAHEAD'],
      dataPointCount: bars.length,
    }),
  });
}

export function embargoValidation(bars, {
  horizonBars = 5,
  embargoBars = 5,
  minimumTrainingBars = 100,
  step = 5,
  modelPipeline = {},
  targetType = 'return',
  ...forecastOpts
} = {}) {
  const results = [];
  
  for (let cutoff = minimumTrainingBars; cutoff + horizonBars + embargoBars < bars.length; cutoff += step) {
    const training = bars.slice(0, cutoff);
    const embargoEnd = cutoff + embargoBars;
    const targetIdx = embargoEnd + horizonBars;
    
    if (targetIdx >= bars.length) break;
    
    const trainData = createMLDataset(training, { horizon: horizonBars, lookback: 60, targetType });
    if (trainData.X.length < minimumTrainingBars) continue;
    
    const pipeline = createModelPipeline(modelPipeline);
    const fitResult = pipeline.fit(trainData.X, trainData.y);
    
    if (!fitResult || !fitResult.normalizedX.length) continue;
    
    const model = simpleLinearRegression(fitResult.normalizedX, trainData.y);
    
    const testFeatures = computeFeatures(bars.slice(0, embargoEnd));
    const testFeatureVec = testFeatures.featureMatrix[testFeatures.featureMatrix.length - 1];
    const testTransformed = pipeline.transform([testFeatureVec]);
    const predictedTarget = model.predict(testTransformed[0]);
    
    let predictedReturn;
    if (targetType === 'return') {
      predictedReturn = predictedTarget;
    } else {
      predictedReturn = predictedTarget > 0.5 ? 0.01 : -0.01;
    }
    
    const actualPrice = bars[targetIdx].close;
    const trainLastPrice = training.at(-1).close;
    const expectedPrice = trainLastPrice * Math.exp(predictedReturn);
    const actualReturn = actualPrice / trainLastPrice - 1;
    
    const hurst = HurstExponent(training.map(b => b.close)).value;
    const forecast = forecastPrices(training, { horizonBars, hurstValue: hurst, ...forecastOpts });
    const forecastVol = forecast.forecastVolatility || forecast.volatility * Math.sqrt(horizonBars) || 0;
    const probabilities = computeProbabilities(predictedReturn, forecastVol);
    
    const direction = predictedReturn > forecastVol * 0.3 ? 'UP' : predictedReturn < -forecastVol * 0.3 ? 'DOWN' : 'UNCERTAIN';
    const actualDirection = actualReturn > 0 ? 'UP' : actualReturn < 0 ? 'DOWN' : 'FLAT';
    const directionCorrect = direction === actualDirection || (direction === 'UNCERTAIN' && actualDirection === 'FLAT');
    
    const interval = 1.96 * forecastVol;
    const lowerBound = expectedPrice * Math.exp(-interval);
    const upperBound = expectedPrice * Math.exp(interval);
    const withinInterval = actualPrice >= lowerBound && actualPrice <= upperBound;
    
    const error = predictedReturn - actualReturn;
    
    results.push(immutableContract({
      cutoffTimestamp: training.at(-1).timestamp,
      embargoEndTimestamp: bars[embargoEnd].timestamp,
      targetTimestamp: bars[targetIdx].timestamp,
      trainSize: trainData.X.length,
      predictedReturn,
      actualReturn,
      expectedPrice,
      actualPrice,
      error,
      absoluteError: Math.abs(error),
      squaredError: error * error,
      direction,
      actualDirection,
      directionCorrect,
      probabilityOfGain: probabilities.probPositive,
      probabilityOfGainAboveThreshold: probabilities.probGainAboveThreshold,
      probabilityOfSignificantLoss: probabilities.probLossBelowThreshold,
      predictionInterval: { lower: lowerBound, upper: upperBound },
      withinInterval,
      hurst,
      regime: forecast.hurstRegime,
      embargoBars,
    }));
  }
  
  const validResults = results.filter(r => r.predictedReturn !== undefined);
  const directionalAccuracy = validResults.length ? mean(validResults.map(r => r.directionCorrect ? 1 : 0)) : 0;
  const intervalCoverage = validResults.length ? mean(validResults.map(r => r.withinInterval ? 1 : 0)) : 0;
  const mae = validResults.length ? mean(validResults.map(r => r.absoluteError)) : 0;
  const rmse = validResults.length ? Math.sqrt(mean(validResults.map(r => r.squaredError))) : 0;
  
  return immutableContract({
    horizonBars,
    embargoBars,
    minimumTrainingBars,
    step,
    observations: results,
    metrics: {
      totalObservations: results.length,
      validObservations: validResults.length,
      directionalAccuracy,
      intervalCoverage,
      meanAbsoluteError: mae,
      rootMeanSquaredError: rmse,
    },
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'EMBARGO_VALIDATION', 'NO_LOOKAHEAD'],
      dataPointCount: validResults.length,
    }),
  });
}

export function comprehensiveMLValidation(bars, {
  horizons = [1, 3, 5, 10, 20],
  minimumTrainingBars = 100,
  step = 5,
  purgeBars = 5,
  embargoBars = 2,
  nSplits = 5,
  modelPipeline = { usePCA: true, nComponents: 10, featureSelection: 'mutual_info', nFeatures: 20 },
  targetType = 'return',
  gainThreshold = 0.02,
  lossThreshold = 0.03,
  ...forecastOpts
} = {}) {
  const horizonResults = {};
  
  for (const horizonBars of horizons) {
    const wfResult = walkForwardMLValidation(bars, {
      horizonBars,
      minimumTrainingBars,
      step,
      purgeBars,
      embargoBars,
      modelPipeline,
      targetType,
      gainThreshold,
      lossThreshold,
      ...forecastOpts
    });
    
    const cvResult = purgedKFoldCV(bars, {
      nSplits,
      nTestSplits: 2,
      purgeBars: purgeBars * 2,
      embargoBars: embargoBars * 2,
      horizonBars,
      minimumTrainingBars,
      step,
      modelPipeline,
      targetType,
      ...forecastOpts
    });
    
    const embargoResult = embargoValidation(bars, {
      horizonBars,
      embargoBars: embargoBars * 3,
      minimumTrainingBars,
      step,
      modelPipeline,
      targetType,
      ...forecastOpts
    });
    
    horizonResults[`${horizonBars}D`] = {
      walkForward: wfResult,
      purgedCV: cvResult,
      embargoValidation: embargoResult,
    };
  }
  
  const allDirectionalAccuracies = [];
  const allRmses = [];
  const allIntervalCoverages = [];
  
  for (const [horizon, result] of Object.entries(horizonResults)) {
    if (result.walkForward.metrics.validObservations > 0) {
      allDirectionalAccuracies.push(result.walkForward.metrics.directionalAccuracy);
      allRmses.push(result.walkForward.metrics.rootMeanSquaredError);
      allIntervalCoverages.push(result.walkForward.metrics.intervalCoverage);
    }
  }
  
  return immutableContract({
    horizons: horizonResults,
    overallSummary: {
      meanDirectionalAccuracy: allDirectionalAccuracies.length ? mean(allDirectionalAccuracies) : 0,
      meanRMSE: allRmses.length ? mean(allRmses) : 0,
      meanIntervalCoverage: allIntervalCoverages.length ? mean(allIntervalCoverages) : 0,
      horizonsTested: horizons.length,
      consistentHorizons: allDirectionalAccuracies.filter(d => d > 0.5).length,
    },
    dataVerification: dataVerification({
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'COMPREHENSIVE_ML_VALIDATION', 'WALK_FORWARD', 'PURGED_CV', 'EMBARGO', 'NO_LOOKAHEAD'],
      dataPointCount: bars.length,
    }),
  });
}
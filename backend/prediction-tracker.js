import { dataVerification, immutableContract } from './contracts.js';

const predictionStore = new Map();
const outcomeStore = new Map();

function generatePredictionId() {
  return `pred_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function addTradingDays(timestamp, tradingDays) {
  const date = new Date(timestamp);
  let remaining = tradingDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.getTime();
}

export function storePrediction({
  symbol,
  timestamp,
  horizonBars,
  modelVersion,
  expectedReturn,
  expectedPrice,
  predictedDirection,
  probabilityOfGain,
  probabilityOfGainAboveThreshold,
  probabilityOfSignificantLoss,
  predictionInterval,
  regime,
  marketConditions,
  featureVersion,
  modelVersion: modelVer,
  metadata = {}
}) {
  const id = generatePredictionId();
  const expiryTimestamp = addTradingDays(timestamp, horizonBars);
  
  const prediction = immutableContract({
    id,
    symbol: symbol.toUpperCase(),
    timestamp,
    horizonBars,
    modelVersion: modelVer,
    expectedReturn,
    expectedPrice,
    predictedDirection,
    probabilityOfGain,
    probabilityOfGainAboveThreshold,
    probabilityOfSignificantLoss,
    predictionInterval,
    regime,
    marketConditions,
    featureVersion,
    metadata,
    expiryTimestamp,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  });
  
  if (!predictionStore.has(symbol.toUpperCase())) {
    predictionStore.set(symbol.toUpperCase(), []);
  }
  predictionStore.get(symbol.toUpperCase()).push(prediction);
  
  return prediction;
}

export function getStoredPredictions(symbol, { status, limit = 100 } = {}) {
  const predictions = predictionStore.get(symbol.toUpperCase()) || [];
  let filtered = predictions;
  
  if (status) {
    filtered = filtered.filter(p => p.status === status);
  }
  
  return filtered
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

export function getAllPendingPredictions() {
  const allPredictions = [];
  for (const [symbol, predictions] of predictionStore.entries()) {
    for (const pred of predictions) {
      if (pred.status === 'PENDING') {
        allPredictions.push(pred);
      }
    }
  }
  return allPredictions.sort((a, b) => a.expiryTimestamp - b.expiryTimestamp);
}

export function resolvePredictionOutcome(symbol, predictionId, actualPrice, actualTimestamp) {
  const predictions = predictionStore.get(symbol.toUpperCase()) || [];
  const prediction = predictions.find(p => p.id === predictionId);
  
  if (!prediction) {
    throw new Error(`Prediction ${predictionId} not found for symbol ${symbol}`);
  }
  
  if (prediction.status !== 'PENDING') {
    throw new Error(`Prediction ${predictionId} already resolved with status ${prediction.status}`);
  }
  
  const actualReturn = actualPrice / prediction.expectedPrice - 1;
  const actualDirection = actualReturn > 0 ? 'UP' : actualReturn < 0 ? 'DOWN' : 'FLAT';
  const directionCorrect = prediction.predictedDirection === actualDirection || 
                          (prediction.predictedDirection === 'UNCERTAIN' && actualDirection === 'FLAT');
  
  const withinInterval = actualPrice >= prediction.predictionInterval.lower && 
                         actualPrice <= prediction.predictionInterval.upper;
  
  const error = actualReturn - prediction.expectedReturn;
  const absoluteError = Math.abs(error);
  
  const outcome = immutableContract({
    predictionId,
    symbol: symbol.toUpperCase(),
    predictionTimestamp: prediction.timestamp,
    outcomeTimestamp: actualTimestamp,
    horizonBars: prediction.horizonBars,
    expectedReturn: prediction.expectedReturn,
    actualReturn,
    expectedPrice: prediction.expectedPrice,
    actualPrice,
    predictedDirection: prediction.predictedDirection,
    actualDirection,
    directionCorrect,
    withinInterval,
    absoluteError,
    squaredError: error * error,
    resolvedAt: new Date().toISOString(),
    modelVersion: prediction.modelVersion,
    regime: prediction.regime,
  });
  
  predictionStore.get(symbol.toUpperCase()) = predictions.map(p => 
    p.id === predictionId ? { ...p, status: 'RESOLVED', outcome } : p
  );
  
  if (!outcomeStore.has(symbol.toUpperCase())) {
    outcomeStore.set(symbol.toUpperCase(), []);
  }
  outcomeStore.get(symbol.toUpperCase()).push(outcome);
  
  return outcome;
}

export function autoResolveExpiredPredictions(getHistoricalPriceFn) {
  const now = Date.now();
  const results = [];
  
  for (const [symbol, predictions] of predictionStore.entries()) {
    for (const prediction of predictions) {
      if (prediction.status === 'PENDING' && prediction.expiryTimestamp <= now) {
        try {
          const actualPrice = getHistoricalPriceFn(symbol, prediction.expiryTimestamp);
          if (Number.isFinite(actualPrice) && actualPrice > 0) {
            const outcome = resolvePredictionOutcome(symbol, prediction.id, actualPrice, prediction.expiryTimestamp);
            results.push({ symbol, predictionId: prediction.id, outcome, autoResolved: true });
          } else {
            predictionStore.get(symbol) = predictions.map(p => 
              p.id === prediction.id ? { ...p, status: 'EXPIRED_NO_DATA' } : p
            );
            results.push({ symbol, predictionId: prediction.id, autoResolved: false, reason: 'No price data available' });
          }
        } catch (error) {
          predictionStore.get(symbol) = predictions.map(p => 
            p.id === prediction.id ? { ...p, status: 'ERROR', error: error.message } : p
          );
          results.push({ symbol, predictionId: prediction.id, autoResolved: false, reason: error.message });
        }
      }
    }
  }
  
  return results;
}

export function getPredictionStats(symbol) {
  const outcomes = outcomeStore.get(symbol.toUpperCase()) || [];
  const predictions = predictionStore.get(symbol.toUpperCase()) || [];
  
  if (outcomes.length === 0) {
    return immutableContract({
      symbol: symbol.toUpperCase(),
      totalPredictions: predictions.length,
      resolvedPredictions: 0,
      pendingPredictions: predictions.filter(p => p.status === 'PENDING').length,
      expiredPredictions: predictions.filter(p => p.status === 'EXPIRED_NO_DATA' || p.status === 'ERROR').length,
      directionalAccuracy: null,
      intervalCoverage: null,
      meanAbsoluteError: null,
      meanSquaredError: null,
      byHorizon: {},
    });
  }
  
  const directionalAccuracy = outcomes.filter(o => o.directionCorrect).length / outcomes.length;
  const intervalCoverage = outcomes.filter(o => o.withinInterval).length / outcomes.length;
  const meanAbsoluteError = outcomes.reduce((sum, o) => sum + o.absoluteError, 0) / outcomes.length;
  const meanSquaredError = outcomes.reduce((sum, o) => sum + o.squaredError, 0) / outcomes.length;
  
  const byHorizon = {};
  for (const outcome of outcomes) {
    const key = `${outcome.horizonBars}D`;
    if (!byHorizon[key]) {
      byHorizon[key] = { count: 0, correct: 0, withinInterval: 0, maeSum: 0, mseSum: 0 };
    }
    byHorizon[key].count++;
    if (outcome.directionCorrect) byHorizon[key].correct++;
    if (outcome.withinInterval) byHorizon[key].withinInterval++;
    byHorizon[key].maeSum += outcome.absoluteError;
    byHorizon[key].mseSum += outcome.squaredError;
  }
  
  for (const key of Object.keys(byHorizon)) {
    const h = byHorizon[key];
    h.directionalAccuracy = h.correct / h.count;
    h.intervalCoverage = h.withinInterval / h.count;
    h.meanAbsoluteError = h.maeSum / h.count;
    h.meanSquaredError = h.mseSum / h.count;
    h.rootMeanSquaredError = Math.sqrt(h.meanSquaredError);
  }
  
  return immutableContract({
    symbol: symbol.toUpperCase(),
    totalPredictions: predictions.length,
    resolvedPredictions: outcomes.length,
    pendingPredictions: predictions.filter(p => p.status === 'PENDING').length,
    expiredPredictions: predictions.filter(p => p.status === 'EXPIRED_NO_DATA' || p.status === 'ERROR').length,
    directionalAccuracy,
    intervalCoverage,
    meanAbsoluteError,
    meanSquaredError,
    rootMeanSquaredError: Math.sqrt(meanSquaredError),
    byHorizon,
    dataVerification: dataVerification({
      sourceSignatures: ['PREDICTION_TRACKING_SYSTEM'],
      dataPointCount: outcomes.length,
    }),
  });
}

export function getGlobalPredictionStats() {
  let allOutcomes = [];
  for (const outcomes of outcomeStore.values()) {
    allOutcomes = allOutcomes.concat(outcomes);
  }
  
  let allPredictions = [];
  for (const predictions of predictionStore.values()) {
    allPredictions = allPredictions.concat(predictions);
  }
  
  if (allOutcomes.length === 0) {
    return immutableContract({
      totalPredictions: allPredictions.length,
      resolvedPredictions: 0,
      pendingPredictions: allPredictions.filter(p => p.status === 'PENDING').length,
      expiredPredictions: allPredictions.filter(p => p.status === 'EXPIRED_NO_DATA' || p.status === 'ERROR').length,
      directionalAccuracy: null,
      intervalCoverage: null,
      meanAbsoluteError: null,
      rootMeanSquaredError: null,
      bySymbol: {},
      byHorizon: {},
    });
  }
  
  const directionalAccuracy = allOutcomes.filter(o => o.directionCorrect).length / allOutcomes.length;
  const intervalCoverage = allOutcomes.filter(o => o.withinInterval).length / allOutcomes.length;
  const meanAbsoluteError = allOutcomes.reduce((sum, o) => sum + o.absoluteError, 0) / allOutcomes.length;
  const meanSquaredError = allOutcomes.reduce((sum, o) => sum + o.squaredError, 0) / allOutcomes.length;
  
  const bySymbol = {};
  for (const outcome of allOutcomes) {
    if (!bySymbol[outcome.symbol]) {
      bySymbol[outcome.symbol] = { count: 0, correct: 0, withinInterval: 0, maeSum: 0, mseSum: 0 };
    }
    bySymbol[outcome.symbol].count++;
    if (outcome.directionCorrect) bySymbol[outcome.symbol].correct++;
    if (outcome.withinInterval) bySymbol[outcome.symbol].withinInterval++;
    bySymbol[outcome.symbol].maeSum += outcome.absoluteError;
    bySymbol[outcome.symbol].mseSum += outcome.squaredError;
  }
  
  for (const sym of Object.keys(bySymbol)) {
    const s = bySymbol[sym];
    s.directionalAccuracy = s.correct / s.count;
    s.intervalCoverage = s.withinInterval / s.count;
    s.meanAbsoluteError = s.maeSum / s.count;
    s.rootMeanSquaredError = Math.sqrt(s.mseSum / s.count);
  }
  
  const byHorizon = {};
  for (const outcome of allOutcomes) {
    const key = `${outcome.horizonBars}D`;
    if (!byHorizon[key]) {
      byHorizon[key] = { count: 0, correct: 0, withinInterval: 0, maeSum: 0, mseSum: 0 };
    }
    byHorizon[key].count++;
    if (outcome.directionCorrect) byHorizon[key].correct++;
    if (outcome.withinInterval) byHorizon[key].withinInterval++;
    byHorizon[key].maeSum += outcome.absoluteError;
    byHorizon[key].mseSum += outcome.squaredError;
  }
  
  for (const key of Object.keys(byHorizon)) {
    const h = byHorizon[key];
    h.directionalAccuracy = h.correct / h.count;
    h.intervalCoverage = h.withinInterval / h.count;
    h.meanAbsoluteError = h.maeSum / h.count;
    h.rootMeanSquaredError = Math.sqrt(h.mseSum / h.count);
  }
  
  return immutableContract({
    totalPredictions: allPredictions.length,
    resolvedPredictions: allOutcomes.length,
    pendingPredictions: allPredictions.filter(p => p.status === 'PENDING').length,
    expiredPredictions: allPredictions.filter(p => p.status === 'EXPIRED_NO_DATA' || p.status === 'ERROR').length,
    directionalAccuracy,
    intervalCoverage,
    meanAbsoluteError,
    rootMeanSquaredError: Math.sqrt(meanSquaredError),
    bySymbol,
    byHorizon,
    dataVerification: dataVerification({
      sourceSignatures: ['PREDICTION_TRACKING_SYSTEM'],
      dataPointCount: allOutcomes.length,
    }),
  });
}

export function clearPredictionStore() {
  predictionStore.clear();
  outcomeStore.clear();
}

export function getPredictionStoreStats() {
  let totalPredictions = 0;
  let pending = 0;
  let resolved = 0;
  let expired = 0;
  
  for (const predictions of predictionStore.values()) {
    totalPredictions += predictions.length;
    for (const p of predictions) {
      if (p.status === 'PENDING') pending++;
      else if (p.status === 'RESOLVED') resolved++;
      else expired++;
    }
  }
  
  return { totalPredictions, pending, resolved, expired, symbolsTracked: predictionStore.size };
}
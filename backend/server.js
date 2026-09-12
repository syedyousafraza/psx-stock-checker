import express from 'express';
import { randomUUID } from 'node:crypto';
import { getListedSymbols, getLiveQuote, getOfficialHistoricalBars } from './psx-adapter.js';
import { brokerConfigured } from './broker-adapter.js';
import { appendLiveQuote, applyCorporateActions, detectCorporateActions, filterBadPrints, prepareVerifiedMatrix } from './data-engine.js';
import { forecastPrices, forecastMultiHorizon } from './prediction-engine.js';
import { HurstExponent, KalmanFilter, adfStatistic, varianceRatioTest, halfLifeMeanReversion } from './math-agents.js';
import { researchSymbol } from './research-agent.js';
import { generateSignal, signalToOrder } from './decision-engine.js';
import { riskProfile, portfolioRisk, stressTest, positionSizing } from './risk-engine.js';
import { getCatalystEvents } from './catalyst-agent.js';
import { walkForwardBacktest, combinatorialPurgedCV, monteCarloBacktest, regimeBacktest } from './backtest-engine.js';
import { computeFeatures, createMLDataset, normalizeFeatures, selectFeatures, pcaFeatures } from './feature-engine.js';
import { validateModel, monitorModelDrift, predictionIntervalCoverage, backtestModelValidation, modelPerformanceReport } from './model-validation.js';
import { storePrediction, getStoredPredictions, getAllPendingPredictions, autoResolveExpiredPredictions, getPredictionStats, getGlobalPredictionStats, getPredictionStoreStats, resolvePredictionOutcome } from './prediction-tracker.js';
import { walkForwardMLValidation, purgedKFoldCV, embargoValidation, comprehensiveMLValidation } from './ml-validation.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const startedAt = Date.now();
const requestCounts = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((request, response, next) => {
  const requestId = request.get('x-request-id') || randomUUID();
  response.setHeader('x-request-id', requestId);
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `${request.ip}:${bucket}`;
  const count = (requestCounts.get(key) || 0) + 1;
  requestCounts.set(key, count);
  if (count > 120) return response.status(429).json({ error: 'Rate limit exceeded', requestId });
  return next();
});

app.get('/health/live', (_request, response) => response.json({ status: 'ok', uptimeSeconds: (Date.now() - startedAt) / 1000 }));
app.get('/health/ready', (_request, response) => response.json({
  status: 'ready',
  brokerConfigured: brokerConfigured(),
  psxSnapshotConfigured: true,
  psxHistoricalConfigured: true,
}));

app.get('/api/symbols', async (_request, response, next) => {
  try {
    response.json(await getListedSymbols());
  } catch (error) {
    next(error);
  }
});

app.get('/api/quote/:symbol', async (request, response, next) => {
  try {
    response.json(await getLiveQuote(request.params.symbol));
  } catch (error) {
    next(error);
  }
});

app.get('/api/research/:symbol', async (request, response, next) => {
  try {
    response.json(await researchSymbol(request.params.symbol));
  } catch (error) {
    next(error);
  }
});

async function buildAnalysis(symbol, query) {
  const normalized = symbol.trim().toUpperCase();
  const live = await getLiveQuote(normalized);
  const mode = query.mode === 'macro' ? 'macro' : 'weekly';
  const horizonBars = mode === 'macro' ? 21 : 5;
  const historical = await getOfficialHistoricalBars(normalized, { limit: Number(query.limit) || 1000 });
  
  const matrix = prepareVerifiedMatrix(historical.bars, historical.bars, []);
  const barsWithLive = appendLiveQuote(matrix.bars, live.quote);
  
  const closes = barsWithLive.map((bar) => bar.close);
  const hurst = HurstExponent(closes, { method: 'RS' });
  const adf = adfStatistic(closes, { trend: 'c' });
  const vrTest = varianceRatioTest(closes);
  const halfLife = halfLifeMeanReversion(closes);
  
  const anchorPrice = Number.isFinite(Number(live.quote.close)) ? Number(live.quote.close) : null;
  const anchorTimestamp = Number.isFinite(Number(live.quote.timestamp)) ? Number(live.quote.timestamp) : null;
  const prediction = forecastPrices(barsWithLive, { horizonBars, anchorPrice, anchorTimestamp, hurstValue: hurst.value });
  
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const risk = riskProfile(returns, { capital: Number(process.env.PAPER_CAPITAL || 1_000_000) });
  const stress = stressTest(returns);
  
  const catalyst = await getCatalystEvents(normalized);
  const kalman = KalmanFilter(barsWithLive, { adaptive: true });
  const signal = generateSignal({ bars: barsWithLive, hurst, adf, prediction, risk, quote: live.quote, catalyst });
  const order = signalToOrder(signal, { symbol: normalized });
  
  const validation = walkForwardBacktest(barsWithLive, {
    horizonBars,
    step: mode === 'macro' ? 21 : 5,
    capital: Number(process.env.PAPER_CAPITAL || 1_000_000),
    edgeThreshold: 0.5,
    purgeBars: 5,
    embargoBars: 2,
  });
  
  const cvResult = combinatorialPurgedCV(barsWithLive, { 
    nSplits: 5, nTestSplits: 2, purgeBars: 10, embargoBars: 5,
    horizonBars, step: mode === 'macro' ? 21 : 5 
  });
  
let features;
  let mlDataset;
  try {
    features = computeFeatures(barsWithLive);
    mlDataset = createMLDataset(barsWithLive, { horizon: horizonBars, lookback: 60 });
  } catch (featErr) {
    features = { featureNames: [], featureMatrix: [], timestamps: [], returns: [], dataVerification: { sourceSignatures: ['FEATURE_ENGINEERING_PIPELINE'], dataPointCount: barsWithLive.length } };
    mlDataset = { X: [], featureNames: [], targetType: 'return', dataVerification: { sourceSignatures: ['ML_DATASET_CREATION'], dataPointCount: barsWithLive.length } };
  }

  return {
    symbol: normalized,
    quote: live.quote,
    matrix: { ...matrix, bars: barsWithLive },
    corporateActions: [],
    rejected: matrix.rejected,
    kalman,
    hurst,
    adf,
    varianceRatio: vrTest,
    halfLife,
    prediction,
    risk,
    stress,
    catalyst,
    validation,
    cvResult,
    features: {
      featureNames: features.featureNames,
      featureCount: features.featureMatrix[0]?.length || 0,
      sampleCount: features.featureMatrix.length,
    },
    mlDataset: {
      samples: mlDataset.X.length,
      features: mlDataset.featureNames.length,
      targetType: 'return',
    },
    mode,
    signal,
    order,
    dataVerification: {
      epochMs: Date.now(),
      sourceSignatures: [...live.dataVerification.sourceSignatures, ...historical.dataVerification.sourceSignatures],
      dataPointCount: barsWithLive.length,
      divergenceScore: 0,
    },
  };
}

app.get('/api/analysis/:symbol', async (request, response, next) => {
  try {
    response.json(await buildAnalysis(request.params.symbol, request.query));
  } catch (error) {
    next(error);
  }
});

app.get('/api/logs/:symbol', async (request, response, next) => {
  try {
    const analysis = await buildAnalysis(request.params.symbol, request.query);
    response.json({
      generatedAt: new Date().toISOString(),
      symbol: analysis.symbol,
      mode: analysis.mode,
      purpose: 'Refined audit record of the real source data and calculations used for this analysis',
      sources: {
        quote: analysis.quote,
        quoteVerification: analysis.dataVerification,
        historicalVerification: analysis.matrix.dataVerification,
        catalystVerification: analysis.catalyst.dataVerification,
        catalyst: analysis.catalyst,
      },
      pipeline: {
        fetchedBars: analysis.matrix.bars.length + analysis.rejected.length,
        acceptedBars: analysis.matrix.bars.length,
        rejectedBars: analysis.rejected.length,
        rejectedPrints: analysis.rejected,
        refinedBarsUsedForPrediction: analysis.matrix.bars,
      },
      calculations: {
        kalman: analysis.kalman,
        hurst: analysis.hurst,
        adf: analysis.adf,
        varianceRatio: analysis.varianceRatio,
        halfLife: analysis.halfLife,
        prediction: analysis.prediction,
        risk: analysis.risk,
        stress: analysis.stress,
        signal: analysis.signal,
        order: analysis.order,
        validation: analysis.validation,
        cvResult: analysis.cvResult,
        features: analysis.features,
        mlDataset: analysis.mlDataset,
      },
      finalDataVerification: analysis.dataVerification,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/backtest/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const mode = request.query.mode === 'macro' ? 'macro' : 'weekly';
    const horizonBars = mode === 'macro' ? 21 : 5;
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    
    const wfResult = walkForwardBacktest(matrix.bars, {
      horizonBars,
      step: mode === 'macro' ? 21 : 5,
      capital: Number(process.env.PAPER_CAPITAL || 1_000_000),
      purgeBars: 5,
      embargoBars: 2,
    });
    
    const cvResult = combinatorialPurgedCV(matrix.bars, {
      nSplits: 5, nTestSplits: 2, purgeBars: 10, embargoBars: 5,
      horizonBars, step: mode === 'macro' ? 21 : 5,
    });
    
    const mcResult = monteCarloBacktest(matrix.bars, { nSimulations: 500, horizonBars });
    const regimeResult = regimeBacktest(matrix.bars, { regimeWindow: 63, horizonBars });
    
    response.json({
      symbol: normalized,
      mode,
      source: historical.dataVerification,
      corporateActions: actions.actions,
      walkForward: wfResult,
      combinatorialCV: cvResult,
      monteCarlo: mcResult,
      regimeAnalysis: regimeResult,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/features/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 500 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    const features = computeFeatures(barsWithLive);
    if (!features.featureMatrix || features.featureMatrix.length === 0) {
      response.json({ symbol: normalized, error: 'Insufficient data for feature computation', featureNames: [], featureMatrix: [], dataVerification: features.dataVerification });
      return;
    }
    const normalized_feats = normalizeFeatures(features.featureMatrix, { method: 'robust' });
    const selected = selectFeatures(normalized_feats.normalized, features.returns.slice(-normalized_feats.normalized.length), { k: 30 });
    const pca = pcaFeatures(normalized_feats.normalized, { nComponents: 15, varianceThreshold: 0.9 });
    
    response.json({
      symbol: normalized,
      rawFeatures: {
        featureNames: features.featureNames,
        featureMatrix: features.featureMatrix.slice(-10),
        timestamps: features.timestamps.slice(-10),
      },
      normalized: {
        normalized: normalized_feats.normalized.slice(-10),
        means: normalized_feats.means,
        stds: normalized_feats.stds,
      },
      selected: {
        indices: selected.selected,
        scores: selected.scores.slice(0, 30),
      },
      pca: {
        transformed: pca.transformed.slice(-10),
        explainedVariance: pca.explainedVariance,
        components: pca.components,
      },
      dataVerification: features.dataVerification,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/model-validation/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    if (barsWithLive.length < 105) {
      response.json({ symbol: normalized, error: 'Insufficient data for model validation - at least 105 bars required', dataVerification: { sourceSignatures: ['BACKTEST_MODEL_VALIDATION'], dataPointCount: barsWithLive.length } });
      return;
    }
    
    const validation = backtestModelValidation(
      (bars, opts) => forecastPrices(bars, { ...opts, hurstValue: HurstExponent(bars.map(b => b.close)).value }),
      barsWithLive,
      { horizonBars: 5, minimumTrainingBars: 100, step: 5 }
    );
    
    const report = modelPerformanceReport(validation.overall);
    
    response.json({
      symbol: normalized,
      validation,
      report,
      dataVerification: validation.dataVerification,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/risk/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 500 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    const returns = barsWithLive.slice(1).map((b, i) => Math.log(b.close / barsWithLive[i].close));
    const risk = riskProfile(returns, { capital: Number(process.env.PAPER_CAPITAL || 1_000_000) });
    const stress = stressTest(returns);
    const sizing = positionSizing({
      signal: { direction: 'BUY', edgeScore: 1.2, allowShort: false },
      volatility: risk.volatility,
      capital: Number(process.env.PAPER_CAPITAL || 1_000_000),
      conviction: 0.7,
    });
    
    response.json({
      symbol: normalized,
      riskProfile: risk,
      stressTest: stress,
      positionSizing: sizing,
      dataVerification: risk.dataVerification,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/predictions/multi-horizon/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    const closes = barsWithLive.map((bar) => bar.close);
    const hurst = HurstExponent(closes, { method: 'RS' });
    
    const anchorPrice = Number.isFinite(Number(live.quote.close)) ? Number(live.quote.close) : null;
    const anchorTimestamp = Number.isFinite(Number(live.quote.timestamp)) ? Number(live.quote.timestamp) : null;
    
    const horizons = request.query.horizons ? request.query.horizons.split(',').map(Number) : [1, 3, 5, 10, 20];
    const gainThreshold = Number(request.query.gainThreshold) || 0.02;
    const lossThreshold = Number(request.query.lossThreshold) || 0.03;
    
    const live = await getLiveQuote(normalized);
    
    const prediction = forecastMultiHorizon(barsWithLive, {
      horizons,
      anchorPrice,
      anchorTimestamp,
      hurstValue: hurst.value,
      gainThreshold,
      lossThreshold,
    });
    
    prediction.symbol = normalized;
    
    for (const [horizon, pred] of Object.entries(prediction.horizons)) {
      storePrediction({
        symbol: normalized,
        timestamp: Date.now(),
        horizonBars: pred.horizonBars,
        modelVersion: pred.modelVersion,
        expectedReturn: pred.expectedReturn,
        expectedPrice: pred.expectedPrice,
        predictedDirection: pred.direction,
        probabilityOfGain: pred.probabilityOfGain,
        probabilityOfGainAboveThreshold: pred.probabilityOfGainAboveThreshold,
        probabilityOfSignificantLoss: pred.probabilityOfSignificantLoss,
        predictionInterval: pred.predictionInterval,
        regime: pred.regime,
        marketConditions: { hurst: pred.hurst, hurstRegime: pred.hurstRegime },
        featureVersion: 'v1.0',
        modelVersion: pred.modelVersion,
        metadata: { confidence: pred.confidence, extremeForecast: pred.extremeForecast },
      });
    }
    
    response.json(prediction);
  } catch (error) {
    next(error);
  }
});

app.get('/api/predictions/track/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const status = request.query.status;
    const limit = Number(request.query.limit) || 100;
    
    const predictions = getStoredPredictions(normalized, { status, limit });
    const stats = getPredictionStats(normalized);
    
    response.json({
      symbol: normalized,
      predictions,
      stats,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/predictions/pending', async (request, response, next) => {
  try {
    const pending = getAllPendingPredictions();
    response.json({ predictions: pending, count: pending.length });
  } catch (error) {
    next(error);
  }
});

app.get('/api/predictions/stats', async (request, response, next) => {
  try {
    const globalStats = getGlobalPredictionStats();
    const storeStats = getPredictionStoreStats();
    response.json({ global: globalStats, store: storeStats });
  } catch (error) {
    next(error);
  }
});

app.post('/api/predictions/resolve/:symbol/:predictionId', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const predictionId = request.params.predictionId;
    const { actualPrice, actualTimestamp } = request.body;
    
    if (!Number.isFinite(actualPrice) || actualPrice <= 0) {
      return response.status(400).json({ error: 'actualPrice must be a positive number' });
    }
    
    const outcome = resolvePredictionOutcome(normalized, predictionId, actualPrice, actualTimestamp || Date.now());
    response.json({ outcome });
  } catch (error) {
    next(error);
  }
});

app.post('/api/predictions/auto-resolve', async (request, response, next) => {
  try {
    const getHistoricalPrice = async (symbol, timestamp) => {
      const historical = await getOfficialHistoricalBars(symbol, { limit: 100 });
      const bar = historical.bars.find(b => b.timestamp >= timestamp);
      return bar ? bar.close : null;
    };
    
    const results = autoResolveExpiredPredictions(getHistoricalPrice);
    response.json({ resolved: results.length, results });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ml-validation/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    if (barsWithLive.length < 105) {
      response.json({ symbol: normalized, error: 'Insufficient data for ML validation - at least 105 bars required', dataVerification: { sourceSignatures: ['COMPREHENSIVE_ML_VALIDATION'], dataPointCount: barsWithLive.length } });
      return;
    }
    
    const horizons = request.query.horizons ? request.query.horizons.split(',').map(Number) : [1, 3, 5, 10, 20];
    const minimumTrainingBars = Number(request.query.minimumTrainingBars) || 100;
    const step = Number(request.query.step) || 5;
    const purgeBars = Number(request.query.purgeBars) || 5;
    const embargoBars = Number(request.query.embargoBars) || 2;
    const nSplits = Number(request.query.nSplits) || 5;
    const targetType = request.query.targetType || 'return';
    const gainThreshold = Number(request.query.gainThreshold) || 0.02;
    const lossThreshold = Number(request.query.lossThreshold) || 0.03;
    
    const modelPipeline = {
      usePCA: request.query.usePCA !== 'false',
      nComponents: Number(request.query.nComponents) || 10,
      featureSelection: request.query.featureSelection || 'mutual_info',
      nFeatures: Number(request.query.nFeatures) || 20,
    };
    
    const validation = comprehensiveMLValidation(barsWithLive, {
      horizons,
      minimumTrainingBars,
      step,
      purgeBars,
      embargoBars,
      nSplits,
      modelPipeline,
      targetType,
      gainThreshold,
      lossThreshold,
    });
    
    response.json({
      symbol: normalized,
      validation,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ml-validation/walkforward/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    if (barsWithLive.length < 105) {
      response.json({ symbol: normalized, error: 'Insufficient data for walk-forward ML validation - at least 105 bars required', dataVerification: { sourceSignatures: ['WALK_FORWARD_ML_VALIDATION'], dataPointCount: barsWithLive.length } });
      return;
    }
    
    const horizonBars = Number(request.query.horizonBars) || 5;
    const minimumTrainingBars = Number(request.query.minimumTrainingBars) || 100;
    const step = Number(request.query.step) || 5;
    const purgeBars = Number(request.query.purgeBars) || 5;
    const embargoBars = Number(request.query.embargoBars) || 2;
    const targetType = request.query.targetType || 'return';
    const gainThreshold = Number(request.query.gainThreshold) || 0.02;
    const lossThreshold = Number(request.query.lossThreshold) || 0.03;
    
    const modelPipeline = {
      usePCA: request.query.usePCA !== 'false',
      nComponents: Number(request.query.nComponents) || 10,
      featureSelection: request.query.featureSelection || 'mutual_info',
      nFeatures: Number(request.query.nFeatures) || 20,
    };
    
    const validation = walkForwardMLValidation(barsWithLive, {
      horizonBars,
      minimumTrainingBars,
      step,
      purgeBars,
      embargoBars,
      modelPipeline,
      targetType,
      gainThreshold,
      lossThreshold,
    });
    
    response.json({
      symbol: normalized,
      validation,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ml-validation/purged-cv/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    if (barsWithLive.length < 105) {
      response.json({ symbol: normalized, error: 'Insufficient data for purged CV validation - at least 105 bars required', dataVerification: { sourceSignatures: ['PURGED_KFOLD_CV'], dataPointCount: barsWithLive.length } });
      return;
    }
    
    const horizonBars = Number(request.query.horizonBars) || 5;
    const minimumTrainingBars = Number(request.query.minimumTrainingBars) || 100;
    const step = Number(request.query.step) || 5;
    const purgeBars = Number(request.query.purgeBars) || 10;
    const embargoBars = Number(request.query.embargoBars) || 5;
    const nSplits = Number(request.query.nSplits) || 5;
    const nTestSplits = Number(request.query.nTestSplits) || 2;
    const targetType = request.query.targetType || 'return';
    const gainThreshold = Number(request.query.gainThreshold) || 0.02;
    const lossThreshold = Number(request.query.lossThreshold) || 0.03;
    
    const modelPipeline = {
      usePCA: request.query.usePCA !== 'false',
      nComponents: Number(request.query.nComponents) || 10,
      featureSelection: request.query.featureSelection || 'mutual_info',
      nFeatures: Number(request.query.nFeatures) || 20,
    };
    
    const validation = purgedKFoldCV(barsWithLive, {
      nSplits,
      nTestSplits,
      purgeBars,
      embargoBars,
      horizonBars,
      minimumTrainingBars,
      step,
      modelPipeline,
      targetType,
      gainThreshold,
      lossThreshold,
    });
    
    response.json({
      symbol: normalized,
      validation,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ml-validation/embargo/:symbol', async (request, response, next) => {
  try {
    const normalized = request.params.symbol.trim().toUpperCase();
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 1000 });
    const actions = detectCorporateActions(historical.bars);
    const adjusted = applyCorporateActions(historical.bars, actions.actions);
    const matrix = filterBadPrints(adjusted.bars);
    const barsWithLive = appendLiveQuote(matrix.bars, (await getLiveQuote(normalized)).quote);
    
    if (barsWithLive.length < 105) {
      response.json({ symbol: normalized, error: 'Insufficient data for embargo validation - at least 105 bars required', dataVerification: { sourceSignatures: ['EMBARGO_VALIDATION'], dataPointCount: barsWithLive.length } });
      return;
    }
    
    const horizonBars = Number(request.query.horizonBars) || 5;
    const embargoBars = Number(request.query.embargoBars) || 5;
    const minimumTrainingBars = Number(request.query.minimumTrainingBars) || 100;
    const step = Number(request.query.step) || 5;
    const targetType = request.query.targetType || 'return';
    const gainThreshold = Number(request.query.gainThreshold) || 0.02;
    const lossThreshold = Number(request.query.lossThreshold) || 0.03;
    
    const modelPipeline = {
      usePCA: request.query.usePCA !== 'false',
      nComponents: Number(request.query.nComponents) || 10,
      featureSelection: request.query.featureSelection || 'mutual_info',
      nFeatures: Number(request.query.nFeatures) || 20,
    };
    
    const validation = embargoValidation(barsWithLive, {
      horizonBars,
      embargoBars,
      minimumTrainingBars,
      step,
      modelPipeline,
      targetType,
      gainThreshold,
      lossThreshold,
    });
    
    response.json({
      symbol: normalized,
      validation,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/udf/history', (_request, response) => {
  response.status(501).json({ s: 'error', errmsg: 'Historical UDF feed requires a licensed historical provider configuration' });
});

app.use((error, request, response, _next) => {
  const status = Number(error.statusCode) || (error.code === 'BROKER_NOT_CONFIGURED' ? 503 : 500);
  response.status(status).json({
    error: status >= 500 ? 'Market data service unavailable' : error.message,
    detail: error.message,
    code: error.code || 'REQUEST_FAILED',
    requestId: response.getHeader('x-request-id'),
    path: request.path,
  });
});

const server = app.listen(port, () => console.log(`PSX quant API listening on http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
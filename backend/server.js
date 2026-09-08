import express from 'express';
import { randomUUID } from 'node:crypto';
import { getListedSymbols, getLiveQuote, getOfficialHistoricalBars } from './psx-adapter.js';
import { brokerConfigured } from './broker-adapter.js';
import { applyCorporateActions, filterBadPrints } from './data-engine.js';
import { forecastPrices } from './prediction-engine.js';
import { HurstExponent, KalmanFilter, adfStatistic } from './math-agents.js';
import { researchSymbol } from './research-agent.js';
import { generateSignal } from './decision-engine.js';
import { riskProfile } from './risk-engine.js';
import { getCatalystEvents } from './catalyst-agent.js';
import { walkForwardBacktest } from './backtest-engine.js';

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
  const historical = await getOfficialHistoricalBars(normalized, { limit: Number(query.limit) || 500 });
  const filtered = filterBadPrints(historical.bars);
  const matrix = applyCorporateActions(filtered.bars);
  const closes = matrix.bars.map((bar) => bar.close);
  const hurst = HurstExponent(closes);
  const adf = adfStatistic(closes);
  const prediction = forecastPrices(matrix.bars, { horizonBars });
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const risk = riskProfile(returns, { capital: Number(process.env.PAPER_CAPITAL || 1_000_000) });
  const catalyst = await getCatalystEvents(normalized);
  const kalman = KalmanFilter(matrix.bars);
  const signal = generateSignal({ bars: matrix.bars, hurst, adf, prediction, risk, quote: live.quote });
  return {
    symbol: normalized,
    quote: live.quote,
    matrix,
    rejected: filtered.rejected,
    kalman,
    hurst,
    adf,
    prediction,
    risk,
    catalyst,
    mode,
    signal,
    dataVerification: {
      epochMs: Date.now(),
      sourceSignatures: [...live.dataVerification.sourceSignatures, ...historical.dataVerification.sourceSignatures],
      dataPointCount: matrix.bars.length,
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
        prediction: analysis.prediction,
        risk: analysis.risk,
        signal: analysis.signal,
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
    const historical = await getOfficialHistoricalBars(normalized, { limit: Number(request.query.limit) || 500 });
    const filtered = filterBadPrints(historical.bars);
    const matrix = applyCorporateActions(filtered.bars);
    response.json({
      symbol: normalized,
      mode,
      source: historical.dataVerification,
      result: walkForwardBacktest(matrix.bars, {
        horizonBars,
        step: mode === 'macro' ? 21 : 5,
        capital: Number(process.env.PAPER_CAPITAL || 1_000_000),
      }),
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

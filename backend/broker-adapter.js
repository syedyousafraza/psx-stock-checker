const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BARS = 5_000;

function configuredUrl() {
  return process.env.BROKER_MARKET_DATA_URL || '';
}

function normalizeBar(value, symbol) {
  const bar = value && typeof value === 'object' ? value : {};
  const timestamp = Date.parse(bar.timestamp ?? bar.time ?? bar.date);
  const close = Number(bar.close ?? bar.last ?? bar.price);
  const volume = Number(bar.volume ?? 0);
  if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) return null;
  return {
    symbol,
    timestamp,
    open: Number.isFinite(Number(bar.open)) ? Number(bar.open) : close,
    high: Number.isFinite(Number(bar.high)) ? Number(bar.high) : close,
    low: Number.isFinite(Number(bar.low)) ? Number(bar.low) : close,
    close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
  };
}

function parsePayload(payload, symbol) {
  const values = Array.isArray(payload) ? payload : payload?.bars;
  if (!Array.isArray(values)) throw new Error('Broker response must contain a bars array');
  const bars = values.map((bar) => normalizeBar(bar, symbol)).filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (bars.length === 0) throw new Error('Broker response contained no valid bars');
  return bars.slice(-MAX_BARS);
}

export function brokerConfigured() {
  return Boolean(configuredUrl());
}

export async function getHistoricalBars(symbol, { limit = 500 } = {}) {
  const url = configuredUrl();
  if (!url) {
    const error = new Error('Licensed broker market-data API is not configured');
    error.code = 'BROKER_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  const normalized = symbol.trim().toUpperCase();
  const endpoint = new URL(url);
  endpoint.searchParams.set('symbol', normalized);
  endpoint.searchParams.set('limit', String(Math.min(MAX_BARS, Math.max(32, limit))));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { accept: 'application/json', 'user-agent': 'PSX-Quant-Swarm/1.0' };
    if (process.env.BROKER_API_KEY) headers.authorization = `Bearer ${process.env.BROKER_API_KEY}`;
    const response = await fetch(endpoint, { signal: controller.signal, headers });
    if (!response.ok) {
      const error = new Error(`Broker market-data API returned HTTP ${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    const bars = parsePayload(await response.json(), normalized);
    return {
      bars,
      dataVerification: {
        epochMs: Date.now(),
        sourceSignatures: ['LICENSED_BROKER_MARKET_DATA_API'],
        sourceUrl: endpoint.origin,
        dataPointCount: bars.length,
        divergenceScore: 0,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const MARKET_SUMMARY_URL = 'https://www.psx.com.pk/market-summary';
const REQUEST_TIMEOUT_MS = 15_000;
let cachedSnapshot = null;
let cacheExpiresAt = 0;
let inFlightRequest = null;
const historicalCache = new Map();
let symbolCatalog = null;

function numberFromCell(value) {
  const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceVerification(dataPointCount) {
  return {
    epochMs: Date.now(),
    sourceSignatures: ['PSX_OFFICIAL_MARKET_SUMMARY_HTML'],
    sourceUrl: MARKET_SUMMARY_URL,
    dataPointCount,
    divergenceScore: 0,
  };
}

function parseMarketSummary(html) {
  const $ = cheerio.load(html);
  const quotes = [];
  $('td.dataportal').each((_index, cell) => {
    const rawSymbol = $(cell).attr('data-srip') || $(cell).text();
    const symbol = rawSymbol.trim().toUpperCase().replace(/-SEP$/, '');
    const cells = $(cell).closest('tr').find('td').toArray().map((item) => $(item).text().trim());
    const [open, high, low, close, change, volume] = cells.slice(-6).map(numberFromCell);
    if (symbol && close !== null && volume !== null && !quotes.some((quote) => quote.symbol === symbol)) {
      quotes.push({ symbol, timestamp: Date.now(), open, high, low, close, change, volume });
    }
  });
  if (quotes.length === 0) throw new Error('PSX market summary returned no parseable quotes');
  return quotes;
}

async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(MARKET_SUMMARY_URL, {
      signal: controller.signal,
      headers: { accept: 'text/html', 'user-agent': 'PSX-Quant-Swarm/1.0 (+live-data-client)' },
    });
    if (!response.ok) throw new Error(`PSX market summary returned HTTP ${response.status}`);
    const quotes = parseMarketSummary(await response.text());
    return { quotes, dataVerification: sourceVerification(quotes.length) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getMarketSnapshot({ maxAgeMs = 5_000 } = {}) {
  if (cachedSnapshot && Date.now() < cacheExpiresAt) return cachedSnapshot;
  if (!inFlightRequest) {
    inFlightRequest = fetchSnapshot().then((snapshot) => {
      cachedSnapshot = snapshot;
      cacheExpiresAt = Date.now() + maxAgeMs;
      return snapshot;
    }).finally(() => {
      inFlightRequest = null;
    });
  }
  return inFlightRequest;
}

export async function getLiveQuote(symbol) {
  const normalized = symbol.trim().toUpperCase();
  const snapshot = await getMarketSnapshot();
  const quote = snapshot.quotes.find((item) => item.symbol === normalized);
  if (!quote) {
    const error = new Error(`PSX symbol ${normalized} was not present in the official market summary`);
    error.statusCode = 404;
    throw error;
  }
  const catalog = await getSymbolCatalog();
  const metadata = catalog.get(normalized);
  return { quote: { ...quote, companyName: metadata?.name || null, sectorName: metadata?.sectorName || null }, dataVerification: snapshot.dataVerification };
}

export async function getListedSymbols() {
  const snapshot = await getMarketSnapshot();
  return { symbols: snapshot.quotes.map((quote) => quote.symbol), dataVerification: snapshot.dataVerification };
}

async function getSymbolCatalog() {
  if (symbolCatalog) return symbolCatalog;
  const response = await fetch('https://dps.psx.com.pk/symbols', { headers: { accept: 'application/json', 'user-agent': 'PSX-Quant-Swarm/1.0' } });
  if (!response.ok) throw new Error(`PSX symbols returned HTTP ${response.status}`);
  const records = await response.json();
  symbolCatalog = new Map(records.map((record) => [String(record.symbol).toUpperCase(), record]));
  return symbolCatalog;
}

function parseHistoricalTable(html, symbol) {
  const $ = cheerio.load(html);
  return $('#historicalTable tbody tr').toArray().map((row) => {
    const cells = $(row).find('td').toArray();
    const values = cells.map((cell) => $(cell).text().replace(/,/g, '').trim());
    const timestamp = Number($(cells[0]).attr('data-order')) * 1000;
    const [open, high, low, close, volume] = values.slice(1).map(Number);
    if (!Number.isFinite(timestamp) || ![open, high, low, close, volume].every(Number.isFinite)) return null;
    return { symbol, timestamp, open, high, low, close, volume };
  }).filter(Boolean);
}

export async function getOfficialHistoricalBars(symbol, { limit = 500 } = {}) {
  const normalized = symbol.trim().toUpperCase();
  const requestedLimit = Math.min(5000, Math.max(32, Number(limit) || 500));
  const cacheKey = `${normalized}:${requestedLimit}`;
  const cached = historicalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'PSX-Quant-Swarm/1.0 official historical collector' });
  const bars = new Map();
  try {
    const now = new Date();
    for (let offset = 0; offset < 60 && bars.size < requestedLimit; offset += 1) {
      const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const month = String(monthDate.getUTCMonth() + 1);
      const year = String(monthDate.getUTCFullYear());
      const response = await page.request.post('https://dps.psx.com.pk/historical', {
        form: { month, year, symbol: normalized },
        timeout: REQUEST_TIMEOUT_MS,
      });
      if (!response.ok()) throw new Error(`PSX historical request returned HTTP ${response.status()}`);
      for (const bar of parseHistoricalTable(await response.text(), normalized)) bars.set(bar.timestamp, bar);
    }
  } finally {
    await browser.close();
  }
  const resultBars = [...bars.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-requestedLimit);
  if (resultBars.length < 32) throw new Error(`PSX returned only ${resultBars.length} historical bars for ${normalized}`);
  const value = {
    bars: resultBars,
    dataVerification: {
      epochMs: Date.now(),
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT'],
      sourceUrl: 'https://dps.psx.com.pk/historical',
      dataPointCount: resultBars.length,
      divergenceScore: 0,
    },
  };
  historicalCache.set(cacheKey, { value, expiresAt: Date.now() + 300_000 });
  return value;
}

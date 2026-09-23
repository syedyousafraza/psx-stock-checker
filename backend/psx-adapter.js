import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const MARKET_SUMMARY_URL = 'https://www.psx.com.pk/market-summary';
const MARKET_WATCH_URL = 'https://dps.psx.com.pk/market-watch';
const YAHOO_FINANCE_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const REQUEST_TIMEOUT_MS = 15_000;
let cachedSnapshot = null;
let cacheExpiresAt = 0;
let inFlightRequest = null;
const historicalCache = new Map();
const yahooCache = new Map();
let symbolCatalog = null;

function numberFromCell(value) {
  const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceVerification(dataPointCount, sourceSignatures) {
  return {
    epochMs: Date.now(),
    sourceSignatures: sourceSignatures || ['PSX_OFFICIAL_MARKET_SUMMARY_HTML'],
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

function parseMarketWatch(html) {
  const $ = cheerio.load(html);
  const quotes = [];
  $('tr[data-symbol]').each((_index, row) => {
    const symbol = $(row).attr('data-symbol')?.trim().toUpperCase().replace(/-SEP$/, '');
    if (!symbol) return;
    const cells = $(row).find('td').toArray().map((item) => $(item).text().trim());
    const close = cells[3] ? Number(cells[3].replace(/,/g, '')) : null;
    const volume = cells[4] ? Number(cells[4].replace(/,/g, '')) : null;
    if (symbol && close !== null && volume !== null && !quotes.some((quote) => quote.symbol === symbol)) {
      quotes.push({ symbol, timestamp: Date.now(), close, volume });
    }
  });
  if (quotes.length === 0) throw new Error('PSX market watch returned no parseable quotes');
  return quotes;
}

async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(MARKET_WATCH_URL, {
      signal: controller.signal,
      headers: { accept: 'text/html', 'user-agent': 'PSX-Quant-Swarm/1.0 (+live-data-client)' },
    });
    if (!response.ok) throw new Error(`PSX market watch returned HTTP ${response.status}`);
    const quotes = parseMarketWatch(await response.text());
    return { quotes, dataVerification: sourceVerification(quotes.length, ['PSX_MARKET_WATCH']) };
  } catch (watchError) {
    try {
      const response = await fetch(MARKET_SUMMARY_URL, {
        signal: controller.signal,
        headers: { accept: 'text/html', 'user-agent': 'PSX-Quant-Swarm/1.0 (+live-data-client)' },
      });
      if (!response.ok) throw new Error(`PSX market summary returned HTTP ${response.status}`);
      const quotes = parseMarketSummary(await response.text());
      return { quotes, dataVerification: sourceVerification(quotes.length, ['PSX_OFFICIAL_MARKET_SUMMARY_HTML']) };
    } catch (summaryError) {
      throw new Error(`PSX market watch and market summary both failed: ${watchError.message}; ${summaryError.message}`);
    }
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

const KSC30 = ['MARI','LUCK','ENGROH','OGDC','PPL','POL','HBL','UBL','MCB','BOP','BAHL','BAFL','PSO','FFC','EFERT','DGKC','FATIMA','LOTCHEM','COLG','NESTLE','NBP','SNGP','SYS','POWER','PIOC','FCL','ATBA','GHNI','TBL','HCAR'];
const KSC100 = ['MARI','LUCK','ENGROH','OGDC','PPL','POL','HBL','UBL','MCB','BOP','BAHL','BAFL','PSO','FFC','EFERT','DGKC','FATIMA','LOTCHEM','COLG','NESTLE','NBP','SNGP','SYS','POWER','PIOC','FCL','ATBA','GHNI','TBL','HCAR','INDU','MTL','SAZEW','AGTL','SLM','WAVES','EPCL','PAEL','PCAL','THALL','DWAE','BELA','ATLH','DFML','AGIL','EXIDE','LOADS','PTL','SIEM','WAVESAPP','ACPL','BWCL','CHCC','DBCI','DNCC','DCL','FCCL','FECTC','GWLC','KOHC','MLCF','BAPL','BERG','BUXL','DAAG','DOL','DYNO','EPCLPS','GCIL','GCWL','GGL','ICL','LPGL','NICL','NRSL','PAKOXY','PPVC','SARC','SITC','SPL','WAHN','HGFA','HIFA','TSMF','ABL','AKBL','BML','BOK','BIPL','FABL','HMB','JSBL','MEBL','SBL','SNBL','SCBPL','UBL','AGHA','ASL','ASTL','BECO','BCL','CSAP','DSL','INIL','ISL','MSCL','MUGHAL','PECO','KEL','HUBC','GATM','PICT','POML','SSOM','ZAL','NETSOL','QTECH','SELECT','STL','SYM','TPLT','WTL','ZUMA','AATM','AMTEX','ASTM','CTM','CFL','DMC','DSIL','DFSM','DWTM','DINT','ELCM','ELSM','GADT','GUSM','GSPM','HIRAT','IDEAL','IDRT','IDYM','JATM','JKSM','JDMT','KSTM','KOHTM','MQTM','NATM','NAGC','NCML','PRET','RUBY','SAIF','SLYT','SNAI','SSML','SERT','SHDT','SHCM','SZTM','SUTM','TATM','ASHT','ICCI','PRWM','STJT','YOUW'];

export async function getListedSymbols() {
  const snapshot = await getMarketSnapshot();
  const symbols = snapshot.quotes.map((quote) => quote.symbol);
  const ksc100 = KSC100.filter((sym) => symbols.includes(sym));
  const ksc30 = KSC30.filter((sym) => symbols.includes(sym));
  return { symbols, indexMembership: { ksc100, ksc30 }, dataVerification: snapshot.dataVerification };
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
  let resultBars = [...bars.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-requestedLimit);
  if (resultBars.length < 32) {
    const yahooBars = await getYahooHistoricalBars(normalized, requestedLimit);
    if (yahooBars.length >= 32) {
      resultBars = yahooBars;
    } else {
      throw new Error(`PSX returned only ${resultBars.length} historical bars for ${normalized} and Yahoo Finance fallback also unavailable`);
    }
  }
  const value = {
    bars: resultBars,
    dataVerification: {
      epochMs: Date.now(),
      sourceSignatures: ['PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT', 'YAHOO_FINANCE_FALLBACK'],
      sourceUrl: resultBars.length >= requestedLimit ? 'https://dps.psx.com.pk/historical' : 'https://query1.finance.yahoo.com/v8/finance/chart',
      dataPointCount: resultBars.length,
      divergenceScore: 0,
    },
  };
  historicalCache.set(cacheKey, { value, expiresAt: Date.now() + 300_000 });
  return value;
}

export async function getMarketWatch() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(MARKET_WATCH_URL, {
      signal: controller.signal,
      headers: { accept: 'text/html', 'user-agent': 'PSX-Quant-Swarm/1.0 (+live-data-client)' },
    });
    if (!response.ok) throw new Error(`PSX market watch returned HTTP ${response.status}`);
    const quotes = parseMarketWatch(await response.text());
    return { quotes, dataVerification: { ...sourceVerification(quotes.length), sourceSignatures: ['PSX_MARKET_WATCH'] } };
  } finally {
    clearTimeout(timeout);
  }
}

async function getYahooHistoricalBars(symbol, requestedLimit) {
  const yahooSymbol = `${symbol}.KA`;
  const cacheKey = `yahoo:${yahooSymbol}:${requestedLimit}`;
  const cached = yahooCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  
  const now = Date.now();
  const period1 = Math.floor((now - 365 * 24 * 60 * 60 * 1000) / 1000);
  const period2 = Math.floor(now / 1000);
  
  try {
    const response = await fetch(`${YAHOO_FINANCE_BASE}/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`, {
      headers: { 'user-agent': 'PSX-Quant-Swarm/1.0' },
    });
    if (!response.ok) throw new Error(`Yahoo Finance returned HTTP ${response.status}`);
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
      return [];
    }
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < timestamps.length && bars.length < requestedLimit; i++) {
      const bar = {
        symbol,
        timestamp: timestamps[i] * 1000,
        open: quotes.open[i],
        high: quotes.high[i],
        low: quotes.low[i],
        close: quotes.close[i],
        volume: quotes.volume[i],
      };
      if (bar.close && bar.volume && Number.isFinite(bar.close) && Number.isFinite(bar.volume)) {
        bars.push(bar);
      }
    }
    bars.sort((a, b) => a.timestamp - b.timestamp);
    yahooCache.set(cacheKey, { value: bars, expiresAt: Date.now() + 600_000 });
    return bars;
  } catch (error) {
    return [];
  }
}

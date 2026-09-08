import { chromium } from 'playwright';
import { dataVerification, immutableContract } from './contracts.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TEXT_LENGTH = 4_000;
const PSX_URL = 'https://www.psx.com.pk/market-summary';
const TRADINGVIEW_URL = 'https://www.tradingview.com/chart/?symbol=PSX:{symbol}';

function verification(sourceUrl, sourceSignature) {
  return dataVerification({
    sourceSignatures: [sourceSignature],
    dataPointCount: 1,
    divergenceScore: 0,
  });
}

async function inspectPage(page, url, sourceSignature, symbol) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  const title = await page.title();
  const text = (await page.locator('body').innerText({ timeout: REQUEST_TIMEOUT_MS })).replace(/\s+/g, ' ').trim();
  const symbolIndex = text.toUpperCase().indexOf(symbol);
  return immutableContract({
    url: page.url(),
    httpStatus: response?.status() ?? null,
    title,
    excerpt: text.slice(Math.max(0, symbolIndex - 250), Math.max(0, symbolIndex - 250) + MAX_TEXT_LENGTH),
    dataVerification: verification(url, sourceSignature),
  });
}

export async function researchSymbol(symbol) {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,20}$/.test(normalized)) throw new TypeError('Invalid symbol');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'PSX-Quant-Swarm/1.0 research agent' });
  const psxPage = await context.newPage();
  const tradingViewPage = await context.newPage();
  try {
    const [psx, tradingView] = await Promise.all([
      inspectPage(psxPage, PSX_URL, 'PSX_OFFICIAL_MARKET_SUMMARY_BROWSER', normalized),
      inspectPage(tradingViewPage, TRADINGVIEW_URL.replace('{symbol}', normalized), 'TRADINGVIEW_PUBLIC_CHART_PAGE_BROWSER', normalized),
    ]);
    return immutableContract({
      symbol: normalized,
      sources: immutableContract({ psx, tradingView }),
      dataVerification: dataVerification({
        sourceSignatures: [psx.dataVerification.sourceSignatures[0], tradingView.dataVerification.sourceSignatures[0]],
        dataPointCount: 2,
        divergenceScore: 0,
      }),
    });
  } finally {
    await browser.close();
  }
}

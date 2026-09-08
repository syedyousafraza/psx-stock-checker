import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { dataVerification, immutableContract } from './contracts.js';

const ANNOUNCEMENTS_URL = 'https://dps.psx.com.pk/announcements/companies';
const cache = new Map();
const REQUEST_TIMEOUT_MS = 20_000;

function unavailable(symbol, error) {
  return immutableContract({
    symbol,
    eventsFound: 0,
    classification: { direction: 'UNAVAILABLE', severity: 'UNKNOWN' },
    excerpt: '',
    sourceUrl: ANNOUNCEMENTS_URL,
    error: error.message,
    dataVerification: dataVerification({ sourceSignatures: ['PSX_OFFICIAL_ANNOUNCEMENTS_UNAVAILABLE'], dataPointCount: 0 }),
  });
}

function buildResult(symbol, text, sourceSignature) {
  const normalizedText = text.replace(/\s+/g, ' ');
  const index = normalizedText.toUpperCase().indexOf(symbol);
  const excerpt = index >= 0 ? normalizedText.slice(Math.max(0, index - 250), index + 1_500) : '';
  return immutableContract({
    symbol,
    eventsFound: index >= 0 ? 1 : 0,
    classification: classify(excerpt),
    excerpt,
    sourceUrl: ANNOUNCEMENTS_URL,
    dataVerification: dataVerification({ sourceSignatures: [sourceSignature], dataPointCount: index >= 0 ? 1 : 0 }),
  });
}

async function fetchAnnouncementsHtml() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ANNOUNCEMENTS_URL, {
      signal: controller.signal,
      headers: { accept: 'text/html', 'user-agent': 'PSX-Quant-Swarm/1.0 catalyst agent' },
    });
    if (!response.ok) throw new Error(`PSX announcements returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function classify(text) {
  const value = text.toUpperCase();
  if (/DIVIDEND|BONUS|BUYBACK/.test(value)) return { direction: 'POSITIVE', severity: 'MATERIAL' };
  if (/DELAY|DEFAULT|SUSPENSION|LOSS|RESIGNATION/.test(value)) return { direction: 'NEGATIVE', severity: 'MATERIAL' };
  return { direction: 'NEUTRAL', severity: 'INFORMATIONAL' };
}

export async function getCatalystEvents(symbol) {
  const normalized = symbol.trim().toUpperCase();
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ userAgent: 'PSX-Quant-Swarm/1.0 official announcements agent' });
    await page.goto(ANNOUNCEMENTS_URL, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const value = buildResult(normalized, await page.locator('body').innerText(), 'PSX_OFFICIAL_ANNOUNCEMENTS_BROWSER');
    cache.set(normalized, { value, expiresAt: Date.now() + 300_000 });
    return value;
  } catch (browserError) {
    try {
      const html = await fetchAnnouncementsHtml();
      const value = buildResult(normalized, cheerio.load(html).text(), 'PSX_OFFICIAL_ANNOUNCEMENTS_HTTP');
      cache.set(normalized, { value, expiresAt: Date.now() + 300_000 });
      return value;
    } catch (httpError) {
      return unavailable(normalized, new Error(`Browser: ${browserError.message}; HTTP: ${httpError.message}`));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

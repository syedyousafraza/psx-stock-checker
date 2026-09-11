import { assertFiniteSeries, dataVerification, immutableContract } from './contracts.js';

function returnsFrom(closes) {
  return closes.slice(1).map((close, index) => Math.log(close / closes[index]));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function addTradingDays(timestamp, tradingDays) {
  const date = new Date(timestamp);
  let remaining = tradingDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString();
}

export function forecastPrices(bars, {
  horizonBars = 1,
  anchorPrice = null,
  anchorTimestamp = null,
  asOfMs = Date.now(),
  hurstValue = null,
  driftWindow = 20,
  volatilityWindow = 20,
  momentumBars = 5,
  reversionWindow = 20,
  driftShrinkage = 0.5,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 32) {
    throw new RangeError('At least 32 verified bars are required for a forecast');
  }
  const closes = bars.map((bar) => Number(bar.close));
  assertFiniteSeries(closes, 'verified close prices');
  const returns = returnsFrom(closes);
  const lastBarTimestamp = bars.at(-1).timestamp;

  const volatility = standardDeviation(returns.slice(-volatilityWindow));
  const recent = returns.slice(-driftWindow);
  const decay = 2 / (driftWindow + 1);
  let driftNumerator = 0;
  let driftWeight = 0;
  recent.forEach((value, index) => {
    const weight = Math.exp(-decay * (recent.length - 1 - index));
    driftNumerator += weight * value;
    driftWeight += weight;
  });
  const ewmDrift = driftWeight > 0 ? driftNumerator / driftWeight : 0;

  const momentum = closes.at(-1) > 0 && closes.length > momentumBars
    ? Math.log(closes.at(-1) / closes.at(-momentumBars - 1)) / momentumBars
    : 0;

  const reversionMean = mean(closes.slice(-reversionWindow));
  const zScore = volatility > 0
    ? (closes.at(-1) - reversionMean) / (volatility * Math.sqrt(reversionWindow))
    : 0;
  const cappedZ = Math.max(-3, Math.min(3, zScore));
  const reversionSignal = -cappedZ * volatility * 0.5;

  const regime = Number.isFinite(hurstValue) ? Math.max(-1, Math.min(1, (hurstValue - 0.5) * 2.5)) : 0;
  const trendSignal = ewmDrift * 0.6 + momentum * 0.4;
  const blendedPerBar = (0.5 + regime / 2) * trendSignal + (0.5 - regime / 2) * reversionSignal;
  const expectedPerBar = blendedPerBar * driftShrinkage;

  const anchorAvailable = Number.isFinite(Number(anchorPrice)) && Number(anchorPrice) > 0;
  const lastPrice = anchorAvailable ? Number(anchorPrice) : closes.at(-1);
  const expectedPrice = lastPrice * Math.exp(expectedPerBar * horizonBars);
  const expectedReturn = expectedPrice / lastPrice - 1;
  const interval = 1.96 * volatility * Math.sqrt(horizonBars);

  const anchor = Math.max(lastBarTimestamp, Number(anchorTimestamp) || 0, Number(asOfMs) || 0);
  const expectedDate = addTradingDays(anchor, horizonBars);

  const historicalHorizonReturns = [];
  for (let index = horizonBars; index < closes.length; index += 1) {
    historicalHorizonReturns.push(Math.log(closes[index] / closes[index - horizonBars]));
  }
  const historicalExtreme = historicalHorizonReturns.length ? Math.max(...historicalHorizonReturns.map((value) => Math.abs(value))) : 0;
  const extremeForecast = Math.abs(expectedReturn) > Math.max(0.2, historicalExtreme * 3);

  const dataStalenessDays = Math.max(0, Math.round(((Number(asOfMs) || lastBarTimestamp) - lastBarTimestamp) / 86_400_000));

  return immutableContract({
    model: 'REGIME_BLEND_ENSEMBLE',
    modelStatus: 'PARTIALLY_CALIBRATED',
    direction: expectedPerBar > volatility * 0.5 ? 'UP' : expectedPerBar < -volatility * 0.5 ? 'DOWN' : 'UNCERTAIN',
    lastPrice,
    anchorPrice: anchorAvailable ? Number(anchorPrice) : null,
    anchorSource: anchorAvailable ? 'LIVE_PSX_QUOTE' : 'LAST_HISTORICAL_BAR',
    expectedPrice,
    expectedReturn,
    lowerBound: lastPrice * Math.exp(expectedPerBar * horizonBars - interval),
    upperBound: lastPrice * Math.exp(expectedPerBar * horizonBars + interval),
    volatility,
    horizonBars,
    expectedDate,
    extremeForecast,
    dataStalenessDays,
    factors: {
      ewmDrift,
      momentum,
      reversionSignal,
      regime,
      zScore: cappedZ,
      expectedPerBar,
    },
    sanityNote: extremeForecast ? 'Projected move is outside a conservative historical range; treat as NO_TRADE until validated.' : null,
    actionable: false,
    reason: `Regime-blended forecast using Hurst ${Number.isFinite(hurstValue) ? hurstValue.toFixed(3) : 'N/A'} (${anchorAvailable ? 'anchored to the live PSX quote' : 'anchored to the last verified bar'}). Requires walk-forward validation and broker-specific calibration before trading use.`,
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX'],
      dataPointCount: bars.length,
    }),
  });
}
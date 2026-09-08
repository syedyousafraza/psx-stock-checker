import { assertFiniteSeries, dataVerification, immutableContract } from './contracts.js';

function returnsFrom(closes) {
  return closes.slice(1).map((close, index) => Math.log(close / closes[index]));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

export function forecastPrices(bars, { horizonBars = 1 } = {}) {
  if (!Array.isArray(bars) || bars.length < 32) {
    throw new RangeError('At least 32 verified bars are required for a forecast');
  }
  const closes = bars.map((bar) => Number(bar.close));
  assertFiniteSeries(closes, 'verified close prices');
  const returns = returnsFrom(closes);
  const recent = returns.slice(-20);
  const drift = mean(recent);
  const variance = mean(recent.map((value) => (value - drift) ** 2));
  const volatility = Math.sqrt(variance);
  const lastPrice = closes.at(-1);
  const expectedReturn = Math.expm1(drift * horizonBars);
  const expectedPrice = lastPrice * (1 + expectedReturn);
  const interval = 1.96 * volatility * Math.sqrt(horizonBars);
  const historicalHorizonReturns = [];
  for (let index = horizonBars; index < closes.length; index += 1) {
    historicalHorizonReturns.push(Math.log(closes[index] / closes[index - horizonBars]));
  }
  const historicalExtreme = historicalHorizonReturns.length ? Math.max(...historicalHorizonReturns.map((value) => Math.abs(value))) : 0;
  const extremeForecast = Math.abs(expectedReturn) > Math.max(0.2, historicalExtreme * 3);
  return immutableContract({
    model: 'EWMA_DRIFT_BASELINE',
    modelStatus: 'BASELINE_UNCALIBRATED',
    direction: expectedReturn > volatility ? 'UP' : expectedReturn < -volatility ? 'DOWN' : 'UNCERTAIN',
    lastPrice,
    expectedPrice,
    expectedReturn,
    lowerBound: lastPrice * Math.exp(drift * horizonBars - interval),
    upperBound: lastPrice * Math.exp(drift * horizonBars + interval),
    volatility,
    horizonBars,
    expectedDate: addTradingDays(bars.at(-1).timestamp, horizonBars),
    extremeForecast,
    sanityNote: extremeForecast ? 'Projected move is outside a conservative historical range; treat as NO_TRADE until validated.' : null,
    actionable: false,
    reason: 'Requires walk-forward validation and broker-specific calibration before trading use',
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX'],
      dataPointCount: bars.length,
    }),
  });
}

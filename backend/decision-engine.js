import { dataVerification, immutableContract } from './contracts.js';

function returnsFrom(bars) {
  return bars.slice(1).map((bar, index) => Math.log(Number(bar.close) / Number(bars[index].close)));
}

export function generateSignal({ bars, hurst, adf, prediction, risk, quote }, { minimumBars = 32, threshold = 0.5, minimumMedianVolume = 100_000, allowPaperWithoutSpread = true } = {}) {
  if (!Array.isArray(bars) || bars.length < minimumBars) throw new RangeError(`At least ${minimumBars} verified bars are required for a signal`);
  const returns = returnsFrom(bars);
  const volatility = Number(prediction?.volatility);
  const expectedReturn = Number(prediction?.expectedReturn);
  const edgeScore = volatility > 0 ? expectedReturn / volatility : 0;
  const persistence = Number(hurst?.value);
  const directionalSignal = !prediction?.extremeForecast && (edgeScore >= threshold && persistence > 0.5 ? 'BUY' : edgeScore <= -threshold && persistence > 0.5 ? 'SELL' : 'NO_TRADE');
  const volumes = bars.map((bar) => Number(bar.volume)).filter(Number.isFinite).sort((left, right) => left - right);
  const medianVolume = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0;
  const liquidity = { medianVolume, minimumMedianVolume, pass: medianVolume >= minimumMedianVolume };
  const spread = {
    bid: Number.isFinite(Number(quote?.bid)) ? Number(quote.bid) : null,
    ask: Number.isFinite(Number(quote?.ask)) ? Number(quote.ask) : null,
    bps: Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)) && Number(quote.bid) > 0
      ? ((Number(quote.ask) - Number(quote.bid)) / Number(quote.bid)) * 10_000 : null,
    pass: Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)),
    status: Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)) ? 'VERIFIED' : 'UNAVAILABLE',
  };
  const riskGate = Boolean(risk?.authorized) && liquidity.pass && (spread.pass || allowPaperWithoutSpread);
  const direction = directionalSignal !== 'NO_TRADE' && riskGate ? directionalSignal : 'NO_TRADE';
  const confidence = Math.min(0.99, Math.abs(edgeScore) / 2);
  const reasons = [
    `edge score ${edgeScore.toFixed(3)}`,
    `Hurst ${persistence.toFixed(3)} (${hurst?.regime || 'UNKNOWN'})`,
    `ADF ${adf?.stationary ? 'stationary' : 'non-stationary'}`,
  ];
  if (directionalSignal === 'NO_TRADE') reasons.push('forecast edge is below the configured threshold or regime is not persistent');
  if (prediction?.extremeForecast) reasons.push('projected move is outside the conservative historical range');
  if (!risk?.authorized) reasons.push('VaR/CVaR or Kelly risk gate failed');
  if (!liquidity.pass) reasons.push(`median volume ${medianVolume.toFixed(0)} is below ${minimumMedianVolume}`);
  if (!spread.pass) reasons.push('bid/ask spread is unavailable from the official PSX snapshot');
  if (!spread.pass && allowPaperWithoutSpread) reasons.push('paper signal permitted for display only; execution remains blocked');
  return immutableContract({
    signal: direction,
    directionalSignal,
    confidence,
    edgeScore,
    horizonBars: prediction.horizonBars,
    expectedReturn,
    paperOnly: true,
    executionAuthorized: false,
    riskGate,
    spreadGate: spread.pass,
    paperSignalWithoutSpread: allowPaperWithoutSpread && !spread.pass,
    risk,
    liquidity,
    spread,
    reasons,
    dataVerification: dataVerification({
      sourceSignatures: ['VERIFIED_PRICE_MATRIX', 'PSX_OFFICIAL_HISTORICAL_PORTAL_PLAYWRIGHT'],
      dataPointCount: bars.length,
      divergenceScore: 0,
    }),
  });
}

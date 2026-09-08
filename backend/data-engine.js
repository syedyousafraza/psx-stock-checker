import { assertFiniteSeries, dataVerification, immutableContract } from './contracts.js';

const DEFAULT_TOLERANCE = 0.001;

function barValue(bar, key) {
  return Number(typeof bar === 'number' ? bar : bar[key]);
}

function cloneBar(bar, close, volume = barValue(bar, 'volume')) {
  return typeof bar === 'number' ? close : { ...bar, close, volume };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function reconcileStreams(primary, baseline, tolerance = DEFAULT_TOLERANCE) {
  if (!Array.isArray(primary) || !Array.isArray(baseline)) throw new TypeError('Both streams must be arrays');
  const baselineByTimestamp = new Map(baseline.map((bar, index) => [bar.timestamp ?? index, bar]));
  let anomalyCount = 0;
  const reconciled = primary.map((primaryBar, index) => {
    const timestamp = primaryBar.timestamp ?? index;
    const baselineBar = baselineByTimestamp.get(timestamp);
    if (!baselineBar) return { ...primaryBar, dataFeedAnomaly: false };
    const primaryClose = barValue(primaryBar, 'close');
    const baselineClose = barValue(baselineBar, 'close');
    const divergence = baselineClose === 0 ? 0 : Math.abs(primaryClose - baselineClose) / Math.abs(baselineClose);
    const dataFeedAnomaly = divergence > tolerance;
    if (dataFeedAnomaly) anomalyCount += 1;
    return {
      ...cloneBar(primaryBar, dataFeedAnomaly ? baselineClose : primaryClose),
      timestamp,
      dataFeedAnomaly,
      divergenceScore: divergence,
      fallbackSource: dataFeedAnomaly ? 'PSX_OFFICIAL_LEDGER' : null,
    };
  });
  return immutableContract({
    bars: reconciled,
    dataVerification: dataVerification({
      sourceSignatures: ['PRIMARY_INTRADAY', 'PSX_OFFICIAL_LEDGER'],
      dataPointCount: reconciled.length,
      divergenceScore: reconciled.length ? anomalyCount / reconciled.length : 0,
    }),
  });
}

export function filterBadPrints(bars, { rollingWindow = 5, volumeWindow = 20, sigma = 3 } = {}) {
  if (!Array.isArray(bars)) throw new TypeError('bars must be an array');
  const accepted = [];
  const rejected = [];
  bars.forEach((bar, index) => {
    const price = barValue(bar, 'close');
    const volume = barValue(bar, 'volume');
    const recentPrices = accepted.slice(-rollingWindow).map((item) => barValue(item, 'close'));
    const priorVolumes = bars.slice(Math.max(0, index - volumeWindow), index).map((item) => barValue(item, 'volume')).filter(Number.isFinite);
    const baselineVolume = priorVolumes.length ? mean(priorVolumes) : volume;
    const average = recentPrices.length ? mean(recentPrices) : price;
    const deviation = recentPrices.length > 1 ? standardDeviation(recentPrices) : 0;
    const outlier = deviation > 0 && Math.abs(price - average) > sigma * deviation;
    const volumeExpansion = baselineVolume > 0 ? volume / baselineVolume : Infinity;
    if (outlier && volumeExpansion < 2) rejected.push({ ...bar, rejectionReason: 'THREE_SIGMA_WITHOUT_VOLUME_CONFIRMATION' });
    else accepted.push(bar);
  });
  return immutableContract({
    bars: accepted,
    rejected,
    dataVerification: dataVerification({
      sourceSignatures: ['RECONCILED_STREAM'],
      dataPointCount: accepted.length,
      divergenceScore: bars.length ? rejected.length / bars.length : 0,
    }),
  });
}

export function applyCorporateActions(bars, actions = []) {
  if (!Array.isArray(bars)) throw new TypeError('bars must be an array');
  const adjusted = bars.map((bar) => ({ ...bar }));
  actions.forEach((action) => {
    if (!Number.isFinite(action.factor) || action.factor <= 0) throw new TypeError('Corporate action factor must be positive');
    adjusted.forEach((bar) => {
      if ((bar.timestamp ?? 0) < action.timestamp) {
        const volume = barValue(bar, 'volume');
        const close = barValue(bar, 'close');
        Object.assign(bar, cloneBar(bar, close / action.factor, volume * action.factor));
      }
    });
  });
  return immutableContract({
    bars: adjusted,
    dataVerification: dataVerification({
      sourceSignatures: ['PUCARS_CORPORATE_ACTIONS'],
      dataPointCount: adjusted.length,
      divergenceScore: 0,
    }),
  });
}

export function prepareVerifiedMatrix(primary, baseline, actions = []) {
  const reconciled = reconcileStreams(primary, baseline);
  const filtered = filterBadPrints(reconciled.bars);
  const adjusted = applyCorporateActions(filtered.bars, actions);
  assertFiniteSeries(adjusted.bars.map((bar) => barValue(bar, 'close')), 'adjusted close prices');
  return immutableContract({
    bars: adjusted.bars,
    rejected: filtered.rejected,
    dataVerification: adjusted.dataVerification,
  });
}

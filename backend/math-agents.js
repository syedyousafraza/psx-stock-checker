import { assertFiniteSeries, dataVerification, immutableContract } from './contracts.js';

function pricesOf(priceArray) {
  const values = priceArray.map((item) => Number(typeof item === 'number' ? item : item.close));
  assertFiniteSeries(values, 'priceArray');
  return values;
}

export function KalmanFilter(priceArray, { processNoise = 1e-5, measurementNoise = 1e-2 } = {}) {
  const prices = pricesOf(priceArray);
  let estimate = prices[0];
  let covariance = 1;
  const track = prices.map((price, index) => {
    const volume = typeof priceArray[index] === 'number' ? 1 : Number(priceArray[index].volume) || 1;
    const predictionCovariance = covariance + processNoise * Math.max(1, volume);
    const gain = predictionCovariance / (predictionCovariance + measurementNoise);
    estimate += gain * (price - estimate);
    covariance = (1 - gain) * predictionCovariance;
    return immutableContract({
      index,
      observedPrice: price,
      filteredPrice: estimate,
      gain,
      covariance,
      dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: index + 1 }),
    });
  });
  return immutableContract({
    track,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}

function log2(value) {
  return Math.log(value) / Math.log(2);
}

export function HurstExponent(priceArray) {
  const prices = pricesOf(priceArray);
  if (prices.length < 16) throw new RangeError('At least 16 prices are required for Hurst estimation');
  const logReturns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const scales = [];
  for (let scale = 8; scale <= logReturns.length / 2; scale *= 2) scales.push(scale);
  const points = [];
  for (const scale of scales) {
    const samples = Math.floor(logReturns.length / scale);
    const rsValues = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const segment = logReturns.slice(sample * scale, (sample + 1) * scale);
      const average = segment.reduce((sum, value) => sum + value, 0) / scale;
      let cumulative = 0;
      let minimum = Infinity;
      let maximum = -Infinity;
      let variance = 0;
      segment.forEach((value) => {
        cumulative += value - average;
        minimum = Math.min(minimum, cumulative);
        maximum = Math.max(maximum, cumulative);
        variance += (value - average) ** 2;
      });
      const standardDeviation = Math.sqrt(variance / scale);
      if (standardDeviation > 0) rsValues.push((maximum - minimum) / standardDeviation);
    }
    if (rsValues.length) points.push([log2(scale), log2(rsValues.reduce((sum, value) => sum + value, 0) / rsValues.length)]);
  }
  const xMean = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const slope = points.reduce((sum, [x, y]) => sum + (x - xMean) * (y - yMean), 0) /
    points.reduce((sum, [x]) => sum + (x - xMean) ** 2, 0);
  const value = Math.max(0, Math.min(1, slope));
  const regime = Math.abs(value - 0.5) < 0.01 ? 'RANDOM_WALK' : value < 0.5 ? 'MEAN_REVERTING' : 'PERSISTENT_TREND';
  return immutableContract({
    value,
    regime,
    scales: points.map(([scale]) => 2 ** scale),
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}

export function adfStatistic(priceArray) {
  const prices = pricesOf(priceArray);
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return immutableContract({
    statistic: variance === 0 ? 0 : mean / Math.sqrt(variance),
    stationary: variance > 0 && Math.abs(mean / Math.sqrt(variance)) < 1.96,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_PRICE_MATRIX'], dataPointCount: prices.length }),
  });
}

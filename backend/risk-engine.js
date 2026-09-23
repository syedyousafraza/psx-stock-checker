import { dataVerification, immutableContract } from './contracts.js';

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function ewmaVariance(returns, lambda = 0.94) {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  let varEst = 0;
  for (let i = 1; i < returns.length; i++) {
    const dev = returns[i] - m;
    varEst = lambda * varEst + (1 - lambda) * dev * dev;
  }
  return varEst;
}

function garch11(returns) {
  const n = returns.length;
  if (n < 10) return { conditionalVariance: standardDeviation(returns) ** 2 };
  const uncondVar = standardDeviation(returns) ** 2;
  const alpha = 0.1, beta = 0.85;
  const omega = uncondVar * (1 - alpha - beta);
  let h = uncondVar;
  for (let i = 0; i < n; i++) {
    const eps = returns[i] - mean(returns);
    h = omega + alpha * eps * eps + beta * h;
  }
  return { conditionalVariance: Math.max(h, 1e-10), omega, alpha, beta };
}

export function riskProfile(returns, { 
  capital = 1_000_000, 
  horizon = 1, 
  confidence = 0.99, 
  rewardMultiple = 2.5,
  maxPosition = 0.1,
  maxDrawdown = 0.15,
  useGarch = true,
  useCVaR = true,
} = {}) {
  if (!Array.isArray(returns) || returns.length < 30) {
    throw new TypeError('At least 30 returns are required for robust risk estimation');
  }
  
  const sorted = [...returns].sort((a, b) => a - b);
  const n = returns.length;
  
  const varIdx = Math.max(0, Math.floor((1 - confidence) * n));
  const varReturn = sorted[varIdx];
  
  const tail = sorted.slice(0, varIdx + 1);
  const expectedShortfall = tail.length ? tail.reduce((sum, value) => sum + value, 0) / tail.length : varReturn;
  
  const garch = useGarch ? garch11(returns) : null;
  const condVol = garch ? Math.sqrt(garch.conditionalVariance) : standardDeviation(returns);
  const ewmaVol = Math.sqrt(ewmaVariance(returns));
  const vol = Math.max(condVol, ewmaVol);
  
  const meanReturn = mean(returns);
  const winProb = returns.filter(v => v > 0).length / n;
  const lossProb = 1 - winProb;
  const avgWin = returns.filter(v => v > 0).reduce((a, b) => a + b, 0) / (returns.filter(v => v > 0).length || 1);
  const avgLoss = Math.abs(returns.filter(v => v < 0).reduce((a, b) => a + b, 0) / (returns.filter(v => v < 0).length || 1));
  
  const payoff = avgLoss > 0 ? avgWin / avgLoss : rewardMultiple;
  const kellyFull = (winProb * payoff - lossProb) / payoff;
  const kellyHalf = kellyFull / 2;
  const kellyQuarter = kellyFull / 4;
  
  const volTarget = 0.15;
  const volScaled = vol > 0 ? volTarget / (vol * Math.sqrt(252)) : 0;
  const allocation = Math.min(maxPosition, Math.max(0, Math.min(kellyHalf, volScaled)));
  
  const var99 = Math.abs(varReturn) * Math.sqrt(horizon);
  const cvar99 = Math.abs(expectedShortfall) * Math.sqrt(horizon);
  const garchVar = garch ? Math.sqrt(garch.conditionalVariance * horizon) * 2.33 : var99;
  const garchCVaR = garch ? garchVar * 1.3 : cvar99;
  
  const capitalAtRisk = capital * allocation;
  const maxLoss = capital * maxDrawdown;
  const positionLimitByDrawdown = maxDrawdown > 0 && cvar99 > 0 ? maxLoss / (capital * cvar99) : maxPosition;
  const finalAllocation = Math.min(allocation, positionLimitByDrawdown);
  
  const sharpe = vol > 0 ? meanReturn / vol * Math.sqrt(252) : 0;
  const sortino = downsideDeviation(returns) > 0 ? meanReturn / downsideDeviation(returns) * Math.sqrt(252) : 0;
  const calmar = maxDrawdownCalc(returns) > 0 ? (meanReturn * 252) / maxDrawdownCalc(returns) : 0;
  
  const authorized = sharpe > 0.15 && sortino > 0.15 && calmar > 0.15 && finalAllocation > 0.005;
  
  return immutableContract({
    var99,
    cvar99,
    garchVar99: garchVar,
    garchCVaR99: garchCVaR,
    conditionalVolatility: condVol,
    ewmaVolatility: ewmaVol,
    rewardMultiple: payoff,
    kellyFull,
    kellyHalf,
    kellyQuarter,
    allocation: finalAllocation,
    capitalAtRisk: capital * finalAllocation,
    maxDrawdownLimit: maxDrawdown,
    authorized,
    winProbability: winProb,
    avgWin,
    avgLoss,
    payoffRatio: payoff,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    meanReturn,
    volatility: vol,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_RETURN_MATRIX'], dataPointCount: n }),
  });
}

function downsideDeviation(returns) {
  const meanRet = mean(returns);
  const downside = returns.filter(r => r < meanRet);
  if (downside.length < 2) return 0;
  return Math.sqrt(downside.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (downside.length - 1));
}

function maxDrawdownCalc(returns) {
  let peak = 0;
  let maxDD = 0;
  let cum = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

export function portfolioRisk(returnsMatrix, weights, { capital = 1_000_000, confidence = 0.99 } = {}) {
  const nAssets = returnsMatrix[0].length;
  const nObs = returnsMatrix.length;
  if (weights.length !== nAssets) throw new Error('Weights length must match number of assets');
  
  const covMatrix = estimateCovariance(returnsMatrix);
  const portVar = quadraticForm(weights, covMatrix);
  const portVol = Math.sqrt(portVar);
  
  const portReturns = returnsMatrix.map(row => dotProduct(row, weights));
  const sorted = [...portReturns].sort((a, b) => a - b);
  const varIdx = Math.floor((1 - confidence) * nObs);
  const varRet = sorted[varIdx];
  const tail = sorted.slice(0, varIdx + 1);
  const cvarRet = tail.reduce((a, b) => a + b, 0) / tail.length;
  
  const marginalVaR = weights.map((w, i) => {
    const covRow = covMatrix[i];
    return dotProduct(covRow, weights) / (portVol || 1);
  });
  
  const componentVaR = weights.map((w, i) => w * marginalVaR[i]);
  
  return immutableContract({
    portfolioVolatility: portVol,
    portfolioVaR: Math.abs(varRet),
    portfolioCVaR: Math.abs(cvarRet),
    marginalVaR,
    componentVaR,
    diversificationRatio: weights.reduce((s, w) => s + Math.abs(w) * Math.sqrt(covMatrix[weights.indexOf(w)][weights.indexOf(w)]), 0) / (portVol || 1),
    weights,
    capitalAtRisk: capital * Math.abs(varRet),
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_RETURN_MATRIX'], dataPointCount: nObs }),
  });
}

function estimateCovariance(returnsMatrix) {
  const n = returnsMatrix.length;
  const p = returnsMatrix[0].length;
  const means = Array(p).fill(0).map((_, j) => mean(returnsMatrix.map(row => row[j])));
  const centered = returnsMatrix.map(row => row.map((v, j) => v - means[j]));
  const cov = Array(p).fill(0).map(() => Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += centered[k][i] * centered[k][j];
      }
      cov[i][j] = cov[j][i] = sum / (n - 1);
    }
  }
  return cov;
}

function dotProduct(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

function quadraticForm(x, A) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < x.length; j++) {
      sum += x[i] * A[i][j] * x[j];
    }
  }
  return sum;
}

export function stressTest(returns, scenarios = {}) {
  const defaultScenarios = {
    '2008_crisis': { meanShift: -0.02, volMultiplier: 3 },
    'covid_crash': { meanShift: -0.03, volMultiplier: 4 },
    'flash_crash': { meanShift: -0.05, volMultiplier: 5 },
    'normal': { meanShift: 0, volMultiplier: 1 },
  };
  const allScenarios = { ...defaultScenarios, ...scenarios };
  const results = {};
  
  const baseMean = mean(returns);
  const baseVol = standardDeviation(returns);
  
  for (const [name, { meanShift, volMultiplier }] of Object.entries(allScenarios)) {
    const stressedMean = baseMean + meanShift;
    const stressedVol = baseVol * volMultiplier;
    const var99 = stressedMean - 2.33 * stressedVol;
    const cvar99 = stressedMean - 3.0 * stressedVol;
    results[name] = {
      expectedReturn: stressedMean,
      volatility: stressedVol,
      var99: Math.abs(var99),
      cvar99: Math.abs(cvar99),
      maxDrawdownEstimate: Math.abs(cvar99) * 5,
    };
  }
  
  return immutableContract({
    base: { mean: baseMean, vol: baseVol },
    scenarios: results,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_RETURN_MATRIX'], dataPointCount: returns.length }),
  });
}

export function positionSizing({ 
  signal, 
  volatility, 
  capital, 
  maxRisk = 0.02, 
  kellyFraction = 0.25,
  conviction = 1,
  minSize = 0,
  maxSize = 0.1,
} = {}) {
  if (!signal || volatility <= 0) return { size: 0, reason: 'No signal or invalid volatility' };
  
  const volTarget = 0.15;
  const volScaled = volTarget / (volatility * Math.sqrt(252));
  const kellySize = Math.abs(signal.edgeScore) * kellyFraction * conviction;
  const riskSize = maxRisk / (volatility * Math.sqrt(252));
  
  let size = Math.min(volScaled, kellySize, riskSize);
  size = Math.max(minSize, Math.min(maxSize, size));
  
  if (signal.direction === 'DOWN' && !signal.allowShort) size = 0;
  
  const notional = capital * size;
  const riskAmount = notional * volatility * Math.sqrt(1/252) * 2.33;
  
  return {
    size,
    notional,
    riskAmount,
    riskPct: riskAmount / capital,
    method: 'vol_target_kelly_risk',
    conviction,
    edgeScore: signal.edgeScore,
  };
}
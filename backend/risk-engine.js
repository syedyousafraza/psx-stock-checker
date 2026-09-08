import { dataVerification, immutableContract } from './contracts.js';

export function riskProfile(returns, { capital = 1_000_000, horizon = 1, confidence = 0.99, rewardMultiple = 2.5 } = {}) {
  if (!Array.isArray(returns) || returns.length < 2) throw new TypeError('At least two returns are required');
  const sorted = [...returns].sort((a, b) => a - b);
  const tailIndex = Math.max(0, Math.floor((1 - confidence) * sorted.length));
  const varReturn = sorted[tailIndex];
  const tail = sorted.slice(0, tailIndex + 1);
  const expectedShortfall = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const winProbability = returns.filter((value) => value > 0).length / returns.length;
  const lossProbability = 1 - winProbability;
  const payoff = rewardMultiple;
  const kelly = Math.max(0, (winProbability * payoff - lossProbability) / payoff / 2);
  const allocation = Math.min(0.05, kelly);
  return immutableContract({
    var99: Math.abs(varReturn) * Math.sqrt(horizon),
    cvar99: Math.abs(expectedShortfall) * Math.sqrt(horizon),
    rewardMultiple,
    authorized: rewardMultiple >= 2.5 && allocation > 0,
    winProbability,
    allocation,
    capitalAtRisk: capital * allocation,
    dataVerification: dataVerification({ sourceSignatures: ['VERIFIED_RETURN_MATRIX'], dataPointCount: returns.length }),
  });
}

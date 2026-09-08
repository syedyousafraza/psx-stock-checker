import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const modes = {
  weekly: { label: 'Weekly swing', interval: 'Daily bars', horizon: '2-5 trading days' },
  macro: { label: 'Macro position', interval: 'Daily bars', horizon: '1-6 months' },
};

function Sparkline({ prices, filtered }) {
  const points = useMemo(() => {
    if (!prices?.length) return '';
    const min = Math.min(...prices); const max = Math.max(...prices); const range = max - min || 1;
    return prices.map((value, index) => `${(index / (prices.length - 1)) * 100},${100 - ((value - min) / range) * 88}`).join(' ');
  }, [prices]);
  const filterPoints = filtered?.map((item, index) => `${(index / (filtered.length - 1)) * 100},${100 - ((item.filteredPrice - Math.min(...prices)) / (Math.max(...prices) - Math.min(...prices) || 1)) * 88}`).join(' ');
  return <svg className="chart" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={points} className="price-line" /><polyline points={filterPoints} className="kalman-line" /></svg>;
}

function App() {
  const [symbol, setSymbol] = useState('SYS');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('weekly');
  const [symbols, setSymbols] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [research, setResearch] = useState(null);
  const [selectedSymbols, setSelectedSymbols] = useState([]);
  const [comparisonQuery, setComparisonQuery] = useState('');
  const [comparisonResults, setComparisonResults] = useState([]);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [showExplanations, setShowExplanations] = useState(false);
  const [loadingSymbol, setLoadingSymbol] = useState(false);
  const [backtest, setBacktest] = useState(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  useEffect(() => { fetch('/api/symbols').then((response) => response.json()).then((payload) => setSymbols(payload.symbols)); }, []);
  useEffect(() => {
    let active = true;
    setLoadingSymbol(true);
    setAnalysis(null);
    setResearch(null);
    setBacktest(null);
    fetch(`/api/analysis/${symbol}?mode=${mode}`).then((response) => response.json()).then((payload) => {
      if (active) setAnalysis(payload);
    }).finally(() => {
      if (active) setLoadingSymbol(false);
    });
    fetch(`/api/research/${symbol}`).then((response) => response.json()).then((payload) => {
      if (active) setResearch(payload);
    });
    return () => { active = false; };
  }, [symbol, mode]);
  const visibleSymbols = symbols.filter((item) => item.toLowerCase().includes(query.toLowerCase()));
  const comparisonSymbols = symbols.filter((item) => item.toLowerCase().includes(comparisonQuery.toLowerCase())).slice(0, 80);
  const selectedMode = modes[mode];
  const prices = analysis?.matrix?.bars.map((bar) => bar.close) || [];
  const liveQuote = analysis?.quote;
  const analysisReady = Boolean(analysis?.matrix);
  const researchReady = Boolean(research?.dataVerification);
  const prediction = analysis?.prediction;
  const signal = analysis?.signal;
  const formatPercent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '--';
  async function compareSelected() {
    if (selectedSymbols.length === 0) return;
    setComparisonLoading(true);
    const results = await Promise.all(selectedSymbols.map(async (item) => {
      try {
        const response = await fetch(`/api/analysis/${item}?mode=${mode}&limit=100`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        return { symbol: item, comparisonError: error.message };
      }
    }));
    setComparisonResults(results.filter((item) => item.signal));
    setComparisonLoading(false);
  }
  async function runBacktest() {
    setBacktestLoading(true);
    setBacktest(null);
    try {
      const response = await fetch(`/api/backtest/${symbol}?mode=${mode}&limit=500`);
      setBacktest(response.ok ? await response.json() : { error: `HTTP ${response.status}` });
    } catch (error) {
      setBacktest({ error: error.message });
    } finally {
      setBacktestLoading(false);
    }
  }
  const rankedResults = [...comparisonResults].sort((left, right) => right.signal.edgeScore - left.signal.edgeScore);
  const actionableBuys = comparisonResults.filter((item) => item.signal.signal === 'BUY').sort((left, right) => right.signal.edgeScore - left.signal.edgeScore);
  const blockedPositive = comparisonResults.filter((item) => item.signal.edgeScore > 0 && item.signal.signal !== 'BUY').sort((left, right) => right.signal.edgeScore - left.signal.edgeScore)[0] || null;
  const strongestBuy = actionableBuys[0] || null;
  const backtestRows = backtest?.result?.observations || [];
  const formatDate = (timestamp) => timestamp ? new Date(timestamp).toLocaleDateString() : '--';
  const formatMoney = (value) => Number.isFinite(value) ? value.toLocaleString('en-US', { style: 'currency', currency: 'PKR', maximumFractionDigits: 2 }) : '--';
  const verdictClass = (verdict) => verdict === 'STRONG_EDGE' || verdict === 'PROFITABLE' ? 'buy-text' : verdict === 'MARGINALLY_PROFITABLE' ? '' : 'warning-text';
  const bt = backtest?.result;
  const btComplete = Boolean(bt?.portfolio && bt?.performance && bt?.winLoss && bt?.tradeLog && bt?.verdict);
  return <main>
    <header><div><span className="eyebrow">PSX / QUANTITATIVE OPERATIONS</span><h1>Market structure, measured.</h1></div><div className="status"><i className={analysisReady ? '' : 'warning-dot'} /> {analysisReady ? 'Feeds reconciled' : 'Historical feed required'} <span>UTC {new Date().toISOString().slice(11, 16)}</span></div></header>
    <section className="control-bar"><label className="search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search listed symbols" /><select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{visibleSymbols.map((item) => <option key={item}>{item}</option>)}</select></label><nav>{Object.entries(modes).map(([key, item]) => <button className={mode === key ? 'active' : ''} onClick={() => setMode(key)} key={key}>{item.label}</button>)}</nav></section>
    <section className="compare panel"><div className="panel-head"><div><span className="eyebrow">UNIVERSE RANKING</span><h3>Compare up to 10 symbols</h3></div><span className="muted">{selectedSymbols.length}/10 selected</span></div><div className="compare-controls"><input value={comparisonQuery} onChange={(event) => setComparisonQuery(event.target.value)} placeholder="Filter listed symbols" /><button className="active" disabled={!selectedSymbols.length || comparisonLoading} onClick={compareSelected}>{comparisonLoading ? 'Analyzing...' : 'Rank selection'}</button><button className="help-button" onClick={() => setShowExplanations((value) => !value)}>{showExplanations ? 'Hide explanations' : 'Explain results'}</button></div>{showExplanations && <div className="explanations"><div><strong>BUY</strong><span>The model sees a strong positive pattern, but this is a paper signal, not an order.</span></div><div><strong>SELL</strong><span>The model sees a strong negative pattern. It does not mean short-selling is available.</span></div><div><strong>NO_TRADE</strong><span>The evidence is too weak or a safety check blocked the candidate.</span></div><div><strong>Edge</strong><span>How strong the expected move is compared with recent price variability. Higher is not automatically safer.</span></div><div><strong>Liquidity</strong><span>Whether the stock normally trades enough shares for the configured minimum. BLOCK means it may be difficult to enter or exit.</span></div><div><strong>VaR / CVaR</strong><span>Estimated bad-day loss and average loss in the worst 1% of historical outcomes.</span></div><div><strong>Spread unavailable</strong><span>PSX public data gives price and volume, but not live bid and ask prices. Trading cost cannot be measured, so real execution stays blocked.</span></div><div><strong>Confidence</strong><span>Confidence in this model pattern, not a guarantee that the price will move as predicted.</span></div></div>}<div className="symbol-picks">{comparisonSymbols.map((item) => <label key={item} className={selectedSymbols.includes(item) ? 'picked' : ''}><input type="checkbox" checked={selectedSymbols.includes(item)} disabled={!selectedSymbols.includes(item) && selectedSymbols.length >= 10} onChange={() => setSelectedSymbols((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])} />{item}</label>)}</div>{comparisonResults.length > 0 && <div className="candidate-summary">{strongestBuy ? <div className="strongest actionable"><span className="eyebrow">STRONGEST ACTIONABLE PAPER BUY</span><strong>{strongestBuy.symbol}</strong><b>PSX price {strongestBuy.quote.close.toFixed(2)}</b><span>edge {strongestBuy.signal.edgeScore.toFixed(3)} · confidence {formatPercent(strongestBuy.signal.confidence)}</span><small>Paper signal only · live execution remains blocked</small></div> : <div className="strongest"><span className="eyebrow">STRONGEST ACTIONABLE PAPER BUY</span><strong>NONE</strong><span>No selected symbol passed the BUY gates.</span></div>}{blockedPositive ? <div className="strongest blocked"><span className="eyebrow">HIGHEST POSITIVE EDGE BLOCKED</span><strong>{blockedPositive.symbol}</strong><b>PSX price {blockedPositive.quote.close.toFixed(2)}</b><span>edge {blockedPositive.signal.edgeScore.toFixed(3)} · {blockedPositive.signal.signal} · {blockedPositive.signal.liquidity.pass ? 'liquidity passed' : 'liquidity blocked'}</span><small>{blockedPositive.signal.reasons.at(-1)}</small></div> : <div className="strongest"><span className="eyebrow">HIGHEST POSITIVE EDGE BLOCKED</span><strong>NONE</strong><span>No positive but blocked candidate in this selection.</span></div>}</div>}{comparisonResults.length > 0 && <div className="ranking">{rankedResults.map((item, index) => <div key={item.symbol}><span>#{index + 1}</span><strong>{item.symbol}</strong><b>PSX {item.quote.close.toFixed(2)}</b><b className={item.signal.signal === 'BUY' ? 'buy-text' : item.signal.signal === 'SELL' ? 'sell-text' : ''}>{item.signal.signal}</b><small>volume {item.quote.volume.toLocaleString()} · edge {item.signal.edgeScore.toFixed(3)} · VaR {(item.risk.var99 * 100).toFixed(2)}% · liquidity {item.signal.liquidity.pass ? 'PASS' : 'BLOCK'} · spread {item.signal.spread.status}</small></div>)}</div>}</section>
    <section className="overview"><div><span className="eyebrow">SELECTED INSTRUMENT</span><h2>{symbol}{liveQuote?.companyName ? ` (${liveQuote.companyName})` : ''} <small>Pakistan Stock Exchange</small></h2>{loadingSymbol ? <p className="muted loading-copy">Loading verified PSX analysis...</p> : <><p className="muted">{liveQuote ? `Live PSX close ${liveQuote.close} · volume ${liveQuote.volume}` : `${selectedMode.interval} data matrix · ${selectedMode.horizon}`}</p>{analysis?.status === 'HISTORICAL_SOURCE_REQUIRED' && <p className="warning">Live quote verified. Historical provider required before analysis.</p>}<a className="audit-link" href={`/api/logs/${symbol}?mode=${mode}&limit=500`} target="_blank" rel="noreferrer">View refined analysis logs</a></>}</div><div className="regime"><span>Hurst regime</span><strong>{loadingSymbol ? 'Loading' : analysis?.hurst?.regime || 'Unavailable'}</strong><em>{loadingSymbol ? '--' : analysis?.hurst?.value?.toFixed(3) || '--'}</em></div></section>
    <section className="read panel"><div><span className="eyebrow">QUANTITATIVE MARKET READ</span><h3 className={signal?.signal === 'BUY' ? 'buy-text' : signal?.signal === 'SELL' ? 'sell-text' : ''}>{loadingSymbol ? 'LOADING' : signal?.signal || 'Awaiting verified analysis'}</h3><p className="muted">{loadingSymbol ? 'Collecting official PSX quote, history, and research...' : prediction ? `Expected move ${formatPercent(prediction.expectedReturn)} over ${prediction.horizonBars} daily bars · estimated by ${new Date(prediction.expectedDate).toLocaleDateString()}` : 'A verified historical series is required before estimating direction.'}</p>{prediction?.extremeForecast && <p className="warning">Extreme forecast blocked: outside conservative historical range.</p>}</div><div className="read-values"><div className="current-price"><span>Current PSX price</span><strong>{loadingSymbol ? '--' : liveQuote?.close?.toFixed(2) || '--'}</strong><small>Live quote</small></div><div><span>Expected</span><strong>{loadingSymbol ? '--' : prediction?.expectedPrice?.toFixed(2) || '--'}</strong></div><div><span>Expected date</span><strong>{loadingSymbol ? '--' : prediction?.expectedDate ? new Date(prediction.expectedDate).toLocaleDateString() : '--'}</strong></div><div><span>Range</span><strong>{loadingSymbol ? '--' : prediction ? `${prediction.lowerBound.toFixed(2)} – ${prediction.upperBound.toFixed(2)}` : '--'}</strong></div><div><span>Paper gate</span><strong className={signal?.signal === 'BUY' ? 'buy-text' : signal?.signal === 'SELL' ? 'sell-text' : 'warning-text'}>{loadingSymbol ? 'WAITING' : signal ? (signal.executionAuthorized ? 'AUTHORIZED' : 'PAPER ONLY') : 'BLOCKED'}</strong></div></div></section>
    <section className="backtest panel"><div className="panel-head"><div><span className="eyebrow">HISTORICAL VALIDATION</span><h3>Test {symbol} on past PSX dates</h3></div><button className="active" onClick={runBacktest} disabled={backtestLoading}>{backtestLoading ? 'Testing...' : 'Run backtest'}</button></div><p className="muted">This uses real official PSX daily bars for <strong>{symbol}</strong> in {selectedMode.label} mode. At each cutoff, only earlier bars train the model; the later target date is then compared with the real PSX close.</p>{backtest?.error && <p className="warning">{backtest.error}</p>}{bt && btComplete ? <><div className="backtest-meta"><span>Symbol <strong>{symbol}</strong></span><span>Mode <strong>{backtest.mode}</strong></span><span>Training minimum <strong>{bt.minimumTrainingBars} bars</strong></span><span>Forecast horizon <strong>{bt.horizonBars} daily bars</strong></span><span>Test period <strong>{formatDate(backtestRows[0]?.cutoffTimestamp)} – {formatDate(backtestRows.at(-1)?.targetTimestamp)}</strong></span></div><div className="backtest-verdict"><span className="eyebrow">PROFITABILITY VERDICT</span><h3 className={verdictClass(bt.verdict)}>{bt.verdict.replace(/_/g, ' ')}</h3><p className="muted">{bt.verdictReasons?.join(' · ') || 'No concerns detected within tested period.'}</p></div><div className="backtest-results"><div><span>Starting → ending capital</span><strong>{formatMoney(bt.portfolio.startingCapital)} → {formatMoney(bt.portfolio.endingCapital)}</strong></div><div><span>Total return (annualized)</span><strong>{formatPercent(bt.portfolio.totalReturn)} ({formatPercent(bt.performance.annualizedReturn)})</strong></div><div><span>Net P&L</span><strong className={(bt.portfolio.totalPnL ?? 0) >= 0 ? 'buy-text' : 'sell-text'}>{formatMoney(bt.portfolio.totalPnL)}</strong></div><div><span>Executed trades</span><strong>{bt.portfolio.totalTrades}</strong></div></div><div className="backtest-results"><div><span>Sharpe ratio</span><strong>{(bt.performance.sharpeRatio ?? 0).toFixed(2)}</strong></div><div><span>Sortino ratio</span><strong>{(bt.performance.sortinoRatio ?? 0).toFixed(2)}</strong></div><div><span>Max drawdown</span><strong>{formatPercent(bt.performance.maxDrawdown)}</strong></div><div><span>Profit factor</span><strong>{Number.isFinite(bt.winLoss.profitFactor) ? bt.winLoss.profitFactor.toFixed(2) : bt.winLoss.profitFactor === Infinity ? '∞' : '--'}</strong></div></div><div className="backtest-results"><div><span>Win rate</span><strong>{formatPercent(bt.winLoss.winRate)} ({bt.winLoss.wins}W / {bt.winLoss.losses}L)</strong></div><div><span>Avg win / avg loss</span><strong>{formatMoney(bt.winLoss.averageWin)} / {formatMoney(bt.winLoss.averageLoss)}</strong></div><div><span>Per-trade expectancy</span><strong>{formatMoney(bt.winLoss.expectancy)}</strong></div><div><span>Transaction costs</span><strong>{formatMoney(bt.portfolio.totalTransactionCosts)}</strong></div></div><div className="backtest-table-wrap"><table className="backtest-table"><thead><tr><th>#</th><th>Training cutoff</th><th>Target date</th><th>Signal</th><th>Forecast move</th><th>Actual move</th><th>Trade P&L</th><th>Equity</th></tr></thead><tbody>{bt.tradeLog.map((row, index) => <tr key={`${row.cutoffTimestamp}-${row.targetTimestamp}`}><td>{index + 1}</td><td>{formatDate(row.cutoffTimestamp)}</td><td>{formatDate(row.targetTimestamp)}</td><td>{row.signal}</td><td>{formatPercent(row.forecastReturn)}</td><td>{formatPercent(row.actualReturn)}</td><td>{row.signal === 'NO_TRADE' ? '—' : formatMoney(row.netPnL)}</td><td>{formatMoney(row.equityAfter)}</td></tr>)}</tbody></table></div></> : bt ? <p className="warning">Backtest returned an older format. Restart the backend server (node backend/server.js) to enable profitability analysis.</p> : null}</section>
    <section className="grid"><article className="panel chart-panel"><div className="panel-head"><div><span className="eyebrow">DISTRIBUTION TRACK</span><h3>Observed vs. Kalman state</h3></div><span className="legend"><b /> Observed <b className="orange" /> Hidden state</span></div>{loadingSymbol ? <div className="empty-state">Loading verified PSX history...</div> : analysisReady ? <Sparkline prices={prices} filtered={analysis.kalman.track} /> : <div className="empty-state">Awaiting verified historical bars</div>}<div className="chart-foot"><span>Official PSX daily history</span><span>PSX ledger source verified</span></div></article><article className="panel"><div className="panel-head"><div><span className="eyebrow">PIPELINE STATUS</span><h3>Agent lattice</h3></div></div><div className="agents">{['01 Micro-structure', '02 Statistical transform', '03 Catalyst flow', '04 Institutional risk'].map((item, index) => { const states = loadingSymbol ? ['Collecting quote and bars', 'Waiting for analysis', 'Waiting for announcements', 'Waiting for risk profile'] : analysisReady ? ['Verified · daily bars', 'Verified · emitting', analysis?.catalyst ? `${analysis.catalyst.eventsFound} event(s) captured` : 'Loading announcements', analysis?.risk ? 'VaR/CVaR + Kelly calculated' : 'Loading risk profile'] : ['Live quote captured', 'Blocked · historical feed required', 'Blocked · historical feed required', 'Blocked · historical feed required']; return <div className="agent" key={item}><span>0{index + 1}</span><div><strong>{item}</strong><small>{states[index]}</small></div><i className={!loadingSymbol && analysisReady && (index < 2 || (index === 2 && analysis?.catalyst) || (index === 3 && analysis?.risk)) ? 'ok' : ''} /></div>; })}</div></article></section>
    <section className="research panel"><div className="panel-head"><div><span className="eyebrow">BROWSER RESEARCH</span><h3>PSX and TradingView evidence</h3></div><span className="muted">{researchReady ? 'Captured' : 'Waiting'}</span></div><div className="research-grid"><div><strong>PSX official</strong><small>{research?.sources?.psx?.title || research?.error || 'Browser unavailable'}</small>{research?.sources?.psx?.url && <a href={research.sources.psx.url} target="_blank" rel="noreferrer">Open source</a>}</div><div><strong>TradingView</strong><small>{research?.sources?.tradingView?.title || research?.error || 'Browser unavailable'}</small>{research?.sources?.tradingView?.url && <a href={research.sources.tradingView.url} target="_blank" rel="noreferrer">Open source</a>}</div></div></section>
    <section className="metrics"><div><span>Data points</span><strong>{analysis?.matrix?.dataVerification.dataPointCount || '--'}</strong><small>verified matrix</small></div><div><span>VaR / CVaR 99%</span><strong>{analysis?.risk ? `${(analysis.risk.var99 * 100).toFixed(2)}% / ${(analysis.risk.cvar99 * 100).toFixed(2)}%` : '--'}</strong><small>expected downside</small></div><div><span>Kelly allocation</span><strong>{analysis?.risk ? `${(analysis.risk.allocation * 100).toFixed(2)}%` : '--'}</strong><small>5% maximum</small></div><div><span>Liquidity / spread</span><strong>{analysis?.signal ? `${analysis.signal.liquidity.pass ? 'PASS' : 'BLOCK'} / ${analysis.signal.spread.status}` : '--'}</strong><small>execution gate</small></div></section>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);

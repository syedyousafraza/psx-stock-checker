import http from 'http';

const tests = [
  { path: '/api/analysis/SYS?mode=weekly', label: 'Analysis SYS' },
  { path: '/api/analysis/MEBL?mode=weekly', label: 'Analysis MEBL' },
  { path: '/api/analysis/AGIL?mode=weekly', label: 'Analysis AGIL' },
  { path: '/api/analysis/THALL?mode=weekly', label: 'Analysis THALL' },
  { path: '/api/analysis/ICI?mode=weekly', label: 'Analysis ICI' },
  { path: '/api/analysis/SYS?mode=weekly&limit=200', label: 'Analysis SYS limit=200' },
  { path: '/api/research/SYS', label: 'Research SYS' },
  { path: '/api/backtest/SYS?mode=weekly', label: 'Backtest SYS' },
  { path: '/api/symbols', label: 'Symbols list' },
  { path: '/api/analysis/SYS?mode=weekly&limit=100', label: 'Analysis SYS limit=100' },
];

async function runTest(test) {
  return new Promise((resolve) => {
    http.get(`http://localhost:5173${test.path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          let info = '';
          if (json.error) info = `ERROR: ${json.error}`;
          else if (json.symbol) info = `symbol=${json.symbol}, signal=${json.signal?.signal}, bars=${json.matrix?.bars?.length}`;
          else if (json.sources) info = `PSX=${json.sources.psx?.title?.substring(0,20)}, TV=${json.sources.tradingView?.title?.substring(0,20)}`;
          else if (json.walkForward) info = `verdict=${json.walkForward.verdict}`;
          else if (json.symbols) info = `${json.symbols.length} symbols`;
          else if (json.model) info = `model=${json.model}, status=${json.modelStatus}`;
          else if (json.featureNames) info = `features=${json.featureNames.length}`;
          console.log(`${test.label}: ${info} [HTTP ${res.statusCode}]`);
        } catch(e) {
          console.log(`${test.label}: parse error - ${data.substring(0,80)}`);
        }
        resolve();
      });
    }).on('error', (e) => {
      console.log(`${test.label}: ${e.message}`);
      resolve();
    });
  });
}

async function main() {
  console.log('=== PSX QUANT SWARM - COMPREHENSIVE END-TO-END TEST ===\n');
  for (const test of tests) {
    await runTest(test);
  }
  console.log('\n=== ALL TESTS COMPLETE ===');
}

main().catch(console.error);
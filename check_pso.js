import http from 'http';

const req = http.request({ hostname: 'localhost', port: 5173, path: '/api/analysis/PSO?mode=weekly', method: 'GET' }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const d = JSON.parse(data);
    const latestBar = d.matrix.bars[d.matrix.bars.length - 1];
    const latestDate = new Date(latestBar.timestamp);
    const today = new Date();
    const diffDays = Math.floor((today.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24));
    console.log('=== PSO Analysis ===');
    console.log('Symbol:', d.symbol);
    console.log('Live close:', d.quote?.close);
    console.log('Volume:', d.quote?.volume);
    console.log('Bars count:', d.matrix.bars.length);
    console.log('Latest bar timestamp:', latestBar.timestamp, '= ' + latestDate.toISOString());
    console.log('Days since latest bar:', diffDays);
    console.log('Data staleness:', d.prediction?.dataStalenessDays, 'days');
    console.log('');
    console.log('=== PREDICTION ===');
    console.log('Direction:', d.prediction?.direction);
    console.log('Expected price:', d.prediction?.expectedPrice);
    console.log('Expected return:', d.prediction?.expectedReturn);
    console.log('Confidence:', d.prediction?.confidence);
    console.log('Model:', d.prediction?.model);
    console.log('Hurst regime:', d.prediction?.hurstRegime);
    console.log('Extreme forecast:', d.prediction?.extremeForecast);
    console.log('Data stale days:', d.prediction?.dataStalenessDays);
    console.log('');
    console.log('=== SIGNAL ===');
    console.log('Signal:', d.signal?.signal);
    console.log('Paper only:', d.signal?.paperOnly);
    console.log('Execution authorized:', d.signal?.executionAuthorized);
    console.log('Edge score:', d.signal?.edgeScore);
    console.log('');
    console.log('=== VERDICT ===');
    if (diffDays > 2) {
      console.log('CRITICAL: Data is STALE (' + diffDays + ' days old)! Predictions are NOT reliable.');
    } else if (d.prediction?.dataStalenessDays > 3) {
      console.log('WARNING: Data is ' + d.prediction?.dataStalenessDays + ' days stale. Forecast anchored to live quote.');
    } else if (d.prediction?.confidence < 0.1) {
      console.log('Prediction confidence is very LOW (' + (d.prediction?.confidence * 100).toFixed(2) + '%). NO_TRADE signal is correct.');
    } else {
      console.log('Data is recent. Predictions appear valid.');
    }
    console.log('');
    console.log('=== RECOMMENDATION ===');
    if (d.prediction?.direction === 'UNCERTAIN' && d.signal?.signal === 'NO_TRADE') {
      console.log('System correctly shows NO_TRADE because confidence is too low.');
      console.log('This is EXPECTED for volatile/unpredictable stocks like PSO.');
      console.log('The ensemble model (GARCH + AR + EWMA + momentum) is uncertain.');
      console.log('');
      console.log('To get better predictions, the system needs:');
      console.log('1. More historical bars (currently ' + d.matrix.bars.length + ')');
      console.log('2. More recent data (DPS portal updates every 5 min)');
      console.log('3. Better signal-to-noise ratio');
    }
  });
});
req.on('error', (e) => console.error('Error:', e.message));
req.end();
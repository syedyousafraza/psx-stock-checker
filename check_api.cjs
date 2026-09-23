const http = require('http');
http.get('http://localhost:8787/api/symbols', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const r = JSON.parse(data);
    console.log('KSC30 count:', r.indexMembership.ksc30.length);
    console.log('KSC30:', r.indexMembership.ksc30.join(', '));
    console.log('KSC100 count:', r.indexMembership.ksc100.length);
    console.log('KSC100 sample:', r.indexMembership.ksc100.slice(0, 10).join(', '));
  });
});

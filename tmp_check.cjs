const fs = require('fs');
const content = fs.readFileSync('C:/casino/src/main.jsx', 'utf8');
const lines = content.split('\n');
const line135 = lines[134];
// Find the last 200 chars of line 135
const end = line135.substring(line135.length - 200);
console.log('END:', JSON.stringify(end));
// Also find where the compare section ends
const idx = line135.lastIndexOf('</section>');
console.log('Last </section> at index:', idx);
console.log('After that:', JSON.stringify(line135.substring(idx)));

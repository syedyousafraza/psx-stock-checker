const fs = require('fs');
const lines = fs.readFileSync('C:/casino/src/main.jsx', 'utf8').split('\n');
const line = lines[134];
if (line) {
  console.log('Last 80 chars:', line.substring(line.length - 80));
} else {
  console.log('Line 134 not found, file has', lines.length, 'lines');
}

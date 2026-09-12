import('./backend/psx-adapter.js').then(async mod => {
  const symbols = ['SYS','MEBL','AGIL','THALL','ICI'];
  for (const sym of symbols) {
    for (const lim of [30, 100, 200, 500]) {
      try {
        const b = await mod.getOfficialHistoricalBars(sym, {limit: lim});
        console.log(sym + ' limit='+lim+': ' + b.bars.length + ' bars, earliest=' + new Date(b.bars[0].timestamp).toLocaleDateString() + ', latest=' + new Date(b.bars[b.bars.length-1].timestamp).toLocaleDateString());
      } catch (e) {
        console.log(sym + ' limit='+lim+': ERROR - ' + e.message.substring(0,50));
      }
    }
    console.log('---');
  }
})
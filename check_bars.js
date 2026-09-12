import('./backend/psx-adapter.js').then(async mod => {
  const symbols = ['SYS','MEBL','AGIL','INDEX','THALL'];
  for (const sym of symbols) {
    try {
      const b = await mod.getOfficialHistoricalBars(sym, {limit: 30});
      console.log(sym + ': ' + b.bars.length + ' bars, from ' + new Date(b.bars[0].timestamp).toLocaleDateString() + ' to ' + new Date(b.bars[b.bars.length-1].timestamp).toLocaleDateString());
    } catch (e) {
      console.log(sym + ': ERROR - ' + e.message);
    }
  }
})
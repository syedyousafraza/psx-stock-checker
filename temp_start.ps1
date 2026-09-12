$p1 = node ./backend/server.js; $p2 = & vite --host 0.0.0.0; Write-Host "Backend PID: $($p1.Id)"; Write-Host "Frontend PID: $($p2.Id)"; Wait-Process $p1; Kill -Id $p2 -Force

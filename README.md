# PSX Quant Swarm

JavaScript PSX market-data and quantitative-analysis service with immutable, sequential contracts.

## Run

```bash
npm install
npm test
npm run dev
```

The React console runs on the Vite port shown by the terminal and proxies `/api` to `http://localhost:8787`.

For a production build, run `npm run build` and start the API with `npm start`. Health endpoints are available at `/health/live` and `/health/ready`.

## Deliverables

- `backend/data-engine.js`: two-stream reconciliation, PSX-ledger fallback, rolling bad-print filtration, and retroactive PUCARS split adjustments.
- `backend/math-agents.js`: recursive volume-aware Kalman tracker, rescaled-range Hurst estimator, and ADF-style return check.
- `backend/risk-engine.js`: 99% VaR/CVaR, reward horizon gate, and capped fractional Kelly allocation.
- `backend/server.js`: API orchestration and UDF-shaped history endpoint.
- `backend/psx-adapter.js`: live official PSX Market Summary adapter with caching, timeout, schema parsing, and source verification.
- `backend/research-agent.js`: Playwright browser research against public PSX and TradingView symbol pages.
- `backend/broker-adapter.js`: fail-closed adapter for a licensed broker JSON market-data API.
- `backend/prediction-engine.js`: explicitly non-actionable baseline forecast with uncertainty bounds.
- `src/main.jsx`: searchable symbol console, mode switch, Kalman chart, Hurst regime, and agent status.

## Data boundary

`GET /api/quote/:symbol` and `GET /api/symbols` use the official PSX Market Summary page. `GET /api/analysis/:symbol` now collects official daily historical OHLCV records from the PSX Historical Data portal by submitting its documented month/year/symbol form through Playwright. It never fabricates history for quantitative analysis. No trading decision should be authorized while a source signature, timestamp, point count, or divergence score is missing.

Configure the broker adapter with environment variables:

```text
BROKER_MARKET_DATA_URL=https://your-licensed-provider.example/api/bars
BROKER_API_KEY=keep-this-out-of-source-control
```

The JSGLOBAL web portal URL supplied for this project is a login web page, not documented market-data API documentation. Do not automate credentials or scrape it as a substitute for a licensed API. Obtain the broker's approved API endpoint, authentication method, symbol mapping, throttling rules, and redistribution permission, then adapt the JSON response to the `bars` shape expected by `backend/broker-adapter.js`.

The forecast is an uncalibrated baseline for research and is deliberately marked `actionable: false`. Production trading requires walk-forward validation, paper trading, market-hours handling, corporate-action/event feeds, persistence, observability, broker order controls, and independent risk/compliance review. This service is not investment advice or an execution venue.

The PSX collector provides daily historical bars. The UI therefore supports only Weekly swing and Macro position modes. Production intraday analysis, 1-minute/5-minute bars, and market depth require a licensed broker or exchange feed; PSX remains the official settlement and announcement source.

## Playwright research

The workspace MCP server is configured in `.vscode/mcp.json` for Copilot/browser inspection. The application itself uses `backend/research-agent.js` because an MCP server is an agent tool provider and cannot be called directly by the Express process. Install its browser once with:

```bash
npm run playwright:install
```

When a symbol is selected, the React client requests `/api/research/:symbol`; the agent opens the public PSX Market Summary and TradingView PSX chart page in separate Playwright pages, captures page titles, URLs, status codes, excerpts, and source verification. The TradingView chart is supporting browser evidence only; its rendered chart/network stream is not treated as a verified application OHLCV feed. It does not automate credentials or bypass access controls.

All agent returns are shallow-frozen JSON contracts. This is an analytics framework, not investment advice or an execution venue.



Commands to run
Command	Purpose
npm run dev	Full stack: backend API (:8787) + Vite frontend (:5173) — open http://localhost:5173 (http://localhost:5173)
node backend/server.js	Backend API only (if already running separately)
npm test	Run test suite (currently 17/17 pass)
npm run build	Build production frontend → dist/
npm run lint	Syntax-check all backend files
Right now you don't need to run anything — both servers are already listening. Just refresh http://localhost:5173.
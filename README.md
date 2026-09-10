# Chess Longitudinal Dashboard

A browser-first longitudinal chess analysis dashboard. It measures how a player's underlying quality of play changes over large game histories rather than relying only on rating or win/loss.

## Architecture

- Chess.com PubAPI: game history fetched by the visitor's browser.
- Stockfish 18 lite-single: WebAssembly Web Worker running on the visitor's CPU.
- IndexedDB: fast per-browser cache; each completed game is saved immediately.
- Shared analysis cache: Cloudflare Worker + separate GitHub data repository.
- React/Vite: dashboard frontend.
- CSV import: supported.

Only rated Rapid or rated Blitz games are selected.

## Shared cache

Normal Sync checks the shared central archive before starting Stockfish. Compatible previously analyzed games are hydrated into IndexedDB, so another visitor/device does not repeat them. Only genuinely missing games are analyzed.

`Full rescan` intentionally bypasses the shared cache.

Shared records include analyzer version, engine, node budget, timestamp, PGN, game metrics, and move metrics. The Worker merges by game ID. For the same analyzer version, the higher-node result is retained.

See `GITHUB_ARCHIVE_SETUP.md` for deployment/secrets setup.

## Local development

Node.js 20.19+ recommended.

```bash
npm install
npm run dev
```

The Stockfish package installation copies:

- `stockfish-18-lite-single.js`
- `stockfish-18-lite-single.wasm`

into `public/stockfish/`.

## Browser engine settings

- Fast: 5,000 nodes/position
- Standard: 12,000 nodes/position
- Deep: 30,000 nodes/position

The browser analyzer evaluates each played position once and reuses the next position's evaluation to calculate played-move loss. This is much cheaper than the original Python analyzer and therefore is not byte-for-byte identical to it.

## Cloudflare deployment

Build:

```bash
npm run build
```

Deploy:

```bash
npx wrangler deploy
```

`wrangler.jsonc` serves `dist/` as static assets and invokes `worker/index.js` only for `/api/*` requests.

## Current limitations

1. Stockfish analysis is single-threaded lite WASM.
2. Shared results are client-generated and are not cryptographically verified.
3. Very large profile snapshots may eventually need chunked storage instead of one profile gzip.
4. GitHub is suitable for the initial corpus but a real database such as D1 is the natural migration target at larger scale.
5. iOS Safari compatibility is still being diagnosed; the current app works on the same iPhone in Chrome.

## Licensing

Stockfish.js / Stockfish is GPL-3.0 software. Preserve required copyright/license notices and comply with GPL-3.0 source-availability requirements for the Stockfish component.

Chess.com PubAPI is public/read-only. This project is not affiliated with or endorsed by Chess.com.

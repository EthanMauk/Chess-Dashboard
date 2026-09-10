# Browser-only Chess Longitudinal Dashboard

This is the first static/public prototype of the dashboard. It has **no Python backend** and needs **no server-side Stockfish**.

## What runs where

- Chess.com public game history: fetched directly by the visitor's browser.
- Stockfish 18 lite-single: WebAssembly Web Worker running on the visitor's CPU.
- Analysis history: IndexedDB in that browser/device.
- React dashboard: static Vite application.
- CSV import: still supported.

Only rated Rapid or rated Blitz games are selected.

## Run locally

Requirements: Node.js 20.19+ recommended for current Vite.

```powershell
npm install
npm run dev
```

`npm install` installs the `stockfish` npm package and copies these files into `public/stockfish/`:

- `stockfish-18-lite-single.js`
- `stockfish-18-lite-single.wasm`

Then open the Vite URL.

## Browser engine settings

The header exposes three node budgets per position:

- Fast: 5,000 nodes
- Standard: 12,000 nodes
- Deep: 30,000 nodes

The browser analyzer evaluates each position in the played game once. The next position's evaluation is reused to calculate the played move's centipawn loss. This makes the browser version much cheaper than the current Python analyzer, which separately analyzes the position, played child, and best child.

Because of that optimization, browser results will be close in spirit but **not byte-for-byte identical** to the Python analyzer. This is intentionally a feasibility/performance prototype.

Completed games are committed to IndexedDB immediately. Canceling keeps completed analysis.

## Deploy as a static site

### Netlify

Import the repository/site and use the included `netlify.toml`. Build command is `npm run build`; publish directory is `dist`.

### Cloudflare Pages

- Build command: `npm run build`
- Build output directory: `dist`

No Functions/Workers are required.

### Any static host

Run:

```bash
npm install
npm run build
```

and publish the generated `dist/` directory.

## Current limitations of this prototype

1. Browser analysis is single-threaded Stockfish 18 lite. It is deliberately chosen for compatibility and small download size.
2. IndexedDB is per browser/device; there is no cloud account or cross-device sync.
3. Clearing browser/site data removes cached analysis.
4. A Full rescan currently clears the selected cached time class before rebuilding it. A production version should use staged replacement.
5. Very large histories can take substantial time because analysis uses the visitor's CPU.
6. The browser calculation reuses the root evaluation as the best achievable score instead of separately analyzing the engine's best child, so results can differ slightly from the Python analyzer at equal node budgets.
7. Conversion-error/opportunity modeling is currently the same lightweight logic used by the dashboard schema; this build is primarily intended to measure browser compute feasibility.

## Licensing

Stockfish.js / Stockfish is GPL-3.0 software. The `stockfish` dependency is installed from npm and its engine files are copied into the public build. If this project is publicly distributed, preserve the Stockfish copyright/license notices and comply with GPL-3.0 source-availability requirements for the Stockfish component.

Stockfish.js project: https://github.com/nmrugg/stockfish.js

Chess.com PubAPI is a public read-only API. This application is not affiliated with or endorsed by Chess.com.

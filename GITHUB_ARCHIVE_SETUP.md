# Shared GitHub Analysis Cache Setup

This build keeps Stockfish analysis in the visitor's browser, saves completed games in IndexedDB, and shares completed analysis through a Cloudflare Worker backed by a separate GitHub data repository.

## 1. Create the data repository

Create:

`EthanMauk/Chess-Dashboard-Data`

Private is recommended. Initialize it with a README so the `main` branch exists.

The Worker stores snapshots at:

`profiles/<username>/<rapid|blitz>.json.gz`

Do not use the app repository for these snapshots; that would cause data commits to trigger site deployments.

## 2. Create a GitHub fine-grained token

Restrict the token to `EthanMauk/Chess-Dashboard-Data` and grant only:

- Repository contents: Read and write

## 3. Add the Cloudflare secret

In the `chess-dashboard` Worker, add an encrypted secret named:

`GITHUB_TOKEN`

Never commit this token to GitHub or place it in `wrangler.jsonc`.

The non-secret repository settings are already in `wrangler.jsonc`:

- `GITHUB_OWNER=EthanMauk`
- `GITHUB_REPO=Chess-Dashboard-Data`
- `GITHUB_BRANCH=main`

## 4. Deploy

From the Chess-Dashboard repository:

```powershell
npm install
npm run build
npx wrangler deploy
```

With GitHub/Cloudflare automatic deployment configured, normally you only need:

```powershell
git pull
git add .
git commit -m "Add shared analysis database"
git push
```

## How Sync works

Normal Sync:

1. GET `/api/profile-analysis` for the username/time class.
2. Reuse centrally stored games produced by the current analyzer version.
3. Save those games into local IndexedDB.
4. Ask Chess.com which rated games exist.
5. Run Stockfish only for games not already known locally/centrally.
6. Save each completed new game locally immediately.
7. POST the current profile snapshot to the Worker after successful new analysis.
8. The Worker merges by Chess.com game ID and commits the canonical gzip snapshot to the data repository.

`Full rescan` intentionally ignores the shared cache and recomputes the selected profile/time class.

## Data integrity behavior

- Analyzer provenance is stored with every record.
- A normal Sync will not silently reuse records from a different analyzer version.
- For duplicate records from the same analyzer version, the Worker preserves the result analyzed with the larger node budget. At equal node budget, the newer result wins.
- Uploads are merged by game ID, so a partial browser snapshot cannot delete games already in the central archive.
- A failed GitHub upload does not delete local IndexedDB analysis.
- Malformed records and oversized submissions are rejected.

## Current trust model

The Worker validates structure but the calculations are client-generated. A malicious visitor could fabricate an otherwise valid payload. Treat the corpus as a community-generated analysis cache, not as cryptographically verified research data, until server-side verification/auditing is added.

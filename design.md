# Auction House Viewer: Design and Setup

## What this is
A static web page with Game, Region and Server dropdowns that shows current auction house listings, plus a GitHub Actions job that collects the data from the Battle.net Game Data API every hour.

The page never talks to Blizzard. Your Client Secret lives only in GitHub Actions secrets.

## Files

| Path | Purpose |
|---|---|
| `index.html` | The viewer. Single file, no build step. Put it on GitHub Pages. |
| `collector/collect.mjs` | Node 20+ script, no dependencies. Fetches, aggregates and saves data. |
| `.github/workflows/collect.yml` | Runs the collector hourly and publishes the result to a `data` branch. |
| `collector/test/` | Mock Blizzard API plus an automated test. Run with `npm test`. |
| `package.json` | Only holds the `collect` and `test` scripts. |

## Setup steps

1. Create a new GitHub repo (for example `wow-auction-house`) and upload everything in this folder to `main`.
2. In the repo go to Settings, Secrets and variables, Actions. Add two repository secrets:
   - `BLIZZARD_CLIENT_ID`
   - `BLIZZARD_CLIENT_SECRET`
3. Go to the Actions tab, open "Collect auction data", and press Run workflow. The first run creates the `data` branch. It can take 10 to 30 minutes because it covers every realm.
4. In Settings, Pages, set the source to the `main` branch, root folder.
5. Open `https://<your-user>.github.io/<repo>/`. The page finds the data branch by itself when it is hosted on github.io.

To test with a different data location, add `?data=<url>` to the page address. The URL must end at the folder that contains `games.json`.

To run the first collection on a smaller scope, use the workflow inputs, for example games `retail` and regions `us`.

## How the page finds data
On `*.github.io/<repo>/` it reads `https://raw.githubusercontent.com/<user>/<repo>/data/`. Anywhere else it reads a relative `data/` folder. The `?data=` parameter overrides both.

GitHub caches raw files for a few minutes, so the page can lag the collector slightly.

## Why a `data` branch
Hourly snapshots for every realm are large. The workflow rebuilds the `data` branch as a single commit and force-pushes it each run, so the repo never accumulates hourly history. Price history is kept inside the data files themselves, not in git history.

## Data layout

```
games.json                          list of games and their regions
{game}/items.json                   item id to name, filled gradually
{game}/{region}/realms.json         connected realms with their server names
{game}/{region}/{realmId}/latest.json.gz
{game}/{region}/{realmId}/history.json.gz
{game}/{region}/commodities/...     retail only, region-wide stackable goods
```

Game ids are `retail`, `classic` (progression) and `classic1x` (Era).

### latest.json.gz
```
{ u: ISO time, g, r, id, realms: [names], items: [ { i, q, n, m, l } ] }
```
- `i` item id
- `q` total quantity for sale
- `n` number of listings
- `m` lowest unit price in copper, or null if no listing has a buyout
- `l` up to five cheapest listings, each `[quantity, unit price, time left, faction]`
- time left codes: S short, M medium, L long, V very long
- faction is `alliance`, `horde`, `blackwater` or empty (retail has no faction houses)

Prices are in copper. 10000 copper is 1 gold.

### history.json.gz
```
{ h: { itemId: [ [unix seconds, lowest unit price, quantity], ... ] } }
```
- Every hourly point is kept for 3 days. Older points are reduced to one per day (the lowest) up to 30 days.
- Each run adds points for the 300 most listed items per realm (`HISTORY_TOP`) and for any item that already has history.
- This cap keeps the files small. Raise `HISTORY_TOP` if you want more items tracked and can accept larger files.

## Collector settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` | none | Required |
| `GAMES` | `retail,classic,classic1x` | Which games to collect |
| `REGIONS` | `us,eu` | Which regions to collect (`kr` and `tw` also work) |
| `OUT_DIR` | `data` | Where files are written |
| `MAX_REALMS` | 0 (all) | Limit realms per region, useful for testing |
| `CONCURRENCY` | 8 | Parallel requests |
| `ITEM_LOOKUPS` | 400 | New item names fetched per region per run |
| `HISTORY_TOP` | 300 | Items tracked in history per realm |

Item names fill in over several runs. Until an item name is known the page shows `Item #id`.

## API behavior the collector relies on
- Token: client credentials flow at `https://oauth.battle.net/token`.
- Realm list: `/data/wow/connected-realm/index`, then `/data/wow/connected-realm/{id}` for the server names.
- Retail auctions: `/data/wow/connected-realm/{id}/auctions`, plus `/data/wow/auctions/commodities` for region-wide goods.
- Classic auctions: the collector first tries `/auctions/index` and then `/auctions/{houseId}` for each faction house, and falls back to the plain `/auctions` endpoint if the index is missing.
- Item names: `/data/wow/item/{id}` in the `static` namespace.
- Retries on 429 and 5xx, honoring `Retry-After`. Gets a new token on a 401.
- China is not supported because it uses a different token address.

## Things I could not verify
These were built from documentation and forum reports, then tested against a mock server that follows the same shapes. They have not been run against the real Blizzard API from here.

- Classic and Classic Era auction endpoints and namespaces (`dynamic-classic-{region}`, `dynamic-classic1x-{region}`). Blizzard has broken classic namespaces after patches before. If a game shows no data, check the workflow log for lines starting with that game id.
- Whether Classic returns faction houses through `/auctions/index`. The fallback covers the case where it does not.
- **WoW Forever** is not included. Add it to the `GAMES` table in `collect.mjs` only after Blizzard publishes its namespace. It is one object with a label and namespace names.
- Real payload sizes. Retail commodities can be a very large response. The workflow has a 55 minute limit. If runs get close, reduce `REGIONS` or `GAMES`, or lower `CONCURRENCY`.

## What the page does
- Game, Region and Server dropdowns. The server list has a filter box and shows connected realm names together. Retail also lists "Commodities (region-wide)".
- Item name search, min and max price in gold, sortable columns, 100 rows per page.
- Click an item for its cheapest listings and a lowest price history chart (hover or touch for values). The chart needs at least two hourly snapshots.
- Remembers your last game, region and server in the browser.
- Works on phone width. Footer credits Ian McGonigal with website and Patreon links.

## Not in v1
- Same item price across other servers.
- Item icons.
- A Forever entry (see above).
- An addon import path for games without API endpoints.

## Testing
`npm test` starts a mock Blizzard API and runs the collector against it. It checks token handling, realm lists, retail, commodities, classic faction houses, item names (including a 404), history growth across runs, manifest merging and the missing credentials failure. The viewer was also checked in a headless browser against the mock data on desktop and phone widths.

## Costs and limits
- GitHub Actions is free for public repos. Private repos have monthly minute limits, and an hourly job of up to 55 minutes would exceed the free allowance, so keep the repo public or reduce the schedule.
- Blizzard allows 36,000 requests per hour per client. A full run of both regions uses roughly a few hundred auction requests plus item lookups, well under that.
- Use only your own artwork and names in the app. Do not add Blizzard logos or art.

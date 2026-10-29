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
{game}/cats.json                    item id to gather category (herb, ore, leather, cloth, other)
{game}/sources.json.gz              recipes and dungeon/raid drops, refreshed every few days
{game}/{region}/realms.json         connected realms with their server names
{game}/{region}/{realmId}/latest.json.gz
{game}/{region}/{realmId}/history.json.gz
{game}/{region}/{realmId}/sales.json.gz    estimated sales per item, last 7 days
{game}/{region}/{realmId}/state.bin.gz     previous listings, used to detect sales
{game}/icons.json                   item id to icon file name
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

### sources.json.gz
```
{ u, t, pending, recipes: { recipeId: { p, t, i, q, r } | null }, drops: { itemId: [[instance, boss], ...] } }
```
- `p` profession, `t` skill tier, `i` crafted item id, `q` quantity made, `r` reagents as `[itemId, quantity]`
- `null` recipes are ones with no crafted item (for example enchants). They are remembered so they are not fetched again.
- Only the newest `RECIPE_TIERS` skill tiers (default 3) of each profession are collected, so old expansion recipes are left out.
- At most `RECIPE_FETCH_CAP` new recipes are fetched per run (default 6000). If more remain, `pending` is above zero and the next run continues.
- Drops come from Blizzard's Journal API (Retail only), up to four bosses per item.
- The whole file is rebuilt at most every `SOURCES_REFRESH_HOURS` (default 72), unless recipes are still pending.

## Top 10 profits tab
The tab works out profit in the browser from the selected server's latest prices plus `sources.json.gz` and `cats.json`.

- **Crafted:** profit = lowest sell price x quantity made x (1 - 5% auction house cut) - reagent cost at today's lowest prices. Recipes with a reagent that has no auction listing (usually vendor-bought) are skipped. Only recipes with a profit above zero appear, best recipe per item.
- **Region-wide commodities (Retail):** herbs, ore, leather and cloth are sold on the commodities market, not on a single server. On Retail the tab merges the commodities prices into the selected server's prices, so gathered items show up on every server.
- **Gathered:** items categorized as herb, ore or leather and not crafted. Profit is the sell price minus the cut. The method shown is Herbalism, Mining or Skinning.
- **Dungeon and raid drops:** items the Journal API lists as boss loot, with the boss and instance names.
- **Other:** everything else, including cloth. The card says Blizzard's data does not tell where it comes from, and links to Wowhead.
- Every card links to the item's Wowhead page for every way to get it. Nothing is copied from Wowhead.
- **Min listings** (default 3) hides items with very few listings, which often have unrealistic prices.
- Profit is an estimate. Auction snapshots show what is listed, not what sells, and the lowest price may not hold if you buy many reagents.
- **Crafted is mostly unavailable.** Checked against the live API: Blizzard's recipe endpoint returns no crafted item and no reagent list for current-expansion recipes (only a name and optional-reagent slots). Only a handful of older recipes have reagents, so the tab shows a message instead of guessing costs. Getting costs would need another data source for recipe reagents.
- **Classic and Classic Era:** the profession and journal endpoints return 404, so Classic has Gathered and Other only, plus Wowhead links.

## Games and region
- **Classic (Progression)** is Mists of Pandaria Classic (game data build 5.5.x). It uses the modern auction house layout: each server has its own listings from `/data/wow/connected-realm/{id}/auctions`, and trade goods (herbs, ore, cloth, leather and so on) are on a region-wide commodities market at `/data/wow/auctions/commodities` in the `dynamic-classic-us` namespace. The separate Alliance, Horde and Blackwater house endpoints return 404 for it.
- The commodities link Blizzard gives for MoP Classic currently returns no listings (only a `_links` block), so herbs, ore, cloth and other trade goods are not available from the API right now. The collector keeps checking each run and adds a "Commodities (region-wide)" entry as soon as it has listings. Until then the Gathered tab has little or nothing for Classic.
- Blizzard's Classic server list includes many servers with no listings. Servers with zero listings are left out of the dropdown and come back automatically once they have listings.
- **Classic Anniversary** realms (Dreamscythe, Nightslayer, Maladath) are under the `dynamic-classicann-us` namespace. Their auction endpoints also return 404. The collector includes them as a third game so they appear by themselves if Blizzard starts serving them.
- Checked on 29 October 2026: Era and Anniversary auctions return 404 for the plain `/auctions` endpoint and for the Alliance (2) house endpoint, under every namespace tried. That includes version-specific namespaces such as `dynamic-1.15.9_68185-classic1x-us`, which return 403.
- **Classic Era** auction data is not available from Blizzard's API right now. The house list loads, but every request for the listings returns 404 (checked on 29 October 2026). The collector keeps trying each run. Games that return no auction data are left out of `games.json`, so Classic Era will appear in the dropdown by itself if Blizzard starts serving it.
- `diagnostics.json` at the top of the data branch records the item namespace each game uses and Blizzard's raw responses for the first few servers. Use it to check what the API returned without opening the workflow logs.
- The collector is set to **Classic (Progression)** and **Classic Era**, in the **US** region. Retail was removed at your request. Games or regions that are not in the current settings are deleted from the data on the next run.
- The page hides the region selector and always uses US.
- To bring Retail back, add `retail` to the `GAMES` line in `collect.yml`. Retail also brings back dungeon and raid drop data, which only Retail's Journal API provides.

## Item icons
- For each item the collector calls Blizzard's media endpoint (`/data/wow/media/item/{id}`) and keeps the icon file name in `icons.json`. Up to `ICON_LOOKUPS` items per run, most listed first.
- `icons.json` is `{ base, icons: { itemId: name } }`. The image address is `base + name + ".jpg"`, served from Blizzard's public render site. Values that do not share the base are stored as full addresses.
- The page shows icons in the listings table, the item popup, profit cards and the fastest selling table. Missing icons show an empty square.

## Item tooltips
- When the collector looks up an item it also turns Blizzard's `preview_item` block into tooltip lines and saves them in `{game}/tooltips.json.gz`.
- Format: `{ itemId: { q: quality, l: [[text, color, rightText?], ...], s: sell price in copper } }`. Colors come from Blizzard's data where given (stats, equip effects), otherwise item level and flavor text are gold and set pieces are grey.
- Lines, in game order: item level, binding, unique, slot and type, weapon damage, speed and DPS, armor, block, stats, bag slots, durability, class, race, level, skill and reputation requirements, Equip/Use/Chance on hit effects, set name with pieces and bonuses, recipe materials, crafting reagent note, flavor text.
- The item popup shows the tooltip in a WoW-style box above the stats, and colors the item name by quality.
- `meta.json` holds `tipsVersion`. Raising `TIPS_VERSION` in `collect.mjs` makes the next run rebuild every tooltip.

## Fastest selling tab
- Each run the collector saves every listing (auction id, item, quantity, time left) for each server in `state.bin.gz`, a compact binary file.
- On the next run it compares the new listings with the saved ones:
  - A listing that disappeared while it had **Long** or **Very long** time left (2 hours or more) counts as sold. Short and Medium listings that disappear are treated as expired and ignored.
  - A listing that is still there with a smaller quantity counts the difference as sold.
- Comparisons only count when the runs are 20 minutes to 3 hours apart (`SALES_MIN_GAP`, 3 hour maximum), so a quick extra run or a long outage does not skew the numbers.
- `sales.json.gz` is `{ last, obs: [[time, seconds covered]], h: { itemId: [[time, quantity, listings]] } }`, trimmed to `SALES_DAYS` (7).
- The page adds up sales in the chosen window (24 hours or 7 days), divides by the time actually observed, and scales to a day. It shows the top 20 by units sold or by gold traded (units times today's lowest price).
- It waits until at least one hour of tracking exists before showing anything.
- Cancelled auctions look the same as sales, so this is a ranking, not exact sales.
- The Top 10 profits cards also show "Sells about N a day" when sales data exists.

## Collector settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` | none | Required |
| `GAMES` | `classic,classic1x` | Which games to collect (`retail` also works). Games not listed are removed from the data. |
| `REGIONS` | `us` | Which regions to collect (`eu`, `kr` and `tw` also work). Regions not listed are removed from the data. |
| `OUT_DIR` | `data` | Where files are written |
| `MAX_REALMS` | 0 (all) | Limit realms per region, useful for testing |
| `CONCURRENCY` | 8 | Parallel requests |
| `ITEM_LOOKUPS` | 8000 | New item names fetched per region per run |
| `HISTORY_TOP` | 300 | Items tracked in history per realm |
| `RECIPE_TIERS` | 3 | Newest skill tiers collected per profession |
| `RECIPE_FETCH_CAP` | 6000 | New recipes fetched per run |
| `SOURCES_REFRESH_HOURS` | 72 | How often recipes and drops are refreshed |
| `ICON_LOOKUPS` | 8000 | Item icons fetched per run |
| `SALES_DAYS` | 7 | Days of sales history kept |
| `SALES_MIN_GAP` | 1200 | Minimum seconds between runs for a sales comparison |

Item names and categories fill in over the first couple of runs (up to `ITEM_LOOKUPS` items per run, most listed first). Until an item name is known the page shows `Item #id`.

## API behavior the collector relies on
- Token: client credentials flow at `https://oauth.battle.net/token`.
- Realm list: `/data/wow/connected-realm/index`, then `/data/wow/connected-realm/{id}` for the server names.
- Retail auctions: `/data/wow/connected-realm/{id}/auctions`, plus `/data/wow/auctions/commodities` for region-wide goods.
- Classic auctions: the collector first tries `/auctions/index` and then `/auctions/{houseId}` for each faction house, and falls back to the plain `/auctions` endpoint if the index is missing.
- Item names and category: `/data/wow/item/{id}` in the `static` namespace. Trade Goods subclasses Herb, Metal & Stone and Leather become gather categories.
- Recipes: `/data/wow/profession/index`, then each profession, its skill tiers, and `/data/wow/recipe/{id}` for reagents and the crafted item.
- Drops: `/data/wow/journal-expansion/index`, then instances, then `/data/wow/journal-encounter/{id}` for each boss's item list.
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

## Not yet done
- Same item price across other servers.
- Specific farming spots and quest rewards. These are only available as Wowhead links.
- A Forever entry (see above).
- An addon import path for games without API endpoints.

## Testing
`npm test` starts a mock Blizzard API and runs the collector against it. It checks token handling, realm lists, retail, commodities, classic faction houses, item names (including a 404), history growth across runs, manifest merging and the missing credentials failure. The viewer was also checked in a headless browser against the mock data on desktop and phone widths.

## Costs and limits
- GitHub Actions is free for public repos. Private repos have monthly minute limits, and an hourly job of up to 55 minutes would exceed the free allowance, so keep the repo public or reduce the schedule.
- Blizzard allows 36,000 requests per hour per client. A full run of both regions uses roughly a few hundred auction requests plus item lookups, well under that.
- Use only your own artwork and names in the app. Do not add Blizzard logos or art.

## MoP Classic item sources and Professions tab
- `static/mop-classic-sources.json` is built from Napalmsteak's WoW Classic Item Caches (`MoP Classic Cache.json`), used with the author's permission and credited in the page footer.
- Build it with `node tools/build-classic-sources.mjs "<path>/MoP Classic Cache.json" static/mop-classic-sources.json` after cloning that repo. Re-run it when the dataset updates and commit the result. It is served from the site itself, not the data branch.
- Format: `{ src: [[type, label]], items: { id: [sourceIndex] }, boss: { id: [names] }, craft: { id: profession }, recipes: { craftedId: { p, skill, r: [[itemId, qty]], by: recipeItemId } }, names: { id: name } }`. Cooking specialties ("Way of the Wok" and so on) are grouped as Cooking.
- Coverage: 15,761 items with sources, 3,485 crafted items mapped to a profession, 259 recipes with material lists (taken from recipe item tooltips). Trade goods are mostly not in the dataset.
- **Item popup:** a "How to get it" section lists the sources (raid, dungeon, vendor, quest, PvP, reputation, world drop, crafted), the bosses that drop it, gather notes, and the recipe materials with today's prices where listed.
- **Top 10 profits:** dungeon and raid drops now come from this data for Classic. Crafted items with a full priced material list rank by profit; the rest rank by sell price after the cut and say the material cost is unknown.
- **Professions tab:** groups the selected server's listings by the profession that makes them. Ranked by estimated gold sold per day once sales tracking has at least an hour of data, otherwise by value listed now (lowest price x quantity, counting only items with two or more listings). Each profession expands to its top 10 items. Gathering professions (Herbalism, Mining, Skinning) use the item categories and show a message while MoP Classic's commodities market is empty.
- Item names in tables, cards and the sales list open the item popup.

## Vendors and locations (QuestieDB)
- `static/mop-classic-locations.json` is built from QuestieDB's MoP data (`data/MoP/mopItemDB.lua`, `mopNpcDB.lua`, `mopObjectDB.lua`) and its zone list (`src/corrections/enum/zones.lua`). QuestieDB content may be reused under GPLv3 according to its license notes, so this derived file is marked GPL-3.0 and credited in the footer.
- Build: `node tools/build-questie-locations.mjs <QuestieDB checkout> static/mop-classic-locations.json`. The script reads the Lua tables directly.
- Format: `{ zones: { areaId: name }, npcs: { id: [name, title, faction "A"/"H"/"AH", minLevel, maxLevel, { areaId: [[x, y]] }] }, objects: { id: [name, { areaId: [[x, y]] }] }, items: { id: { v: [vendor npc ids], d: [dropping npc ids], o: [object ids] } } }`.
- Limits per item: up to 8 vendors, 25 droppers and 10 objects. Per NPC or object: up to 3 zones and 30 points per zone. Coordinates are zone map percentages.
- Zone names come from the enum constant names (for example `ELWYNN_FOREST` becomes "Elwynn Forest"). Six zones have no name and show as "Zone 1234".
- The item popup has a "Where to find it" section: vendors with their title and faction, droppers with level range, and objects such as herb nodes or chests. Selecting one draws its spawn points on a plain zone grid (no game map art) with the coordinates listed below, plus a link to the full map on Wowhead.

### Drop chances
- Drop percentages come from QuestieDB's `support/DropTables/mopItemDrops.lua` (`wowheadData`), which the Questie team built from Wowhead's player-collected loot statistics. It is part of QuestieDB and covered by the same GPLv3 terms.
- It only covers items tied to quest objectives: 2,301 items, about 20,000 mob rates.
- Every other item gets rates from private-server world databases, worked out by `tools/build-drop-rates.mjs` from each database's `creature_template` (LootId), `creature_loot_template` and `reference_loot_template`. Ungrouped rows use their own chance; grouped rows split the group's remaining chance equally among zero-chance rows; reference rows multiply the reference chance by the referenced table's chances (rolled `maxcount` times). Chances from several rows combine as 1 - product of (1 - p). Rates under 0.005% are dropped and the top 25 mobs per item are kept.
- Sources, earliest wins per item: MaNGOS Three (Cataclysm 4.3.4, `mangosthree/database`, CC BY-NC-SA 3.0, tagged `cata`), then CMaNGOS Wrath, TBC and Classic (`cmangos/wotlk-db`, `tbc-db`, `classic-db`, GPLv3). 13,962 items got rates this way, for 16,263 in total.
- These are private-server approximations from older expansions, so the popup names the source and notes that rates may differ in MoP Classic. MaNGOS Three's license is non-commercial: drop its `cata=` argument from the build if that does not fit the site.
- Build: `node tools/build-drop-rates.mjs rates.json cata=<mangosthree>/World/Setup/FullDB wotlk=<WoTLKDB.sql.gz> tbc=<TBCDB.sql.gz> classic=<ClassicDB.sql.gz>`, then `node tools/build-questie-locations.mjs <QuestieDB> static/mop-classic-locations.json rates.json`.
- For rated items the droppers are sorted by drop chance and the popup shows "N% drop chance" next to each mob. Mobs from the drop table that are not in the item's NPC list are added. The rates are stored in `dc`, in the same order as `d`, with `null` where a mob has no rate.

### Dropped by and Crafted by
- The locations file keeps up to 8 vendors, 25 dropping creatures and 10 objects per item. When more creatures drop an item, `dn` holds the full count and the popup says "top 25 of N".
- The popup groups sources under Sold by, Dropped by (with level range) and Found in, each with its spawn point count. The first 8 of each group show, with a "Show all" button. Selecting one draws it on the zone grid.
- **Crafted by** shows the profession and required skill, a materials table (quantity, today's lowest price each, line total, materials total) and, when every material is listed, the profit after the 5% cut at the item's current price. It names the recipe item it is learned from with that item's sources and vendor count. Opening a recipe item shows what it teaches with the same table.
- Materials, recipe items and other linked items open their own popup even when they are not listed on the server, so you can follow a material to its vendors or drops.
- Material lists come from the wago.tools recipe build (4,662 items) and the Napalmsteak recipe items (259).
- MoP Classic crafting materials are mostly trade goods on the region-wide market, which Blizzard's API returns empty, so most show as "not listed" and the total is unknown.

### Recipes and vendor prices (wago.tools)
- `.github/workflows/build-recipes.yml` runs `tools/build-recipes.mjs` on GitHub Actions (on changes, weekly on Monday, or by hand). It downloads Blizzard's MoP Classic data tables as CSV from wago.tools for the newest `wow_classic` 5.x build and commits `static/mop-classic-recipes.json` plus `static/recipes-build-log.json`.
- Tables: `SkillLine` (profession names and parent lines), `SkillLineAbility` (spell to profession and required skill), `SpellEffect` (effect 24 = create item, giving the item made and how many), `SpellReagents` (up to 8 materials with counts), `SpellName`, and `ItemSparse` (names, `BuyPrice`, `VendorStackCount`).
- Result: 4,662 crafted items with full material lists across all professions. The page merges them into the Napalmsteak recipe data; the Napalmsteak recipe item ("Learned from ...") is kept when both have the item.
- Vendor prices: `buy` holds `BuyPrice` (or `[price, stack]`) for every item QuestieDB lists as vendor-sold (`static/vendor-items.json`, rebuilt with the locations file) plus every recipe material.
- `BuyPrice` exists even for items no vendor sells for gold, so the page only uses it when the item has at least one vendor whose title is not a currency vendor (Justice, Honor, Valor and Conquest quartermasters, Darkmoon Faire, Legacy vendors, arena and similar).
- Crafting costs use the lower of the auction house price and the gold vendor price for each material and mark vendor prices. The Top 10 profits crafted list uses the same rule.
- The "Sold by" group in the popup shows the vendor price, per stack when vendors sell stacks.

## Listing filters
- **Category** uses Blizzard's item class: Weapon (2), Armor (4), Container (1, 11), Consumable (0), Trade Goods (7 plus gems 3, reagents 5 and item enhancements 8), Recipe (9), and Quest / Miscellaneous for everything else (quest items, pets, mounts, keys, glyphs).
- **Wearable by** keeps only equippable gear the chosen class can use in MoP: cloth and miscellaneous slots for everyone, leather, mail, plate and shields by class, weapon types by class (ranged weapons are Hunter only, wands are Mage, Priest and Warlock), and any "Classes:" restriction on the item.
- Both use `{game}/iteminfo.json` (`id: [itemClass, itemSubclass, inventoryType, allowedClassIds or 0, itemLevel, requiredLevel, dps, armor]`), saved by the collector during item lookups. Raising `INFO_VERSION` makes the next runs look every item up again. Items not yet looked up are hidden while a filter is on.
- **Item level** min and max narrow the listings to an item level range.
- **Sort by**: quantity, listings, lowest price, name, item level, required level, DPS (weapons) or armor value. The table has iLvl, Req and DPS / Armor columns; clicking the Item, iLvl, Req, Quantity, Listings or Lowest price headers also sorts and flips direction. Items without the chosen stat go to the end.
- The server picker is a plain dropdown.
- Item names are colored by rarity (from the tooltip data) in every table and card.

## Outside data sources considered
- **nexus-devs/wow-classic-items** (MIT license): 38,000 original-Classic items with sources (boss, quest, vendor, zone drop with drop chance), crafting reagents for about 3,200 items and vendor prices. Last updated 2022 and built by scraping Wowhead. It fits Classic Era best, but Era has no auction data, so it is not used yet.
- **Napalmsteak/WoW-Classic-Item-Caches**: current data for every Classic version including MoP Classic and Forever. Used for MoP Classic with the author's permission (see above).
- **Questie / QuestieDB**: used for vendors, drops and spawn locations (see above).
- **cmangos/classic-db** and **dkpminus/Classic-Wow-Database**: SQL world databases for patch 1.12 (original Classic). They have vendors, loot tables and spawn coordinates, but only for 1.12 content, and QuestieDB already covers MoP Classic with the same kind of data. Useful only if Classic Era auction data becomes available.
- **WowUp**: an addon manager, with no item data.
- Wowhead links on every item cover what the other sources do not.

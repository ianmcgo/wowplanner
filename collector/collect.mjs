import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';

const env = process.env;
const CLIENT_ID = env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = env.BLIZZARD_CLIENT_SECRET;
const API_BASE = env.API_BASE || null;
const OAUTH_URL = env.OAUTH_URL || 'https://oauth.battle.net/token';
const OUT_DIR = env.OUT_DIR || 'data';
const REGIONS = (env.REGIONS || 'us').split(',').map(s => s.trim()).filter(Boolean);
const GAME_IDS = (env.GAMES || 'retail,classic,classic1x').split(',').map(s => s.trim()).filter(Boolean);
const MAX_REALMS = Number(env.MAX_REALMS || 0);
const CONCURRENCY = Number(env.CONCURRENCY || 8);
const ITEM_LOOKUPS = Number(env.ITEM_LOOKUPS || 400);
const HISTORY_TOP = Number(env.HISTORY_TOP || 300);
const DAY = 86400;
const KNOWN_REGIONS = ['us', 'eu', 'kr', 'tw'];
const TIME = { SHORT: 'S', MEDIUM: 'M', LONG: 'L', VERY_LONG: 'V' };

const GAMES = {
  retail: { label: 'Retail', dynamic: 'dynamic-{r}', static: 'static-{r}', commodities: true, houses: false },
  classic: { label: 'Classic (Progression)', dynamic: 'dynamic-classic-{r}', static: 'static-classic-{r}', commodities: false, houses: true },
  classic1x: { label: 'Classic Era', dynamic: 'dynamic-classic1x-{r}', static: 'static-classic1x-{r}', commodities: false, houses: true }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const apiBase = region => API_BASE || `https://${region}.api.blizzard.com`;
const localName = n => (typeof n === 'string' ? n : (n && (n.en_US || Object.values(n)[0])) || '');

let token = null;

async function getToken() {
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const body = await res.json();
  return body.access_token;
}

async function getJson(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * (attempt + 1));
      return getJson(url, attempt + 1);
    }
    throw err;
  }
  if (res.status === 404) {
    await res.text().catch(() => {});
    return null;
  }
  if (res.status === 401 && attempt < 1) {
    await res.text().catch(() => {});
    token = await getToken();
    return getJson(url, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await res.text().catch(() => {});
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) {
    await res.text().catch(() => {});
    throw new Error(`${res.status} ${url}`);
  }
  return res.json();
}

async function pool(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writeGz(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, gzipSync(JSON.stringify(obj), { level: 9 }));
}

async function readGz(file) {
  try {
    return JSON.parse(gunzipSync(await readFile(file)).toString());
  } catch {
    return null;
  }
}

async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function aggregate(auctions) {
  const map = new Map();
  for (const a of auctions) {
    const id = a.item && a.item.id;
    if (!id) continue;
    const q = a.quantity || 1;
    let unit = null;
    if (a.unit_price > 0) unit = a.unit_price;
    else if (a.buyout > 0) unit = Math.max(1, Math.round(a.buyout / q));
    let e = map.get(id);
    if (!e) {
      e = { i: id, q: 0, n: 0, m: null, l: [] };
      map.set(id, e);
    }
    e.q += q;
    e.n += 1;
    if (unit !== null) {
      if (e.m === null || unit < e.m) e.m = unit;
      e.l.push([q, unit, TIME[a.time_left] || '', a.house || '']);
      if (e.l.length > 12) {
        e.l.sort((x, y) => x[1] - y[1]);
        e.l.length = 5;
      }
    }
  }
  const items = [...map.values()];
  for (const e of items) {
    e.l.sort((x, y) => x[1] - y[1]);
    if (e.l.length > 5) e.l.length = 5;
  }
  return items;
}

function compactPoints(points, now) {
  const recent = [];
  const byDay = new Map();
  for (const p of points) {
    const age = now - p[0];
    if (age > 30 * DAY) continue;
    if (age <= 3 * DAY) {
      recent.push(p);
    } else {
      const d = Math.floor(p[0] / DAY);
      const cur = byDay.get(d);
      if (!cur || p[1] < cur[1]) byDay.set(d, p);
    }
  }
  return [...byDay.values(), ...recent].sort((a, b) => a[0] - b[0]);
}

function updateHistory(prev, items, now) {
  const hist = prev && prev.h ? prev.h : {};
  const present = new Map(items.filter(e => e.m !== null).map(e => [e.i, e]));
  const top = [...present.values()].sort((a, b) => b.n - a.n).slice(0, HISTORY_TOP).map(e => String(e.i));
  const keys = new Set([...Object.keys(hist), ...top]);
  const out = {};
  for (const k of keys) {
    const e = present.get(Number(k));
    let pts = hist[k] || [];
    if (e) pts = pts.concat([[now, e.m, e.q]]);
    pts = compactPoints(pts, now);
    if (pts.length) out[k] = pts;
  }
  return { h: out };
}

async function fetchRealmAuctions(game, base, ns, id) {
  if (game.houses) {
    const index = await getJson(`${base}/data/wow/connected-realm/${id}/auctions/index?namespace=${ns}&locale=en_US`);
    if (index && Array.isArray(index.auctions) && index.auctions.length) {
      const out = [];
      for (const house of index.auctions) {
        const data = await getJson(`${base}/data/wow/connected-realm/${id}/auctions/${house.id}?namespace=${ns}&locale=en_US`);
        if (data && Array.isArray(data.auctions)) {
          const tag = String(house.name || '').split(' ')[0].toLowerCase();
          for (const a of data.auctions) {
            a.house = tag;
            out.push(a);
          }
        }
      }
      return out;
    }
  }
  const data = await getJson(`${base}/data/wow/connected-realm/${id}/auctions?namespace=${ns}&locale=en_US`);
  return data ? data.auctions || [] : null;
}

async function fetchCommodities(base, ns) {
  const data = await getJson(`${base}/data/wow/auctions/commodities?namespace=${ns}&locale=en_US`);
  return data ? data.auctions || [] : null;
}

async function storeSnapshot(game, region, entry, auctions, seen, now) {
  const items = aggregate(auctions);
  for (const e of items) seen.set(e.i, (seen.get(e.i) || 0) + e.n);
  const dir = path.join(OUT_DIR, game.id, region, String(entry.id));
  await writeGz(path.join(dir, 'latest.json.gz'), {
    u: new Date(now * 1000).toISOString(),
    g: game.id,
    r: region,
    id: entry.id,
    realms: entry.names,
    items
  });
  const prev = await readGz(path.join(dir, 'history.json.gz'));
  await writeGz(path.join(dir, 'history.json.gz'), updateHistory(prev, items, now));
}

async function resolveItemNames(game, region, base, seen) {
  const file = path.join(OUT_DIR, game.id, 'items.json');
  const names = (await readJson(file)) || {};
  const ns = game.static.replace('{r}', region);
  const missing = [...seen.entries()]
    .filter(([id]) => !(id in names))
    .sort((a, b) => b[1] - a[1])
    .slice(0, ITEM_LOOKUPS)
    .map(([id]) => id);
  await pool(missing, CONCURRENCY, async id => {
    try {
      const item = await getJson(`${base}/data/wow/item/${id}?namespace=${ns}&locale=en_US`);
      names[id] = item && item.name ? localName(item.name) : null;
    } catch (err) {
      log('item lookup failed', id, err.message);
    }
  });
  await writeJson(file, names);
  log(game.id, region, 'item names looked up:', missing.length);
}

async function collectRegion(game, region, now) {
  const base = apiBase(region);
  const ns = game.dynamic.replace('{r}', region);
  const index = await getJson(`${base}/data/wow/connected-realm/index?namespace=${ns}&locale=en_US`);
  if (!index || !Array.isArray(index.connected_realms)) {
    log(game.id, region, 'no connected realm index, skipping');
    return false;
  }
  let ids = index.connected_realms
    .map(r => Number((/connected-realm\/(\d+)/.exec(r.href) || [])[1]))
    .filter(Boolean);
  if (MAX_REALMS > 0) ids = ids.slice(0, MAX_REALMS);
  log(game.id, region, 'connected realms:', ids.length);

  const seen = new Map();
  const entries = await pool(ids, CONCURRENCY, async id => {
    try {
      const cr = await getJson(`${base}/data/wow/connected-realm/${id}?namespace=${ns}&locale=en_US`);
      const names = cr && Array.isArray(cr.realms) ? cr.realms.map(r => localName(r.name)) : [`Realm ${id}`];
      const entry = { id, names };
      const auctions = await fetchRealmAuctions(game, base, ns, id);
      if (!auctions) return null;
      await storeSnapshot(game, region, entry, auctions, seen, now);
      return entry;
    } catch (err) {
      log(game.id, region, 'realm failed', id, err.message);
      return null;
    }
  });

  const realms = entries.filter(Boolean).sort((a, b) => a.names[0].localeCompare(b.names[0]));

  if (game.commodities) {
    try {
      const auctions = await fetchCommodities(base, ns);
      if (auctions) {
        const entry = { id: 'commodities', names: ['Commodities (region-wide)'] };
        await storeSnapshot(game, region, entry, auctions, seen, now);
        realms.unshift(entry);
      }
    } catch (err) {
      log(game.id, region, 'commodities failed', err.message);
    }
  }

  if (!realms.length) return false;

  await writeJson(path.join(OUT_DIR, game.id, region, 'realms.json'), {
    u: new Date(now * 1000).toISOString(),
    realms
  });
  await resolveItemNames(game, region, base, seen);
  log(game.id, region, 'stored realms:', realms.length);
  return true;
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET');
  token = await getToken();
  const now = Math.floor(Date.now() / 1000);
  const manifest = (await readJson(path.join(OUT_DIR, 'games.json'))) || { games: [] };
  const table = new Map(manifest.games.map(g => [g.id, { id: g.id, label: g.label, regions: new Set(g.regions) }]));
  let successes = 0;

  for (const gid of GAME_IDS) {
    const base = GAMES[gid];
    if (!base) {
      log('unknown game', gid);
      continue;
    }
    const game = { id: gid, ...base };
    for (const region of REGIONS) {
      try {
        if (await collectRegion(game, region, now)) {
          successes++;
          if (!table.has(gid)) table.set(gid, { id: gid, label: game.label, regions: new Set() });
          table.get(gid).regions.add(region);
        }
      } catch (err) {
        log(gid, region, 'failed', err.message);
      }
    }
  }

  for (const g of table.values()) {
    for (const region of KNOWN_REGIONS) {
      if (!REGIONS.includes(region)) {
        g.regions.delete(region);
        await rm(path.join(OUT_DIR, g.id, region), { recursive: true, force: true });
      }
    }
  }
  const games = [...table.values()].filter(g => g.regions.size).map(g => ({ id: g.id, label: g.label, regions: [...g.regions].sort() }));
  await writeJson(path.join(OUT_DIR, 'games.json'), { u: new Date(now * 1000).toISOString(), games });
  if (!successes) throw new Error('No game and region combination was collected');
  log('done, collected', successes, 'game and region combinations');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

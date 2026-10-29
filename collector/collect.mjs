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
const GAME_IDS = (env.GAMES || 'classic,classic1x').split(',').map(s => s.trim()).filter(Boolean);
const MAX_REALMS = Number(env.MAX_REALMS || 0);
const CONCURRENCY = Number(env.CONCURRENCY || 8);
const ITEM_LOOKUPS = Number(env.ITEM_LOOKUPS || 8000);
const HISTORY_TOP = Number(env.HISTORY_TOP || 300);
const DAY = 86400;
const RECIPE_TIERS = Number(env.RECIPE_TIERS || 3);
const RECIPE_FETCH_CAP = Number(env.RECIPE_FETCH_CAP || 6000);
const SOURCES_REFRESH_HOURS = Number(env.SOURCES_REFRESH_HOURS || 72);
const SOURCES_VERSION = 2;
const CATS_VERSION = 2;
const diagnostics = {};
const KNOWN_REGIONS = ['us', 'eu', 'kr', 'tw'];
const TIME = { SHORT: 'S', MEDIUM: 'M', LONG: 'L', VERY_LONG: 'V' };
const ICON_LOOKUPS = Number(env.ICON_LOOKUPS || 8000);
const SALES_DAYS = Number(env.SALES_DAYS || 7);
const SALES_MAX_GAP = 3 * 3600;
const SALES_MIN_GAP = Number(env.SALES_MIN_GAP ?? 1200);
const TIME_CODE = { SHORT: 1, MEDIUM: 2, LONG: 3, VERY_LONG: 4 };
const HOUSE_CODE = { alliance: 1, horde: 2, blackwater: 3 };

const GAMES = {
  retail: { label: 'Retail', dynamic: 'dynamic-{r}', static: 'static-{r}', commodities: true, houses: false, journal: true },
  classic: { label: 'Classic (Progression)', dynamic: 'dynamic-classic-{r}', static: 'static-classic-{r}', staticFallback: ['static-classic1x-{r}'], commodities: false, houses: true, journal: false },
  classic1x: { label: 'Classic Era', dynamic: 'dynamic-classic1x-{r}', static: 'static-classic1x-{r}', staticFallback: ['static-classic-{r}'], commodities: false, houses: true, journal: false }
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
  await updateSales(dir, auctions, now);
}

function listingRows(auctions) {
  const rows = [];
  for (const a of auctions) {
    if (!a.id || !a.item || !a.item.id) continue;
    const key = a.id * 4 + (HOUSE_CODE[a.house] || 0);
    rows.push([key, a.item.id, a.quantity || 1, TIME_CODE[a.time_left] || 0]);
  }
  rows.sort((x, y) => x[0] - y[0]);
  return rows;
}

function encodeRows(rows) {
  const out = new Uint8Array(rows.length * 20 + 16);
  let i = 0;
  const put = n => {
    while (n >= 128) {
      out[i++] = (n % 128) + 128;
      n = Math.floor(n / 128);
    }
    out[i++] = n;
  };
  let last = 0;
  for (const [key, item, qty, tc] of rows) {
    put(key - last);
    last = key;
    put(item);
    put(qty);
    out[i++] = tc;
  }
  return Buffer.from(out.buffer, 0, i);
}

function decodeRows(buf) {
  const map = new Map();
  let i = 0;
  let last = 0;
  const get = () => {
    let n = 0;
    let mul = 1;
    let b;
    do {
      b = buf[i++];
      n += (b % 128) * mul;
      mul *= 128;
    } while (b >= 128);
    return n;
  };
  while (i < buf.length) {
    const key = last + get();
    last = key;
    const item = get();
    const qty = get();
    const tc = buf[i++];
    map.set(key, [item, qty, tc]);
  }
  return map;
}

function diffSales(prevMap, rows) {
  const cur = new Map();
  for (const [key, item, qty] of rows) cur.set(key, [item, qty]);
  const sold = new Map();
  const add = (item, qty, listings) => {
    const s = sold.get(item) || [0, 0];
    s[0] += qty;
    s[1] += listings;
    sold.set(item, s);
  };
  for (const [key, [item, qty, tc]] of prevMap) {
    const c = cur.get(key);
    if (!c) {
      if (tc >= 3) add(item, qty, 1);
    } else if (c[1] < qty) {
      add(item, qty - c[1], 0);
    }
  }
  return sold;
}

async function updateSales(dir, auctions, now) {
  const stateFile = path.join(dir, 'state.bin.gz');
  const salesFile = path.join(dir, 'sales.json.gz');
  const rows = listingRows(auctions);
  const prev = (await readGz(salesFile)) || { last: 0, obs: [], h: {} };
  let prevMap = null;
  const gap = now - (prev.last || 0);
  if (prev.last && gap > 0 && gap >= SALES_MIN_GAP && gap <= SALES_MAX_GAP) {
    try {
      prevMap = decodeRows(gunzipSync(await readFile(stateFile)));
    } catch {
      prevMap = null;
    }
  }
  const cutoff = now - SALES_DAYS * DAY;
  const h = {};
  for (const [k, pts] of Object.entries(prev.h || {})) {
    const kept = pts.filter(p => p[0] > cutoff);
    if (kept.length) h[k] = kept;
  }
  const obs = (prev.obs || []).filter(o => o[0] > cutoff);
  if (prevMap) {
    const sold = diffSales(prevMap, rows);
    for (const [item, [qty, listings]] of sold) {
      (h[item] || (h[item] = [])).push([now, qty, listings]);
    }
    obs.push([now, gap]);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(stateFile, gzipSync(encodeRows(rows), { level: 6 }));
  await writeGz(salesFile, { last: now, obs, h });
}

async function loadMeta(game) {
  const dir = path.join(OUT_DIR, game.id);
  const icons = (await readJson(path.join(dir, 'icons.json'))) || {};
  const info = (await readJson(path.join(dir, 'meta.json'))) || {};
  return {
    names: (await readJson(path.join(dir, 'items.json'))) || {},
    cats: info.catsVersion === CATS_VERSION ? (await readJson(path.join(dir, 'cats.json'))) || {} : {},
    iconBase: icons.base || null,
    icons: icons.icons || {},
    staticNs: null
  };
}

async function saveMeta(game, meta) {
  const dir = path.join(OUT_DIR, game.id);
  await writeJson(path.join(dir, 'items.json'), meta.names);
  await writeJson(path.join(dir, 'cats.json'), meta.cats);
  await writeJson(path.join(dir, 'icons.json'), { base: meta.iconBase, icons: meta.icons });
  await writeJson(path.join(dir, 'meta.json'), { catsVersion: CATS_VERSION, staticNs: meta.staticNs });
}

async function probeStatic(game, region, base, meta) {
  const candidates = [game.static, ...(game.staticFallback || [])].map(s => s.replace('{r}', region));
  const probes = [];
  let chosen = null;
  for (const ns of candidates) {
    try {
      const item = await getJson(`${base}/data/wow/item/2589?namespace=${ns}&locale=en_US`);
      probes.push({ ns, ok: !!item, sample: item ? JSON.stringify(item).slice(0, 900) : null });
      if (item && !chosen) chosen = ns;
    } catch (err) {
      probes.push({ ns, ok: false, error: String(err.message).slice(0, 200) });
    }
  }
  meta.staticNs = chosen || candidates[0];
  diagnostics[game.id] = { staticNs: meta.staticNs, probes };
  log(game.id, 'item namespace:', meta.staticNs);
}

function storeIcon(meta, id, url) {
  if (!url) {
    meta.icons[id] = null;
    return;
  }
  const m = /^(.*\/)([^/]+)\.jpg$/.exec(url);
  if (m && !meta.iconBase) meta.iconBase = m[1];
  meta.icons[id] = m && m[1] === meta.iconBase ? m[2] : url;
}

async function resolveIcons(game, region, base, seen, meta) {
  const ns = meta.staticNs || game.static.replace('{r}', region);
  const missing = [...seen.entries()]
    .filter(([id]) => !(id in meta.icons))
    .sort((a, b) => b[1] - a[1])
    .slice(0, ICON_LOOKUPS)
    .map(([id]) => id);
  await pool(missing, CONCURRENCY, async id => {
    try {
      const media = await getJson(`${base}/data/wow/media/item/${id}?namespace=${ns}`);
      const asset = media && Array.isArray(media.assets) ? media.assets.find(a => a.key === 'icon') : null;
      storeIcon(meta, id, asset ? asset.value : null);
    } catch (err) {
      log('icon lookup failed', id, err.message);
    }
  });
  log(game.id, region, 'icons looked up:', missing.length);
}

function categoryOf(item) {
  const cls = item.item_class && item.item_class.id;
  const clsName = localName(item.item_class && item.item_class.name).toLowerCase();
  const sub = localName(item.item_subclass && item.item_subclass.name).toLowerCase();
  if (cls !== 7 && !clsName.includes('trade')) return 'other';
  if (sub.includes('herb')) return 'herb';
  if (sub.includes('metal')) return 'ore';
  if (sub.includes('leather')) return 'leather';
  if (sub.includes('cloth')) return 'cloth';
  return 'other';
}

async function resolveItemNames(game, region, base, seen, meta) {
  const ns = meta.staticNs || game.static.replace('{r}', region);
  const missing = [...seen.entries()]
    .filter(([id]) => !(id in meta.names) || !(id in meta.cats))
    .sort((a, b) => b[1] - a[1])
    .slice(0, ITEM_LOOKUPS)
    .map(([id]) => id);
  await pool(missing, CONCURRENCY, async id => {
    try {
      const item = await getJson(`${base}/data/wow/item/${id}?namespace=${ns}&locale=en_US`);
      if (item) {
        if (!meta.names[id] && item.name) meta.names[id] = localName(item.name);
        else if (!(id in meta.names)) meta.names[id] = null;
        meta.cats[id] = categoryOf(item);
      } else {
        if (!(id in meta.names)) meta.names[id] = null;
        meta.cats[id] = null;
      }
    } catch (err) {
      log('item lookup failed', id, err.message);
    }
  });
  log(game.id, region, 'item details looked up:', missing.length);
}

async function buildRecipes(game, base, ns, meta, prev) {
  const index = await getJson(`${base}/data/wow/profession/index?namespace=${ns}&locale=en_US`);
  if (!index || !Array.isArray(index.professions)) return null;
  const recipes = prev;
  const wanted = [];
  for (const prof of index.professions) {
    const detail = await getJson(`${base}/data/wow/profession/${prof.id}?namespace=${ns}&locale=en_US`);
    const tiers = ((detail && detail.skill_tiers) || []).slice().sort((a, b) => b.id - a.id).slice(0, RECIPE_TIERS);
    for (const tier of tiers) {
      const td = await getJson(`${base}/data/wow/profession/${prof.id}/skill-tier/${tier.id}?namespace=${ns}&locale=en_US`);
      for (const cat of (td && td.categories) || []) {
        for (const r of cat.recipes || []) wanted.push({ id: r.id, p: localName(prof.name), t: localName(tier.name) });
      }
    }
  }
  const todo = wanted.filter(w => !(w.id in recipes));
  const batch = todo.slice(0, RECIPE_FETCH_CAP);
  log(game.id, 'recipes listed:', wanted.length, 'to fetch now:', batch.length);
  const diag = { listed: wanted.length, fetched: batch.length, missing: 0, noCrafted: 0, samples: [] };
  await pool(batch, CONCURRENCY, async w => {
    try {
      const r = await getJson(`${base}/data/wow/recipe/${w.id}?namespace=${ns}&locale=en_US`);
      const crafted = r && (r.crafted_item || r.alliance_crafted_item || r.horde_crafted_item);
      if (!r) diag.missing++;
      if (!crafted || !crafted.id) {
        if (r) {
          diag.noCrafted++;
          if (diag.samples.length < 4) diag.samples.push(JSON.stringify(r).slice(0, 900));
        }
        recipes[w.id] = null;
        return;
      }
      const cq = r.crafted_quantity || {};
      const reagents = (r.reagents || []).filter(x => x.reagent && x.reagent.id);
      if (!meta.names[crafted.id] && crafted.name) meta.names[crafted.id] = localName(crafted.name);
      for (const x of reagents) {
        if (!meta.names[x.reagent.id] && x.reagent.name) meta.names[x.reagent.id] = localName(x.reagent.name);
      }
      recipes[w.id] = {
        p: w.p,
        t: w.t,
        i: crafted.id,
        q: cq.value || cq.minimum || 1,
        r: reagents.map(x => [x.reagent.id, x.quantity || 1])
      };
    } catch (err) {
      log(game.id, 'recipe failed', w.id, err.message);
    }
  });
  log(game.id, 'recipe results. missing:', diag.missing, 'no crafted item:', diag.noCrafted);
  return { recipes, pending: todo.length - batch.length, diag };
}

async function buildDrops(game, base, ns, meta) {
  const index = await getJson(`${base}/data/wow/journal-expansion/index?namespace=${ns}&locale=en_US`);
  if (!index || !Array.isArray(index.tiers)) return null;
  const instances = [];
  for (const tier of index.tiers) {
    const t = await getJson(`${base}/data/wow/journal-expansion/${tier.id}?namespace=${ns}&locale=en_US`);
    for (const inst of [...((t && t.dungeons) || []), ...((t && t.raids) || [])]) instances.push(inst);
  }
  const encounters = [];
  await pool(instances, CONCURRENCY, async inst => {
    try {
      const d = await getJson(`${base}/data/wow/journal-instance/${inst.id}?namespace=${ns}&locale=en_US`);
      for (const e of (d && d.encounters) || []) {
        encounters.push({ id: e.id, instance: localName(inst.name), encounter: localName(e.name) });
      }
    } catch (err) {
      log(game.id, 'instance failed', inst.id, err.message);
    }
  });
  log(game.id, 'journal instances:', instances.length, 'encounters:', encounters.length);
  const drops = {};
  await pool(encounters, CONCURRENCY, async e => {
    try {
      const d = await getJson(`${base}/data/wow/journal-encounter/${e.id}?namespace=${ns}&locale=en_US`);
      for (const entry of (d && d.items) || []) {
        const item = entry.item;
        if (!item || !item.id) continue;
        if (!meta.names[item.id] && item.name) meta.names[item.id] = localName(item.name);
        const list = drops[item.id] || (drops[item.id] = []);
        if (list.length < 4 && !list.some(x => x[0] === e.instance && x[1] === e.encounter)) {
          list.push([e.instance, e.encounter]);
        }
      }
    } catch (err) {
      log(game.id, 'encounter failed', e.id, err.message);
    }
  });
  return drops;
}

async function buildSources(game, meta) {
  const file = path.join(OUT_DIR, game.id, 'sources.json.gz');
  const stored = await readGz(file);
  const prev = stored && stored.v === SOURCES_VERSION ? stored : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const ageHours = prev && prev.t ? (nowSec - prev.t) / 3600 : Infinity;
  if (prev && ageHours < SOURCES_REFRESH_HOURS && !prev.pending) {
    log(game.id, 'sources are fresh, skipping');
    return;
  }
  const region = REGIONS[0];
  const base = apiBase(region);
  const ns = game.static.replace('{r}', region);
  const built = await buildRecipes(game, base, ns, meta, prev && prev.recipes ? prev.recipes : {});
  const drops = game.journal ? await buildDrops(game, base, ns, meta) : null;
  if (!built && !drops && !prev) {
    log(game.id, 'no recipe or journal data available');
    return;
  }
  await writeGz(file, {
    v: SOURCES_VERSION,
    u: new Date(nowSec * 1000).toISOString(),
    t: nowSec,
    diag: built ? built.diag : null,
    pending: built ? built.pending : 0,
    recipes: built ? built.recipes : (prev && prev.recipes) || {},
    drops: drops || (prev && prev.drops) || {}
  });
  log(game.id, 'sources stored. recipes:', built ? Object.keys(built.recipes).length : 0, 'drops:', drops ? Object.keys(drops).length : 0);
}

async function collectRegion(game, region, now, meta) {
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
  if (!meta.staticNs) await probeStatic(game, region, base, meta);
  await resolveItemNames(game, region, base, seen, meta);
  await resolveIcons(game, region, base, seen, meta);
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
    const meta = await loadMeta(game);
    try {
      await buildSources(game, meta);
    } catch (err) {
      log(gid, 'sources failed', err.message);
    }
    await saveMeta(game, meta);
    for (const region of REGIONS) {
      try {
        if (await collectRegion(game, region, now, meta)) {
          successes++;
          if (!table.has(gid)) table.set(gid, { id: gid, label: game.label, regions: new Set() });
          table.get(gid).regions.add(region);
        }
      } catch (err) {
        log(gid, region, 'failed', err.message);
      }
      await saveMeta(game, meta);
    }
  }

  for (const id of [...table.keys()]) {
    if (!GAME_IDS.includes(id)) {
      table.delete(id);
      await rm(path.join(OUT_DIR, id), { recursive: true, force: true });
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
  await writeJson(path.join(OUT_DIR, 'diagnostics.json'), { u: new Date(now * 1000).toISOString(), games: diagnostics });
  if (!successes) throw new Error('No game and region combination was collected');
  log('done, collected', successes, 'game and region combinations');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

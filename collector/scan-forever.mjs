import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const env = process.env;
const CLIENT_ID = env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = env.BLIZZARD_CLIENT_SECRET;
const REGION = env.REGION || 'us';
const OUT = path.join(env.OUT_DIR || 'data-out', 'forever', 'api');
const BASE = env.API_BASE || `https://${REGION}.api.blizzard.com`;
const OAUTH_URL = env.OAUTH_URL || 'https://oauth.battle.net/token';
const WAGO = env.WAGO_BASE || 'https://wago.tools';
const MAX_MINUTES = Number(env.MAX_MINUTES || 40);
const started = Date.now();
const timeLeft = () => Date.now() - started < MAX_MINUTES * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const name = n => (typeof n === 'string' ? n : (n && (n.en_US || Object.values(n)[0])) || '');

let token = null;
let calls = 0;

async function getToken() {
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}

async function get(p, ns, extra = '', attempt = 0) {
  const url = `${BASE}${p}${p.includes('?') ? '&' : '?'}namespace=${ns}&locale=en_US${extra}`;
  calls++;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * (attempt + 1));
      return get(p, ns, extra, attempt + 1);
    }
    return { status: 0, error: String(err.message) };
  }
  if (res.status === 401 && attempt < 1) {
    token = await getToken();
    return get(p, ns, extra, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1));
    return get(p, ns, extra, attempt + 1);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

async function save(file, data) {
  const full = path.join(OUT, file);
  await mkdir(path.dirname(full), { recursive: true });
  if (file.endsWith('.gz')) await writeFile(full, gzipSync(JSON.stringify(data)));
  else await writeFile(full, JSON.stringify(data));
}

function namespacesIn(obj, found = new Set()) {
  const s = JSON.stringify(obj || {});
  for (const m of s.matchAll(/namespace=([a-z0-9._-]+)/gi)) found.add(m[1]);
  return found;
}

async function wagoVersions() {
  const out = new Set();
  try {
    const res = await fetch(`${WAGO}/api/builds`, { headers: { 'User-Agent': 'wowplanner-forever-scan (github.com/ianmcgo/wowplanner)' } });
    if (!res.ok) return [];
    const builds = await res.json();
    for (const [product, list] of Object.entries(builds)) {
      if (!/forever|plus/i.test(product) || !Array.isArray(list)) continue;
      for (const b of list.slice(0, 6)) {
        const v = String(b.version || b);
        const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(v);
        if (m) out.add(`${m[1]}_${m[2]}`);
      }
    }
  } catch {}
  return [...out];
}

const summary = { region: REGION, scannedAt: new Date().toISOString(), dynamic: {}, static: {}, profile: {}, datasets: {} };

async function scanDynamic() {
  const nsList = ['dynamic-forever', 'dynamic-classicforever', 'dynamic-classicplus'].map(n => `${n}-${REGION}`);
  const paths = ['/data/wow/realm/index', '/data/wow/connected-realm/index', '/data/wow/region/index', '/data/wow/search/realm?_pageSize=100', '/data/wow/search/connected-realm?_pageSize=100', '/data/wow/token/index', '/data/wow/pvp-season/index', '/data/wow/mythic-keystone/index'];
  const found = new Set();
  for (const ns of nsList) {
    for (const p of paths) {
      const r = await get(p, ns);
      const key = `${ns} ${p}`;
      summary.dynamic[key] = r.status;
      if (r.status === 200 && r.body) {
        namespacesIn(r.body, found);
        const file = `dynamic/${p.replace(/^\/data\/wow\//, '').replace(/[?/=&]+/g, '_')}.json`;
        await save(file, r.body);
      }
    }
  }
  const realms = await get('/data/wow/realm/index', `dynamic-forever-${REGION}`);
  if (realms.status === 200 && realms.body && Array.isArray(realms.body.realms)) {
    const details = [];
    for (const r of realms.body.realms.slice(0, 40)) {
      const d = await get(`/data/wow/realm/${r.slug}`, `dynamic-forever-${REGION}`);
      details.push({ slug: r.slug, status: d.status, body: d.body });
      if (d.body) namespacesIn(d.body, found);
      if (d.body && d.body.connected_realm && d.body.connected_realm.href) {
        const cid = /connected-realm\/(\d+)/.exec(d.body.connected_realm.href);
        if (cid) {
          const cr = await get(`/data/wow/connected-realm/${cid[1]}`, `dynamic-forever-${REGION}`);
          const ah = await get(`/data/wow/connected-realm/${cid[1]}/auctions/index`, `dynamic-forever-${REGION}`);
          const a2 = await get(`/data/wow/connected-realm/${cid[1]}/auctions`, `dynamic-forever-${REGION}`);
          details[details.length - 1].connected = { id: cid[1], status: cr.status, auctionsIndex: ah.status, auctions: a2.status, ahBody: ah.body };
        }
      }
    }
    await save('dynamic/realm-details.json', details);
    summary.realms = details.map(d => ({ slug: d.slug, status: d.status, name: d.body && name(d.body.name), type: d.body && d.body.type && name(d.body.type.name), category: d.body && name(d.body.category), connected: d.connected && { id: d.connected.id, status: d.connected.status, auctionsIndex: d.connected.auctionsIndex, auctions: d.connected.auctions } }));
  }
  const com = await get('/data/wow/auctions/commodities', `dynamic-forever-${REGION}`);
  summary.dynamic.commodities = com.status;
  return found;
}

async function findStatic(hints) {
  const cands = new Set([`static-forever-${REGION}`]);
  for (const h of hints) if (h.startsWith('static-')) cands.add(h);
  for (const v of await wagoVersions()) cands.add(`static-${v}-forever-${REGION}`);
  for (const v of (env.FOREVER_STATIC_VERSIONS || '1.60.1_70399').split(',').filter(Boolean)) cands.add(`static-${v}-forever-${REGION}`);
  let chosen = null;
  for (const ns of cands) {
    const r = await get('/data/wow/playable-class/index', ns);
    summary.static[ns] = r.status;
    if (r.status === 200 && !chosen) chosen = ns;
  }
  summary.staticNs = chosen;
  return chosen;
}

const INDEXES = [
  ['playable-class/index', 'classes'], ['playable-race/index', 'races'], ['playable-specialization/index', 'specs'], ['power-type/index', 'power-types'],
  ['item-class/index', 'item-classes'], ['item-set/index', 'item-sets'], ['profession/index', 'professions'], ['journal-expansion/index', 'journal-expansions'],
  ['journal-instance/index', 'journal-instances'], ['journal-encounter/index', 'journal-encounters'], ['creature-family/index', 'creature-families'], ['creature-type/index', 'creature-types'],
  ['mount/index', 'mounts'], ['pet/index', 'pets'], ['toy/index', 'toys'], ['title/index', 'titles'], ['achievement/index', 'achievements'], ['achievement-category/index', 'achievement-categories'],
  ['reputation-faction/index', 'reputations'], ['quest/index', 'quest-index'], ['quest/category/index', 'quest-categories'], ['quest/area/index', 'quest-areas'], ['quest/type/index', 'quest-types'],
  ['talent/index', 'talents'], ['pvp-talent/index', 'pvp-talents'], ['tech-talent-tree/index', 'tech-talent-trees'], ['covenant/index', 'covenants'], ['heirloom/index', 'heirlooms'],
  ['media/search?_pageSize=1', 'media-search-probe'], ['guild-crest/index', 'guild-crest'], ['keystone-affix/index', 'keystone-affixes']
];

async function scanIndexes(ns) {
  for (const [p, label] of INDEXES) {
    const r = await get(`/data/wow/${p}`, ns);
    summary.datasets[label] = { status: r.status };
    if (r.status === 200 && r.body) {
      await save(`static/${label}.json`, r.body);
      const arr = Object.values(r.body).find(v => Array.isArray(v));
      summary.datasets[label].count = arr ? arr.length : null;
    }
  }
}

async function scanDetails(ns, label, p, list, key = 'id') {
  const out = {};
  for (const e of list) {
    if (!timeLeft()) break;
    const id = e[key];
    const r = await get(`/data/wow/${p}/${id}`, ns);
    if (r.status === 200) out[id] = r.body;
  }
  await save(`static/${label}.json.gz`, out);
  summary.datasets[label] = { status: 200, count: Object.keys(out).length };
  return out;
}

async function scanProfessions(ns) {
  const idx = await get('/data/wow/profession/index', ns);
  if (idx.status !== 200 || !idx.body) return;
  const profs = {};
  const tiers = {};
  const recipes = {};
  for (const p of idx.body.professions || []) {
    const d = await get(`/data/wow/profession/${p.id}`, ns);
    if (d.status !== 200) continue;
    profs[p.id] = d.body;
    for (const t of d.body.skill_tiers || []) {
      const st = await get(`/data/wow/profession/${p.id}/skill-tier/${t.id}`, ns);
      if (st.status !== 200) continue;
      tiers[`${p.id}-${t.id}`] = st.body;
      for (const c of st.body.categories || []) {
        for (const rc of c.recipes || []) {
          if (!timeLeft()) break;
          if (recipes[rc.id]) continue;
          const r = await get(`/data/wow/recipe/${rc.id}`, ns);
          if (r.status === 200) recipes[rc.id] = r.body;
        }
      }
    }
  }
  await save('static/profession-details.json', profs);
  await save('static/skill-tiers.json.gz', tiers);
  await save('static/recipes.json.gz', recipes);
  summary.datasets.professionDetails = { count: Object.keys(profs).length };
  summary.datasets.skillTiers = { count: Object.keys(tiers).length };
  summary.datasets.recipes = { count: Object.keys(recipes).length };
}

async function searchAll(ns, kind, slim) {
  const out = {};
  let from = 0;
  let pages = 0;
  let status = null;
  while (timeLeft()) {
    const r = await get(`/data/wow/search/${kind}?orderby=id&_pageSize=1000&id=[${from},]`, ns);
    status = r.status;
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.results) || !r.body.results.length) break;
    pages++;
    let max = from;
    for (const x of r.body.results) {
      const d = x.data || {};
      out[d.id] = slim(d);
      if (d.id > max) max = d.id;
    }
    if (r.body.results.length < 1000 || max < from) break;
    from = max + 1;
  }
  await save(`static/${kind}s.json.gz`, out);
  summary.datasets[`search-${kind}`] = { status, pages, count: Object.keys(out).length, complete: timeLeft() };
  return out;
}

const slimItem = d => ({
  n: name(d.name), q: d.quality && d.quality.type, il: d.level, rl: d.required_level, c: d.item_class && d.item_class.id, s: d.item_subclass && d.item_subclass.id,
  inv: d.inventory_type && d.inventory_type.type, st: d.max_count, eq: d.is_equippable, stack: d.is_stackable, buy: d.purchase_price, sell: d.sell_price, m: d.media && d.media.id
});
const slimCreature = d => ({ n: name(d.name), t: d.type && d.type.id, f: d.family && d.family.id, tame: d.is_tameable, disp: (d.creature_displays || []).map(x => x.id).slice(0, 3) });

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET');
  token = await getToken();
  await mkdir(OUT, { recursive: true });
  const hints = await scanDynamic();
  summary.namespacesSeen = [...hints];
  const ns = await findStatic(hints);
  log('static namespace', ns);
  if (ns) {
    await scanIndexes(ns);
    const races = summary.datasets.races && summary.datasets.races.status === 200;
    if (races) {
      const cl = await get('/data/wow/playable-class/index', ns);
      if (cl.body) await scanDetails(ns, 'class-details', 'playable-class', cl.body.classes || []);
      const rc = await get('/data/wow/playable-race/index', ns);
      if (rc.body) await scanDetails(ns, 'race-details', 'playable-race', rc.body.races || []);
    }
    await searchAll(ns, 'item', slimItem);
    await scanProfessions(ns);
    const ji = await get('/data/wow/journal-instance/index', ns);
    if (ji.status === 200 && ji.body) await scanDetails(ns, 'journal-instance-details', 'journal-instance', ji.body.instances || []);
    await searchAll(ns, 'creature', slimCreature);
  }
  summary.calls = calls;
  summary.minutes = Math.round((Date.now() - started) / 600) / 100;
  await save('summary.json', summary);
  log(JSON.stringify(summary, null, 1).slice(0, 6000));
}

main().catch(async err => {
  summary.error = String(err && err.stack || err);
  try {
    await save('summary.json', summary);
  } catch {}
  console.error(err);
  process.exit(1);
});

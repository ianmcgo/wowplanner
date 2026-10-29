import { writeFile } from 'node:fs/promises';

const outFile = process.argv[2] || 'static/map-bounds.json';
const BASE = process.env.WAGO_BASE || 'https://wago.tools';
const PRODUCT_HINTS = (process.env.WAGO_PRODUCTS || 'wow_classic,wow_classic_ptr,wow_classic_beta').split(',');
const VERSION_PREFIX = process.env.WAGO_VERSION_PREFIX || '5.';

const wait = ms => new Promise(r => setTimeout(r, ms));

async function get(url, type) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'wowplanner-map-builder (github.com/ianmcgo/wowplanner)' } });
      if (res.ok) return type === 'json' ? res.json() : res.text();
      last = new Error(`${res.status} ${url}`);
      if (res.status < 500 && res.status !== 429) throw last;
    } catch (err) {
      last = err;
    }
    await wait(5000 * (attempt + 1));
  }
  throw last;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(header.map((h, k) => [h, r[k]])));
}

async function pickBuild() {
  const builds = await get(`${BASE}/api/builds`, 'json');
  const products = [...PRODUCT_HINTS, ...Object.keys(builds)];
  for (const p of products) {
    const list = builds[p];
    if (!Array.isArray(list)) continue;
    const match = list.find(b => String(b.version || b).startsWith(VERSION_PREFIX));
    if (match) return String(match.version || match);
  }
  throw new Error(`No build starting with ${VERSION_PREFIX}`);
}

const table = async (name, build) => parseCsv(await get(`${BASE}/db2/${name}/csv?build=${encodeURIComponent(build)}`, 'text'));
const num = v => (v === undefined || v === '' ? 0 : Number(v));
const r2 = v => Math.round(v * 1000) / 1000;

const build = await pickBuild();
const maps = await table('Map', build);
const uiMaps = await table('UiMap', build);
const assigns = await table('UiMapAssignment', build);
let groups = [];
try {
  groups = await table('UiMapGroupMember', build);
} catch {}

const out = { build, columns: Object.keys(assigns[0] || {}), maps: {}, ui: {}, assign: [], groups: {} };
for (const m of maps) out.maps[String(m.Directory || '').toLowerCase()] = [num(m.ID), m.MapName_lang || m.MapName || ''];
for (const u of uiMaps) out.ui[u.ID] = [u.Name_lang || u.Name || '', num(u.ParentUiMapID), num(u.Type)];
for (const a of assigns) {
  out.assign.push([
    num(a.UiMapID), num(a.MapID), num(a.AreaID), num(a.OrderIndex), num(a.WmoDoodadPlacementID), num(a.WmoGroupID),
    r2(num(a['UiMin[0]'])), r2(num(a['UiMin[1]'])), r2(num(a['UiMax[0]'])), r2(num(a['UiMax[1]'])),
    r2(num(a['Region[0]'])), r2(num(a['Region[1]'])), r2(num(a['Region[2]'])), r2(num(a['Region[3]'])), r2(num(a['Region[4]'])), r2(num(a['Region[5]']))
  ]);
}
for (const g of groups) out.groups[g.UiMapID] = [num(g.UiMapGroupID), num(g.RelativeHeightIndex), g.Name_lang || ''];
await writeFile(outFile, JSON.stringify(out));
console.log('build', build, 'maps', maps.length, 'uiMaps', uiMaps.length, 'assignments', assigns.length, 'columns', out.columns.join(','));

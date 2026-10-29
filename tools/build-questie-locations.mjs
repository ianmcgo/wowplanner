import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [dbDir, outFile] = process.argv.slice(2);
if (!dbDir || !outFile) {
  console.error('Usage: node tools/build-questie-locations.mjs <QuestieDB checkout> static/mop-classic-locations.json');
  process.exit(1);
}

const MAX_SOURCES = 6;
const MAX_ZONES = 3;
const MAX_POINTS = 30;

function parseLua(src) {
  let i = 0;
  const ws = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') i++;
      else if (c === '-' && src[i + 1] === '-') {
        while (i < src.length && src[i] !== '\n') i++;
      } else break;
    }
  };
  const str = () => {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        i += 2;
      } else out += src[i++];
    }
    i++;
    return out;
  };
  const num = () => {
    const m = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(i, i + 40));
    i += m[0].length;
    return Number(m[0]);
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    if (src.startsWith('nil', i)) { i += 3; return null; }
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return false; }
    throw new Error(`Unexpected "${src.slice(i, i + 30)}" at ${i}`);
  };
  const table = () => {
    i++;
    const arr = [];
    let map = null;
    for (;;) {
      ws();
      if (src[i] === '}') { i++; break; }
      if (src[i] === '[') {
        i++;
        const key = value();
        ws();
        i++;
        ws();
        i++;
        const v = value();
        if (!map) map = {};
        map[key] = v;
      } else {
        arr.push(value());
      }
      ws();
      if (src[i] === ',' || src[i] === ';') i++;
    }
    return map ? map : arr;
  };
  ws();
  if (src.startsWith('return', i)) i += 6;
  return value();
}

async function loadData(file, field) {
  const text = await readFile(file, 'utf8');
  const start = text.indexOf(`${field} = [[`);
  if (start < 0) throw new Error(`No ${field} in ${file}`);
  const open = text.indexOf('[[', start) + 2;
  const close = text.indexOf(']]', open);
  return parseLua(text.slice(open, close));
}

async function loadZones(file) {
  const text = await readFile(file, 'utf8');
  const small = new Set(['of', 'the', 'and', 'in', 'to']);
  const zones = {};
  const re = /^\s*([A-Z0-9_]+)\s*=\s*(\d+),/gm;
  let m;
  while ((m = re.exec(text))) {
    const id = Number(m[2]);
    if (zones[id]) continue;
    zones[id] = m[1].toLowerCase().split('_').map((w, k) => (k > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }
  return zones;
}

function trimSpawns(spawns, mainZone) {
  if (!spawns || typeof spawns !== 'object') return null;
  const entries = Object.entries(spawns)
    .map(([z, pts]) => [Number(z), (Array.isArray(pts) ? pts : []).filter(p => Array.isArray(p) && p[0] >= 0 && p[1] >= 0)])
    .filter(([, pts]) => pts.length);
  if (!entries.length) return null;
  entries.sort((a, b) => (a[0] === mainZone ? -1 : b[0] === mainZone ? 1 : b[1].length - a[1].length));
  const out = {};
  for (const [z, pts] of entries.slice(0, MAX_ZONES)) {
    const step = Math.max(1, Math.ceil(pts.length / MAX_POINTS));
    out[z] = pts.filter((_, k) => k % step === 0).slice(0, MAX_POINTS).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }
  return out;
}

const mop = path.join(dbDir, 'data', 'MoP');
const items = await loadData(path.join(mop, 'mopItemDB.lua'), 'QuestieDB.itemData');
const npcs = await loadData(path.join(mop, 'mopNpcDB.lua'), 'QuestieDB.npcData');
const objects = await loadData(path.join(mop, 'mopObjectDB.lua'), 'QuestieDB.objectData');
const zoneNames = await loadZones(path.join(dbDir, 'src', 'corrections', 'enum', 'zones.lua'));

const out = { v: 1, built: new Date().toISOString(), license: 'GPL-3.0, derived from QuestieDB (https://github.com/Questie/QuestieDB)', zones: {}, npcs: {}, objects: {}, items: {} };
const usedNpcs = new Set();
const usedObjects = new Set();

const pick = list => (Array.isArray(list) ? list.filter(x => typeof x === 'number') : []);

for (const [id, row] of Object.entries(items)) {
  if (!Array.isArray(row)) continue;
  const vendors = pick(row[13]).filter(n => npcs[n] && npcs[n][6]);
  const drops = pick(row[1]).filter(n => npcs[n] && npcs[n][6]);
  const objs = pick(row[2]).filter(o => objects[o] && objects[o][3]);
  if (!vendors.length && !drops.length && !objs.length) continue;
  const entry = {};
  if (vendors.length) entry.v = vendors.slice(0, MAX_SOURCES);
  if (drops.length) entry.d = drops.slice(0, MAX_SOURCES);
  if (objs.length) entry.o = objs.slice(0, MAX_SOURCES);
  out.items[id] = entry;
  for (const n of [...(entry.v || []), ...(entry.d || [])]) usedNpcs.add(n);
  for (const o of entry.o || []) usedObjects.add(o);
}

const usedZones = new Set();
for (const n of usedNpcs) {
  const r = npcs[n];
  const spawns = trimSpawns(r[6], r[8]);
  if (!spawns) continue;
  Object.keys(spawns).forEach(z => usedZones.add(Number(z)));
  out.npcs[n] = [r[0], r[13] || null, r[12] || null, r[3] || null, r[4] || null, spawns];
}
for (const o of usedObjects) {
  const r = objects[o];
  const spawns = trimSpawns(r[3], r[4]);
  if (!spawns) continue;
  Object.keys(spawns).forEach(z => usedZones.add(Number(z)));
  out.objects[o] = [r[0], spawns];
}
for (const z of usedZones) out.zones[z] = zoneNames[z] || null;

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(out));
const vendorItems = Object.values(out.items).filter(e => e.v).length;
console.log('items', Object.keys(out.items).length, 'with vendors', vendorItems, 'npcs', Object.keys(out.npcs).length, 'objects', Object.keys(out.objects).length, 'zones', usedZones.size, 'named zones', Object.values(out.zones).filter(Boolean).length);

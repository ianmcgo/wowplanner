import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [dbDir, outFile, ratesFile] = process.argv.slice(2);
if (!dbDir || !outFile) {
  console.error('Usage: node tools/build-questie-locations.mjs <QuestieDB checkout> static/mop-classic-locations.json');
  process.exit(1);
}

const MAX_VENDORS = 8;
const MAX_DROPS = 25;
const MAX_OBJECTS = 10;
const MAX_ZONES = 3;
const MAX_POINTS = 15;

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
const dropRates = await loadData(path.join(dbDir, 'support', 'DropTables', 'mopItemDrops.lua'), 'QuestieMopItemDrops.wowheadData');
const extRates = ratesFile ? JSON.parse(await readFile(ratesFile, 'utf8')).items : {};

const out = { v: 1, built: new Date().toISOString(), license: 'Derived from QuestieDB and CMaNGOS (GPL-3.0); drop rates tagged ds=cata from the MaNGOS Three world database (CC BY-NC-SA 3.0)', zones: {}, npcs: {}, objects: {}, items: {} };
const usedNpcs = new Set();
const usedObjects = new Set();

const pick = list => (Array.isArray(list) ? list.filter(x => typeof x === 'number') : []);

let ratedItems = 0;
let extRated = 0;
for (const [id, row] of Object.entries(items)) {
  if (!Array.isArray(row)) continue;
  const vendors = pick(row[13]).filter(n => npcs[n] && npcs[n][6]);
  let rates = dropRates[id] && typeof dropRates[id] === 'object' && !Array.isArray(dropRates[id]) ? dropRates[id] : {};
  let rateSource = Object.keys(rates).length ? 'mop' : null;
  let total = 0;
  if (!rateSource && extRates[id]) {
    rates = Object.fromEntries(extRates[id].d.filter(([n]) => npcs[n] && npcs[n][6]).map(([n, p]) => [n, p]));
    if (Object.keys(rates).length) {
      rateSource = extRates[id].s;
      total = extRates[id].n;
      extRated++;
    }
  }
  const rate = n => (typeof rates[n] === 'number' ? rates[n] : -1);
  const drops = [...new Set([...pick(row[1]), ...Object.keys(rates).map(Number)])]
    .filter(n => npcs[n] && npcs[n][6])
    .sort((a, b) => rate(b) - rate(a));
  const objs = pick(row[2]).filter(o => objects[o] && objects[o][3]);
  if (!vendors.length && !drops.length && !objs.length) continue;
  const entry = {};
  if (vendors.length) entry.v = vendors.slice(0, MAX_VENDORS);
  if (drops.length) {
    entry.d = drops.slice(0, MAX_DROPS);
    if (Math.max(drops.length, total) > MAX_DROPS) entry.dn = Math.max(drops.length, total);
    const dc = entry.d.map(n => (rate(n) >= 0 ? Math.round(rate(n) * 100) / 100 : null));
    if (dc.some(x => x !== null)) {
      entry.dc = dc;
      entry.ds = rateSource;
      ratedItems++;
    }
  }
  if (objs.length) entry.o = objs.slice(0, MAX_OBJECTS);
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

const SHARDS = 64;
const CURRENCY_VENDOR = /quartermaster|justice|honor|valor|conquest|arena|darkmoon|exotic goods|legacy|prizes|tabard|heirloom|sha'tari|emblem|badge|token|wintergrasp|triumphant|glorious|gladiator|exchange|spirit of harmony|currency|mark|insignia|commendation/i;
const outDir = path.join(path.dirname(outFile), 'loc');
await mkdir(outDir, { recursive: true });
const shards = Array.from({ length: SHARDS }, () => ({ items: {}, npcs: {}, objects: {} }));
for (const [id, entry] of Object.entries(out.items)) {
  const sh = shards[Number(id) % SHARDS];
  sh.items[id] = entry;
  for (const n of [...(entry.v || []), ...(entry.d || [])]) if (out.npcs[n]) sh.npcs[n] = out.npcs[n];
  for (const o of entry.o || []) if (out.objects[o]) sh.objects[o] = out.objects[o];
}
for (let k = 0; k < SHARDS; k++) await writeFile(path.join(outDir, `${k}.json`), JSON.stringify(shards[k]));
await writeFile(path.join(outDir, 'zones.json'), JSON.stringify(out.zones));
const vendorIds = Object.entries(out.items).filter(([, e]) => e.v).map(([id]) => Number(id)).sort((a, b) => a - b);
const goldIds = Object.entries(out.items)
  .filter(([, e]) => (e.v || []).some(n => out.npcs[n] && !(out.npcs[n][1] && CURRENCY_VENDOR.test(out.npcs[n][1]))))
  .map(([id]) => Number(id))
  .sort((a, b) => a - b);
await writeFile(path.join(path.dirname(outFile), 'vendor-items.json'), JSON.stringify(vendorIds));
await writeFile(path.join(path.dirname(outFile), 'gold-vendor-items.json'), JSON.stringify(goldIds));
console.log('shards', SHARDS, 'vendor items', vendorIds.length, 'gold vendor items', goldIds.length);
const INSTANCES = {
  Classic: {
    dungeon: ['Ragefire Chasm', 'Wailing Caverns', 'The Deadmines', 'Shadowfang Keep', 'The Stockade', 'Blackfathom Deeps', 'Gnomeregan', 'Razorfen Kraul', 'Razorfen Downs', 'Uldaman', "Zul'Farrak", 'Maraudon', "The Temple of Atal'Hakkar", 'Blackrock Depths', 'Blackrock Spire', 'Dire Maul', 'Stratholme'],
    raid: ['Molten Core', "Onyxia's Lair", 'Blackwing Lair', "Ruins of Ahn'Qiraj", "Temple of Ahn'Qiraj"]
  },
  'Burning Crusade': {
    dungeon: ['Hellfire Ramparts', 'The Blood Furnace', 'The Shattered Halls', 'The Slave Pens', 'The Underbog', 'The Steamvault', 'Mana-Tombs', 'Auchenai Crypts', 'Sethekk Halls', 'Shadow Labyrinth', 'Old Hillsbrad Foothills', 'The Black Morass', 'The Mechanar', 'The Botanica', 'The Arcatraz', "Magisters' Terrace"],
    raid: ['Karazhan', "Gruul's Lair", "Magtheridon's Lair", 'Serpentshire Cavern', 'Tempest Keep', 'Hyjal Summit', 'Black Temple', 'Sunwell Plateau']
  },
  'Wrath of the Lich King': {
    dungeon: ['Utgarde Keep', 'Utgarde Pinnacle', 'The Nexus', 'The Oculus', 'Azjol-Nerub', "Ahn'kahet: The Old Kingdom", "Drak'Tharon Keep", 'The Violet Hold', 'Gundrak', 'Halls of Stone', 'Halls of Lightning', 'The Culling of Stratholme', 'Trial of the Champion', 'The Forge of Souls', 'Pit of Saron', 'Halls of Reflection'],
    raid: ['Naxxramas', 'The Obsidian Sanctum', 'The Eye of Eternity', 'Vault of Archavon', 'Ulduar', 'Trial of the Crusader', 'Icecrown Citadel', 'The Ruby Sanctum']
  },
  Cataclysm: {
    dungeon: ['Blackrock Caverns', 'Throne of the Tides', 'The Stonecore', 'The Vortex Pinnacle', 'Grim Batol', 'Halls of Origination', "Lost City of the Tol'vir", "Zul'Gurub", "Zul'Aman", 'End Time', 'Well of Eternity', 'Hour of Twilight'],
    raid: ['Blackwing Descent', 'The Bastion of Twilight', 'Throne of the Four Winds', 'Baradin Hold', 'Firelands', 'Dragon Soul']
  },
  'Mists of Pandaria': {
    dungeon: ['Temple of the Jade Serpent', 'Stormstout Brewery', 'Shado-Pan Monastery', "Mogu'shan Palace", 'Gate of the Setting Sun', 'Siege of Niuzao Temple', 'Scarlet Halls', 'Scarlet Monastery', 'Scholomance'],
    raid: ["Mogu'shan Vaults", 'Heart of Fear', 'Terrace of Endless Spring', 'Throne of Thunder', 'Siege of Orgrimmar']
  }
};
const DISPLAY_NAME = { 'Serpentshire Cavern': 'Serpentshrine Cavern' };
const instanceList = [];
const instanceByName = new Map();
for (const [exp, kinds] of Object.entries(INSTANCES)) {
  for (const [type, names] of Object.entries(kinds)) {
    for (const n of names) {
      instanceByName.set(n, instanceList.length);
      instanceList.push([DISPLAY_NAME[n] || n, exp, type]);
    }
  }
}
const dungeonLua = await readFile(path.join(dbDir, 'support', 'Zones', 'dungeons.lua'), 'utf8');
const areaInstance = new Map();
for (const m of dungeonLua.matchAll(/^\s*\[(\d+)\]\s*=\s*\{"([^"]+)",(nil|\{[\d,\s]*\})/gm)) {
  const idx = instanceByName.get(m[2]);
  if (idx === undefined) continue;
  areaInstance.set(Number(m[1]), idx);
  if (m[3] !== 'nil') for (const alt of m[3].match(/\d+/g) || []) areaInstance.set(Number(alt), idx);
}
const NAPALM_LABEL = { 'Siege of Orgrimmar (Flex)': 'Siege of Orgrimmar' };
let napalm = null;
try {
  napalm = JSON.parse(await readFile(path.join(path.dirname(outFile), 'mop-classic-sources.json'), 'utf8'));
} catch {
  napalm = null;
}
const MIN_DROP = 0.5;
const instDrops = new Map();
const addDrop = (idx, item, boss, chance) => {
  if (!instDrops.has(idx)) instDrops.set(idx, new Map());
  const m = instDrops.get(idx);
  const cur = m.get(item);
  if (!cur || (chance ?? -1) > (cur[2] ?? -1)) m.set(item, [item, boss, chance]);
};
for (const [id, row] of Object.entries(items)) {
  if (!Array.isArray(row)) continue;
  const rates = dropRates[id] && typeof dropRates[id] === 'object' && !Array.isArray(dropRates[id]) ? dropRates[id] : (extRates[id] ? Object.fromEntries(extRates[id].d) : {});
  const droppers = [...new Set([...pick(row[1]), ...Object.keys(rates).map(Number)])];
  for (const n of droppers) {
    const npc = npcs[n];
    if (!npc) continue;
    const chance = typeof rates[n] === 'number' ? Math.round(rates[n] * 100) / 100 : null;
    const named = napalm && napalm.boss[id] && napalm.boss[id].includes(npc[0]);
    if (chance === null ? !(npc[5] === 3 || named) : chance < MIN_DROP) continue;
    const areas = new Set([...Object.keys(npc[6] && typeof npc[6] === 'object' ? npc[6] : {}).map(Number), npc[8]]);
    for (const a of areas) {
      const idx = areaInstance.get(a);
      if (idx !== undefined) addDrop(idx, Number(id), npc[0], chance);
    }
  }
}
if (napalm) {
  for (const [id, keys] of Object.entries(napalm.items)) {
    for (const k of keys) {
      const src = napalm.src[k];
      if (!src || (src[0] !== 'Dungeon' && src[0] !== 'Raid')) continue;
      const idx = instanceByName.get(NAPALM_LABEL[src[1]] || src[1]);
      if (idx === undefined) continue;
      const bosses = napalm.boss[id];
      const m = instDrops.get(idx);
      if (m && m.has(Number(id))) continue;
      addDrop(idx, Number(id), bosses && bosses.length ? bosses.join(' / ') : null, null);
    }
  }
}
const instOut = { v: 1, built: out.built, license: out.license, instances: instanceList, drops: {} };
for (const [idx, m] of instDrops) instOut.drops[idx] = [...m.values()];
await writeFile(path.join(path.dirname(outFile), 'instance-drops.json'), JSON.stringify(instOut));
console.log('instances with drops', instDrops.size, 'of', instanceList.length, 'drop rows', [...instDrops.values()].reduce((s, m) => s + m.size, 0));

const MINING_NODE = /\b(vein|deposit|lode|seam)\b/i;
let catalog = null;
try {
  catalog = JSON.parse(await readFile(path.join(path.dirname(outFile), 'mop-classic-items.json'), 'utf8')).items;
} catch {
  catalog = null;
}
const SKIN_SKIP = /^(cured|refined|enchanted|crystal infused|ruined|hardened magnificent)|salt|feather|^heavy (knothide|borean|savage|mist)|murloc|deviate|whelp|scale of onyxia|2\.0/i;
const harvest = { Herbalism: {}, Mining: {}, Skinning: {} };
for (const [id, row] of Object.entries(items)) {
  if (!Array.isArray(row)) continue;
  const objs = pick(row[2]).filter(o => objects[o] && objects[o][3]);
  if (!objs.length) continue;
  const name = row[0];
  const c = catalog && catalog[id];
  const mine = objs.filter(o => MINING_NODE.test(objects[o][0]));
  const herb = objs.filter(o => objects[o][0] === name || (c && c[4] === 7 && c[5] === 9 && !MINING_NODE.test(objects[o][0])));
  const nodes = list => list.reduce((s, o) => s + Object.values(objects[o][3]).reduce((k, p) => k + (Array.isArray(p) ? p.length : 0), 0), 0);
  const isHerb = c ? c[4] === 7 && c[5] === 9 : herb.length > 0;
  if (isHerb && herb.length) harvest.Herbalism[id] = nodes(herb);
  else if (!isHerb && mine.length && (!c || c[4] === 7 || c[4] === 3)) harvest.Mining[id] = nodes(mine);
}
const HERB_SKIP = /seed|bulb|petal|stem|spore|pollen|^unused|essence/i;
if (catalog) {
  for (const [id, c] of Object.entries(catalog)) {
    if (c[4] !== 7) continue;
    if (c[5] === 6 && !SKIN_SKIP.test(c[0])) harvest.Skinning[id] = 0;
    if (c[5] === 9 && !HERB_SKIP.test(c[0]) && !(id in harvest.Herbalism)) harvest.Herbalism[id] = 0;
    if (c[5] === 7 && / ore$/i.test(c[0]) && !(id in harvest.Mining)) harvest.Mining[id] = 0;
  }
}
await writeFile(path.join(path.dirname(outFile), 'harvest-items.json'), JSON.stringify(harvest));
console.log('harvest', Object.fromEntries(Object.entries(harvest).map(([k, v]) => [k, Object.keys(v).length])));
const vendorItems = Object.values(out.items).filter(e => e.v).length;
console.log('items with drop rates', ratedItems, 'from private server tables', extRated);
console.log('items', Object.keys(out.items).length, 'with vendors', vendorItems, 'npcs', Object.keys(out.npcs).length, 'objects', Object.keys(out.objects).length, 'zones', usedZones.size, 'named zones', Object.values(out.zones).filter(Boolean).length);

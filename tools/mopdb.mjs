import path from 'node:path';
import { readTable } from './sqldump.mjs';

const CELL = 100;
const MAX_SPAWNS_PER_ENTITY = 20000;

function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
  }
  if (!sxx) return null;
  const a = sxy / sxx;
  return { a, b: my - a * mx };
}

function robustFit(pairs) {
  let cur = pairs;
  let fx = null;
  let fy = null;
  for (let round = 0; round < 3 && cur.length >= 4; round++) {
    fx = fitLine(cur.map(p => p.wy), cur.map(p => p.qx));
    fy = fitLine(cur.map(p => p.wx), cur.map(p => p.qy));
    if (!fx || !fy) return null;
    const next = cur.filter(p => Math.abs(fx.a * p.wy + fx.b - p.qx) < 2.5 && Math.abs(fy.a * p.wx + fy.b - p.qy) < 2.5);
    if (next.length === cur.length) break;
    cur = next;
  }
  if (!fx || !fy || cur.length < 4 || fx.a >= 0 || fy.a >= 0) return null;
  return { a: fx.a, b: fx.b, c: fy.a, d: fy.b, n: cur.length };
}

function lootResolver(tables) {
  const memo = new Map();
  function resolve(rows, depth) {
    const out = new Map();
    const add = (item, p) => {
      if (p <= 0) return;
      const cur = out.get(item) || 0;
      out.set(item, 1 - (1 - cur) * (1 - Math.min(1, p)));
    };
    const groups = new Map();
    for (const r of rows) {
      if (r.group > 0) {
        if (!groups.has(r.group)) groups.set(r.group, []);
        groups.get(r.group).push(r);
        continue;
      }
      const p = Math.abs(r.chance) / 100;
      if (r.ref < 0) {
        if (depth > 4) continue;
        const rp = r.chance === 0 ? 1 : p;
        for (const [item, q] of ref(-r.ref, depth + 1)) add(item, rp * (1 - Math.pow(1 - q, Math.max(1, r.max))));
      } else add(r.item, p);
    }
    for (const g of groups.values()) {
      const explicit = g.filter(r => r.chance !== 0).reduce((s, r) => s + Math.abs(r.chance), 0);
      const zero = g.filter(r => r.chance === 0).length;
      const share = zero ? Math.max(0, 100 - explicit) / zero : 0;
      for (const r of g) {
        const p = (r.chance !== 0 ? Math.abs(r.chance) : share) / 100;
        if (r.ref < 0) {
          if (depth > 4) continue;
          for (const [item, q] of ref(-r.ref, depth + 1)) add(item, p * q);
        } else add(r.item, p);
      }
    }
    return out;
  }
  function ref(id, depth) {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, new Map());
    const res = resolve(tables.reference.get(id) || [], depth);
    memo.set(id, res);
    return res;
  }
  return (table, id) => resolve(table.get(id) || [], 0);
}

async function lootTable(file, table) {
  const map = new Map();
  await readTable(file, table, ['entry', 'item', 'ChanceOrQuestChance', 'groupid', 'mincountOrRef', 'maxcount'], r => {
    const e = Number(r[0]);
    if (!map.has(e)) map.set(e, []);
    map.get(e).push({ item: Number(r[1]), chance: Number(r[2] || 0), group: Number(r[3] || 0), ref: Number(r[4] || 1), max: Number(r[5] || 1) });
  });
  return map;
}

export async function augmentFromMopDb(dir, q) {
  const f = name => path.join(dir, `${name}.sql`);
  const stats = {};
  const ctpl = new Map();
  await readTable(f('creature_template'), 'creature_template', ['entry', 'name', 'subname', 'minlevel', 'maxlevel', 'faction_A', 'rank', 'skinloot', 'npcflag'], r => {
    ctpl.set(Number(r[0]), { name: r[1], sub: r[2] || null, min: Number(r[3] || 0), max: Number(r[4] || 0), faction: Number(r[5] || 0), rank: Number(r[6] || 0), skin: Number(r[7] || 0), flags: Number(r[8] || 0) });
  });
  const cspawn = new Map();
  await readTable(f('creature'), 'creature', ['id', 'map', 'position_x', 'position_y'], r => {
    const id = Number(r[0]);
    if (!cspawn.has(id)) cspawn.set(id, []);
    const list = cspawn.get(id);
    if (list.length < MAX_SPAWNS_PER_ENTITY) list.push([Number(r[1]), Number(r[2]), Number(r[3])]);
  });
  const gtpl = new Map();
  await readTable(f('gameobject_template'), 'gameobject_template', ['entry', 'type', 'name', 'data1'], r => {
    gtpl.set(Number(r[0]), { type: Number(r[1]), name: r[2], loot: Number(r[3] || 0) });
  });
  const gspawn = new Map();
  await readTable(f('gameobject'), 'gameobject', ['id', 'map', 'position_x', 'position_y'], r => {
    const id = Number(r[0]);
    if (!gspawn.has(id)) gspawn.set(id, []);
    const list = gspawn.get(id);
    if (list.length < MAX_SPAWNS_PER_ENTITY) list.push([Number(r[1]), Number(r[2]), Number(r[3])]);
  });
  stats.creatureTemplates = ctpl.size;
  stats.creaturesWithSpawns = cspawn.size;
  stats.objectTemplates = gtpl.size;
  stats.objectsWithSpawns = gspawn.size;

  const pairs = new Map();
  const labels = new Map();
  const addLabel = (map, wx, wy, zone) => {
    if (!labels.has(map)) labels.set(map, new Map());
    const key = `${Math.floor(wx / CELL)},${Math.floor(wy / CELL)}`;
    const grid = labels.get(map);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push([wx, wy, zone]);
  };
  const learn = (qSpawns, spawns) => {
    if (!qSpawns || typeof qSpawns !== 'object' || !spawns || !spawns.length) return;
    const zones = Object.entries(qSpawns).filter(([, pts]) => Array.isArray(pts) && pts.length);
    if (zones.length !== 1) return;
    const [zone, pts] = zones[0];
    const maps = new Set(spawns.map(s => s[0]));
    if (maps.size !== 1) return;
    for (const s of spawns) addLabel(s[0], s[1], s[2], Number(zone));
    if (pts.length === 1 && spawns.length === 1 && Array.isArray(pts[0])) {
      const z = Number(zone);
      if (!pairs.has(z)) pairs.set(z, []);
      pairs.get(z).push({ map: spawns[0][0], wx: spawns[0][1], wy: spawns[0][2], qx: pts[0][0], qy: pts[0][1] });
    }
  };
  for (const [id, row] of Object.entries(q.npcs)) if (Array.isArray(row)) learn(row[6], cspawn.get(Number(id)));
  for (const [id, row] of Object.entries(q.objects)) if (Array.isArray(row)) learn(row[3], gspawn.get(Number(id)));

  const transforms = new Map();
  for (const [zone, list] of pairs) {
    const byMap = new Map();
    for (const p of list) byMap.set(p.map, (byMap.get(p.map) || 0) + 1);
    const map = [...byMap.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const fit = robustFit(list.filter(p => p.map === map));
    if (fit) transforms.set(zone, { map, ...fit });
  }
  stats.zoneTransforms = transforms.size;

  const zoneAt = (map, wx, wy) => {
    const grid = labels.get(map);
    if (!grid) return null;
    const cx = Math.floor(wx / CELL);
    const cy = Math.floor(wy / CELL);
    const near = [];
    for (let r = 0; r <= 3 && near.length < 5; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const p of grid.get(`${cx + dx},${cy + dy}`) || []) near.push([Math.hypot(p[0] - wx, p[1] - wy), p[2]]);
        }
      }
    }
    if (!near.length) return null;
    near.sort((a, b) => a[0] - b[0]);
    const votes = new Map();
    for (const [, z] of near.slice(0, 5)) if (transforms.has(z)) votes.set(z, (votes.get(z) || 0) + 1);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  };
  const convert = spawns => {
    const out = {};
    let n = 0;
    for (const [map, wx, wy] of spawns) {
      const zone = zoneAt(map, wx, wy);
      if (zone === null) continue;
      const t = transforms.get(zone);
      if (t.map !== map) continue;
      const x = t.a * wy + t.b;
      const y = t.c * wx + t.d;
      if (x < 0 || x > 100 || y < 0 || y > 100) continue;
      if (!out[zone]) out[zone] = [];
      out[zone].push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      n++;
    }
    return n ? out : null;
  };
  const mainZone = sp => Object.entries(sp).sort((a, b) => b[1].length - a[1].length)[0][0];

  const factionVotes = new Map();
  for (const [id, row] of Object.entries(q.npcs)) {
    const t = ctpl.get(Number(id));
    if (!Array.isArray(row) || !t || !t.faction) continue;
    const key = t.faction;
    if (!factionVotes.has(key)) factionVotes.set(key, new Map());
    const v = row[12] || 'none';
    factionVotes.get(key).set(v, (factionVotes.get(key).get(v) || 0) + 1);
  }
  const friendly = fac => {
    const v = factionVotes.get(fac);
    if (!v) return undefined;
    const best = [...v.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return best === 'none' ? null : best;
  };

  const pointCount = sp => (sp && typeof sp === 'object' ? Object.values(sp).reduce((n, p) => n + (Array.isArray(p) ? p.length : 0), 0) : 0);
  const converted = new Map();
  const convertOnce = (key, sp) => {
    if (!converted.has(key)) converted.set(key, sp ? convert(sp) : null);
    return converted.get(key);
  };
  const ensureNpc = id => {
    const row = q.npcs[id];
    const have = Array.isArray(row) ? pointCount(row[6]) : 0;
    const t = ctpl.get(id);
    const sp = cspawn.get(id);
    if (have >= 5 || (have && (!sp || sp.length <= have * 2))) return true;
    if (!t || !sp) return have > 0;
    const spawns = convertOnce('n' + id, sp);
    if (!spawns || pointCount(spawns) <= have) return have > 0;
    if (Array.isArray(row) && have) {
      row[6] = spawns;
      stats.npcsMoreSpawns = (stats.npcsMoreSpawns || 0) + 1;
      return true;
    }
    const fr = friendly(t.faction);
    q.npcs[id] = [t.name, null, null, t.min, t.max, t.rank, spawns, null, Number(mainZone(spawns)), null, null, null, fr === undefined ? 'unknown' : fr, t.sub, t.flags];
    stats.npcsAdded = (stats.npcsAdded || 0) + 1;
    return true;
  };
  const ensureObject = id => {
    const row = q.objects[id];
    const have = Array.isArray(row) ? pointCount(row[3]) : 0;
    const haveZones = Array.isArray(row) && row[3] && typeof row[3] === 'object' ? Object.keys(row[3]).length : 0;
    const t = gtpl.get(id);
    const sp = gspawn.get(id);
    if (have && (!sp || sp.length <= have * 2)) return true;
    if (!t || !sp) return have > 0;
    const spawns = convertOnce('o' + id, sp);
    if (!spawns || (pointCount(spawns) <= have && Object.keys(spawns).length <= haveZones)) return have > 0;
    if (Array.isArray(row) && have) {
      row[3] = spawns;
      stats.objectsMoreSpawns = (stats.objectsMoreSpawns || 0) + 1;
      return true;
    }
    q.objects[id] = [t.name, null, null, spawns, Number(mainZone(spawns))];
    stats.objectsAdded = (stats.objectsAdded || 0) + 1;
    return true;
  };
  const itemRow = id => {
    if (!Array.isArray(q.items[id])) {
      const row = new Array(14).fill(null);
      row[0] = '';
      q.items[id] = row;
      stats.itemsAdded = (stats.itemsAdded || 0) + 1;
    }
    return q.items[id];
  };
  const pushUnique = (row, k, v) => {
    if (!Array.isArray(row[k])) row[k] = [];
    if (row[k].includes(v)) return false;
    row[k].push(v);
    return true;
  };

  const reference = await lootTable(f('reference_loot_template'), 'reference_loot_template');
  const resolve = lootResolver({ reference });
  const goLoot = await lootTable(f('gameobject_loot_template'), 'gameobject_loot_template');
  const lootObjects = new Map();
  for (const [id, t] of gtpl) {
    if (t.type !== 3 || !t.loot || !gspawn.has(id)) continue;
    if (!lootObjects.has(t.loot)) lootObjects.set(t.loot, []);
    lootObjects.get(t.loot).push(id);
  }
  let objectLinks = 0;
  for (const [loot, objs] of lootObjects) {
    for (const [item, p] of resolve(goLoot, loot)) {
      if (p < 0.01) continue;
      for (const o of objs) {
        if (!ensureObject(o)) continue;
        if (pushUnique(itemRow(item), 2, o)) objectLinks++;
      }
    }
  }
  if (q.itemNames) {
    const byName = new Map();
    for (const [id, name] of Object.entries(q.itemNames)) if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), Number(id));
    let named = 0;
    for (const [id, t] of gtpl) {
      if ((t.type !== 3 && t.type !== 1) || !gspawn.has(id) || !t.name) continue;
      if (t.loot > 0 && goLoot.has(t.loot)) continue;
      const base = t.name.replace(/^(rich|small|large|huge|pure|ancient|giant)\s+/i, '').trim();
      const ore = base.replace(/\s+(deposit|vein|lode|seam)$/i, '').trim();
      const targets = [];
      if (byName.has(base.toLowerCase())) targets.push(byName.get(base.toLowerCase()));
      if (ore !== base) {
        for (const cand of [`${ore} ore`, ore, `white ${ore} ore`, `black ${ore} ore`]) if (byName.has(cand.toLowerCase())) targets.push(byName.get(cand.toLowerCase()));
      }
      if (!targets.length || !ensureObject(id)) continue;
      for (const item of new Set(targets)) if (pushUnique(itemRow(item), 2, id)) named++;
    }
    stats.nameLinkedNodes = named;
  }
  stats.objectItemLinks = objectLinks;

  const vendorCosts = {};
  let vendorLinks = 0;
  await readTable(f('npc_vendor'), 'npc_vendor', ['entry', 'item', 'ExtendedCost', 'type'], r => {
    const npc = Number(r[0]);
    const item = Number(r[1]);
    const ext = Number(r[2] || 0);
    if (Number(r[3] || 1) !== 1 || item <= 0) return;
    if (ext > 0) {
      if (!vendorCosts[item]) vendorCosts[item] = [];
      if (!vendorCosts[item].includes(ext)) vendorCosts[item].push(ext);
    }
    if (!ensureNpc(npc)) return;
    if (pushUnique(itemRow(item), 13, npc)) vendorLinks++;
  });
  stats.vendorLinks = vendorLinks;
  stats.vendorCostItems = Object.keys(vendorCosts).length;

  const skinLoot = await lootTable(f('skinning_loot_template'), 'skinning_loot_template');
  const skinBy = new Map();
  for (const [id, t] of ctpl) {
    if (!t.skin || !skinLoot.has(t.skin)) continue;
    if (!skinBy.has(t.skin)) skinBy.set(t.skin, []);
    skinBy.get(t.skin).push(id);
  }
  const skin = {};
  for (const [loot, creatures] of skinBy) {
    for (const [item, p] of resolve(skinLoot, loot)) {
      if (p < 0.01) continue;
      for (const c of creatures) {
        if (!ensureNpc(c)) continue;
        if (!skin[item]) skin[item] = [];
        skin[item].push([c, Math.round(p * 10000) / 100]);
      }
    }
  }
  for (const list of Object.values(skin)) list.sort((a, b) => b[1] - a[1]);
  stats.skinnedItems = Object.keys(skin).length;

  const trainers = {};
  await readTable(f('npc_trainer'), 'npc_trainer', ['entry', 'spell', 'spellcost', 'reqskill', 'reqskillvalue', 'reqlevel'], r => {
    const spell = Number(r[1]);
    if (spell <= 0) return;
    const cost = Number(r[2] || 0);
    const cur = trainers[spell];
    if (!cur || cost < cur[0]) trainers[spell] = [cost, Number(r[4] || 0), Number(r[3] || 0)];
  });
  stats.trainerSpells = Object.keys(trainers).length;

  return { ensureNpc, skin, trainers, vendorCosts, stats };
}

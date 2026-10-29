import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

const args = process.argv.slice(2);
const outFile = args.shift();
if (!outFile || !args.length) {
  console.error('Usage: node tools/build-drop-rates.mjs <out.json> <tag>=<dump.sql.gz or folder of .sql> ...');
  console.error('Earlier sources win. Example: cata=mangosthree/World/Setup/FullDB wotlk=WoTLKDB.sql.gz tbc=TBCDB.sql.gz classic=ClassicDB.sql.gz');
  process.exit(1);
}

const TABLES = new Set(['creature_template', 'creature_loot_template', 'reference_loot_template']);
const MAX_PER_ITEM = 25;
const MIN_CHANCE = 0.005;

function parseTuples(text, onRow) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text[i] !== '(') {
      if (text[i] === ';') return true;
      i++;
    }
    if (i >= n) return false;
    i++;
    const row = [];
    let field = '';
    let inStr = false;
    let wasStr = false;
    for (; i < n; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') {
          field += text[i + 1];
          i++;
        } else if (c === "'") {
          if (text[i + 1] === "'") {
            field += "'";
            i++;
          } else inStr = false;
        } else field += c;
      } else if (c === "'") {
        inStr = true;
        wasStr = true;
      } else if (c === ',' || c === ')') {
        const f = field.trim();
        row.push(wasStr ? field : f === 'NULL' ? null : f);
        field = '';
        wasStr = false;
        if (c === ')') {
          i++;
          break;
        }
      } else field += c;
    }
    onRow(row);
  }
  return false;
}

async function readSource(src) {
  const files = [];
  if (src.endsWith('.gz') || src.endsWith('.sql')) files.push(src);
  else for (const t of TABLES) files.push(path.join(src, `${t}.sql`));
  const columns = {};
  const data = { creature_template: [], creature_loot_template: [], reference_loot_template: [] };
  for (const file of files) {
    let stream = createReadStream(file);
    if (file.endsWith('.gz')) stream = stream.pipe(createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let createFor = null;
    let current = null;
    let cols = null;
    for await (const line of rl) {
      if (createFor) {
        const m = /^\s*`([^`]+)`/.exec(line);
        if (m) columns[createFor].push(m[1]);
        else if (/^\)/.test(line)) createFor = null;
        continue;
      }
      const ct = /^CREATE TABLE `([^`]+)`/.exec(line);
      if (ct && TABLES.has(ct[1])) {
        createFor = ct[1];
        columns[createFor] = [];
        continue;
      }
      let rest = null;
      if (!current) {
        const ins = /^INSERT\s+INTO\s+`([^`]+)`\s*(\(([^)]*)\))?\s*VALUES\s*(.*)$/i.exec(line);
        if (!ins || !TABLES.has(ins[1])) continue;
        current = ins[1];
        cols = ins[3] ? ins[3].split(',').map(c => c.trim().replace(/`/g, '')) : columns[current];
        rest = ins[4];
      } else rest = line;
      const table = current;
      const colList = cols;
      const ended = parseTuples(rest, row => {
        const obj = {};
        colList.forEach((c, k) => { obj[c.toLowerCase()] = row[k]; });
        data[table].push(obj);
      });
      if (ended || /;\s*$/.test(rest)) current = null;
    }
  }
  return data;
}

function buildDrops(data) {
  const lootOf = new Map();
  for (const c of data.creature_template) {
    const entry = Number(c.entry);
    const loot = Number(c.lootid || 0);
    if (loot) lootOf.set(entry, loot);
  }
  const group = rows => {
    const map = new Map();
    for (const r of rows) {
      const e = Number(r.entry);
      if (!map.has(e)) map.set(e, []);
      map.get(e).push({
        item: Number(r.item),
        chance: Number(r.chanceorquestchance || 0),
        group: Number(r.groupid || 0),
        ref: Number(r.mincountorref || 1),
        max: Number(r.maxcount || 1)
      });
    }
    return map;
  };
  const creatureLoot = group(data.creature_loot_template);
  const refLoot = group(data.reference_loot_template);
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
        const sub = resolveRef(-r.ref, depth + 1);
        const rolls = Math.max(1, r.max);
        const rp = r.chance === 0 ? 1 : p;
        for (const [item, q] of sub) add(item, rp * (1 - Math.pow(1 - q, rolls)));
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
          for (const [item, q] of resolveRef(-r.ref, depth + 1)) add(item, p * q);
        } else add(r.item, p);
      }
    }
    return out;
  }

  function resolveRef(id, depth) {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, new Map());
    const res = resolve(refLoot.get(id) || [], depth);
    memo.set(id, res);
    return res;
  }

  const byItem = new Map();
  for (const [npc, loot] of lootOf) {
    const rows = creatureLoot.get(loot);
    if (!rows) continue;
    for (const [item, p] of resolve(rows, 0)) {
      const pct = p * 100;
      if (pct < MIN_CHANCE) continue;
      if (!byItem.has(item)) byItem.set(item, []);
      byItem.get(item).push([npc, Math.round(pct * 1000) / 1000]);
    }
  }
  return byItem;
}

const result = {};
const stats = {};
for (const spec of args) {
  const eq = spec.indexOf('=');
  const tag = spec.slice(0, eq);
  const src = spec.slice(eq + 1);
  const t0 = Date.now();
  const data = await readSource(src);
  const byItem = buildDrops(data);
  let added = 0;
  for (const [item, list] of byItem) {
    if (result[item]) continue;
    list.sort((a, b) => b[1] - a[1]);
    result[item] = { s: tag, n: list.length, d: list.slice(0, MAX_PER_ITEM) };
    added++;
  }
  stats[tag] = { creatures: data.creature_template.length, lootRows: data.creature_loot_template.length, refRows: data.reference_loot_template.length, itemsWithDrops: byItem.size, itemsAdded: added, seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(tag, JSON.stringify(stats[tag]));
}
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify({ built: new Date().toISOString(), stats, items: result }));
console.log('items', Object.keys(result).length);

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const outFile = process.argv[2] || 'static/mop-classic-recipes.json';
const logFile = process.argv[3] || 'static/recipes-build-log.json';
const vendorListFile = process.argv[4] || 'static/vendor-items.json';
const catalogFile = process.argv[5] || 'static/mop-classic-items.json';
const extCostFile = process.argv[6] || 'static/vendor-extended-costs.json';
const currencyFile = process.argv[7] || 'static/currency-items.json';
const JUNK = /deprecated|^old|\(old\)|^test|\btest\b|^zz|\[ph\]|^ph |^monster -|unused|^qa /i;
const BASE = process.env.WAGO_BASE || 'https://wago.tools';
const PRODUCT_HINTS = (process.env.WAGO_PRODUCTS || 'wow_classic,wow_classic_ptr,wow_classic_beta').split(',');
const VERSION_PREFIX = process.env.WAGO_VERSION_PREFIX || '5.';
const log = { started: new Date().toISOString(), steps: [] };
const step = (name, info) => {
  log.steps.push({ name, ...info });
  console.log(name, JSON.stringify(info));
};

const wait = ms => new Promise(r => setTimeout(r, ms));

async function get(url, type) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'wowplanner-recipe-builder (github.com/ianmcgo/wowplanner)' } });
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

export function parseCsv(text) {
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
  const products = Object.keys(builds);
  step('products', { products: products.filter(p => p.includes('classic')) });
  for (const p of PRODUCT_HINTS) {
    const list = builds[p];
    if (!Array.isArray(list)) continue;
    const match = list.find(b => String(b.version || b).startsWith(VERSION_PREFIX));
    if (match) return { product: p, version: String(match.version || match) };
  }
  for (const p of products) {
    const list = builds[p];
    if (!Array.isArray(list)) continue;
    const match = list.find(b => String(b.version || b).startsWith(VERSION_PREFIX));
    if (match) return { product: p, version: String(match.version || match) };
  }
  throw new Error(`No build starting with ${VERSION_PREFIX}`);
}

async function table(name, build) {
  const text = await get(`${BASE}/db2/${name}/csv?build=${encodeURIComponent(build)}`, 'text');
  const rows = parseCsv(text);
  step(`table ${name}`, { rows: rows.length, columns: rows[0] ? Object.keys(rows[0]).slice(0, 30) : [] });
  return rows;
}

const col = (row, ...names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== '') return row[n];
  return undefined;
};

async function main() {
  const { product, version } = await pickBuild();
  step('build', { product, version });
  const skillLines = await table('SkillLine', version);
  const abilities = await table('SkillLineAbility', version);
  const effects = await table('SpellEffect', version);
  const reagents = await table('SpellReagents', version);
  const spellNames = await table('SpellName', version);
  const items = await table('ItemSparse', version);
  const itemBase = await table('Item', version);
  let itemEffects = null;
  let itemXEffects = null;
  try {
    itemEffects = await table('ItemEffect', version);
  } catch (err) {
    step('ItemEffect failed', { error: String(err.message || err) });
  }
  try {
    itemXEffects = await table('ItemXItemEffect', version);
  } catch (err) {
    step('ItemXItemEffect not available', { error: String(err.message || err).slice(0, 120) });
  }
  let extCosts = null;
  let currencyTypes = null;
  try {
    extCosts = await table('ItemExtendedCost', version);
    currencyTypes = await table('CurrencyTypes', version);
  } catch (err) {
    step('currency tables failed', { error: String(err.message || err) });
  }

  const PROFESSIONS = new Set([164, 165, 171, 182, 185, 186, 197, 202, 333, 393, 755, 773, 129, 356]);
  const lineName = new Map();
  for (const s of skillLines) lineName.set(Number(s.ID), col(s, 'DisplayName_lang', 'DisplayName'));
  const parentLine = new Map();
  for (const s of skillLines) {
    const parent = Number(col(s, 'ParentSkillLineID') || 0);
    if (parent) parentLine.set(Number(s.ID), parent);
  }
  const professionOf = id => {
    let cur = id;
    for (let k = 0; k < 4 && !PROFESSIONS.has(cur) && parentLine.has(cur); k++) cur = parentLine.get(cur);
    return PROFESSIONS.has(cur) ? cur : null;
  };

  const spellSkill = new Map();
  for (const a of abilities) {
    const line = professionOf(Number(col(a, 'SkillLine')));
    if (!line) continue;
    const spell = Number(col(a, 'Spell'));
    const min = Number(col(a, 'MinSkillLineRank', 'MinSkillLineRank_0') || 0);
    if (!spellSkill.has(spell)) spellSkill.set(spell, { line, min });
  }
  step('profession spells', { count: spellSkill.size });

  const creates = new Map();
  for (const e of effects) {
    if (Number(col(e, 'Effect')) !== 24) continue;
    const spell = Number(col(e, 'SpellID'));
    if (!spellSkill.has(spell)) continue;
    const item = Number(col(e, 'EffectItemType'));
    if (!item) continue;
    const base = Math.round(Number(col(e, 'EffectBasePoints', 'EffectBasePointsF') || 0));
    const qty = Math.max(1, base || 1);
    if (!creates.has(spell)) creates.set(spell, { item, qty });
  }
  step('create item spells', { count: creates.size });

  const mats = new Map();
  for (const r of reagents) {
    const spell = Number(col(r, 'SpellID'));
    if (!creates.has(spell)) continue;
    const list = [];
    for (let k = 0; k < 8; k++) {
      const id = Number(col(r, `Reagent_${k}`, `Reagent[${k}]`, `Reagent${k}`) || 0);
      const n = Number(col(r, `ReagentCount_${k}`, `ReagentCount[${k}]`, `ReagentCount${k}`) || 0);
      if (id > 0 && n > 0) list.push([id, n]);
    }
    if (list.length) mats.set(spell, list);
  }
  step('spells with reagents', { count: mats.size });

  const itemName = new Map();
  const itemRow = new Map();
  for (const it of items) {
    itemName.set(Number(it.ID), col(it, 'Display_lang', 'Display'));
    itemRow.set(Number(it.ID), it);
  }
  step('price columns', { columns: items[0] ? Object.keys(items[0]).filter(c => /price|stack|vendor/i.test(c)) : [] });
  const spellName = new Map();
  for (const s of spellNames) spellName.set(Number(s.ID), col(s, 'Name_lang', 'Name'));

  const recipes = {};
  const names = {};
  for (const [spell, made] of creates) {
    const r = mats.get(spell);
    if (!r) continue;
    const sk = spellSkill.get(spell);
    const entry = { p: lineName.get(sk.line) || `Skill ${sk.line}`, skill: sk.min, q: made.qty, r, spell, sn: spellName.get(spell) || null };
    const cur = recipes[made.item];
    if (!cur || entry.skill < cur.skill) recipes[made.item] = entry;
    for (const id of [made.item, ...r.map(x => x[0])]) {
      const n = itemName.get(id);
      if (n && !names[id]) names[id] = n;
    }
  }
  const learns = new Map();
  for (const e of effects) {
    if (Number(col(e, 'Effect')) !== 36) continue;
    const trig = Number(col(e, 'EffectTriggerSpell', 'EffectTriggerSpell_0') || 0);
    if (trig) learns.set(Number(col(e, 'SpellID')), trig);
  }
  const spellCrafts = new Map();
  for (const [spell, made] of creates) if (mats.has(spell)) spellCrafts.set(spell, made.item);
  const teach = {};
  if (itemEffects) {
    const effectSpell = new Map();
    const itemSpells = new Map();
    for (const e of itemEffects) {
      const spell = Number(col(e, 'SpellID') || 0);
      effectSpell.set(Number(e.ID), spell);
      const parent = Number(col(e, 'ParentItemID') || 0);
      if (parent && spell) {
        if (!itemSpells.has(parent)) itemSpells.set(parent, []);
        itemSpells.get(parent).push(spell);
      }
    }
    if (itemXEffects) {
      for (const x of itemXEffects) {
        const item = Number(col(x, 'ItemID') || 0);
        const spell = effectSpell.get(Number(col(x, 'ItemEffectID') || 0));
        if (!item || !spell) continue;
        if (!itemSpells.has(item)) itemSpells.set(item, []);
        itemSpells.get(item).push(spell);
      }
    }
    for (const [item, spells] of itemSpells) {
      for (const sp of spells) {
        const target = spellCrafts.has(sp) ? sp : learns.has(sp) && spellCrafts.has(learns.get(sp)) ? learns.get(sp) : null;
        if (!target) continue;
        const crafted = spellCrafts.get(target);
        teach[item] = crafted;
        const r = recipes[crafted];
        if (r && r.spell === target && !r.by) r.by = item;
        const n = itemName.get(item);
        if (n && !names[item]) names[item] = n;
      }
    }
  }
  step('recipe items', { learnSpells: learns.size, teaches: Object.keys(teach).length, recipesWithItem: Object.values(recipes).filter(r => r.by).length, itemEffectColumns: itemEffects && itemEffects[0] ? Object.keys(itemEffects[0]) : [] });
  let vendorIds = [];
  try {
    vendorIds = JSON.parse(await readFile(vendorListFile, 'utf8'));
  } catch {
    vendorIds = [];
  }
  const wanted = new Set(vendorIds);
  for (const r of Object.values(recipes)) for (const [id] of r.r) wanted.add(id);
  const buy = {};
  for (const id of wanted) {
    const row = itemRow.get(id);
    if (!row) continue;
    const price = Number(col(row, 'BuyPrice') || 0);
    const stack = Number(col(row, 'VendorStackCount') || 1) || 1;
    if (price > 0) buy[id] = stack > 1 ? [price, stack] : price;
    const n = itemName.get(id);
    if (n && !names[id]) names[id] = n;
  }
  step('vendor prices', { wanted: wanted.size, priced: Object.keys(buy).length });
  const base = new Map();
  for (const it of itemBase) base.set(Number(it.ID), it);
  const catalog = {};
  for (const [id, row] of itemRow) {
    const name = itemName.get(id);
    if (!name || JUNK.test(name)) continue;
    const b = base.get(id) || {};
    const q = Number(col(row, 'OverallQualityID') || 0);
    const ilvl = Number(col(row, 'ItemLevel') || 0);
    const req = Number(col(row, 'RequiredLevel') || 0);
    const cls = Number(col(b, 'ClassID') ?? -1);
    const sub = Number(col(b, 'SubclassID') ?? 0);
    const inv = Number(col(row, 'InventoryType') ?? col(b, 'InventoryType') ?? 0);
    const allow = Number(col(row, 'AllowableClass') || -1);
    const bonding = Number(col(row, 'Bonding') || 0);
    const sell = Number(col(row, 'SellPrice') || 0);
    catalog[id] = [name, q, ilvl, req, cls, sub, inv, allow, bonding, sell];
  }
  const bondCounts = {};
  for (const c of Object.values(catalog)) bondCounts[c[8]] = (bondCounts[c[8]] || 0) + 1;
  step('catalog', { bonding: bondCounts, noSell: Object.values(catalog).filter(c => !c[9]).length, items: Object.keys(catalog).length, itemColumns: itemBase[0] ? Object.keys(itemBase[0]).slice(0, 20) : [], sparseSample: itemRow.get(2589) ? { OverallQualityID: col(itemRow.get(2589), 'OverallQualityID'), ItemLevel: col(itemRow.get(2589), 'ItemLevel'), InventoryType: col(itemRow.get(2589), 'InventoryType'), AllowableClass: col(itemRow.get(2589), 'AllowableClass') } : null });
  await mkdir(path.dirname(catalogFile), { recursive: true });
  await writeFile(catalogFile, JSON.stringify({ v: 1, built: new Date().toISOString(), source: `wago.tools ${product} ${version}`, fields: ['name', 'quality', 'itemLevel', 'requiredLevel', 'classId', 'subclassId', 'inventoryType', 'allowableClassMask', 'bonding', 'sellPrice'], items: catalog }));
  if (extCosts && currencyTypes) {
    let vendorCosts = {};
    try {
      vendorCosts = JSON.parse(await readFile(extCostFile, 'utf8'));
    } catch {
      vendorCosts = {};
    }
    const cur = new Map();
    for (const c of currencyTypes) cur.set(Number(c.ID), { name: col(c, 'Name_lang', 'Name'), flags: Number(col(c, 'Flags', 'Flags_0') || 0) });
    const costs = new Map();
    for (const e of extCosts) {
      const currencies = [];
      const itemsNeeded = [];
      for (let k = 0; k < 5; k++) {
        const cid = Number(col(e, `CurrencyID_${k}`, `CurrencyID[${k}]`, `CurrencyID${k}`) || 0);
        let cnt = Number(col(e, `CurrencyCount_${k}`, `CurrencyCount[${k}]`, `CurrencyCount${k}`) || 0);
        if (cid > 0 && cnt > 0) {
          const info = cur.get(cid);
          if (info && info.flags & 8) cnt = cnt / 100;
          currencies.push([cid, cnt]);
        }
        const iid = Number(col(e, `ItemID_${k}`, `ItemID[${k}]`, `ItemID${k}`) || 0);
        const icnt = Number(col(e, `ItemCount_${k}`, `ItemCount[${k}]`, `ItemCount${k}`) || 0);
        if (iid > 0 && icnt > 0) itemsNeeded.push([iid, icnt]);
      }
      if (currencies.length || itemsNeeded.length) costs.set(Number(e.ID), { c: currencies, i: itemsNeeded });
    }
    const curItems = {};
    const used = new Set();
    for (const [item, ids] of Object.entries(vendorCosts)) {
      const opts = ids.map(id => costs.get(id)).filter(Boolean);
      if (!opts.length) continue;
      curItems[item] = opts.map(o => [o.c, o.i]);
      for (const o of opts) for (const [cid] of o.c) used.add(cid);
    }
    const currencies = {};
    for (const cid of used) currencies[cid] = cur.get(cid) ? cur.get(cid).name : `Currency ${cid}`;
    const honorItems = Object.values(curItems).filter(o => o.some(([c]) => c.some(([cid]) => cid === 392))).length;
    step('currency items', { extCostColumns: extCosts[0] ? Object.keys(extCosts[0]) : [], currencyColumns: currencyTypes[0] ? Object.keys(currencyTypes[0]).slice(0, 12) : [], items: Object.keys(curItems).length, honorItems, currencies, sample: Object.entries(curItems).filter(([, o]) => o.some(([c]) => c.some(([cid]) => cid === 392))).slice(0, 5) });
    await writeFile(currencyFile, JSON.stringify({ v: 1, built: new Date().toISOString(), source: `wago.tools ${product} ${version} ItemExtendedCost and CurrencyTypes; vendor lists from the MaNGOS Four database (GPL-3.0)`, currencies, items: curItems }));
  }
  const out = { v: 1, built: new Date().toISOString(), source: `wago.tools ${product} ${version}`, recipes, names, buy, teach };
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(out));
  const byProf = {};
  for (const r of Object.values(recipes)) byProf[r.p] = (byProf[r.p] || 0) + 1;
  step('done', { recipes: Object.keys(recipes).length, byProfession: byProf });
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  try {
    await main();
    log.ok = true;
  } catch (err) {
    log.ok = false;
    log.error = String(err.stack || err.message);
    console.error(err);
  }
  log.finished = new Date().toISOString();
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, JSON.stringify(log, null, 1));
  if (!log.ok) process.exitCode = 1;
}

import http from 'node:http';

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

let round = 0;
let partial = false;

export function setPartial(v) {
  partial = v;
}

function makeAuctions(seed, count, mode) {
  const r = rng(seed);
  const out = [];
  const times = ['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'];
  for (let n = 0; n < count; n++) {
    const id = 100 + Math.floor(r() * 40);
    let q = mode === 'retail' ? 1 : 1 + Math.floor(r() * 20);
    const price = Math.floor(1000 + r() * 500000);
    const time = times[Math.floor(r() * 4)];
    if (round >= 2 && n % 5 === 0) continue;
    if (round >= 2 && mode === 'commodity' && n % 3 === 0 && q > 1) q = Math.floor(q / 2);
    const a = { id: 1000000 + n, item: { id }, quantity: q, time_left: time };
    if (mode === 'commodity') a.unit_price = price;
    else a.buyout = price * q;
    out.push(a);
  }
  return out;
}

export function startMock(port) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/token')) round++;
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    const ns = url.searchParams.get('namespace') || '';
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (p === '/token') return json({ access_token: 'test-token' });
    if (req.headers.authorization !== 'Bearer test-token') return json({ error: 'unauthorized' }, 401);
    const classic = ns.includes('classic');
    if (p === '/data/wow/connected-realm/index') {
      return json({
        connected_realms: [11, 12, 13].map(id => ({ href: `http://localhost:${port}/data/wow/connected-realm/${id}?namespace=${ns}` }))
      });
    }
    let m = /^\/data\/wow\/connected-realm\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      return json({ id, realms: [{ name: `Realm${id}A` }, { name: `Realm${id}B` }] });
    }
    m = /^\/data\/wow\/connected-realm\/(\d+)\/auctions\/index$/.exec(p);
    if (m) {
      if (!classic) return json({}, 404);
      return json({ auctions: [{ id: 2, name: 'Alliance Auction House' }, { id: 6, name: 'Horde Auction House' }] });
    }
    m = /^\/data\/wow\/connected-realm\/(\d+)\/auctions\/(\d+)$/.exec(p);
    if (m) return json({ auctions: makeAuctions(Number(m[1]) * 10 + Number(m[2]), 300, 'classic') });
    m = /^\/data\/wow\/connected-realm\/(\d+)\/auctions$/.exec(p);
    if (m) return json({ auctions: makeAuctions(Number(m[1]), partial ? 20 : 400, 'retail') });
    if (p === '/data/wow/auctions/commodities') return json({ auctions: makeAuctions(77, 800, 'commodity') });
    m = /^\/data\/wow\/item\/(\d+)$/.exec(p);
    if (m) {
      if (m[1] === '139') return json({}, 404);
      const id = Number(m[1]);
      const kinds = ['Herb', 'Metal & Stone', 'Leather', 'Cloth', null];
      const kind = kinds[id % 5];
      return json({
        id,
        name: `Test Item ${id}`,
        level: 60 + (id % 7),
        required_level: 55,
        item_class: kind ? { id: 7, name: 'Trade Goods' } : { id: 2, name: 'Weapon' },
        item_subclass: { id: kind ? 0 : 7, name: kind || 'Sword' },
        inventory_type: { type: kind ? 'NON_EQUIP' : 'WEAPON', name: kind ? 'Non-equippable' : 'One-Hand' },
        preview_item: {
          quality: { type: 'RARE', name: 'Rare' },
          level: { value: 60, display_string: 'Item Level 60' },
          binding: { type: 'ON_EQUIP', name: 'Binds when equipped' },
          inventory_type: { type: 'HEAD', name: 'Head' },
          item_subclass: { name: 'Plate' },
          weapon: kind ? undefined : { damage: { display_string: '10 - 20 Damage' }, attack_speed: { display_string: 'Speed 2.00' }, dps: { value: 7.5, display_string: '(7.5 damage per second)' } },
          armor: { value: 500, display: { display_string: '500 Armor', color: { r: 255, g: 255, b: 255, a: 1 } } },
          stats: [{ value: 10, display: { display_string: '+10 Strength', color: { r: 255, g: 255, b: 255, a: 1 } } }],
          spells: [{ description: 'Equip: Improves your chance to hit by 1%.', display_color: { r: 0, g: 255, b: 0, a: 1 } }],
          requirements: id % 10 === 4 ? { level: { value: 60, display_string: 'Requires Level 60' }, playable_classes: { links: [{ id: 1, name: 'Warrior' }, { id: 2, name: 'Paladin' }], display_string: 'Classes: Warrior, Paladin' } } : { level: { value: 60, display_string: 'Requires Level 60' } },
          sell_price: { value: 12345 },
          description: 'Forged in mock fire.'
        }
      });
    }
    m = /^\/data\/wow\/media\/item\/(\d+)$/.exec(p);
    if (m) {
      if (m[1] === '139') return json({}, 404);
      return json({ assets: [{ key: 'icon', value: `https://render.worldofwarcraft.com/us/icons/56/inv_test_${m[1]}.jpg` }] });
    }
    if (p === '/data/wow/profession/index') {
      if (classic) return json({}, 404);
      return json({ professions: [{ id: 171, name: 'Alchemy' }, { id: 164, name: 'Blacksmithing' }, { id: 182, name: 'Herbalism' }] });
    }
    m = /^\/data\/wow\/profession\/(\d+)$/.exec(p);
    if (m) {
      if (m[1] === '182') return json({ id: 182 });
      return json({ skill_tiers: [10, 11, 12, 13].map(id => ({ id, name: `Tier ${id}` })) });
    }
    m = /^\/data\/wow\/profession\/(\d+)\/skill-tier\/(\d+)$/.exec(p);
    if (m) {
      const base = Number(m[1]) * 1000 + Number(m[2]) * 10;
      return json({ categories: [{ name: 'Everything', recipes: [1, 2, 3, 9].map(k => ({ id: base + k, name: `Recipe ${base + k}` })) }] });
    }
    m = /^\/data\/wow\/recipe\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      if (id % 10 === 9) return json({ id, name: 'Enchant Something' });
      const crafted = 120 + (id % 15);
      return json({
        id,
        crafted_item: { id: crafted, name: `Test Item ${crafted}` },
        crafted_quantity: { value: 1 + (id % 2) },
        reagents: [
          { reagent: { id: 100 + (id % 10), name: `Test Item ${100 + (id % 10)}` }, quantity: 2 },
          { reagent: { id: 105 + (id % 7), name: `Test Item ${105 + (id % 7)}` }, quantity: 1 }
        ]
      });
    }
    if (p === '/data/wow/journal-expansion/index') {
      if (classic) return json({}, 404);
      return json({ tiers: [{ id: 1, name: 'Classic' }] });
    }
    if (p === '/data/wow/journal-expansion/1') {
      return json({ dungeons: [{ id: 5, name: 'Test Dungeon' }], raids: [{ id: 6, name: 'Test Raid' }] });
    }
    if (p === '/data/wow/journal-instance/5') return json({ encounters: [{ id: 50, name: 'Boss A' }, { id: 51, name: 'Boss B' }] });
    if (p === '/data/wow/journal-instance/6') return json({ encounters: [{ id: 60, name: 'Raid Boss' }] });
    m = /^\/data\/wow\/journal-encounter\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      const a = 125 + (id % 5);
      const b = 130 + (id % 5);
      return json({
        items: [
          { id: 1, item: { id: a, name: `Test Item ${a}` } },
          { id: 2, item: { id: b, name: `Test Item ${b}` } }
        ]
      });
    }
    return json({ error: 'not found' }, 404);
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

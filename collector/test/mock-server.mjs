import http from 'node:http';

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function makeAuctions(seed, count, mode) {
  const r = rng(seed);
  const out = [];
  const times = ['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'];
  for (let n = 0; n < count; n++) {
    const id = 100 + Math.floor(r() * 40);
    const q = mode === 'retail' ? 1 : 1 + Math.floor(r() * 20);
    const price = Math.floor(1000 + r() * 500000);
    const a = { id: n, item: { id }, quantity: q, time_left: times[Math.floor(r() * 4)] };
    if (mode === 'commodity') a.unit_price = price;
    else a.buyout = price * q;
    out.push(a);
  }
  return out;
}

export function startMock(port) {
  const server = http.createServer((req, res) => {
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
    if (m) return json({ auctions: makeAuctions(Number(m[1]), 400, 'retail') });
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
        item_class: kind ? { id: 7, name: 'Trade Goods' } : { id: 2, name: 'Weapon' },
        item_subclass: { id: 0, name: kind || 'Sword' }
      });
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

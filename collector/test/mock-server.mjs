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
      return json({ id: Number(m[1]), name: `Test Item ${m[1]}` });
    }
    return json({ error: 'not found' }, 404);
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

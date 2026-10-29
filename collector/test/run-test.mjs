import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, '..', 'collect.mjs');
const out = path.join(here, 'out');
const port = 4545;

rmSync(out, { recursive: true, force: true });
const server = await startMock(port);

function exec(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [collector], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function run(extra = {}) {
  const res = await exec({
    BLIZZARD_CLIENT_ID: 'id',
    BLIZZARD_CLIENT_SECRET: 'secret',
    API_BASE: `http://localhost:${port}`,
    OAUTH_URL: `http://localhost:${port}/token`,
    OUT_DIR: out,
    REGIONS: 'us',
    GAMES: 'retail,classic,classic1x',
    CONCURRENCY: '4',
    SALES_MIN_GAP: '0',
    ...extra
  });
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    throw new Error('collector exited with ' + res.status);
  }
  return res.stdout;
}

const readGz = f => JSON.parse(gunzipSync(readFileSync(f)).toString());

try {
  await run();
  const games =JSON.parse(readFileSync(path.join(out, 'games.json'), 'utf8'));
  assert.deepEqual(games.games.map(g => g.id).sort(), ['classic', 'classic1x', 'retail']);
  assert.deepEqual(games.games.find(g => g.id === 'retail').regions, ['us']);

  const realms = JSON.parse(readFileSync(path.join(out, 'retail', 'us', 'realms.json'), 'utf8'));
  assert.equal(realms.realms[0].id, 'commodities');
  assert.equal(realms.realms.length, 4);
  assert.equal(realms.realms[1].names.length, 2);

  const latest = readGz(path.join(out, 'retail', 'us', '11', 'latest.json.gz'));
  assert.ok(latest.items.length > 10);
  const item = latest.items[0];
  assert.ok(item.q >= item.n && item.m > 0 && item.l.length >= 1 && item.l.length <= 5);
  for (let i = 1; i < item.l.length; i++) assert.ok(item.l[i][1] >= item.l[i - 1][1]);

  const classicRealms = JSON.parse(readFileSync(path.join(out, 'classic', 'us', 'realms.json'), 'utf8'));
  assert.equal(classicRealms.realms[0].id, 'commodities');
  const classicLatest = readGz(path.join(out, 'classic1x', 'us', '12', 'latest.json.gz'));
  const houses = new Set(classicLatest.items.flatMap(e => e.l.map(l => l[3])));
  assert.ok(houses.has('alliance') && houses.has('horde'));

  const commodities = readGz(path.join(out, 'retail', 'us', 'commodities', 'latest.json.gz'));
  assert.ok(commodities.items.length > 10);

  const names = JSON.parse(readFileSync(path.join(out, 'retail', 'items.json'), 'utf8'));
  assert.equal(names['100'], 'Test Item 100');
  assert.equal(names['139'], null);

  const cats = JSON.parse(readFileSync(path.join(out, 'retail', 'cats.json'), 'utf8'));
  assert.equal(cats['100'], 'herb');
  assert.equal(cats['101'], 'ore');
  assert.equal(cats['102'], 'leather');
  assert.equal(cats['103'], 'cloth');
  assert.equal(cats['104'], 'other');
  assert.equal(cats['139'], null);

  const sources = readGz(path.join(out, 'retail', 'sources.json.gz'));
  assert.equal(Object.keys(sources.recipes).length, 24);
  assert.equal(Object.values(sources.recipes).filter(Boolean).length, 18);
  assert.ok(!('171101' in sources.recipes));
  const recipe = sources.recipes['171131'];
  assert.equal(recipe.p, 'Alchemy');
  assert.ok(recipe.i >= 120 && recipe.i <= 134 && recipe.r.length === 2 && recipe.q >= 1);
  assert.deepEqual(Object.keys(sources.drops).sort(), ['125', '126', '130', '131']);
  assert.equal(sources.drops['125'].length, 2);
  assert.equal(sources.pending, 0);
  assert.ok(!existsSync(path.join(out, 'classic', 'sources.json.gz')));

  const h1 = readGz(path.join(out, 'retail', 'us', '11', 'history.json.gz'));
  const k = Object.keys(h1.h)[0];
  assert.equal(h1.h[k].length, 1);

  const icons = JSON.parse(readFileSync(path.join(out, 'retail', 'icons.json'), 'utf8'));
  assert.equal(icons.base, 'https://render.worldofwarcraft.com/us/icons/56/');
  assert.equal(icons.icons['100'], 'inv_test_100');
  assert.equal(icons.icons['139'], null);

  const s1 = readGz(path.join(out, 'retail', 'us', '11', 'sales.json.gz'));
  assert.equal(s1.obs.length, 0);
  assert.ok(existsSync(path.join(out, 'retail', 'us', '11', 'state.bin.gz')));

  await new Promise(r => setTimeout(r, 1100));
  const second = await run({ GAMES: 'retail', MAX_REALMS: '1' });
  assert.ok(second.includes('sources are fresh'));

  const s2 = readGz(path.join(out, 'retail', 'us', '11', 'sales.json.gz'));
  assert.equal(s2.obs.length, 1);
  const soldItems = Object.keys(s2.h);
  assert.ok(soldItems.length > 5);
  const totalListings = Object.values(s2.h).reduce((s, pts) => s + pts[0][2], 0);
  assert.ok(totalListings > 10 && totalListings <= 80);

  const c2 = readGz(path.join(out, 'retail', 'us', 'commodities', 'sales.json.gz'));
  assert.equal(c2.obs.length, 1);
  const partial = Object.values(c2.h).reduce((s, pts) => s + pts[0][1], 0);
  assert.ok(partial > 0);
  const h2 = readGz(path.join(out, 'retail', 'us', '11', 'history.json.gz'));
  assert.equal(h2.h[k].length, 2);

  const games2 = JSON.parse(readFileSync(path.join(out, 'games.json'), 'utf8'));
  assert.deepEqual(games2.games.map(g => g.id), ['retail']);
  assert.ok(!existsSync(path.join(out, 'classic1x')));
  assert.ok(!existsSync(path.join(out, 'classic')));

  const bad = await exec({ BLIZZARD_CLIENT_ID: '', BLIZZARD_CLIENT_SECRET: '', OUT_DIR: out });
  assert.notEqual(bad.status, 0);

  console.log('ALL CHECKS PASSED');
} finally {
  server.close();
}

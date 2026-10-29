import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [cacheFile, outFile] = process.argv.slice(2);
if (!cacheFile || !outFile) {
  console.error('Usage: node tools/build-classic-sources.mjs "<path>/MoP Classic Cache.json" static/mop-classic-sources.json');
  process.exit(1);
}

const decode = s => s
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

const profession = label => (/^Way of the /.test(label) ? 'Cooking' : label);

function parseRecipe(html) {
  const skill = /Requires <a href="[^"]*skill=\d+[^"]*"[^>]*>([^<]+)<\/a>\s*\((\d+)\)/.exec(html);
  const made = /<br \/><span class="q\d"><a href="[^"]*item=(\d+)\/[^"]*">([^<]*)<\/a>/.exec(html);
  const reagentBlock = /whtt-reagents">([\s\S]*?)<\/div>/.exec(html);
  if (!skill || !made || !reagentBlock) return null;
  const reagents = [];
  const re = /<a href="[^"]*item=(\d+)\/[^"]*">([^<]*)<\/a>(?:\s*\((\d+)\))?/g;
  const names = { [made[1]]: decode(made[2]) };
  let m;
  while ((m = re.exec(reagentBlock[1]))) {
    reagents.push([Number(m[1]), m[3] ? Number(m[3]) : 1]);
    names[m[1]] = decode(m[2]);
  }
  if (!reagents.length) return null;
  return { p: profession(decode(skill[1])), skill: Number(skill[2]), i: Number(made[1]), r: reagents, names };
}

const items = JSON.parse(await readFile(cacheFile, 'utf8'));
const srcIndex = new Map();
const src = [];
const out = { v: 1, built: new Date().toISOString(), src, items: {}, boss: {}, craft: {}, recipes: {}, names: {} };

for (const item of items) {
  const ids = [];
  item.sourceTypes.forEach((type, k) => {
    const label = decode(item.sourceLabels[k] || '');
    const key = `${type}|${label}`;
    if (!srcIndex.has(key)) {
      srcIndex.set(key, src.length);
      src.push([type, label]);
    }
    ids.push(srcIndex.get(key));
    if (type === 'Crafted' && label && label !== 'Crafted') out.craft[item.itemId] = profession(label);
  });
  out.items[item.itemId] = ids;
  out.names[item.itemId] = decode(item.name);
  if (item.bossNames && item.bossNames.length) out.boss[item.itemId] = item.bossNames.map(decode);
  if (item.sourceTypes.includes('Recipe')) {
    const r = parseRecipe(item.tooltipHtml || '');
    if (r) {
      for (const [id, name] of Object.entries(r.names)) if (!out.names[id]) out.names[id] = name;
      const cur = out.recipes[r.i];
      if (!cur) out.recipes[r.i] = { p: r.p, skill: r.skill, r: r.r, by: item.itemId };
      if (!out.craft[r.i]) out.craft[r.i] = r.p;
    }
  }
}

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(out));
console.log('items', Object.keys(out.items).length, 'sources', src.length, 'crafted', Object.keys(out.craft).length, 'recipes', Object.keys(out.recipes).length);

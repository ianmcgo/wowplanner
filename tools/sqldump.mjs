import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';

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

export async function readTable(file, table, wanted, onRow) {
  let stream = createReadStream(file);
  if (file.endsWith('.gz')) stream = stream.pipe(createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let active = false;
  let idx = null;
  let count = 0;
  for await (const line of rl) {
    let rest;
    if (!active) {
      const ins = /^INSERT\s+INTO\s+`([^`]+)`\s*\(([^)]*)\)\s*VALUES\s*(.*)$/i.exec(line);
      if (!ins || ins[1] !== table) continue;
      const cols = ins[2].split(',').map(c => c.trim().replace(/`/g, '').toLowerCase());
      idx = wanted.map(w => cols.indexOf(w.toLowerCase()));
      active = true;
      rest = ins[3];
    } else rest = line;
    const ended = parseTuples(rest, row => {
      count++;
      onRow(idx.map(k => (k < 0 ? null : row[k])));
    });
    if (ended || /;\s*$/.test(rest)) active = false;
  }
  return count;
}

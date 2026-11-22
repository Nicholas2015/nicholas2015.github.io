// Walk the built site and report internal links that point at nothing.
// Usage: node scripts/check-links.mjs   (run after `npm run build`)
//
// Astro emits one HTML file per route plus redirect stubs, so a working link is
// either an exact file or a directory holding index.html. Everything else is
// reported together with the pages that reference it, so a dead link can be
// traced back to the post that carries it.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve('dist');
const ATTR = /(?:^|\s)(?:href|src)="([^"]*)"/g;

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith('.html')) yield full;
  }
}

const isFile = async (p) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

const toPosix = (p) => p.split(path.sep).join('/');

// target (relative to dist, no leading slash) -> pages that reference it
const refs = new Map();
let pages = 0;

for await (const file of htmlFiles(DIST)) {
  pages++;
  const html = await readFile(file, 'utf8');
  const page = toPosix(path.relative(DIST, file));

  for (const [, raw] of html.matchAll(ATTR)) {
    const url = raw.trim();
    if (!url || url.startsWith('#') || url.startsWith('?')) continue;
    // http:, https:, mailto:, tel:, data:, javascript: and protocol-relative.
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) continue;

    const bare = url.split('#')[0].split('?')[0];
    if (!bare) continue;

    let rel;
    try {
      rel = bare.startsWith('/')
        ? bare.slice(1)
        : toPosix(path.relative(DIST, path.join(path.dirname(file), bare)));
      rel = decodeURI(rel);
    } catch {
      continue; // Malformed escape; not something the site itself emits.
    }

    rel = rel.replace(/\/+$/, '') || 'index.html';
    if (rel.startsWith('../')) {
      // A relative link that climbs out of the site root; keep it as broken.
      rel = rel.replace(/^(\.\.\/)+/, '');
    }

    if (!refs.has(rel)) refs.set(rel, new Set());
    refs.get(rel).add(page);
  }
}

const broken = [];
for (const [rel, from] of refs) {
  const last = rel.split('/').pop() ?? '';
  const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(last);
  const candidates = looksLikeFile
    ? [path.join(DIST, rel)]
    : [path.join(DIST, rel, 'index.html'), path.join(DIST, rel)];

  let found = false;
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      found = true;
      break;
    }
  }
  if (!found) broken.push({ rel, from: [...from] });
}

console.log(`Scanned ${pages} pages, checked ${refs.size} internal targets.`);

if (!broken.length) {
  console.log('No broken internal links.');
  process.exit(0);
}

console.error(`\n${broken.length} broken:`);
for (const { rel, from } of broken.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.error(`  /${rel}`);
  for (const page of from.slice(0, 3)) console.error(`    from ${page}`);
  if (from.length > 3) console.error(`    and ${from.length - 3} more`);
}
process.exit(1);

// One-off migration: Hexo source/_posts/*.md -> src/content/blog/*.md
// Usage: node scripts/migrate-hexo.mjs <hexo-posts-dir>
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: node scripts/migrate-hexo.mjs <hexo-posts-dir>');
  process.exit(1);
}
const outDir = path.resolve('src/content/blog');
await mkdir(outDir, { recursive: true });

// Posts that are only a title in the Hexo source; keep them as drafts.
const DRAFTS = new Set(['design-pattern-observer', 'design-pattern-singleton']);

// Fold Hexo-era names into the categories and tags the newer posts use.
const CATEGORY_ALIAS = { JAVA基础: 'java', 测试: '随笔' };
const TAG_ALIAS = { database: 'mysql', test: null, AI: null };

const toList = (v) => {
  if (!v) return [];
  if (v.startsWith('[')) return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  return [v.trim()];
};

const quote = (s) => JSON.stringify(s);

for (const file of (await readdir(srcDir)).filter((f) => f.endsWith('.md'))) {
  const slug = file.replace(/\.md$/, '');
  const raw = (await readFile(path.join(srcDir, file), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`No frontmatter in ${file}`);

  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }

  // Hexo dates are local time (China); keep the offset explicit so URLs stay stable.
  const date = fm.date.replace(' ', 'T') + (fm.date.length === 16 ? ':00' : '') + '+08:00';

  // github.com/<user>/<repo>/tree/<branch>/<path> is an HTML page, not an image.
  let body = m[2]
    .replace(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/([^)\s]+\.(?:png|jpe?g|gif|webp|svg))/g,
      'https://raw.githubusercontent.com/$1/$2/$3/$4')
    .replace(/^\n+/, '');

  // Many posts open by repeating the title as a heading; the page already renders the title.
  const norm = (s) => s.replace(/[\s！!？?。.“”"（）()]/g, '').toLowerCase();
  const first = body.match(/^#{1,6}\s+(.+)\n+/);
  if (first) {
    const h = norm(first[1]);
    const t = norm(fm.title);
    if (h && (h === t || t.startsWith(h) || h.startsWith(t))) body = body.slice(first[0].length);
  }

  // Old posts start their outline at any level (#, ###, ####). The page renders the title
  // as <h1>, so shift each post so its shallowest heading becomes ##. Skip fenced code.
  const parts = body.split(/(^```[\s\S]*?^```)/m);
  const levels = parts
    .filter((_, i) => i % 2 === 0)
    .flatMap((p) => [...p.matchAll(/^(#{1,6})\s/gm)].map((x) => x[1].length));
  if (levels.length) {
    const shift = Math.min(...levels) - 2;
    body = parts
      .map((p, i) =>
        i % 2 === 1 ? p : p.replace(/^(#{1,6})(\s)/gm, (_, h, s) => '#'.repeat(Math.min(6, Math.max(2, h.length - shift))) + s),
      )
      .join('');
  }

  const out = [
    '---',
    `title: ${quote(fm.title)}`,
    `date: ${date}`,
    `category: ${quote(CATEGORY_ALIAS[toList(fm.categories)[0]] ?? toList(fm.categories)[0] ?? '未分类')}`,
    `tags: [${[...new Set(toList(fm.tags).map((t) => (t in TAG_ALIAS ? TAG_ALIAS[t] : t)).filter(Boolean))].map(quote).join(', ')}]`,
    ...(DRAFTS.has(slug) ? ['draft: true'] : []),
    '---',
    '',
    body,
  ].join('\n');

  await writeFile(path.join(outDir, file), out, 'utf8');
  console.log(`${DRAFTS.has(slug) ? 'draft ' : 'ok    '} ${slug}`);
}

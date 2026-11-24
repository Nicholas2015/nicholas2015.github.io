// Import plain Markdown articles (no frontmatter) into src/content/blog/YYYY/MM/.
// Usage: node scripts/import-articles.mjs <article-dir>
//
// Source layout: <dir>/<group>/<YYYY-MM-DD>-<name>.md, first line "# Title".
// The source files are only read, never modified.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: node scripts/import-articles.mjs <article-dir>');
  process.exit(1);
}
const outDir = path.resolve('src/content/blog');
await mkdir(outDir, { recursive: true });

// Category per source folder. `tech` is split by topic; first match wins.
// Names reuse the existing categories' spelling so URLs don't collide on case-insensitive disks.
const TECH_CATEGORIES = [
  [/Redis|Kafka|RabbitMQ|RocketMQ|Elasticsearch|ES(?=深分页|分页)|Nginx/i, '中间件'],
  [/MySQL|连接池|数据库/i, '数据库'],
  // Case-sensitive on purpose: /GC/i would match the "gC" in "SpringCloud".
  [/虚拟线程|JVM|GC|OOM|堆外|JDK|雪花|Maven|幂等/, 'java'],
  [/Spring|Gateway|Feign|Async|微服务|灰度/i, 'Spring'],
];
const GROUP_CATEGORY = { ai: 'AI' };

const TAGS = [
  [/Spring ?AI/i, 'spring-ai'],
  [/LangChain4j/i, 'langchain4j'],
  [/RAG|Embedding|向量|召回|切分|切块|检索|重排/i, 'rag'],
  [/MCP/, 'mcp'],
  [/Agent|智能体/i, 'agent'],
  [/Ollama/i, 'ollama'],
  [/Spring ?Boot/i, 'spring-boot'],
  [/Spring ?Cloud|Gateway|Feign|微服务|灰度/i, 'spring-cloud'],
  [/Redis/i, 'redis'],
  [/Kafka/i, 'kafka'],
  [/RabbitMQ/i, 'rabbitmq'],
  [/RocketMQ/i, 'rocketmq'],
  [/Elasticsearch|ES(?=深分页|分页)/, 'elasticsearch'],
  [/MySQL|连接池|Text2SQL/i, 'mysql'],
  [/Async/, 'spring-boot'],
  [/JVM|GC|OOM|堆外/, 'jvm'],
  [/雪花/, 'distributed-id'],
  [/幂等/, 'idempotency'],
  [/JDK/i, 'jdk'],
  [/虚拟线程/, 'virtual-thread'],
  [/Nginx/i, 'nginx'],
  [/Maven/i, 'maven'],
];

const quote = (s) => JSON.stringify(s);
const pad = (n) => String(n).padStart(2, '0');

// Posts sit in YYYY/MM/ folders; a name already used in any month counts as existing.
const existing = new Map(
  (await readdir(outDir, { recursive: true }))
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => [path.basename(f).toLowerCase(), f]),
);
const seenOut = new Set();
const perDay = new Map();
let count = 0;

for (const group of (await readdir(srcDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  const files = (await readdir(path.join(srcDir, group))).filter((f) => f.endsWith('.md')).sort();
  for (const file of files) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (!m) throw new Error(`Unexpected file name: ${group}/${file}`);
    const [, day, name] = m;

    const raw = (await readFile(path.join(srcDir, group, file), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
    if (raw.startsWith('---\n')) throw new Error(`Already has frontmatter: ${group}/${file}`);

    const h1 = raw.match(/^#\s+(.+)\n+/);
    if (!h1) throw new Error(`No "# Title" on first line: ${group}/${file}`);
    // Titles sometimes keep the file name's "_" separator; render it as a Chinese comma.
    const title = h1[1].trim().replace(/\s*_\s*/g, '，');

    // Drop the H1 (the page renders the title) and make sure a "---" rule is never read as a
    // setext heading for the paragraph above it.
    let inFence = false;
    const lines = raw.slice(h1[0].length).split('\n');
    const body = [];
    for (const line of lines) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (!inFence && /^---\s*$/.test(line) && body.length && body.at(-1).trim() !== '') body.push('');
      body.push(line);
    }

    const haystack = `${title} ${name}`;
    const category =
      GROUP_CATEGORY[group] ?? TECH_CATEGORIES.find(([re]) => re.test(haystack))?.[1] ?? 'java';
    // Tags never repeat the category; an AI post without a finer topic just has no tags.
    const tags = [...new Set(TAGS.filter(([re]) => re.test(haystack)).map(([, t]) => t))];

    // Same-day posts in one folder get a few minutes apart so their order is stable.
    const key = `${group}/${day}`;
    const n = perDay.get(key) ?? 0;
    perDay.set(key, n + 1);
    const base = group === 'ai' ? 20 * 60 : 9 * 60;
    const t = base + n * 30;
    const date = `${day}T${pad(Math.floor(t / 60))}:${pad(t % 60)}:00+08:00`;

    const outName = `${name}.md`;
    const lower = outName.toLowerCase();
    if (seenOut.has(lower)) throw new Error(`Two sources map to ${outName}`);
    seenOut.add(lower);

    const out = [
      '---',
      `title: ${quote(title)}`,
      `date: ${date}`,
      `category: ${quote(category)}`,
      `tags: [${tags.map(quote).join(', ')}]`,
      '---',
      '',
      body.join('\n').replace(/^\n+/, ''),
    ].join('\n');

    // An update rewrites the file where it is; a new post goes under its own YYYY/MM.
    const rel = existing.get(lower) ?? path.join(day.slice(0, 4), day.slice(5, 7), outName);
    await mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
    await writeFile(path.join(outDir, rel), out, 'utf8');
    console.log(`${existing.has(lower) ? 'update' : 'add   '} ${day} [${category}] ${title}  {${tags.join(', ')}}`);
    count++;
  }
}
console.log(`\n${count} articles written to ${path.relative(process.cwd(), outDir)}`);

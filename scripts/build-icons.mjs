// Generate every raster icon in public/ from the logo SVG.
// Usage: node scripts/build-icons.mjs
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';

const INK = '#30483d';
const CLAY = '#a77b51';
const PAPER = '#fbfbfc';

const svg = await readFile('public/logo.svg', 'utf8');
// The mark sits in a 1024 box with uneven margins (cloud top at 160, bars end at 856).
// Re-center it into a padded square so icons don't look off-balance.
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const tile = ({ bg, pad = 0.14, radius = 0 }) => {
  const box = 1024, s = (1 - pad * 2) * box / 884; // mark spans x 112..996 (884 wide)
  const tx = box / 2 - (112 + 884 / 2) * s, ty = box / 2 - (160 + 696 / 2) * s; // y 160..856
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${
    bg ? `<rect width="${box}" height="${box}" rx="${radius}" fill="${bg}"/>` : ''
  }<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${inner}</g></svg>`;
};

const png = (s, size, file) => sharp(Buffer.from(s)).resize(size, size).png({ compressionLevel: 9 }).toFile(file);

// Browser tab: a small paper tile behind the mark, so the dark green still reads on dark tab bars.
const favicon = tile({ bg: PAPER, pad: 0.08, radius: 200 });
await writeFile('public/favicon.svg', favicon);
await png(favicon, 32, 'public/favicon-32.png');
await png(favicon, 16, 'public/favicon-16.png');
await png(favicon, 200, 'public/favicon.png'); // kept at the old path and size for anything still linking it

// iOS home screen: opaque paper tile, iOS adds its own corner mask.
await png(tile({ bg: PAPER, pad: 0.16 }), 180, 'public/apple-touch-icon.png');

// PWA / Android: 192 and 512, plus a maskable 512 with the mark inside the safe zone.
await png(tile({ bg: PAPER, pad: 0.14, radius: 224 }), 192, 'public/icon-192.png');
await png(tile({ bg: PAPER, pad: 0.14, radius: 224 }), 512, 'public/icon-512.png');
await png(tile({ bg: PAPER, pad: 0.24 }), 512, 'public/icon-maskable-512.png');

// Social preview, 1200x630: mark on the left, name and line on the right, real text rendered as paths by the system font.
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <g transform="translate(96 155) scale(0.3125)">${tile({}).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>
  <text x="480" y="300" font-family="PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="96" font-weight="500" fill="#0e1116">白云阁</text>
  <text x="484" y="372" font-family="PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="32" fill="#464c55">会编程的吕洞宾的技术笔记</text>
  <text x="484" y="424" font-family="Geist, Segoe UI, Helvetica, Arial, sans-serif" font-size="26" fill="#6b717b">Spring AI · RAG · Kafka · Redis · 线上排查</text>
  <rect x="484" y="472" width="64" height="6" fill="${CLAY}"/>
</svg>`;
await sharp(Buffer.from(og)).png({ compressionLevel: 9 }).toFile('public/og.png');

await writeFile(
  'public/site.webmanifest',
  JSON.stringify(
    {
      name: '白云阁',
      short_name: '白云阁',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      theme_color: PAPER,
      background_color: PAPER,
      display: 'browser',
    },
    null,
    2,
  ) + '\n',
);

console.log('icons written to public/');

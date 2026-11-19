// Convert captured app screenshots into web images for the tools pages.
// Usage: node scripts/tool-images.mjs <capture-dir>
// Every shot exists in a light and a dark capture; the page swaps them with the site theme.
// Captures are taken at 2x, so the output width is twice the CSS display width.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('Usage: node scripts/tool-images.mjs <capture-dir>');

// Dialog shots were captured with 16 CSS px (32 image px) of the modal backdrop around them;
// `trim` cuts that ring off so only the dialog itself remains. `bottom: false` keeps the bottom edge
// when the capture was already cut short by a height limit.
const shots = {
  mopulse: { hero: { width: 2000 }, sync: { width: 1200, trim: 32 } },
  shipdock: { hero: { width: 2000 }, commands: { width: 1600 }, server: { width: 1120, trim: 32, bottom: false } },
};
const icons = {
  mopulse: 'D:/Develop/projects/react/MoPulse/build/icon.png',
  shipdock: 'D:/Develop/projects/dsh/shipdock/build/icon.png',
};

for (const [tool, list] of Object.entries(shots)) {
  const out = path.join('public', 'tools', tool);
  await mkdir(out, { recursive: true });
  for (const [name, opt] of Object.entries(list)) {
    for (const theme of ['light', 'dark']) {
      const file = path.join(out, `${name}-${theme}.webp`);
      let img = sharp(path.join(src, `${tool}-${name}-${theme}.png`));
      const { width: w, height: h } = await img.metadata();
      if (opt.trim) {
        const t = opt.trim;
        img = sharp(await img.extract({ left: t, top: t, width: w - t * 2, height: h - t - (opt.bottom === false ? 0 : t) }).toBuffer());
      }
      const { width: w2 } = await img.metadata();
      await img.resize({ width: Math.min(opt.width, w2) }).webp({ quality: 84 }).toFile(file);
      const m = await sharp(file).metadata();
      console.log('wrote', file, `${m.width}x${m.height}`);
    }
  }
  await sharp(icons[tool]).resize(256, 256).png({ compressionLevel: 9 }).toFile(path.join(out, 'icon.png'));
}

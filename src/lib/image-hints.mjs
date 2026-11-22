// Markdown images render as bare <img> tags, and posts carry up to twenty remote
// screenshots each, so without a hint the browser starts every one of them on load.
//
// Astro's default Markdown processor no longer runs rehype plugins, so this runs
// as a build hook instead: after the HTML is written, any <img> that did not set
// `loading` itself gets `loading="lazy" decoding="async"`. Components that decide
// for themselves (ThemedShot passes eager or lazy) already set it, so they are
// left untouched.
//
// A browser still loads a lazy image that is already on screen, so nothing in the
// first viewport is delayed.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HINT = ' loading="lazy" decoding="async"';

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith('.html')) yield full;
  }
}

export default function imageHints() {
  return {
    name: 'image-hints',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const root = fileURLToPath(dir);
        let touched = 0;

        for await (const file of htmlFiles(root)) {
          const html = await readFile(file, 'utf8');
          let changed = false;

          const next = html.replace(/<img\b([^>]*)>/g, (tag, attrs) => {
            if (/\bloading=/.test(attrs)) return tag;
            changed = true;
            // A trailing slash on a self-closing tag stays before the bracket.
            const body = attrs.replace(/\s*\/\s*$/, '');
            const slash = body === attrs ? '' : '/';
            return `<img${body}${HINT}${slash}>`;
          });

          if (changed) {
            await writeFile(file, next);
            touched++;
          }
        }

        if (touched) console.log(`image-hints: added lazy loading to ${touched} pages`);
      },
    },
  };
}

import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/[^_]*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    description: z.string().optional(),
    category: z.string().default('未分类'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const tools = defineCollection({
  loader: glob({ base: './src/content/tools', pattern: '**/[^_]*.{md,mdx}' }),
  schema: z.object({
    name: z.string(),
    // Chinese name shown beside the product name, e.g. 墨脉
    alias: z.string().optional(),
    tagline: z.string(),
    date: z.coerce.date(),
    version: z.string().optional(),
    // Square app icon under public/, e.g. /tools/mopulse/icon.png
    icon: z.string().optional(),
    // Screenshots are stored as `<base>-light.webp` and `<base>-dark.webp`; the page picks one per theme.
    // `hero` is the full window shown at the top and on the card.
    hero: z.object({ base: z.string(), alt: z.string(), width: z.number(), height: z.number() }).optional(),
    // Features with a shot get a row of their own; the rest sit in a compact grid.
    features: z
      .array(
        z.object({
          title: z.string(),
          body: z.string(),
          shot: z.object({ base: z.string(), alt: z.string(), width: z.number(), height: z.number() }).optional(),
        }),
      )
      .default([]),
    audience: z.string().optional(),
    status: z.enum(['stable', 'beta', 'wip']).default('stable'),
    platforms: z.array(z.enum(['web', 'windows', 'macos', 'linux', 'cli', 'android', 'ios'])).default([]),
    tags: z.array(z.string()).default([]),
    // Online demo: a full URL or a site path such as /tools/xxx/play/
    demo: z.string().optional(),
    repo: z.string().url().optional(),
    download: z.string().url().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog, tools };

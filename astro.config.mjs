// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://nicholas2015.github.io',
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      // Emit both themes as CSS variables; global.css picks one per color scheme.
      defaultColor: false,
      wrap: false,
    },
  },
  // Keep links from the old Hexo site working.
  redirects: {
    '/contact': '/about/',
    '/categories': '/tags/',
    '/page/2': '/archives/',
    '/archives/page/2': '/archives/',
    ...Object.fromEntries(
      ['2014', '2014/06', '2021', '2021/01', '2021/06', '2021/10', '2021/11', '2023', '2023/01', '2025', '2025/02']
        .map((p) => [`/archives/${p}`, `/archives/#y${p.slice(0, 4)}`]),
    ),
    // The Kafka post was republished in 2023; the 2021 URL pointed to the same article.
    '/2021/11/08/kafka-install': '/2023/01/25/kafka-install/',
  },
});

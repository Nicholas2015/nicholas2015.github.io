import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { render } from 'astro:content';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { SITE } from '../consts';
import { categoryLabel, excerpt, getPosts, postUrl, tagLabel } from '../lib/content';

export async function GET(context: APIContext) {
  // Full text, but only the newest ones: the whole archive would be ~13MB, and
  // feed readers fetch the file again every time they poll.
  const all = (await getPosts()).filter((p) => !p.data.draft);
  const posts = all.slice(0, 20);
  const site = context.site!;
  const self = new URL('/rss.xml', site).href;
  const container = await AstroContainer.create();

  const items = await Promise.all(
    posts.map(async (post) => {
      const { Content } = await render(post);
      // Links in the article are site-relative, so rewrite them for the feed.
      // Shiki puts a style attribute on every token, which alone doubles the
      // file size; readers show code as plain monospace without it.
      const content = (await container.renderToString(Content))
        .replace(/ style="[^"]*"/g, '')
        .replaceAll('href="/', `href="${site.origin}/`)
        .replaceAll('src="/', `src="${site.origin}/`);

      return {
        title: post.data.title,
        pubDate: post.data.date,
        description: post.data.description ?? excerpt(post.body, 200),
        content,
        // Category and tags can repeat (e.g. "AI" as both); feed readers show each one.
        categories: [...new Set([categoryLabel(post.data.category), ...post.data.tags.map(tagLabel)])],
        link: postUrl(post),
      };
    }),
  );

  return rss({
    title: SITE.title,
    description: `${SITE.author}的技术笔记。${SITE.description}`,
    site,
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    items,
    customData: `<language>zh-CN</language><atom:link href="${self}" rel="self" type="application/rss+xml"/>`,
  });
}

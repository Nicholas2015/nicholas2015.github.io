import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { SITE } from '../consts';
import { excerpt, getPosts, postUrl } from '../lib/content';

export async function GET(context: APIContext) {
  const posts = (await getPosts()).filter((p) => !p.data.draft);
  const self = new URL('/rss.xml', context.site).href;
  return rss({
    title: SITE.title,
    description: `${SITE.author}的技术笔记。${SITE.description}`,
    site: context.site!,
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description ?? excerpt(post.body, 200),
      // Category and tags can repeat (e.g. "AI" as both); feed readers show each one.
      categories: [...new Set([post.data.category, ...post.data.tags])],
      link: postUrl(post),
    })),
    customData: `<language>zh-CN</language><atom:link href="${self}" rel="self" type="application/rss+xml"/>`,
  });
}

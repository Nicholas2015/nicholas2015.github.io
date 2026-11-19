import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;
export type Tool = CollectionEntry<'tools'>;

// Drafts show up in `npm run dev` but are never built for production.
const visible = ({ data }: { data: { draft: boolean } }) => import.meta.env.DEV || !data.draft;

export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', visible);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export async function getTools(): Promise<Tool[]> {
  const tools = await getCollection('tools', visible);
  return tools.sort((a, b) => b.data.order - a.data.order || b.data.date.valueOf() - a.data.date.valueOf());
}

// Dates are rendered in China time so URLs match the old Hexo permalinks.
const ymd = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const formatDate = (date: Date) => ymd.format(date);

/** Hexo permalink format: :year/:month/:day/:title */
export function postPath(post: Post) {
  return `${formatDate(post.data.date).replaceAll('-', '/')}/${post.id}`;
}

export const postUrl = (post: Post) => `/${postPath(post)}/`;

export function excerpt(markdown = '', length = 120) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/[`*_>#|-]/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function countBy(values: string[]) {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
}

// Tags stay as ASCII slugs in front matter and URLs; readers see these names.
const TAG_LABEL: Record<string, string> = {
  rag: 'RAG',
  'spring-boot': 'Spring Boot',
  'spring-ai': 'Spring AI',
  'spring-cloud': 'Spring Cloud',
  langchain4j: 'LangChain4j',
  redis: 'Redis',
  mysql: 'MySQL',
  mcp: 'MCP',
  java: 'Java',
  kafka: 'Kafka',
  agent: 'Agent',
  elasticsearch: 'Elasticsearch',
  jvm: 'JVM',
  rabbitmq: 'RabbitMQ',
  rocketmq: 'RocketMQ',
  'virtual-thread': '虚拟线程',
  jdk: 'JDK',
  'distributed-id': '分布式 ID',
  idempotency: '接口幂等',
  nginx: 'Nginx',
  ollama: 'Ollama',
  git: 'Git',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  maven: 'Maven',
};

export const tagLabel = (tag: string) => TAG_LABEL[tag] ?? tag;

// Category slugs stay lowercase in front matter and URLs; readers see these names.
const CATEGORY_LABEL: Record<string, string> = {
  java: 'Java',
  ai: 'AI',
};

export const categoryLabel = (category: string) => CATEGORY_LABEL[category] ?? category;

export const STATUS_LABEL = { stable: '可用', beta: '测试中', wip: '开发中' } as const;

export const PLATFORM_LABEL = {
  web: '网页',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  cli: '命令行',
  android: 'Android',
  ios: 'iOS',
} as const;

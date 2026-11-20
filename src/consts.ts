export const SITE = {
  title: '白云阁',
  subtitle: '永不言弃',
  description: 'Stay hungry; Stay foolish!',
  author: '会编程的吕洞宾',
  github: 'https://github.com/Nicholas2015',
  // Lines the slogan types out under the subtitle, carried over from the Hexo theme.
  slogans: ['永不言弃', '从来没有真正的绝境，只有心灵的迷途', 'Never really desperate, only the lost of the soul'],
  // Email and QQ, base64-encoded JSON. Decoded in the browser only when a visitor clicks,
  // so neither appears as plain text in the source or the built HTML.
  contact: 'eyJlbWFpbCI6InN1bmN5X3NvZnR3YXJlQGhvdG1haWwuY29tIiwicXEiOiI3OTkzMjcyMTAifQ==',
};

// Vercount: posting a page view returns that page's counts in the same response,
// so the browser never has to read a separate endpoint (GoatCounter's counter
// endpoint sends no CORS header, which made it unusable from this static site).
export const STATS = {
  endpoint: 'https://events.vercount.one/api/v2/log',
};

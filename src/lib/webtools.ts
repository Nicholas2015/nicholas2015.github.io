// The in-browser tools. Kept as data so the tools index, the home page and the sitemap stay in sync.
export const WEB_TOOLS = [
  {
    slug: 'json',
    name: 'JSON 格式化',
    tagline: '格式化、压缩和校验 JSON，出错时指出具体行列',
  },
  {
    slug: 'yaml-properties',
    name: 'YAML ⇄ Properties',
    tagline: 'Spring 配置文件在 application.yml 和 application.properties 之间互转',
  },
  {
    slug: 'base64',
    name: 'Base64 编解码',
    tagline: '文本和图片的 Base64 编码、解码，支持 URL 安全格式',
  },
  {
    slug: 'jwt',
    name: 'JWT 解析',
    tagline: '查看 JWT 的 header 和 payload，输入密钥或公钥验证签名',
  },
  {
    slug: 'password',
    name: '密码生成',
    tagline: '按长度和字符类型生成随机密码，用浏览器的加密随机数',
  },
] as const;

export type WebToolSlug = (typeof WEB_TOOLS)[number]['slug'];

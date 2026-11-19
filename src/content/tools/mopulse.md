---
name: MoPulse
alias: 墨脉
tagline: 在一个编辑器里写完，一键存成各个平台的草稿
date: 2026-11-10
version: 0.2.0
status: beta
platforms: [windows, macos, linux]
tags: [写作, 多平台同步, AI]
icon: /tools/mopulse/icon.png
hero:
  base: /tools/mopulse/hero
  alt: 墨脉的编辑器，正在写一篇关于大模型 JSON 解析的文章
  width: 2000
  height: 1288
features:
  - title: 一个编辑器写完
    body: 代码高亮、表格、图片都支持，从别处粘贴进来格式不乱。输入 / 可以插入标题、列表和表格。
  - title: 一键存成各平台草稿
    body: 选好平台点同步，文章存进各平台的草稿箱，登录后台检查一遍再发布。目前接入 19 个平台，包括微信公众号、掘金、CSDN、知乎、博客园、简书，以及 DEV Community、Medium、Reddit。
    shot:
      base: /tools/mopulse/sync
      alt: 同步到平台对话框，列出 19 个可选平台
      width: 1200
      height: 1274
  - title: AI 写作辅助
    body: 选中文字可以润色、精简、扩写；标题太长时自动缩写到平台的字数限制内；摘要和标签可以自动生成。模型和 API Key 用你自己的。
  - title: 一键英文版
    body: 翻译成英文版同步到海外平台，代码块和链接原样保留。
  - title: 图片自动上传
    body: 发布时找出文章里的本地图片，上传到你配置的图床，再替换成线上地址。
  - title: 数据只在本机
    body: 文章存在本地数据库，平台账号和 API Key 存在系统钥匙串里，不经过任何第三方服务器。
audience: 自己写技术博客、同时在好几个平台发文章的人。只在一个平台写的话，平台自带的编辑器就够用了。
featured: true
order: 2
---

写技术文章最费时间的往往不是写，而是发：同一篇稿子要在公众号、掘金、CSDN、知乎之间来回复制，每个平台的编辑器都会把格式弄乱一点。墨脉把这件事收到一个桌面应用里。

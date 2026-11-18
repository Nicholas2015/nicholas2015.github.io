# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Developers arriving from search for one concrete how-to (Kafka/Elasticsearch cluster setup, Redis on Docker, Ollama/LM Studio local models); they read one article and leave.
- Potential users of the author's self-made desktop applications.
- The author, keeping notes for later reference.
- Interviewers and peers looking at the author's technical profile.

## Product Purpose

Personal Chinese-language technical blog plus a showcase for the author's desktop tools. Success: a search visitor finds the steps fast and can copy commands reliably; a tool visitor understands what a tool does and where to download it.

## Operating Context

Static site on GitHub Pages (nicholas2015.github.io), built with Astro from Markdown/MDX. Articles are long step-by-step guides with many shell/config code blocks and full-width screenshots (often hosted on raw.githubusercontent.com). Tools are desktop applications (Windows/macOS), so tool pages center on screenshots, a download link, and source links, not in-browser demos.

## Capabilities and Constraints

- Content collections `blog` and `tools`; Hexo-era URLs `/:year/:month/:day/:slug/` must keep working.
- Readers are Chinese; type must render CJK well with system fonts (no large web-font downloads required).
- Dark and light themes both supported.
- Undecided: how many tools exist and their names; real screenshots of tools are not yet available.

## Brand Commitments

- Site name: 白云阁 (subtitle 永不言弃).
- Author name: 会编程的吕洞宾.
- Motto: Stay hungry; Stay foolish!
- The user allows all three to be reworked in presentation.

## Evidence on Hand

- 14 published articles in `src/content/blog/` (2014–2025), 2 empty drafts.
- One example tool entry (timestamp converter, draft); no real tool content, screenshots, download counts, or testimonials exist. Do not fabricate them.

## Product Principles

1. Articles are read to get something working: commands and screenshots must be easy to scan and copy.
2. Tools get presented as real software with a clear download path, not as blog posts.
3. One site, one identity: posts and tools share the same world.
4. Fast and light on GitHub Pages; no heavy client JS.

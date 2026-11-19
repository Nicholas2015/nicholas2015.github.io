---
name: ShipDock
alias: 码头
tagline: 服务器、Nginx、前后端项目发布与证书管理的桌面工具
date: 2026-11-17
version: 0.4.0
status: beta
platforms: [windows, macos, linux]
tags: [运维, 发布, Nginx, SSH]
icon: /tools/shipdock/icon.png
hero:
  base: /tools/shipdock/hero
  alt: ShipDock 的部署指引页，列出运行方式、代码来源和后端服务的部署要求
  width: 2000
  height: 1288
features:
  - title: 通过 SSH 管理服务器
    body: 连接时校验主机指纹，自动探测系统环境，可以一键安装 Nginx 或 OpenResty。服务器上不需要装任何代理程序。
    shot:
      base: /tools/shipdock/server
      alt: 添加服务器对话框，填写主机地址、SSH 端口、用户名和私钥
      width: 1120
      height: 1088
  - title: 发布前后端项目
    body: 本地构建上传、上传源码远程构建、从 Git 仓库拉取，三种方式任选。每次发布是一个独立版本，健康检查不通过会自动回滚到上一个版本。
  - title: 在线编辑 Nginx 配置
    body: 带补全和规则检查，能模拟一个请求看它匹配到哪个 location。保存时按「备份 → 写入 → nginx -t → reload」执行，检查不通过就不生效。
  - title: 内置运维知识
    body: 部署指引按 Node.js、Java、Python、Go、Rust、Docker 分别说明推荐做法和常见问题；命令手册收录 336 条常用命令，可全文搜索。
    shot:
      base: /tools/shipdock/commands
      alt: 命令手册中的「浏览与查看」一组，每条命令配一句说明
      width: 1600
      height: 724
  - title: 检测 SSL 证书
    body: 统一查看各域名的证书到期时间，快到期时发系统通知。
  - title: 管理 Docker、Supervisor、Redis
    body: 查看容器和进程状态，执行常用操作。
  - title: 操作都有记录
    body: 每次发布、改配置、执行命令都会留下审计记录，出了问题能查到是哪一步。
audience: 自己维护几台云服务器、手上有若干个前后端项目要发布的个人开发者或小团队。
featured: true
order: 1
---

发版、配 Nginx、续证书、查问题，这些事原本都靠 SSH 上去一条条敲命令。敲错一个字符，线上就挂了，而且事后很难说清楚改过什么。ShipDock 把这些操作做成桌面上可确认、可回滚、有记录的步骤。

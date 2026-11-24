---
title: "Docker Desktop(WSL2)修改镜像存储位置"
date: 2021-10-24T19:41:16+08:00
category: "运维"
tags: ["docker"]
---

此处我使用的是WSL2的版本，因此docker desktop在安装的时候创建两个wsl子系统，分别为docker-desktop和docker-desktop-data

```bash
# 查看已创建子系统
C:\Users\xxxxx>wsl -l -v --all
  NAME                   STATE           VERSION
* docker-desktop         Running         2
  docker-desktop-data    Running         2
# 立即终止所有正在运行的发行版
C:\Users\xxxxx>wsl --shutdown
# 导出wsl子系统镜像
C:\Users\xxxxx>wsl --export docker-desktop I:\docker\wsl\docker-desktop\docker-desktop.tar
C:\Users\xxxxx>wsl --export docker-desktop-data I:\docker\wsl\docker-desktop-data\docker-desktop-data.tar
# 删除现有的wsl子系统
C:\Users\xxxxx>wsl --unregister docker-desktop
C:\Users\xxxxx>wsl --unregister docker-desktop-data
# 重新创建wsl子系统
C:\Users\xxxxx>wsl --import docker-desktop I:\docker\wsl\docker-desktop I:\docker\wsl\docker-desktop\docker-desktop.tar --version 2
C:\Users\xxxxx>wsl --import docker-desktop-data I:\docker\wsl\docker-desktop-data I:\docker\wsl\docker-desktop-data\docker-desktop-data.tar --version 2
```

> 说明（这两个wsl子系统默认存放在系统盘）：
>
> 默认存储位置：C:\Users\xxxxx\AppData\Local\Docker\wsl
>
> docker-desktop：存放程序
>
> docker-desktop-data：存放镜像


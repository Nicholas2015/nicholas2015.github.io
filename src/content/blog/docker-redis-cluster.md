---
title: "基于Docker的Redis集群搭建"
date: 2021-06-26T22:54:00+08:00
category: "运维"
tags: ["redis"]
---

## 1. 拉取镜像

```shell
$ docker pull redis:6.2.4
```

## ![image-20210626214403717](https://raw.githubusercontent.com/Nicholas2015/image/master/redis/image-20210626214403717.png)

## 2.创建Redis容器

> 创建三个Redis容器：
>
> * redis-node01:6379
> * redis-node02:6380
> * redis-node03:6380

```shell
$ docker create --name redis-node01 -v /data/redis-data/node1:/data -p 6379:6379 redis:6.2.4 --cluster-enabled yes --cluster-config-file redis-node01.conf

$ docker create --name redis-node02 -v /data/redis-data/node2:/data -p 6380:6379 redis:6.2.4 --cluster-enabled yes --cluster-config-file redis-node02.conf

$ docker create --name redis-node03 -v /data/redis-data/node3:/data -p 6381:6379 redis:6.2.4 --cluster-enabled yes --cluster-config-file redis-node03.conf
```

![image-20210626214440775](https://raw.githubusercontent.com/Nicholas2015/image/master/redis/image-20210626214440775.png)



## 3. 启动Redis集群

* 启动容器

  ```shell
  $ docker start redis-node01 redis-node02 redis-node03
  ```

  ![image-20210626214325367](https://raw.githubusercontent.com/Nicholas2015/image/master/redis/image-20210626214325367.png)

* 检查容器启动情况

  ```shell
  $ docker ps -a
  ```

  ![image-20210626214301278](https://raw.githubusercontent.com/Nicholas2015/image/master/redis/image-20210626214301278.png)

* 查看Redis在Docker中分配的ip

  ```shell
  $ docker inspect redis-node0
  $ docker inspect redis-node02
  $ docker inspect redis-node03
  ```

  ![image-20210626214231630](https://raw.githubusercontent.com/Nicholas2015/image/master/redis/image-20210626214231630.png)

* 得到ip后，在某个容器中进行集群组建

  ```shell
  # 此处进入node01
  $ docker exec -it redis-node01 /bin/bash
  
  # 执行组建集群命令（ip根据自己的信息来确定）
  $ redis-cli --cluster create 172.17.0.2:6379 172.17.0.3:6379 172.17.0.4:6379 --cluster-replicas 0
  ```

  ![image-20210626214558417](https://raw.githubusercontent.com/Nicholas2015/image/master/redis/image-20210626214558417.png)


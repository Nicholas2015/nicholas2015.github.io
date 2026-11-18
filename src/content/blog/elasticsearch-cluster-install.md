---
title: "elasticsearch集群安装与部署"
date: 2023-01-25T20:00:00+08:00
category: "大数据"
tags: ["elasticsearch"]
---

## Elasticsearch部署
#### 一、环境准备
1. 物理机配置

 | 数量 | 配置 | 操作系统 | IP地址 |
|------|:-----|----------|--------|
|6|处理器：56核心<br>内存：512GB<br>系统盘：1T * 2 SSD固态盘<br>数据盘：8T * 10机械盘|Linux CentOS 7.5|192.168.70.130<br>192.168.70.131<br>192.168.70.132<br>192.168.70.133<br>192.168.70.134<br>192.168.70.135|

2. 软件信息
> JDK版本：1.8<br>
> Elasticsearch版本：7.0

#### 二、搭建环境
1. 软件环境信息
```shell
# 创建目录为elasticsearch安装做准备
$ mkdir -p /opt/elastic
$ mkdir -p /opt/elastic/node-01
$ mkdir -p /opt/elastic/node-02
$ mkdir -p /opt/elastic/node-03
$ mkdir -p /opt/elastic/node-04
$ mkdir -p /opt/elastic/node-05
$ mkdir -p /opt/elastic/node-client
# 创建目录用于下载文件，可以根据自己习惯操作
$ mkdir -p /home/software
$ cd /home/software
# 下载JDK
$ wget https://download.oracle.com/otn/java/jdk/8u351-b10/10e8cce67c7843478f41411b7003171c/jdk-8u351-linux-x64.tar.gz?AuthParam=1670730205_7f2b9f799e119cf35d27add28a8187cf
# 解压jdk文件 tar
$ tar -zxvf jdk-8u351-linux-x64.tar.gz
# 查看当前机器是否安装过jdk
$ rpm -qa |grep java
# 删除以java开头的文件
$ rpm -e --nodeps java*
# 删除完毕后可以输入以下命令确认是否还存在，如果提示command找不到，说明移除完成
$ java -version
# 配置JDK
$ vim /etc/profile
# 在最后一行添加如下内容
export JAVA_HOME=/home/local/java/jdk1.8.0_271
export PATH=$JAVA_HOME/bin:$PATH
export CLASSPATH=.:$JAVA_HOME/lib/dt.jar:$JAVA_HOME/lib/tools.jar
# 保存内容
按下esc键，操作:wq保存文件内容
# 重新加载文件，使其生效
$ source /etc/profile
# 验证安装是否成功，如果命令正常说明已经成功
$ java -version 
# 下载elasticsearch
$ wget https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-7.0.0-linux-x86_64.tar.gz
# 解压Elasticsearch
$ tar -zxvf elasticsearch-7.0.0-linux-x86_64.tar.gz
$ cp /home/software/elasticsearch /opt/elastic/node-01
$ cp /home/software/elasticsearch /opt/elastic/node-02
$ cp /home/software/elasticsearch /opt/elastic/node-03
$ cp /home/software/elasticsearch /opt/elastic/node-04
$ cp /home/software/elasticsearch /opt/elastic/node-05
$ cp /home/software/elasticsearch /opt/elastic/node-client
```
> 节点分配<br>
> node-01为即是master节点也是data节点<br>
> node-02~node-05为data节点<br>
> node-client为客户端节点，不充当master节点和data节点，仅作为对外客户端连接<br>
> 说明：<br>
> 此处client可以省略，也可以放到node-01上<br>
* 客户端节点配置
```yaml
# 这种组合表示这个节点即不会成为主节点，也不会存储数据，这个节点的意义是作为一个client(客户端)节点，主要是针对海量请求的时候可以进行负载均衡。
cluster.name: elastic-cluster
cluster.name: 130-node-client
network.host: 192.168.70.130
http.port: 9200
transport.port: 9300
# 是否为master节点
node.master: false
# 是否为data节点
node.data: false
cluster.initial_master_nodes: ["130-node-01", "131-node-01","132-node-01","133-node-01","134-node-01","135-node-01"]
discovery.seed_hosts: ["192.168.70.130:9201", "192.168.70.131:9201", "192.168.70.132:9201", "192.168.70.133:9201", "192.168.70.134:9201", "192.168.70.135:9201"]
# 锁定物理内存地址，防止es内存被交换出去，也就是避免es使用swap交换分区，频繁的交换，会导致IOPS变高
bootstrap.memory_lock: true
# 跨域配置
http.cors.enabled: true
http.cors.allow-origin: "*"
# 超出限制，清除内存已有的fielddata
indices.fielddata.cache.size: 30%
```
* Master节点配置
```yaml
# 这种组合表示这个节点即有成为主节点的资格，又存储数据。这个时候如果某个节点被选举成为了真正的主节点，那么他还要存储数据，这样对于这个节点的压力就比较大了。elasticsearch默认每个节点都是这样的配置，在测试环境下这样做没问题。实际工作中建议不要这样设置，这样相当于主节点和数据节点的角色混合到一块了
cluster.name: elastic-cluster
cluster.name: 130-node-01
network.host: 192.168.70.130
http.port: 9201
transport.port: 9301
# 是否为master节点
node.master: true
# 是否为data节点
node.data: true
cluster.initial_master_nodes: ["130-node-01", "131-node-01","132-node-01","133-node-01","134-node-01","135-node-01"]
discovery.seed_hosts: ["192.168.70.130:9201", "192.168.70.131:9201", "192.168.70.132:9201", "192.168.70.133:9201", "192.168.70.134:9201", "192.168.70.135:9201"]
# 锁定物理内存地址，防止es内存被交换出去，也就是避免es使用swap交换分区，频繁的交换，会导致IOPS变高
bootstrap.memory_lock: true
# 跨域配置
http.cors.enabled: true
http.cors.allow-origin: "*"
# 超出限制，清除内存已有的fielddata
indices.fielddata.cache.size: 30%
```
* Data节点配置（node-02~node-05）此处以node-02为例
```yaml
# 这种组合表示这个节点没有成为主节点的资格，也就不参与选举，只会存储数据。这个节点我们称为data(数据)节点。在集群中需要单独设置几个这样的节点负责存储数据，后期提供存储和查询服务。
cluster.name: elastic-cluster
cluster.name: 130-node-02
network.host: 192.168.70.130
http.port: 9202
transport.port: 9302
# 是否为master节点
node.master: false
# 是否为data节点
node.data: true
cluster.initial_master_nodes: ["130-node-01", "131-node-01","132-node-01","133-node-01","134-node-01","135-node-01"]
discovery.seed_hosts: ["192.168.70.130:9201", "192.168.70.131:9201", "192.168.70.132:9201", "192.168.70.133:9201", "192.168.70.134:9201", "192.168.70.135:9201"]
# 锁定物理内存地址，防止es内存被交换出去，也就是避免es使用swap交换分区，频繁的交换，会导致IOPS变高
bootstrap.memory_lock: true
# 跨域配置
http.cors.enabled: true
http.cors.allow-origin: "*"
# 超出限制，清除内存已有的fielddata
indices.fielddata.cache.size: 30%
```
> 备注：<br>
> 其他服务器配置一致<br>
JDK下载地址：[jdk1.8](https://download.oracle.com/otn/java/jdk/8u351-b10/10e8cce67c7843478f41411b7003171c/jdk-8u351-linux-x64.tar.gz?AuthParam=1670730205_7f2b9f799e119cf35d27add28a8187cf)<br>
OPEN JDK9及以后版本下载地址：[JDK9及以后版本](https://jdk.java.net/archive/)<br>
Elasticsearch下载地址：[Elasticsearch7.0.0](https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-7.0.0-linux-x86_64.tar.gz)<br>
ElasticStack所有软件下载地址：[Elastic Stack所有软件](https://www.elastic.co/cn/downloads/past-releases#elasticsearch)
2. 系统环境准备
> ❗️ Elasticsearch部署需要在Linux中单独创建一个用户供其使用
```shell
# 创建组
$ groupadd elastic
# 创建用户及设置密码 -g将新建用户添加到指定分组 -p设置用户密码
$ useradd elastic -g elastic -p elastic
# 给目录添加权限
$ chown -R elastic:elastic /opt/elastic
# 关闭系统swap交换，发生系统swapping的时候ES节点的性能会非常差，也会影响节点的稳定性。所以要不惜一切代价来避免swapping。swapping会导致Java GC的周期延迟从毫秒级恶化到分钟，更严重的是会引起节点响应延迟甚至脱离集群
$ swapoff -a
# 设置操作系统可以无限制分配内存一个进程
$ ulimit -l unlimited
# 配置限制
$ vim /etc/security/limits.conf
# allow user 'XXX' mlockall
* soft nofile 65536
* hard nofile 65536
* soft nproc 32000
* hard nproc 32000
elastic soft memlock unlimited
elastic hard memlock unlimited
# 切换用户
$ su elastic
# 启动elastisearch
$ /opt/elastic/node-01/elasticsearch7.0.0/bin/elasticsearch -d
$ /opt/elastic/node-02/elasticsearch7.0.0/bin/elasticsearch -d
$ /opt/elastic/node-03/elasticsearch7.0.0/bin/elasticsearch -d
$ /opt/elastic/node-04/elasticsearch7.0.0/bin/elasticsearch -d
$ /opt/elastic/node-05/elasticsearch7.0.0/bin/elasticsearch -d
$ /opt/elastic/node-client/elasticsearch7.0.0/bin/elasticsearch -d
```
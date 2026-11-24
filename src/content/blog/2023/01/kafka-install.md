---
title: "kafka集群安装与部署"
date: 2023-01-25T19:37:00+08:00
category: "中间件"
tags: ["kafka"]
---

## 一、环境准备

1. 物理机配置

   | 数量 | 配置                                           | 操作系统         | IP地址                                              |
   | ---- | ---------------------------------------------- | ---------------- | --------------------------------------------------- |
   | 3    | 处理器：4核心<br> 内存：16GB <br>系统盘：100GB | Linux CentOS 7.5 | 192.168.70.130<br>192.168.70.131<br/>192.168.70.132 |

2. hosts文件修改

   ```shell
   # 部署zk集群和kafka集群，IP映射
   # 添加IP关系映射 
   $ echo '192.168.70.130 kafka-zk01' >> /etc/hosts
   $ echo '192.168.70.131 kafka-zk02' >> /etc/hosts
   $ echo '192.168.70.132 kafka-zk03' >> /etc/hosts
   # 查看添加映射内容
   $ cat /etc/hosts
   192.168.70.130  kafka-zk01
   192.168.70.131  kafka-zk02
   192.168.70.132  kafka-zk03
   ```

## 二、集群部署

1. 基础环境初始化

   ```shell
   # 创建目录用于下载文件，后面文件下载均在此目录下，可以根据自己习惯操作
   $ mkdir -p /home/software
   $ cd /home/software
   # 安装JDK
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
   # 创建kafka集群部署目录
   $ mkdir /opt/kafka
   ```

2. 安装Zookeeper

   ```shell
   # 下载zookeeper
   $ wget https://dlcdn.apache.org/zookeeper/zookeeper-3.8.0/apache-zookeeper-3.8.0-bin.tar.gz
   # 解压zookeeper
   $ tar -xvzf apache-zookeeper-3.8.0-bin.tar.gz
   # 将zookeeper移动到刚刚创建的目录/opt/kafka
   $ mv ./apache-zookeeper-3.8.0-bin /opt/kafka/zookeeper-3.8.0
   # 创建数据目录
   $ mkdir /opt/kafka/zookeeper-data
   # 创建myid文件
   $ touch  /opt/kafka/zookeeper-data/myid
   # 数据目录写入zookeeper的ID，如果是第一台机器则在这里写1，后续机器依次按顺序写入2...
   echo "1" > /opt/kafka/zookeeper-data/myid
   # 查看myid文件中的数据
   cat /opt/kafka/zookeeper-data/myid
   1
   # 进入zookeeper配置文件所在目录
   $ cd /opt/kafka/zookeeper-3.8.0/conf
   $ cp zoo_sample.cfg zoo.cfg
   # 修改zoo.cfg配置文件
   # 修改dataDir的配置，将其设置为zk的数据地址
   dataDir=/opt/kafka/zookeeper-data
   # 增加ZK集群之间的交互配置。此处server.1后⾯的1，必须要和myid中的输⼊数字对应上。
   server.1=kafka-zk01:2888:3888
   server.2=kafka-zk02:2888:3888
   server.3=kafka-zk03:2888:3888
   # 进入zookeeper的bin目录
   $ cd /opt/kafka/zookeeper-3.8.0/bin
   # 启动命令
   $ ./zkServer.sh start
   # 停止命令
   $ ./zkServer.sh stop
   # 查看状态命令,会看到如下内容
   $ ./zkServer.sh status
   ZooKeeper JMX enabled by default
   Using config: /opt/kafka/zookeeper-3.8.0/bin/../conf/zoo.cfg
   Mode: leader
   ```

   > 备注：此处为集群部署，重复以上步骤，注意myid文件的修改

3. 安装Kafka

   ```shell
   # 下载kafka
   $ wget https://downloads.apache.org/kafka/3.3.1/kafka_2.12-3.3.1.tgz
   # 解压kafka
   $ tar -xzf kafka_2.12-3.3.1.tgz
   # 将kafka移动到刚刚创建的目录/opt/kafka
   $ mv ./kafka_2.12-3.3.1 /opt/kafka/kafka_2.12-3.3.1
   # 创建数据目录
   $ mkdir /opt/kafka/kafka-data
   # 进入kafka的配置文件所在目录
   $ cd /opt/kafka/kafka_2.12-3.3.1/config
   # 修改server.properties文件
   # 第⼀台机器设置为1，第⼆台设置为2，依次类推
   broker.id=1 
   # 允许删除Topic
   delete.topic.enable=true 
   # 允许⾃动创建Topic，如果没有部署Kafka管控平台，那么建议开启Topic的⾃动创建以省略单独⼿动创建Topic的麻烦过程
   auto.create.topics.enable=true 
   # 该机器的服务地址,即当前服务器地址
   listeners=PLAINTEXT://kafka-zk01:9092 
   # 数据⽬录，可⾃定义修改
   log.dirs=/home/kafka/kafka-data 
   # 如果开启了Topic⾃动创建，同时机器>=3台，那么分区数建议默认3个，副本建议2个，以保证可靠性
   num.partitions=3
   default.replication.factor=2
   # zookeeper集群地址 后⾯/kafka_3_4_1 标识的是Zookeeper中的下⼀层⽬录kafka_3_4_1作为kafka的元信息存储地
   zookeeper.connect=kafka-zk01:2181,kafka-zk02:2181,kafka-zk03:2181/kafka_3_4_1
   # 进入kafka的bin目录
   $ cd /opt/kafka/kafka_2.12-3.3.1/bin
   # 启动命令
   $ nohup ./kafka-server-start.sh ../config/server.properties > /dev/null 2>&1 &
   # 检查是否正常启动，通过检查../logs/server.log⾥⾯是否有started⽇志，如果有的话，那么就启动成功了
   ```

   > 备注：此处为集群部署，重复以上步骤，注意配置文件中的broker.id以及listeners需要调整

4. 验证

   ```shell
   # 进入kafka的bin目录
   $ cd /opt/kafka/kafka_2.12-3.3.1/bin
   # 生产消息测试
   $ ./kafka-console-producer.sh --bootstrap-server kafka-zk01:9092,kafka-zk02:9092,kafka-zk03:9092 --topic test
   # 消费消息测试
   $ ./kafka-console-consumer.sh --bootstrap-server kafka-zk01:9092,kafka-zk02:9092,kafka-zk03:9092 --topic test --group consume_test --property enable.auto.commit=true
   ```
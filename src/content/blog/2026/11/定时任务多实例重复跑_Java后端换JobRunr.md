---
title: 定时任务多实例重复跑_Java后端换JobRunr
date: 2026-11-25 18:43:40
tags: ["Java", "JobRunr", "Spring Boot", "定时任务"]
categories: java
---

# 定时任务多实例重复跑_Java后端换JobRunr

> 凌晨两点，对账任务在 8 个实例上同时开跑，同一批订单被结算了 8 次，值班同事删数据删到天亮。这不是代码写错了，是 @Scheduled 本身的设计：任务状态只活在 JVM 内存里，每个实例都觉得自己该跑。发版重启更难受，跑到一半的任务直接消失，第二天才发现漏单。这篇讲怎么用 JobRunr 把定时任务落进 MySQL，让集群里只有一个实例真正执行，失败自动重试，每条任务的状态在网页上看得见。

## 一、@Scheduled 的坑，本质只有三个

@Scheduled 只适合单机定时，一上集群，持久化、去重、重试这三件事它一件都不管。

具体是哪三件：

- **状态在内存。** "这个任务下次什么时候跑"记在 JVM 里，进程一重启就清零。正在执行的任务被打断，没有补偿，也没有痕迹。
- **每个实例都跑。** @Scheduled 没有"谁是主"的概念。你扩到 8 个副本，任务就执行 8 次，扩得越多错得越离谱。
- **异常被吞。** 方法抛异常，框架只打一条错误日志，下个周期照常触发。中间那次失败，没人知道，只能等业务方来投诉。

有人拿 Redis 分布式锁打补丁。锁能防住重复执行，但重启丢任务、失败没重试这两个问题原封不动。锁超时时间设短了，两个实例还会同时跑；设长了，一个实例挂掉后任务要等很久才被接手。补丁摞补丁，越补越难维护。

一个能上生产的定时任务，得同时满足四件事：

1. 任务落盘，重启不丢
2. 集群里只执行一次
3. 失败能自动重试
4. 状态看得见，出问题能查

JobRunr 就是照这四条设计的。说白了，它是一个 jar 包，不是一套要单独部署的服务。加个依赖，它把任务的方法名和参数序列化成 JSON，写进你已经有的 MySQL；应用自己起一组后台线程去"抢"这些任务来执行。

先认识五个概念，后面全靠它们：

| 概念 | 干什么 | 打个比方 |
| --- | --- | --- |
| JobScheduler | 把任务写进库，立刻返回 | 下单 |
| BackgroundJobServer | 轮询任务、抢占、执行 | 骑手接单 |
| StorageProvider | 任务存在哪（SQL / MongoDB / 内存） | 仓库 |
| Dashboard | 网页上看任务状态 | 物流跟踪页 |
| RecurringJob | 周期任务的定义 | 每天固定班次 |

它和 XXL-JOB 的根本差异在这儿：XXL-JOB 是"调度中心 + 执行器"两套东西分开部署，JobRunr 把调度逻辑塞进了应用和数据库。好处是少运维一个组件，坏处是应用实例本身成了调度的一部分——实例全挂了，任务自然也不跑。

## 二、一条任务从入队到执行，中间发生了什么

JobRunr 靠数据库里的状态字段加原子更新，保证一条任务只被一个实例拿走；靠心跳选举 master，保证周期任务只入队一次。

### 入队：lambda 被拆成了 JSON

写下这行代码时，方法并没有被调用：

```java
jobScheduler.enqueue(() -> orderService.pushToWarehouse(orderNo));
```

JobRunr 用 ASM 读这段 lambda 的字节码，拿到类名、方法名、参数值，序列化成 JSON，往 jobrunr_jobs 表插一行，状态 ENQUEUED，然后立刻把控制权还给你。方法真正执行是在另一个线程、甚至另一台机器上。

这解释了两条硬限制：

- lambda 里捕获的变量必须能被 JSON 序列化。传订单 id，别传整个实体对象，更别传带懒加载代理的 JPA 实体。
- 方法所在的类必须能从 Spring 容器里拿到。JobRunr 通过 JobActivator 取 bean，Spring 集成会自动配好这一层。

### 执行：一场抢单

BackgroundJobServer 按 poll-interval 扫库，默认 15 秒一次。真实数据库这个值最低 5 秒，配得更小会被抬回去，别指望毫秒级。

扫到 ENQUEUED 的任务后，它不是直接执行，而是先做一次条件更新：只有状态还是 ENQUEUED、版本号没被别人改过，才改成 PROCESSING。数据库的行锁保证同一时刻只有一个实例能更新成功，其他实例影响 0 行，默默跳过。

就是外卖抢单。一百个骑手同时点"接单"，平台只让一个人成功，剩下的继续等下一单。

执行完写回 SUCCEEDED；抛异常则交给 RetryFilter，按指数退避重新排队，默认重试 10 次。次数用完进 FAILED，任务留在库里等你处理，不会悄悄消失。

### master 选举：周期任务只入队一次

周期任务不是每个实例各跑一遍。所有实例往 jobrunr_backgroundjobservers 表写心跳，JobRunr 选出运行时间最长的那个当 master。master 干两件杂活：把到点的周期任务展开成一条条普通任务，以及清理过期数据。

master 挂了会怎样？心跳超时后，剩下的实例重新选一个出来，接着展开周期任务。这中间到点的任务会晚一点入队，但定义躺在表里，丢不了。

这就回答了那个经典问题——调度中心自己挂了，任务还跑不跑？JobRunr 没有独立调度中心，只要还有一个应用实例活着、数据库活着，任务就继续。代价是调度能力和应用绑在一起，应用全下线，任务自然停。

### 表结构长什么样

JobRunr 自己建表、自己迁移，你不用手写：

| 表 | 存什么 |
| --- | --- |
| jobrunr_jobs | 每条任务、当前状态、序列化后的 JSON |
| jobrunr_recurring_jobs | 周期任务的定义 |
| jobrunr_backgroundjobservers | 集群里各实例和它们的心跳 |
| jobrunr_metadata | 集群级配置、统计数字 |
| jobrunr_migrations | 已执行的表结构迁移 |
| jobrunr_jobs_stats | 视图，Dashboard 的统计用 |

有个坑要提前说：JobRunr 必须读写同一个主库。官方文档写得很直白，读从库会拿到复制延迟的数据，更新时版本号对不上，抛 ConcurrentModificationException，表现出来就是任务重复执行或者莫名失败。生产上给 JobRunr 单独配一个指向主库的 DataSource，别图省事共用读写分离的数据源。

## 三、实战：一个能跑的最小工程

下面五个文件加一条建表语句，复制到空目录里 `mvn spring-boot:run` 就能跑起来。环境是 JDK 21 + MySQL 8.0 以上。

### 1. pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>jobrunr-demo</artifactId>
    <version>1.0.0</version>
    <name>jobrunr-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.0</version>
        </dependency>
        <dependency>
            <groupId>org.jobrunr</groupId>
            <artifactId>jobrunr-spring-boot-4-starter</artifactId>
            <version>9.0.5</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.10.0</version>
            <scope>runtime</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

注意 starter 的名字：Spring Boot 4 要用 `jobrunr-spring-boot-4-starter`。老的 `jobrunr-spring-boot-starter` 早就停止维护了，别拿旧教程的坐标直接抄。

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: jobrunr-demo
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/demo?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai
    username: demo
    password: demo123
    hikari:
      maximum-pool-size: 10

jobrunr:
  # 每个任务默认重试次数，用完后进 FAILED，不会丢
  jobs:
    default-number-of-retries: 5
    # 成功的任务保留 72 小时再删，留出排查时间
    delete-succeeded-jobs-after: 72h
    permanently-delete-deleted-jobs-after: 168h
  background-job-server:
    # 默认是 false，不打开就只有"入队"没有"执行"
    enabled: true
    # 单个实例最多同时跑几个任务
    worker-count: 4
    # 扫库间隔，真实数据库最低 5 秒
    poll-interval-in-seconds: 15
    # 停机时等正在跑的任务多久，超时会被打断
    interrupt-jobs-await-duration-on-stop: 30s
  dashboard:
    enabled: true
    port: 8000
    username: admin
    password: change-me-please
  miscellaneous:
    # 别把任务统计发给厂商
    allow-anonymous-data-usage: false
```

`background-job-server.enabled` 默认是 false，这是新手最容易卡住的地方。服务启动成功、接口也返回"已入队"，Dashboard 里一堆 ENQUEUED，就是不动，原因就是执行器没开。

Dashboard 跑在 8000 端口，和业务端口 8080 是两个。`username` 和 `password` 是基础认证，不配就是裸奔，谁都能点进去重跑、删除任务。

### 3. 启动类

```java
package com.example.jobrunr;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class JobRunrDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(JobRunrDemoApplication.class, args);
    }
}
```

### 4. 业务服务与任务入队

业务方法上挂 `@Job`，可以改任务显示名和重试次数。`%0` 会被替换成第一个参数，在 Dashboard 上一眼能看出是哪个订单。

```java
package com.example.jobrunr.service;

import org.jobrunr.jobs.annotations.Job;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    @Job(name = "推送订单到仓库 %0", retries = 3)
    public void pushToWarehouse(String orderNo) {
        log.info("开始推送订单 {}", orderNo);
        if (orderNo.endsWith("9")) {
            throw new IllegalStateException("仓库接口超时，订单 " + orderNo);
        }
        log.info("订单 {} 推送成功", orderNo);
    }
}
```

这里故意让尾号 9 的订单失败，方便你在 Dashboard 里看重试过程：状态变成 FAILED 之前会有几次 PROCESSING，间隔一次比一次长。

控制器负责入队。立即执行和延迟执行各一个接口：

```java
package com.example.jobrunr.web;

import com.example.jobrunr.service.OrderService;
import org.jobrunr.scheduling.JobScheduler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final JobScheduler jobScheduler;
    private final OrderService orderService;

    public OrderController(JobScheduler jobScheduler, OrderService orderService) {
        this.jobScheduler = jobScheduler;
        this.orderService = orderService;
    }

    @PostMapping("/{orderNo}/push")
    public String push(@PathVariable String orderNo) {
        jobScheduler.enqueue(() -> orderService.pushToWarehouse(orderNo));
        return "已入队: " + orderNo;
    }

    @PostMapping("/{orderNo}/push-later")
    public String pushLater(@PathVariable String orderNo) {
        jobScheduler.schedule(Instant.now().plus(30, ChronoUnit.SECONDS),
                () -> orderService.pushToWarehouse(orderNo));
        return "30 秒后执行: " + orderNo;
    }
}
```

`JobScheduler` 是 starter 自动注册的 bean，直接构造器注入。延迟任务不是靠内存里的定时器，30 秒这个时间点也写在库里，服务重启照样会执行。

### 5. 周期任务与幂等

周期任务用 `@Recurring` 声明，Spring 启动时自动注册。cron 是五个字段：分、时、日、月、周。下面这条是每天凌晨 2 点。

```java
package com.example.jobrunr.job;

import com.example.jobrunr.service.ReconcileService;
import org.jobrunr.jobs.annotations.Recurring;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.LocalDate;

@Component
public class RecurringJobs {

    private static final Logger log = LoggerFactory.getLogger(RecurringJobs.class);

    private final ReconcileService reconcileService;

    public RecurringJobs(ReconcileService reconcileService) {
        this.reconcileService = reconcileService;
    }

    @Recurring(cron = "0 2 * * *")
    public void dailyReconcile() {
        String bizDate = LocalDate.now().minusDays(1).toString();
        log.info("周期任务触发，对账日期 {}", bizDate);
        reconcileService.reconcile(bizDate);
    }
}
```

cron 别混着写。JobRunr 支持五字段（分起头）也支持六字段（秒起头）。你从别处抄来一条六字段的表达式塞进五字段的位置，任务触发时间会整体错位，还不报错，最难查。

重试解决不了重复。任务执行到一半实例挂了，JobRunr 会把它重新排给别人跑，业务副作用就出现了两次。所以业务侧必须自己兜一层幂等，用一个唯一键把"这一天已经对过账"钉死：

```java
package com.example.jobrunr.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ReconcileService {

    private static final Logger log = LoggerFactory.getLogger(ReconcileService.class);

    private final JdbcTemplate jdbcTemplate;

    public ReconcileService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void reconcile(String bizDate) {
        int inserted = jdbcTemplate.update(
                "insert ignore into task_execution_log(task_name, biz_date) values (?, ?)",
                "daily-reconcile", bizDate);
        if (inserted == 0) {
            log.info("{} 已经对过账，本次跳过", bizDate);
            return;
        }
        log.info("开始对账 {}", bizDate);
        log.info("对账完成 {}", bizDate);
    }
}
```

配套的业务表和库：

```sql
CREATE DATABASE IF NOT EXISTS demo DEFAULT CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS task_execution_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    task_name VARCHAR(64) NOT NULL,
    biz_date VARCHAR(16) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_task_bizdate (task_name, biz_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

`insert ignore` 命中唯一键时返回 0 行，直接跳过。比先查再插靠谱：先查再插在两个实例同时进来的情况下照样会插两次。

### 6. 生产上不给 DDL 权限怎么办

很多公司应用账号没有建表权限。JobRunr 带了一个生成脚本的工具，把 jar 从本地仓库拿出来执行：

```bash
java -cp ~/.m2/repository/org/jobrunr/jobrunr/9.0.5/jobrunr-9.0.5.jar \
  org.jobrunr.storage.sql.common.DatabaseSqlMigrationFileProvider mysql
```

它会在当前目录生成 MySQL 的建表脚本，交给 DBA 执行。之后把 `jobrunr.database.skip-create` 设成 true，JobRunr 就不会再去建表。

## 四、踩坑经验和最佳实践

下面五条都是上线后真会碰到的，按"现象—怎么查—根因—怎么修"写。

**1. 任务一直 ENQUEUED，就是不动**

现象：接口返回成功，Dashboard 里任务全是 ENQUEUED，日志没有任何执行记录。

怎么查：Dashboard 的 Servers 页看有没有在线实例，一个都没有就是执行器没起。

根因：`jobrunr.background-job-server.enabled` 默认 false，官方故意的，怕 Web 应用莫名其妙开始跑任务。

修：显式打开。另外，一个 JVM 里只允许一个 BackgroundJobServer，别自己再 new 一个。

**2. 日志里翻到 ConcurrentModificationException**

现象：任务偶发失败，堆栈指向 JobRunr 更新任务状态的那一层，或者同一个任务被执行了两次。

怎么查：先看 `spring.datasource.url` 指向的是主库还是读写分离的中间件。

根因：读到了从库的旧版本数据，条件更新对不上版本号。

修：给 JobRunr 单独配一个指向主库的 DataSource，用 `jobrunr.database.datasource` 指定 bean 名字。这个属性填的是 bean 名，不是 JDBC URL，写错会启动失败。

**3. 入队就报序列化错误**

现象：调接口 500，堆栈里是 Jackson 的序列化异常；或者任务进库了，执行时报反序列化失败。

根因：lambda 捕获了不可序列化的对象。实体、`InputStream`、带懒加载代理的 JPA 对象都是常客。

修：只传 id、订单号这类字符串或基本类型，任务方法内部再查库拿数据。任务参数也别塞大对象，整条 JSON 是要存进表里的。

**4. Dashboard 被人点了几下，任务全乱了**

现象：生产环境的 8000 端口能公网访问，任何人打开都能重跑、删除任务。

根因：Dashboard 默认没有认证。

修：配 `jobrunr.dashboard.username` 和 `password`；K8s 里别给它建 Service，用 port-forward 临时看；云服务器安全组只放行自己的出口 IP。要更细的权限控制，那是 Pro 版的事。

**5. 发版重启后，一批任务重复执行了**

现象：滚动发布时日志里同样的业务操作出现两次。

根因：默认停机只等 10 秒，长任务被中断，JobRunr 认为执行失败，重新排给别的实例。

修：把 `interrupt-jobs-await-duration-on-stop` 调到比最长任务还长，同时业务侧做幂等。两件事缺一不可，光调等待时间挡不住进程被 kill -9。

**6. worker-count 别乱开**

worker-count 是单实例并发任务数，默认按 CPU 核数来。开到 50 但 Hikari 连接池只有 10，任务会卡在抢连接上，看着像"任务不执行"。并发数和连接池一起调。

## 五、性能对比和技术选型

选型的核心不是谁快，是你有多少实例、能不能接受多运维一个组件。

| 方案 | 任务存哪 | 集群去重 | 失败重试 | 额外组件 | 适合谁 |
| --- | --- | --- | --- | --- | --- |
| @Scheduled | 内存 | 无 | 无 | 无 | 单实例、丢任务能忍 |
| Quartz | 数据库 | 靠表锁抢占 | 有，配置 misfire | 无（但要 QRTZ 表） | 已用 Quartz、任务模型简单 |
| JobRunr | 数据库 / MongoDB | 原子抢占 + master 选举 | 默认 10 次指数退避 | 无 | Spring Boot 单体、几十个实例 |
| XXL-JOB | 调度中心库 | 调度中心统一派发 | 有，可配告警 | 调度中心 + 执行器 | 执行器上百、要分片广播 |
| Temporal | 自己的工作流存储 | 工作流引擎保证 | 有，且能续跑 | 一整套服务端 | 长流程编排，不是 cron 替代 |

我的建议很直接：

- 实例数 3 个以内、任务丢了业务能补，继续用 @Scheduled，别过度设计。
- 已有 MySQL、实例几十个、不想再运维调度中心，JobRunr 是性价比最高的选择。它的 Dashboard 免费用，够看。
- 执行器上百台、要做分片跑批或者广播到每台机器，去看 XXL-JOB 和 PowerJob。JobRunr 开源版没有分片和广播，这是硬边界。
- 需要"步骤 A 成功才走 B、失败回滚重来"的长流程，那是 Temporal 的活。它是有状态工作流引擎，别当成 cron 的替代品。

JobRunr 的短板也说清楚：没有任务依赖 DAG，没有分片，没有告警渠道（得自己接 Micrometer 做监控），Dashboard 只有基础认证。这些恰好是 XXL-JOB 和 PowerJob 的强项。工具没有全能选手。

## 六、总结

定时任务上集群，问题从来不是"怎么定时"，而是"任务存在哪、谁来执行、失败了怎么办"。

JobRunr 的答案很朴素：任务序列化成 JSON 存进你已有的数据库，应用自己起后台线程抢任务，靠数据库的条件更新保证只执行一次，靠心跳选主保证周期任务只入队一次，失败按指数退避重试，最后落在 FAILED 等你处理。

上线前把这几条对着过一遍：

- `background-job-server.enabled` 打开了没
- JobRunr 的 DataSource 是不是指向主库
- 任务参数是不是只有 id 这类可序列化的值
- Dashboard 有没有认证、端口有没有暴露
- 业务侧有没有幂等兜底，停机等待时间够不够长

五条全过，这套东西可以放心跑在生产上。少一个调度中心要运维，代价是应用自己成了调度的一部分——这笔账，中小规模的团队基本都算得过来。

文 / 会编程的吕洞宾

## 参考资料

- [JobRunr Documentation](https://www.jobrunr.io/en/documentation/)
- [JobRunr Spring Integration](https://www.jobrunr.io/en/documentation/configuration/spring/)
- [JobRunr Storage Providers](https://www.jobrunr.io/en/documentation/storage/)
- [jobrunr-spring-boot-4-starter on Maven Central](https://repo1.maven.org/maven2/org/jobrunr/jobrunr-spring-boot-4-starter/)

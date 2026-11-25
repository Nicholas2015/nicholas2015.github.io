---
title: "Quartz 定时任务实战：集群不重复执行，重启不丢任务"
date: 2026-11-24 11:24:16
tags: ["Java", "Quartz", "定时任务", "集群"]
categories: java
---

# Quartz 定时任务实战：集群不重复执行，重启不丢任务

用 `@Scheduled` 写定时任务，单机什么事都没有。一上两台实例，同一个任务就在两台机器上各跑一次——对账跑两遍、发券发两份、清理任务互相踩。想换成 Quartz 集群，又会冒出新的问题：重启之后一堆任务同时补跑，把下游打挂；或者任务时间越来越不准，说不清是哪台机器在执行。

这篇从零把 Quartz 接进 Spring Boot，代码能直接照着跑。重点不在 API 怎么调，在**集群、存储、misfire 这三件真正会出事的地方**。

## @Scheduled 什么时候就不够用了

它有三个短板，都跟"多实例"直接相关：

**没有协调。** 每个实例各自跑各自的时间表，没有谁去抢。两台机器就是两倍执行，十台就是十倍。

**没有持久化。** 任务定义在代码里，重启就重新算。你没法在后台临时加一条任务，也没法暂停一条——只能改代码、发版。

**没有 misfire 概念。** 服务停了四小时，起来时 `@Scheduled` 该几点跑还几点跑，中间漏掉的那几次它就当没发生过。这个行为对有些任务是好事，对另一些是灾难——而你没得选。

Quartz 把这三件都做成可配置的：任务存在数据库里、实例之间抢数据库行锁、漏掉的执行按你指定的策略补偿。

## 依赖

Spring Boot 已经把 quartz 的版本管好了，不需要自己查。写全版本号是为了让这段 pom 脱离父工程也能用：

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.2.0</version>
</parent>

<properties>
    <java.version>21</java.version>
</properties>

<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-quartz</artifactId>
        <version>4.2.0</version>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-jdbc</artifactId>
        <version>4.2.0</version>
    </dependency>
    <dependency>
        <groupId>com.mysql</groupId>
        <artifactId>mysql-connector-j</artifactId>
        <version>26.10.0</version>
    </dependency>
</dependencies>
```

不需要单独引 `org.quartz-scheduler:quartz`，starter 会带进来，版本由 Spring Boot 统一管理。

## 最小可运行：一个 Job、一个 Trigger

Job 是干活的地方：

```java
package com.example.settle.job;

import org.quartz.DisallowConcurrentExecution;
import org.quartz.JobExecutionContext;
import org.quartz.JobExecutionException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.quartz.QuartzJobBean;
import org.springframework.stereotype.Component;

@Component
@DisallowConcurrentExecution
public class SettleJob extends QuartzJobBean {

    private static final Logger log = LoggerFactory.getLogger(SettleJob.class);

    @Override
    protected void executeInternal(JobExecutionContext context) throws JobExecutionException {
        int batchSize = context.getMergedJobDataMap().getInt("batchSize");
        String shard = context.getMergedJobDataMap().getString("shard");
        log.info("对账开始，批次大小={}，分片={}", batchSize, shard);

        long start = System.currentTimeMillis();
        try {
            // 这里放真实业务：查待对账订单、逐条比对、写结果表
            Thread.sleep(800);
        } catch (Exception e) {
            log.error("对账执行失败", e);
            throw new JobExecutionException(e, false);
        }
        log.info("对账结束，耗时 {} ms", System.currentTimeMillis() - start);
    }
}
```

`QuartzJobBean` 是 Spring 提供的基类，配合 Boot 默认的 JobFactory，Job 里可以直接 `@Autowired` 注入 Service，不用自己去抓 ApplicationContext。

Trigger 和 JobDetail 用配置类声明。Boot 会自动把容器里的 `JobDetail` 和 `Trigger` bean 注册到 Scheduler：

```java
package com.example.settle.config;

import com.example.settle.job.SettleJob;
import org.quartz.CronScheduleBuilder;
import org.quartz.JobBuilder;
import org.quartz.JobDetail;
import org.quartz.Trigger;
import org.quartz.TriggerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.TimeZone;

@Configuration
public class QuartzConfig {

    @Bean
    public JobDetail settleJobDetail() {
        return JobBuilder.newJob(SettleJob.class)
                .withIdentity("settleJob", "billing")
                .usingJobData("batchSize", 500)
                .usingJobData("shard", "shard-0")
                .storeDurably()
                .build();
    }

    @Bean
    public Trigger settleJobTrigger(JobDetail settleJobDetail) {
        return TriggerBuilder.newTrigger()
                .forJob(settleJobDetail)
                .withIdentity("settleJobTrigger", "billing")
                .withSchedule(CronScheduleBuilder
                        .cronSchedule("0 0 2 * * ?")
                        .inTimeZone(TimeZone.getTimeZone("Asia/Shanghai"))
                        .withMisfireHandlingInstructionDoNothing())
                .build();
    }
}
```

三个细节别漏：

- `storeDurably()`：没有 Trigger 关联时，JobDetail 也留在库里，不会因为触发器被删就消失。
- `inTimeZone`：容器默认时区大概率是 UTC，不写这一句，你的"凌晨 2 点"实际是北京时间上午 10 点。
- `withMisfireHandlingInstructionDoNothing()`：显式指定补偿策略，别吃默认值。下面单独讲。

## 存储：RAM 还是 JDBC，这一步决定后面所有事

Quartz 有两种 JobStore：

**RAMJobStore** —— 任务放在内存里。速度快，但**重启就没了**，而且**不支持集群**。Boot 在没配 DataSource 时默认用这个。

**JDBCJobStore** —— 任务、触发器、执行状态全在数据库表里。慢一点，换来的是持久化和集群能力。

想集群，只能是 JDBC。切换就一行：

```yaml
spring:
  quartz:
    job-store-type: jdbc
```

顺带一提，很多人踩的坑是"我配了 isClustered=true 怎么还是重复执行"——因为没切 job-store-type，还在用 RAM 存储，集群配置根本不生效。

## 建表：initialize-schema 别在生产开 always

JDBC 模式需要 11 张 `QRTZ_` 开头的表。Spring Boot 可以帮你建：

```yaml
spring:
  quartz:
    jdbc:
      initialize-schema: always
```

取值三个：`always`、`embedded`（默认，只有内嵌库才建）、`never`。

**开发环境用 always 很方便，生产环境千万别留这个值。** 官方的建表脚本第一段就是 `DROP TABLE IF EXISTS QRTZ_FIRED_TRIGGERS;` 这种语句，每次启动都执行一遍，等于把你的任务定义和调度状态清空重来。

生产该这么做：从 quartz 的 jar 里把脚本取出来，手工执行一次。

```bash
unzip -p quartz-2.5.2.jar org/quartz/impl/jdbcjobstore/tables_mysql_innodb.sql > qrtz_mysql.sql
```

MySQL 用 `tables_mysql_innodb.sql`（带 InnoDB 引擎声明），不是 `tables_mysql.sql`——后者建的是 MyISAM 表，没有行级锁，集群下抢锁会出问题。

建完把配置改成 `never`，表结构交给数据库变更流程管。

## 集群：isClustered 打开之后到底发生了什么

配置长这样：

```yaml
spring:
  quartz:
    job-store-type: jdbc
    jdbc:
      initialize-schema: never
    wait-for-jobs-to-complete-on-shutdown: true
    properties:
      org.quartz.scheduler.instanceName: billing-scheduler
      org.quartz.scheduler.instanceId: AUTO
      org.quartz.jobStore.isClustered: true
      org.quartz.jobStore.clusterCheckinInterval: 10000
      org.quartz.jobStore.misfireThreshold: 5000
      org.quartz.jobStore.acquireTriggersWithinLock: true
      org.quartz.threadPool.threadCount: 10
```

几个关键项：

**`instanceId: AUTO`** —— 必须。每台机器启动时生成唯一 ID。如果你手写成固定值，两台机器 ID 相同，Quartz 会认为是同一个实例，任务状态互相覆盖。这是集群重复执行的头号原因。

**`isClustered: true`** —— 打开后，实例之间不是"分工"，是**抢**。到点了，所有实例都去 `QRTZ_LOCKS` 表里找 `TRIGGER_ACCESS` 这把锁，谁先拿到谁执行，其余的走开等下一轮。所以任务多了要靠 `threadPool.threadCount` 撑并发，而不是靠加机器。

**`clusterCheckinInterval: 10000`** —— 每 10 秒往 `QRTZ_SCHEDULER_STATE` 表打一次心跳。某台机器挂了，别的实例要靠这个心跳超时才发现它死了、把它的任务接过来。这个值越小故障转移越快，代价是数据库压力越大。默认是 7500 毫秒。

**`acquireTriggersWithinLock: true`** —— 取触发器的时候加锁，避免两个实例同时看中同一批触发器。集群环境建议开着。

**`wait-for-jobs-to-complete-on-shutdown: true`** —— 停机时等正在跑的任务结束再退出。不配的话，发版瞬间被 kill 的任务会留在 `QRTZ_FIRED_TRIGGERS` 里变成"僵尸"，要等别的实例清理。

还有一条容易被忽略的：**集群所有节点的系统时间必须是同步的**。Quartz 判断 misfire 靠的是本地时间和触发器计划时间的差，某台机器快了三分钟，它就会认为任务该补跑。

## misfire：重启后任务集体补跑就是这么来的

`misfireThreshold` 是"迟到多久算 misfire"的门槛，默认 60000 毫秒。任务计划 2:00 执行，实例 2:00:30 才抢到锁，还没超阈值，正常跑；超过一分钟没跑，才算 misfire，才走补偿策略。

补偿策略有三种行为：

| 行为 | 常量 | 效果 |
|---|---|---|
| 立刻补一次 | `FIRE_ONCE_NOW` / `FIRE_NOW` | 现在马上跑一次，然后回到正常节奏 |
| 跳过不补 | `DO_NOTHING` | 漏掉的不管，等下一个计划时间 |
| 全补 | `IGNORE_MISFIRE_POLICY` | 漏掉几次补几次，可能连续跑一串 |

**默认的 `SMART_POLICY` 对 Cron 触发器等价于"立刻补一次"。** 这就是为什么服务重启后，你会看到十几个任务同时开始跑——它们都错过了时间，各自补了一次。

对账、清理这类任务，补跑没意义还容易打挂下游，就该显式写 `DO_NOTHING`：

```java
CronScheduleBuilder.cronSchedule("0 0 2 * * ?")
        .inTimeZone(TimeZone.getTimeZone("Asia/Shanghai"))
        .withMisfireHandlingInstructionDoNothing()
```

反过来，如果是"必须处理完每一条"的任务（比如每 5 分钟扫一次队列），漏掉就意味着数据积压，那要 `IGNORE_MISFIRE_POLICY` 全补，并且把 `misfireThreshold` 调小。

没有通用答案。**你必须对每个任务单独判断，并且把判断写进代码里**——让默认值替你决策，出事的时候你都不知道它做了什么。

## 两个注解：不并发、存数据

**`@DisallowConcurrentExecution`** —— 同一个 JobDetail 不会并发执行。上一个还没跑完，下一个到点了就排队等着。注意它锁的是"这个 JobDetail"，不是"这个 Job 类"——如果你用同一个类注册了多个 JobDetail，它们之间仍然可以并发。

对账这种任务必加。不然上一批还没跑完，下一批又进来，同一批数据被处理两次。

**`@PersistJobDataAfterExecution`** —— 执行完把 JobDataMap 的改动写回数据库。适合需要在多次执行之间传状态的场景，比如记录"上次处理到哪个 ID"。

这个注解通常和 `@DisallowConcurrentExecution` 配着用。单独用会有并发覆盖问题——两个执行同时改 JobDataMap，后写的赢。

## 排查：四种现象，四条路

**现象一：每台机器都执行了一遍**

先看 `spring.quartz.job-store-type` 是不是 `jdbc`，再看 `isClustered` 是不是 `true`。这两个有一个没配对，就退化成各跑各的。然后查 `QRTZ_SCHEDULER_STATE` 表里有几条记录——应该是每个实例一条，只有一条说明别的实例没连上库。

**现象二：重启后一堆任务同时补跑**

看那些 Trigger 的 misfire 策略是不是吃了默认值。`QRTZ_TRIGGERS` 表里 `MISFIRE_INSTR` 字段能直接看到每个触发器当前的策略值，负数就是 SMART_POLICY。

**现象三：执行时间越来越不准**

按顺序查三件事：各节点 `date` 是否一致（NTP 没配是最常见的）、`instanceId` 是不是写成了固定值、任务是不是被 `@DisallowConcurrentExecution` 排队拖后了。最后这条容易被误判——任务本身没延迟，是在等上一个跑完。

**现象四：任务根本不跑**

四条线索：`QRTZ_LOCKS` 里的锁是不是被长事务占着（有人在库里挂了事务不提交）、线程池是不是被打满（`threadCount` 太小而任务太慢）、Trigger 是不是被 pause 了（`QRTZ_TRIGGERS` 的 `TRIGGER_STATE` 字段，`PAUSED` 就是不跑了）、表是不是压根没建（`initialize-schema: never` 而你又忘了手工执行脚本）。

## 最后

Quartz 的默认值几乎全都偏向"能跑起来"，不是"跑得对"。RAM 存储能跑、SMART_POLICY 能跑、固定 instanceId 在单机上也能跑——所有问题都在你加第二台机器的时候才暴露。

所以配 Quartz 集群，别抄一份 yaml 就走。存储、instanceId、misfire、并发这四项，每一项都要知道为什么这么配。

## 参考资料

- [Quartz 官方文档](https://www.quartz-scheduler.org/documentation/)
- [Spring Boot 的 Quartz 支持](https://docs.spring.io/spring-boot/reference/io/quartz.html)
- [quartz 在 Maven Central 的版本](https://repo1.maven.org/maven2/org/quartz-scheduler/quartz/)

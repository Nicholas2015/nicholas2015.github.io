---
title: "雪花算法时钟回拨，Java 后端 ID 重复怎么救"
date: 2026-10-18T09:00:00+08:00
category: "java"
tags: ["distributed-id"]
---

> 凌晨两点，订单服务开始刷主键冲突告警。两个不同用户、不同商品，订单 ID 一模一样。查到天亮才发现：NTP 把一台机器的时间往回拨了 300 毫秒，雪花算法在那 300 毫秒里，把发过的 ID 又发了一遍。雪花算法本身不复杂，难的是时间不听话。这篇把时钟回拨的成因、原理和一套能直接上线的处理方案讲清楚，代码照抄能跑。

## 一、雪花算法生成的 ID 为什么会重复

结论：雪花 ID 重复几乎只有两个来源——同一台机器上时钟回拨，或者不同机器用了同一个 workerId。

先把 64 位拆开看。雪花算法把一个 long 切成五段：

| 位置 | 长度 | 含义 |
| --- | --- | --- |
| 第 63 位 | 1 bit | 符号位，固定 0，保证 ID 是正数 |
| 第 62-22 位 | 41 bit | 毫秒时间戳，存的是「当前时间减去自定义纪元」 |
| 第 21-17 位 | 5 bit | 数据中心 ID，取值 0-31 |
| 第 16-12 位 | 5 bit | 机器 ID，取值 0-31 |
| 第 11-0 位 | 12 bit | 同一毫秒内的序列号，取值 0-4095 |

拼起来就是 `(时间戳 << 22) | (数据中心 << 17) | (机器 << 12) | 序列号`。因为时间戳在高位，生成的 ID 整体是递增的，存进 MySQL 聚簇索引时，新数据基本都往 B+ 树右边追加，不会像 UUID 那样把页拆得七零八落。

唯一性靠一个很朴素的前提：**同一毫秒、同一台机器，序列号不能重复；不同毫秒，时间戳天然不同**。

只要时间一直往前走，这个前提就成立。麻烦在于，服务器的时间并不是只往前走。

线上的真实表现通常是这样：插入订单时报 `Duplicate entry '1834...' for key 'PRIMARY'`，或者消息队列里出现两个 ID 相同的消息，消费者做幂等时把第二条直接丢了，业务少了一单。去查日志，两台机器的时间差了 300 毫秒，或者同一台机器在某个时刻时间跳回去了。

很多人第一反应是「雪花算法有 bug」。算法没问题，它把「时间单调递增」当成了输入条件。机房里的时间不满足这个条件，算法就会按错误的输入给出错误的结果。

还有一个更隐蔽的来源：workerId 撞车。两台机器配置里都写着 `worker-id: 1`，同一毫秒各自生成序列号 0，拼出来的 ID 完全一样。这跟时间没关系，但现象一模一样，排查时容易查错方向。

## 二、时钟回拨的底层原理和三种处理思路

结论：回拨本身不可怕，可怕的是代码把「时间变小」当成了「新的一毫秒」，顺手把序列号清零。

### 2.1 一次 ID 生成到底做了什么

生成逻辑可以压缩成四步：

1. 取当前毫秒 `now`。
2. 和上一次生成用的时间 `lastTimestamp` 比。
3. 相等，说明还在同一毫秒里，序列号加一；加到 4096 溢出，就自旋等到下一毫秒，序列号归零。
4. 不相等，说明换了一毫秒，序列号直接归零。

问题就出在第 4 步。`now != lastTimestamp` 这个判断，把「时间前进」和「时间倒退」混在了一起。假设上一次在 `T` 毫秒生成了 ID，序列号用到 37；NTP 把时间拨回 `T-300` 毫秒，下一次取到 `now = T-300`，判断为「不相等」，序列号归零，于是发出 `(T-300, 机器1, 0)`。

这组参数在 300 毫秒前已经发过了。ID 重复。

### 2.2 时间为什么会倒退

生产环境里，时钟倒退基本是这几种原因：

- **NTP 步进校正**：机器启动时时间和标准时间差得多，NTP 一次性把时间「跳」过去。跳的方向可能是往回。
- **人工改时间**：运维排障时执行了 `date -s`，改完忘了改回来。
- **虚拟机暂停与恢复**：宿主机挂起、快照恢复、热迁移，客户机里的时钟会落后一截。
- **闰秒处理**：部分系统用「抹平」的方式处理闰秒，表现为几十毫秒的异常。

NTP 正常运行时是「慢慢追」，每次调整零点几毫秒，影响很小。真正伤人的是启动阶段的大步跳变，以及虚拟化环境里的暂停。

### 2.3 41 位和 12 位到底能撑多久

41 位毫秒时间戳，能表示 2^41 毫秒，约 69.7 年。纪元定在 2025-01-01，够用到 2094 年。改纪元等于换了一套 ID 空间，上线后不能再动。

12 位序列号，意味着单台机器每毫秒最多发 4096 个 ID，也就是理论上限约 409.6 万个/秒。超过这个量，生成线程会自旋等下一毫秒。这个上限对绝大多数业务够用，但秒杀场景要提前算容量。

### 2.4 三种处理思路，我推荐第二种

**第一种：等时间追上来。** 回拨 2 毫秒，就自旋等到 `lastTimestamp`，再继续发。实现简单，代价是这几毫秒内生成线程被阻塞。适合小幅回拨。

**第二种：超过阈值直接失败。** 回拨在 5 毫秒内，等待追平；超过 5 毫秒，抛异常，让上游重试或告警。听起来粗暴，但它保证「宁可短时间不可用，也不发重复 ID」。订单主键重复是数据事故，接口报错只是可用性问题，两者不是一个量级。

**第三种：借用未来时间或切换 workerId。** 不回退时间，继续用 `lastTimestamp` 往后发，序列号溢出就等；或者临时换一个没被用过的 workerId。美团 Leaf、百度 uid-generator 走的就是这类路线，能扛住较大回拨，但要额外维护 workerId 池和状态，复杂度高一个档次。

我的选择是第一种加第二种：小幅等待，大幅快速失败。理由很直接——回拨超过几毫秒，说明机器的时间管理已经出问题了，这时候继续硬扛，等于把风险藏起来。让异常冒出来，比悄悄发重复 ID 强。

## 三、实战：Spring Boot 里写一个能上线的雪花 ID 生成器

结论：核心生成器不超过 120 行，配上配置和 Controller 就能跑，关键是回拨分支要写对。

### 3.1 完整的 pom.xml

只依赖 Web 和测试。Spring Boot 4 里 `spring-boot-starter-web` 已经标记为废弃，新项目直接用 `spring-boot-starter-webmvc`。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>snowflake-id-demo</artifactId>
    <version>1.0.0</version>
    <name>snowflake-id-demo</name>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.1</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.1</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 3.2 核心类：SnowflakeIdGenerator

这个类做了四件事：校验 workerId 范围、处理回拨、在同一毫秒内递增序列号、把各段拼成 long。

回拨的处理写在 `nextId()` 开头：先算回拨了多少毫秒，超过 `maxBackwardMs` 直接抛 `IllegalStateException`；没超过就自旋等到 `lastTimestamp`。等到之后，代码会走「同一毫秒」分支，序列号接着上次的值继续加，不会归零，所以不会重复。

```java
package com.example.snowflake.id;

public class SnowflakeIdGenerator {

    private static final long EPOCH = 1735689600000L;

    private static final long WORKER_ID_BITS = 5L;
    private static final long DATACENTER_ID_BITS = 5L;
    private static final long SEQUENCE_BITS = 12L;

    private static final long MAX_WORKER_ID = ~(-1L << WORKER_ID_BITS);
    private static final long MAX_DATACENTER_ID = ~(-1L << DATACENTER_ID_BITS);
    private static final long SEQUENCE_MASK = ~(-1L << SEQUENCE_BITS);

    private static final long WORKER_ID_SHIFT = SEQUENCE_BITS;
    private static final long DATACENTER_ID_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS;
    private static final long TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS + DATACENTER_ID_BITS;

    private final long workerId;
    private final long datacenterId;
    private final long maxBackwardMs;

    private long sequence = 0L;
    private long lastTimestamp = -1L;

    public SnowflakeIdGenerator(long workerId, long datacenterId, long maxBackwardMs) {
        if (workerId < 0 || workerId > MAX_WORKER_ID) {
            throw new IllegalArgumentException("workerId 必须在 0 到 " + MAX_WORKER_ID + " 之间");
        }
        if (datacenterId < 0 || datacenterId > MAX_DATACENTER_ID) {
            throw new IllegalArgumentException("datacenterId 必须在 0 到 " + MAX_DATACENTER_ID + " 之间");
        }
        if (maxBackwardMs < 0) {
            throw new IllegalArgumentException("maxBackwardMs 不能为负数");
        }
        this.workerId = workerId;
        this.datacenterId = datacenterId;
        this.maxBackwardMs = maxBackwardMs;
    }

    public synchronized long nextId() {
        long timestamp = System.currentTimeMillis();

        if (timestamp < EPOCH) {
            throw new IllegalStateException("系统时间早于纪元时间，检查机器时钟");
        }

        if (timestamp < lastTimestamp) {
            long backward = lastTimestamp - timestamp;
            if (backward > maxBackwardMs) {
                throw new IllegalStateException(
                        "时钟回拨 " + backward + " 毫秒，超过容忍上限 " + maxBackwardMs + " 毫秒，拒绝生成 ID");
            }
            timestamp = waitUntil(lastTimestamp);
        }

        if (timestamp == lastTimestamp) {
            sequence = (sequence + 1) & SEQUENCE_MASK;
            if (sequence == 0L) {
                timestamp = waitNextMillis(lastTimestamp);
            }
        } else {
            sequence = 0L;
        }

        lastTimestamp = timestamp;

        return ((timestamp - EPOCH) << TIMESTAMP_SHIFT)
                | (datacenterId << DATACENTER_ID_SHIFT)
                | (workerId << WORKER_ID_SHIFT)
                | sequence;
    }

    public static String describe(long id) {
        long timestamp = (id >> TIMESTAMP_SHIFT) + EPOCH;
        long datacenterId = (id >> DATACENTER_ID_SHIFT) & MAX_DATACENTER_ID;
        long workerId = (id >> WORKER_ID_SHIFT) & MAX_WORKER_ID;
        long sequence = id & SEQUENCE_MASK;
        return "timestamp=" + timestamp
                + ", datacenterId=" + datacenterId
                + ", workerId=" + workerId
                + ", sequence=" + sequence;
    }

    private long waitUntil(long target) {
        long timestamp = System.currentTimeMillis();
        while (timestamp < target) {
            Thread.onSpinWait();
            timestamp = System.currentTimeMillis();
        }
        return timestamp;
    }

    private long waitNextMillis(long lastTimestamp) {
        long timestamp = System.currentTimeMillis();
        while (timestamp <= lastTimestamp) {
            Thread.onSpinWait();
            timestamp = System.currentTimeMillis();
        }
        return timestamp;
    }
}
```

`nextId()` 上的 `synchronized` 是必需的。序列号和 `lastTimestamp` 是共享状态，两个线程同时读到相同的 `lastTimestamp`，就会拿到相同的序列号。有人担心锁的性能，实测单次生成在几十纳秒到一百纳秒量级，远不是瓶颈。

`waitUntil` 里没有用 `Thread.sleep(1)`。睡 1 毫秒，实际可能睡 1.5 毫秒甚至更多，起来时时间早就过了，白白拉低吞吐。`Thread.onSpinWait()` 只是给 CPU 一个提示，让超线程上的另一个逻辑核优先干活，不会让出时间片，适合几毫秒以内的短等待。

### 3.3 配置类：把生成器注册成 Bean

workerId 从配置读，不写死在代码里。这样同一份包在不同机器上可以用环境变量区分。

```java
package com.example.snowflake.config;

import com.example.snowflake.id.SnowflakeIdGenerator;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class IdConfig {

    @Bean
    public SnowflakeIdGenerator snowflakeIdGenerator(
            @Value("${app.snowflake.worker-id}") long workerId,
            @Value("${app.snowflake.datacenter-id}") long datacenterId,
            @Value("${app.snowflake.max-backward-ms:5}") long maxBackwardMs) {
        return new SnowflakeIdGenerator(workerId, datacenterId, maxBackwardMs);
    }
}
```

### 3.4 启动类

```java
package com.example.snowflake;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class SnowflakeApplication {

    public static void main(String[] args) {
        SpringApplication.run(SnowflakeApplication.class, args);
    }
}
```

### 3.5 Controller：ID 以字符串返回

这一点很关键。long 最大能到 9.22e18，JavaScript 的 Number 只能精确表示到 2^53（约 9.0e15）。雪花 ID 现在大约在 2.4e17 量级，直接当 JSON 数字返回，前端解析后末尾几位会变成 0，再拿这个 ID 回查，查不到。

```java
package com.example.snowflake.web;

import com.example.snowflake.id.SnowflakeIdGenerator;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/ids")
public class IdController {

    private final SnowflakeIdGenerator generator;

    public IdController(SnowflakeIdGenerator generator) {
        this.generator = generator;
    }

    @GetMapping
    public Map<String, String> nextId() {
        long id = generator.nextId();
        return Map.of(
                "id", Long.toString(id),
                "detail", SnowflakeIdGenerator.describe(id)
        );
    }
}
```

### 3.6 配置文件

```yaml
server:
  port: 8080

spring:
  application:
    name: snowflake-id-demo

app:
  snowflake:
    worker-id: ${SNOWFLAKE_WORKER_ID:1}
    datacenter-id: ${SNOWFLAKE_DATACENTER_ID:1}
    max-backward-ms: 5
```

### 3.7 并发唯一性测试

8 个线程各生成 5000 个 ID，用 `Set` 去重后比对数量。这个测试能抓住「序列号没加锁」这类低级错误。

```java
package com.example.snowflake.id;

import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

class SnowflakeIdGeneratorTest {

    @Test
    void 多线程并发生成不产生重复ID() throws InterruptedException {
        SnowflakeIdGenerator generator = new SnowflakeIdGenerator(1, 1, 5);

        int threads = 8;
        int perThread = 5000;
        Set<Long> ids = ConcurrentHashMap.newKeySet();
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(threads);
        ExecutorService pool = Executors.newFixedThreadPool(threads);

        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                try {
                    start.await();
                    for (int j = 0; j < perThread; j++) {
                        ids.add(generator.nextId());
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }

        start.countDown();
        done.await(30, TimeUnit.SECONDS);
        pool.shutdown();

        assertEquals(threads * perThread, ids.size());
    }
}
```

启动后访问 `curl http://localhost:8080/api/ids`，会得到类似 `{"id":"1834567890123456789","detail":"timestamp=..., datacenterId=1, workerId=1, sequence=12"}` 的结果。`describe` 用来反解 ID，线上排查时不用再手算位运算。

## 四、踩坑经验和最佳实践

结论：雪花算法的坑，一半在时钟，一半在部署。代码写对只是及格线。

**workerId 千万别手抄。** 我见过最典型的事故：新机器扩容，运维复制了旧机器的配置文件，两台 `worker-id` 都是 3。压测时没并发，看不出来；上线后订单 ID 开始撞主键。正确做法是启动时统一分配：从配置中心读、从 Redis 用 `INCR` 领号、或者用注册中心分配。机器数少于 32 台时，也可以用「IP 最后一段 % 32」兜底，但要接受哈希碰撞的可能，并且记录到日志里。

**启动时把 workerId 打出来。** 一行日志，能省掉几小时排查。配合健康检查接口暴露当前 workerId 和 datacenterId，出问题时一眼就能看出两台机器是不是撞了。

**回拨异常要接监控。** `IllegalStateException` 抛出来不是让你在日志里翻的，要接到告警上。短时间内多次触发，基本可以确定是 NTP 配置有问题，去看 `chronyc tracking`，把 `makestep` 限制在合理范围，别让它每次启动都大步跳。

**序列号溢出不是异常，是容量信号。** 单机持续打满 4096/毫秒，说明这台机器的写入压力已经到了设计上限。这时候要么加机器分摊，要么换号段模式。别等到自旋时间变长、接口 RT 抖动才反应过来。

**纪元一旦上线不能改。** 改纪元等于把所有时间戳整体平移，新 ID 会和历史 ID 撞车。要换纪元，只能换一套 ID 空间，比如加一个业务前缀。

**多语言解析要统一。** Java 生成的 ID 给其他语言的服务或前端解析，位运算的符号处理容易出错。ID 一律用字符串传输，解析逻辑收敛到一个工具类，别每个服务各写一份。

## 五、性能对比和技术选型

结论：高并发写入场景，雪花算法是综合成本最低的方案；小系统用数据库自增更省事，别为了「分布式」三个字硬上。

| 方案 | 单机吞吐量级 | 是否趋势递增 | 外部依赖 | 适用场景 |
| --- | --- | --- | --- | --- |
| 数据库自增 | 千级到万级 | 是 | 数据库 | 单库、并发不高的后台系统 |
| UUID v4 | 百万级 | 否 | 无 | 日志追踪、临时文件名 |
| UUID v7 | 百万级 | 是 | 无 | 不想维护 workerId 的新系统 |
| Redis INCR | 十万级 | 是 | Redis | 中等规模、能接受一次网络往返 |
| 雪花算法 | 百万级（单机 4096/ms） | 是 | 时钟、workerId | 订单、支付、消息等高并发写入 |

几个选型判断：

- 业务量小、单库还能撑，直接用数据库自增。简单，事务内就能拿到 ID。
- 需要趋势递增又不想管 workerId，UUID v7 是备选。代价是 128 位，索引比 long 大一倍，MySQL 里存储和缓存效率都差一些。
- 分库分表、订单量百万级，雪花算法最合适。ID 里自带时间和机器信息，排查问题时能直接看出是哪台机器、什么时候生成的。
- 公司规模大、机器频繁扩缩容，别自己维护 workerId 池，用 Leaf 这类成熟方案。自己写的分配逻辑，早晚会在「机器下线没释放号」上翻车。

## 六、总结

结论：雪花算法的正确性，取决于你有没有认真对待「时间会倒退」这件事。

把关键点收一下：

- 64 位里，41 位时间戳决定趋势递增，10 位机器标识决定分布式唯一，12 位序列号决定单毫秒容量。
- 回拨导致重复的根因，是代码把「时间变小」误判成「新的一毫秒」，序列号归零后复用了旧的时间戳。
- 小幅回拨自旋等待，大幅回拨快速失败。宁可接口报错，不要主键重复。
- workerId 必须统一分配，启动日志必须打印，回拨异常必须告警。
- ID 对外一律用字符串，别让前端替你丢精度。

最后说句实在话：雪花算法不难，难的是把它放在一个时间不可靠、机器会漂移、配置靠人抄的环境里，还能保证不出事。代码只是其中一环，分配机制、监控、时钟同步，缺一个都可能埋雷。

## 参考资料

- [Twitter Snowflake（GitHub 归档）](https://github.com/twitter-archive/snowflake)
- [美团 Leaf：分布式 ID 生成系统](https://tech.meituan.com/2017/04/21/mt-leaf.html)
- [Spring Boot 官方文档](https://docs.spring.io/spring-boot/)
- [RFC 9562: Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562.html)

文 / 会编程的吕洞宾

---
title: "Redis内存打满key被删，Java后端先查4处"
date: 2026-10-26T09:00:00+08:00
category: "中间件"
tags: ["redis"]
---

> 周三下午，缓存命中率从 98% 掉到 62%，数据库 QPS 翻了五倍。运维查了一圈说：Redis 内存打满了，淘汰了一部分 key，属于正常现象。可被淘汰的偏偏是登录会话，用户集体掉线。内存满了就淘汰，听起来天经地义，问题在于淘汰的是谁、为什么是它。这篇把 Redis 内存淘汰从策略配置讲到内核行为，顺手给一套能直接跑的监控代码。

## 一、这个问题到底是什么

结论：Redis 内存打满后删 key，不是 bug，是 `maxmemory-policy` 这条配置在按规则办事。规则选错，删的就不是你想删的东西。

Redis 是内存数据库，所有数据都放在内存里。你给它一个上限，它就不会无限吃内存。这个上限叫 `maxmemory`，到了上限之后还能不能写、写不进去时删谁，全看 `maxmemory-policy`。

不少团队上线时为了「省事」，直接抄了一段配置：

```
maxmemory 8gb
maxmemory-policy allkeys-lru
```

`allkeys-lru` 的意思是：内存不够了，从**所有 key** 里挑最久没被访问的删掉。注意「所有」这两个字。会话、商品缓存、限流计数、分布式锁、开关配置，一视同仁。只要它最久没被访问，就优先被干掉。

配置类数据最惨。比如一个存在 Redis 里的功能开关，写进去之后再没人读过，一小时后内存吃紧，它第一个被淘汰。然后业务读到空值，走默认分支，功能悄悄关掉了，没有任何报错。

Redis 一共支持 8 种淘汰策略，区别就两件事：**从哪个池子里挑**、**按什么规则挑**。

| 策略 | 候选范围 | 挑选规则 |
| --- | --- | --- |
| noeviction | 不淘汰 | 写入直接报错 |
| allkeys-lru | 所有 key | 最久未访问 |
| allkeys-lfu | 所有 key | 访问频率最低 |
| allkeys-random | 所有 key | 随机 |
| volatile-lru | 设了过期时间的 key | 最久未访问 |
| volatile-lfu | 设了过期时间的 key | 访问频率最低 |
| volatile-random | 设了过期时间的 key | 随机 |
| volatile-ttl | 设了过期时间的 key | 剩余寿命最短 |

`allkeys-*` 和 `volatile-*` 的差别是致命的。前者连你的永久配置一起删，后者只动那些你明确标了「可以过期」的数据。

还有一条容易被忽略：**默认策略是 `noeviction`**。没配过 `maxmemory-policy` 的实例，内存满了不删任何东西，所有写命令返回 `OOM command not allowed when used memory > 'maxmemory'`。读请求正常，写请求全挂。有人把它当成「Redis 卡了」，实际是它在明确拒绝你。

判断实例到底删没删过东西，看一个指标就够：

```bash
redis-cli info stats | grep evicted_keys
```

这个数是进程启动以来累计淘汰的 key 数量，只增不减。它是累计值，不是当前值。重启归零，所以别拿它做业务统计。真正要盯的是它的**增长速度**——半小时涨几万个，说明内存在持续紧张，不是偶发抖动。

## 二、底层原理到底怎么回事

结论：Redis 的内存上限是「有效内存」，不是「物理内存」；淘汰是每次命令执行前的一次检查；LRU 是抽样估算，不是精确排序。

### 内存都花在哪了

`INFO memory` 里有几个关键字段，很多人只看第一个：

- `used_memory`：Redis 自己统计的数据内存，包含数据本身和管理这些数据的结构开销
- `used_memory_rss`：操作系统看到的进程实际占用，包含内存碎片
- `used_memory_dataset`：纯数据部分，扣掉了管理开销
- `mem_fragmentation_ratio`：`used_memory_rss / used_memory`

举个具体的。你存了 100 万个字符串 key，每个 key 平均 20 字节、value 平均 80 字节，数据本身大概 100MB。但 Redis 每个 key 都要挂一个 `dictEntry`、一个 `redisObject`，还有 jemalloc 按固定档位分配带来的空洞。实际 `used_memory` 往往是 150MB 上下，膨胀 50% 很正常。

所以「我数据才 100MB，为什么 8G 内存满了」这个问题，答案通常在管理开销、大 key、复制缓冲区、客户端输出缓冲区这四块，而不是数据本身。

碎片率也要看：

- `mem_fragmentation_ratio` 在 1.0 ~ 1.5 之间，正常
- 大于 1.8，内存碎片严重，考虑开启 `activedefrag`
- 小于 1，说明部分内存被换到 swap 了，性能会断崖式下跌

### 淘汰是在命令执行前做的

Redis 是单线程处理命令的（指命令执行主线程）。每来一条可能增加内存的命令，比如 `SET`、`LPUSH`、`HSET`，执行前都会检查一次：当前 `used_memory` 超过 `maxmemory` 了吗？

超了，就进入淘汰流程，循环删 key，直到降到上限以下，或者删不动了。这个循环有个上限，不会无限删，避免一条命令卡太久。

关键点在这里：**这个检查是按命令触发的，不是后台定时任务**。也就是说，如果一段时间没有写入，内存超了也不会被清理。反过来，一个大批量写入的脚本，可能在执行过程中反复触发淘汰。

### LRU 是抽样，不是排序

教科书上的 LRU 要维护一个完整的访问链表，内存和 CPU 成本都高。Redis 不这么干。

它给每个 key 记一个 24 位的时间戳（`lru` 字段，复用了 `redisObject` 里的空间），淘汰时随机抽 `maxmemory-samples` 个 key，默认抽 5 个，把这 5 个里最久没访问的删掉。

抽 5 个当然不准。但 Redis 做了两件事弥补：

1. 维护一个 16 个元素的候选池（pool），每次抽样结果和池里比较，留下更「老」的
2. 淘汰是持续的，一次不准，多删几轮就准了

把 `maxmemory-samples` 调到 10，精度接近真实 LRU，代价是每次淘汰多花一点 CPU。生产上 5 到 10 之间选，别调太大。

LFU 是另一套逻辑。它给每个 key 一个 8 位的计数器，访问一次按概率加一，同时对长时间不访问的 key 做衰减（`lfu-decay-time`，默认 1 分钟）。8 位最大 255，用的是对数增长，所以前几次访问涨得快，后面涨得慢。

LFU 适合「热点稳定」的场景，比如首页推荐位。LRU 适合「热点会漂移」的场景，比如突发热点新闻。选错了不会崩，但命中率会差一截。

### volatile 策略最坑的一种情况

假设你把策略设成 `volatile-lru`，同时业务代码里有一批 key 忘了设过期时间。

内存满了，Redis 去找「设了 TTL 的 key」来淘汰。找得到，正常淘汰。找不到呢？

答案是：**当作没得淘汰，写命令直接报 OOM 错误**。

这正是很多「用了 volatile-lru 还是写不进去」的根因。策略没错，是数据不符合策略的前提。`volatile-*` 系列有个硬性前提：**所有该被淘汰的 key，都必须有 TTL**。

### 删大 key 会卡住主线程

淘汰一个 key，不只是从字典里摘掉，还要释放它占的内存。如果这个 key 是一个 500 万元素的 Hash，释放过程可能几十毫秒。

Redis 4.0 之后提供了异步释放：

```
lazyfree-lazy-eviction yes
```

开了之后，淘汰时只做逻辑删除，实际内存释放交给后台线程。代价是内存回收有延迟，`used_memory` 会短暂高于实际。

大 key 本身就该拆。单个 value 超过 10KB 就要警惕，超过 1MB 基本属于设计问题。用 `MEMORY USAGE key` 可以看单个 key 的实际占用，用 `redis-cli --bigkeys` 可以扫全库。

### 主从架构下的淘汰

只有主节点做淘汰决策。主节点删掉 key 后，会生成一条 `DEL` 命令同步给从节点。

从节点自己不淘汰。所以从节点的 `maxmemory` 如果设得和主节点一样，从节点内存可能超限。这也是为什么从节点通常建议配 `maxmemory-policy noeviction`，让它只负责照抄主节点的删除动作，不自己拿主意。

### maxmemory 该设多少

不要设成物理内存的 100%。

几个必须留出来的空间：

- 主从复制缓冲区（`repl-backlog`，默认 1MB，但全量同步时会暴涨）
- AOF 重写缓冲区
- 客户端输出缓冲区（Redis 7 之后有 `maxmemory-clients` 单独限制）

经验值：`maxmemory` 设为物理内存的 60% ~ 75%。如果这台机器只跑 Redis，75%；如果和别的服务混部，60% 甚至更低。剩下的空间在 BGSAVE 时 fork 出的子进程做写时复制，也会吃掉不少。

## 三、实战：手把手搭一套可观测的缓存

结论：会话这类数据必须走 `volatile-lru` + 强制 TTL，同时要有代码层面的淘汰监控，不能等用户掉线才发现。

下面这个项目叫 `redis-memory-guard`，包含三个东西：一个带 TTL 的会话缓存、一个每 30 秒采集一次 Redis 内存指标的监控组件、一个把指标吐出来的接口。

### 项目结构

```
redis-memory-guard
├── docker-compose.yml
├── pom.xml
└── src/main
    ├── java/com/example/redisguard
    │   ├── RedisMemoryGuardApplication.java
    │   ├── monitor
    │   │   ├── RedisMemoryMonitor.java
    │   │   ├── RedisMemorySnapshot.java
    │   │   └── RedisMonitorController.java
    │   └── session
    │       ├── SessionCacheService.java
    │       └── SessionController.java
    └── resources/application.yml
```

### 起一个故意配错的 Redis

先用你准备排查的那种错误配置起一个实例，128MB 上限、`allkeys-lru`，方便复现问题。

```yaml
services:
  redis:
    image: redis:8
    container_name: redis-eviction-demo
    command:
      - redis-server
      - --maxmemory
      - 128mb
      - --maxmemory-policy
      - allkeys-lru
    ports:
      - "6379:6379"
```

启动：

```bash
docker compose up -d
```

### pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>redis-memory-guard</artifactId>
    <version>1.0.0</version>
    <name>redis-memory-guard</name>
    <description>Redis 内存淘汰监控示例</description>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.1.2</version>
        </dependency>

        <!-- Lettuce 连接池需要，不引这个 pool 配置不生效 -->
        <dependency>
            <groupId>org.apache.commons</groupId>
            <artifactId>commons-pool2</artifactId>
            <version>2.13.1</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.2</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.2</version>
            </plugin>
        </plugins>
    </build>
</project>
```

注意 `commons-pool2` 这行。很多人在 `application.yml` 里写了连接池参数，发现没生效，就是缺这个依赖——Lettuce 用的是自己的连接池实现，只有类路径上存在 `commons-pool2` 时 Spring Boot 才会启用池化配置。

### application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: redis-memory-guard
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      database: 0
      timeout: 2s
      lettuce:
        pool:
          enabled: true
          max-active: 16
          max-idle: 8
          min-idle: 2
          max-wait: 1s
```

`timeout: 2s` 是命令超时，不是连接超时。默认值是不超时，一个慢命令能把请求线程一路挂住，线上一定显式设置。

### 启动类

```java
package com.example.redisguard;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class RedisMemoryGuardApplication {

    public static void main(String[] args) {
        SpringApplication.run(RedisMemoryGuardApplication.class, args);
    }
}
```

`@EnableScheduling` 是给监控组件的定时任务用的。漏了它，`@Scheduled` 方法永远不会执行，日志一条没有，你会以为监控写错了。

### 会话缓存服务

```java
package com.example.redisguard.session;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Service
public class SessionCacheService {

    private static final String KEY_PREFIX = "session:";
    private static final Duration TTL = Duration.ofMinutes(30);

    private final StringRedisTemplate redisTemplate;

    public SessionCacheService(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public void save(String sessionId, String userId, String nickname) {
        String key = KEY_PREFIX + sessionId;

        Map<String, String> data = new LinkedHashMap<>();
        data.put("userId", userId);
        data.put("nickname", nickname);
        data.put("loginAt", String.valueOf(System.currentTimeMillis()));

        redisTemplate.opsForHash().putAll(key, data);
        // putAll 不会带过期时间，TTL 必须单独设置
        redisTemplate.expire(key, TTL);
    }

    public Map<String, String> find(String sessionId) {
        String key = KEY_PREFIX + sessionId;

        Map<Object, Object> raw = redisTemplate.opsForHash().entries(key);
        if (raw.isEmpty()) {
            return Map.of();
        }

        Map<String, String> result = new LinkedHashMap<>();
        raw.forEach((field, value) -> result.put(String.valueOf(field), String.valueOf(value)));

        // 每次读都续期，做成滑动过期
        redisTemplate.expire(key, TTL);
        return result;
    }

    public void remove(String sessionId) {
        redisTemplate.delete(KEY_PREFIX + sessionId);
    }

    public long ttlSeconds(String sessionId) {
        Long ttl = redisTemplate.getExpire(KEY_PREFIX + sessionId, TimeUnit.SECONDS);
        return ttl == null ? -2L : ttl;
    }
}
```

两个细节值得说。

`putAll` 之后单独调 `expire`，这是必须的。Redis 的 `HSET` 命令本身不带过期时间，Spring Data Redis 也没有把 TTL 揉进 `putAll` 的封装。漏了这一行，key 就是永久的，而永久 key 在 `volatile-lru` 下永远不会被淘汰——缓存只涨不降。

`find` 里的续期是滑动过期：每次访问重置 30 分钟。适合用户一直活跃的会话。如果你要的是「登录 30 分钟后必须重新认证」，那就别续期，做绝对过期。

### 会话接口

```java
package com.example.redisguard.session;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/session")
public class SessionController {

    private final SessionCacheService sessionCacheService;

    public SessionController(SessionCacheService sessionCacheService) {
        this.sessionCacheService = sessionCacheService;
    }

    @PostMapping("/{sessionId}")
    public Map<String, Object> create(@PathVariable String sessionId,
                                      @RequestParam String userId,
                                      @RequestParam String nickname) {
        sessionCacheService.save(sessionId, userId, nickname);
        return Map.of(
                "sessionId", sessionId,
                "ttlSeconds", sessionCacheService.ttlSeconds(sessionId)
        );
    }

    @GetMapping("/{sessionId}")
    public ResponseEntity<Map<String, String>> get(@PathVariable String sessionId) {
        Map<String, String> session = sessionCacheService.find(sessionId);
        if (session.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(session);
    }

    @DeleteMapping("/{sessionId}")
    public Map<String, Object> remove(@PathVariable String sessionId) {
        sessionCacheService.remove(sessionId);
        return Map.of("deleted", true);
    }
}
```

### 内存快照

```java
package com.example.redisguard.monitor;

public record RedisMemorySnapshot(long usedMemory,
                                  long usedMemoryRss,
                                  long maxMemory,
                                  long evictedKeys,
                                  long evictedDelta,
                                  String policy) {

    public static RedisMemorySnapshot empty() {
        return new RedisMemorySnapshot(0L, 0L, 0L, 0L, 0L, "unknown");
    }

    public double usedRatio() {
        if (maxMemory <= 0L) {
            return 0d;
        }
        return (double) usedMemory / maxMemory;
    }

    public double fragmentationRatio() {
        if (usedMemory <= 0L) {
            return 0d;
        }
        return (double) usedMemoryRss / usedMemory;
    }

    public String usedMemoryHuman() {
        return human(usedMemory);
    }

    public String maxMemoryHuman() {
        return maxMemory <= 0L ? "未设置" : human(maxMemory);
    }

    private static String human(long bytes) {
        if (bytes < 1024L) {
            return bytes + "B";
        }
        double kb = bytes / 1024.0;
        if (kb < 1024.0) {
            return String.format("%.1fKB", kb);
        }
        double mb = kb / 1024.0;
        if (mb < 1024.0) {
            return String.format("%.1fMB", mb);
        }
        return String.format("%.2fGB", mb / 1024.0);
    }
}
```

这是一个 record，字段不可变，适合在监控线程和 HTTP 线程之间传递。`evictedDelta` 是「本轮新增淘汰数」，比累计值有用得多——累计值只能证明「删过」，delta 才能告诉你「现在正在删」。

### 监控采集

```java
package com.example.redisguard.monitor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Properties;

@Component
public class RedisMemoryMonitor {

    private static final Logger log = LoggerFactory.getLogger(RedisMemoryMonitor.class);

    private final StringRedisTemplate redisTemplate;

    private volatile RedisMemorySnapshot latest = RedisMemorySnapshot.empty();
    private volatile long lastEvictedKeys = -1L;

    public RedisMemoryMonitor(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    @Scheduled(fixedDelay = 30_000L)
    public void collect() {
        RedisMemorySnapshot snapshot = redisTemplate.execute(
                (RedisCallback<RedisMemorySnapshot>) this::read);

        if (snapshot == null) {
            log.warn("读取 Redis INFO 失败，本次采集跳过");
            return;
        }

        latest = snapshot;

        if (snapshot.evictedDelta() > 0L) {
            log.warn("Redis 正在淘汰 key：本轮新增 {} 个，策略 {}，已用 {} / 上限 {}，碎片率 {}",
                    snapshot.evictedDelta(),
                    snapshot.policy(),
                    snapshot.usedMemoryHuman(),
                    snapshot.maxMemoryHuman(),
                    String.format("%.2f", snapshot.fragmentationRatio()));
        }
    }

    private RedisMemorySnapshot read(RedisConnection connection) {
        Properties memory = connection.serverCommands().info("memory");
        Properties stats = connection.serverCommands().info("stats");
        if (memory == null || stats == null) {
            return null;
        }

        long used = parseLong(memory.getProperty("used_memory"));
        long rss = parseLong(memory.getProperty("used_memory_rss"));
        long max = parseLong(memory.getProperty("maxmemory"));
        long evicted = parseLong(stats.getProperty("evicted_keys"));
        String policy = memory.getProperty("maxmemory_policy", "unknown");

        long delta;
        if (lastEvictedKeys < 0L) {
            delta = 0L;
        } else if (evicted < lastEvictedKeys) {
            // Redis 重启过，计数归零，这一轮整体当作新增
            delta = evicted;
        } else {
            delta = evicted - lastEvictedKeys;
        }
        lastEvictedKeys = evicted;

        return new RedisMemorySnapshot(used, rss, max, evicted, delta, policy);
    }

    private long parseLong(String value) {
        if (value == null || value.isBlank()) {
            return 0L;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    public RedisMemorySnapshot latest() {
        return latest;
    }
}
```

这段代码干的事很简单：每 30 秒通过 Redis 协议发两条 `INFO`，把文本结果解析成结构体。用 `RedisCallback` 而不是自己 new 一个 Jedis 连接，是为了复用 Spring 的连接池和超时配置，出问题也能走统一的异常处理。

`serverCommands().info("memory")` 返回的是 `Properties`，键名就是 `INFO` 输出里的字段名，全小写下划线风格。`INFO stats` 里才有 `evicted_keys`，别去 `memory` 段里找。

### 指标接口

```java
package com.example.redisguard.monitor;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/admin/redis")
public class RedisMonitorController {

    private final RedisMemoryMonitor redisMemoryMonitor;

    public RedisMonitorController(RedisMemoryMonitor redisMemoryMonitor) {
        this.redisMemoryMonitor = redisMemoryMonitor;
    }

    @GetMapping("/memory")
    public Map<String, Object> memory() {
        RedisMemorySnapshot snapshot = redisMemoryMonitor.latest();
        return Map.of(
                "usedMemory", snapshot.usedMemoryHuman(),
                "maxMemory", snapshot.maxMemoryHuman(),
                "usedRatio", String.format("%.2f%%", snapshot.usedRatio() * 100),
                "fragmentationRatio", String.format("%.2f", snapshot.fragmentationRatio()),
                "policy", snapshot.policy(),
                "evictedKeysTotal", snapshot.evictedKeys(),
                "evictedKeysLastRound", snapshot.evictedDelta()
        );
    }
}
```

### 跑起来验证

```bash
mvn spring-boot:run
```

写一个会话：

```bash
curl -X POST "http://localhost:8080/session/s-1001?userId=1001&nickname=lvdongbin"
```

返回：

```json
{"sessionId":"s-1001","ttlSeconds":1799}
```

读回来：

```bash
curl "http://localhost:8080/session/s-1001"
```

```json
{"userId":"1001","nickname":"lvdongbin","loginAt":"1792934400000"}
```

看监控：

```bash
curl "http://localhost:8080/admin/redis/memory"
```

```json
{"usedMemory":"1.2MB","maxMemory":"128.0MB","usedRatio":"0.94%","fragmentationRatio":"1.08","policy":"allkeys-lru","evictedKeysTotal":0,"evictedKeysLastRound":0}
```

想触发淘汰，往 Redis 里灌数据就行：

```bash
docker exec redis-eviction-demo redis-benchmark -n 200000 -r 200000 -d 2048 -t set -q
```

这条命令用 Redis 自带的压测工具写 20 万个随机 key，每个 value 2KB 左右，很容易把 128MB 撑满。灌到超过上限，再看 `/admin/redis/memory`，`evictedKeysLastRound` 就不是 0 了，日志里也会出现 `Redis 正在淘汰 key` 的告警。

这套代码的价值不在监控本身，在于**把「淘汰正在发生」变成一个你能收到信号的数字**。缓存命中率下跌是滞后的，淘汰计数是实时的。

## 四、踩坑经验和最佳实践

结论：Redis 内存问题，八成出在「key 没 TTL」和「maxmemory 设太大」这两件事上。

**坑一：`HSET`、`LPUSH` 之后忘了 `EXPIRE`**

Redis 的过期时间挂在 key 上，不在 field 上。你往一个 Hash 里不断加 field，key 本身的 TTL 不会因为写入而重置，也不会自动产生。

一个真实案例：某项目的用户画像缓存，代码里写的是 `opsForHash().putAll(key, map)`，从来没设过期。上线三个月，这个 Hash 涨到 2000 多万个 key，占满整个实例。内存报警时，第一批被 `allkeys-lru` 干掉的是登录会话。

修法不是加内存，是在写入的地方补一句 `expire`。所有写缓存的方法，TTL 必须是必填参数，不能有默认值。

**坑二：`maxmemory` 设成物理内存的 100%**

设满了会怎样？`used_memory` 确实不会超，但 `used_memory_rss` 会。BGSAVE 时 fork 出的子进程做写时复制，需要额外的物理内存。Linux 的 OOM Killer 会把 Redis 进程干掉，日志里留下一条 `Killed`，没有任何 Redis 自己的错误信息。

更隐蔽的是 swap。物理内存不够，系统把 Redis 的页换到磁盘，`mem_fragmentation_ratio` 会掉到 1 以下。这时候 Redis 还能跑，但每次访问冷数据都是磁盘 IO，延迟从 0.2ms 变成 20ms，监控上看不出错，只觉得「Redis 变慢了」。

**坑三：只看 `used_memory`，不看 `used_memory_rss`**

Redis 释放了 1GB 数据，`used_memory` 立刻降下来，但 `used_memory_rss` 不一定降。jemalloc 不总是把内存还给操作系统。

这不算泄漏。只要碎片率稳定在 1.5 以内，就不用管。但如果 `used_memory_rss` 持续上涨而 `used_memory` 不涨，那就是真碎片了，开 `activedefrag yes`，或者找个低峰期重启一次。

**坑四：`volatile-lru` 配一堆无 TTL 的 key**

前面讲过原理，这里说现象。表现是：内存没满，写命令却报 `OOM command not allowed`。运维一看 `maxmemory` 还有余量，彻底懵。

排查方法一条命令：

```bash
redis-cli info keyspace
```

输出里每个 db 有两列关键数据：`keys` 总数、`expires` 有 TTL 的 key 数。如果 `expires` 是 0 或者远小于 `keys`，那 `volatile-*` 策略基本等于 `noeviction`。

最佳实践清单：

- 缓存类数据一律走 `allkeys-lru`，并且**所有** key 都有 TTL，双保险
- 缓存和「不能丢的数据」混部时，用 `volatile-lru`，同时用脚本定期扫没有 TTL 的 key
- 会话、验证码、限流计数，单独一个实例或者单独一个 db，别和业务缓存抢内存
- `maxmemory` 留 25% 以上的物理内存给 fork、复制缓冲、客户端缓冲
- 开 `lazyfree-lazy-eviction yes`，避免删大 key 卡住主线程
- 把 `evicted_keys` 的增长速率接进告警，阈值按业务定，比如 5 分钟内新增超过 1000 就报

清单里最要紧的是这一条。绝大多数 Redis 内存事故，不是没有监控，是监控只看了内存使用率，没看淘汰速率。

## 五、性能对比和技术选型

结论：淘汰策略的 CPU 开销差异很小，选型的关键是「数据能不能丢」，不是「哪个更快」。

不同策略的淘汰开销对比：

| 策略 | 每次淘汰的额外开销 | 命中率表现 | 适用场景 |
| --- | --- | --- | --- |
| noeviction | 无（直接拒绝写入） | 不适用 | 存不能丢的数据，如队列、配置 |
| allkeys-lru | 抽样 5 个 key，比较时间戳 | 热点漂移场景好 | 纯缓存实例 |
| allkeys-lfu | 抽样 + 计数比较 | 热点稳定场景更好 | 推荐位、榜单 |
| allkeys-random | 几乎为零 | 最差，不推荐 | 几乎不用 |
| volatile-lru | 同 allkeys-lru | 取决于 TTL 覆盖率 | 缓存与持久数据混部 |
| volatile-ttl | 比较剩余 TTL | 中等 | 明确按时间淘汰的场景 |

几个实测出来的经验值：

`maxmemory-samples` 从 5 调到 10，命中率提升大约 1~3 个百分点，CPU 开销增加不到 1%。值得调。

`lazyfree-lazy-eviction` 开启后，淘汰大 key 的延迟从几十毫秒降到微秒级，代价是内存回收滞后几秒。高并发写入场景建议开。

`activedefrag` 会持续消耗 CPU（默认占用一个后台线程），碎片率低于 1.5 时别开。

选型的判断顺序，我建议这样：

1. 这份数据丢了会不会有业务故障？会 → `noeviction`，单独实例
2. 不会，但和别的数据混在一个实例？→ `volatile-lru`，强制所有缓存 key 带 TTL
3. 整个实例都是缓存？→ `allkeys-lru`，简单直接

别为了「更精确」去选 LFU。LFU 的计数衰减参数很难调，调不好会出现「新热点永远进不来」，因为老 key 的计数太高。除非你有明确的热点稳定性判断，否则 LRU 更稳。

## 六、总结

Redis 内存打满之后删 key，是设计行为，不是故障。真正要问的是三个问题：删的是哪批 key、为什么是它们、下次还会不会删到关键数据。

`maxmemory-policy` 决定了候选池。`allkeys-*` 连永久数据一起删，`volatile-*` 只动有 TTL 的 key。选 `volatile-*` 却不给 key 设 TTL，等于把实例变成 `noeviction`，写请求全部报错。

`maxmemory` 不要顶满物理内存。留 25% 以上给 fork、复制缓冲和客户端缓冲，否则 OOM Killer 会在某个凌晨替你做一个更粗暴的决定。

监控上，`used_memory` 只能告诉你「快满了」，`evicted_keys` 的增速才能告诉你「已经开始删了」。把后者接进告警，比盯着内存使用率有用得多。

代码层面，TTL 应该是写缓存的必填项，不是可选项。这一条守住了，`volatile-lru` 才有意义。

## 参考资料

- [Key eviction - Redis Docs](https://redis.io/docs/latest/develop/reference/eviction/)
- [INFO - Redis Docs](https://redis.io/docs/latest/commands/info/)
- [MEMORY USAGE - Redis Docs](https://redis.io/docs/latest/commands/memory-usage/)
- [Redis configuration - Redis Docs](https://redis.io/docs/latest/operate/oss_and_stack/management/config/)
- [Spring Data Redis Reference](https://docs.spring.io/spring-data/redis/reference/)

文 / 会编程的吕洞宾

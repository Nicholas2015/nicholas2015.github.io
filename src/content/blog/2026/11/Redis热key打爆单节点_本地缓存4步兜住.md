---
title: "Redis热key打爆单节点，本地缓存4步兜住"
date: 2026-11-16T09:00:00+08:00
category: "中间件"
tags: ["redis"]
---

> 压测那天，商品详情接口 QPS 冲到 12 万，Redis 集群六台机器，只有一台 CPU 顶到 100%，另外五台在发呆。查下来是一个爆款商品，四成请求读的是同一个 key。集群按 key 分片，同一个 key 永远落在同一个节点，加机器加了个寂寞。这篇文章讲清楚热 key 为什么绕不开单分片、本地缓存凭什么快三个数量级，以及一套能直接跑起来的二级缓存代码——包含广播失效和防击穿。

## 一、热key到底热在哪，为什么加机器没用

**热 key 不是「访问量大的 key」，是「能把单个 Redis 分片打满的 key」。两者差着一个数量级。**

先看数据长什么样。一个商品详情接口，日 QPS 平均 8000，看着很温和。可一旦某个商品上了首页秒杀位，它的请求占比能从 1% 跳到 40%。12 万 QPS 里 4.8 万打在 `product:detail:10086` 这一个 key 上。

Redis Cluster 的分片规则是 `CRC16(key) % 16384`，算出来是哪个槽，就归哪个节点管。这条规则有个必然结果：**同一个 key 只会落在一个节点上**。你加十台机器，那 4.8 万 QPS 还是全砸在同一台上。

判断一个 key 是不是热 key，看三个信号：

| 信号 | 阈值 | 说明 |
| --- | --- | --- |
| 单节点 CPU | 持续 > 70%，其他节点 < 20% | 最直观，监控里一眼能看出偏斜 |
| 单 key QPS 占比 | 超过总 QPS 的 10% | 说明流量集中，不是均匀分布 |
| 单节点网络出带宽 | 接近网卡上限 | 大 value 的热 key 先撞网卡，不是 CPU |

发现热 key 有四种路子，别只依赖一种：

- `redis-cli --hotkeys`：要先把淘汰策略设成 `allkeys-lfu`，它是扫 LFU 计数器找出来的，成本低，但只在有淘汰压力时准
- `MONITOR`：能抓到真实命令流，但会拖慢实例，只能开几秒采样，生产上慎用
- 客户端埋点：在自己代码里统计每个 key 的访问次数，最准，也最贴合业务（本文的代码走这条）
- 代理层统计：Twemproxy、Codis 这类代理天然能看到所有命令，有的话直接查

第三种最值得做。理由很实在：热 key 往往对应具体业务对象（爆款商品、热门活动、头部主播的房间），你能提前从运营那边知道下个月谁要上首页。监控只能事后发现，业务能提前预判。

## 二、原理：单线程、RTT 和三个数量级

**热 key 撞的是 Redis 的单线程执行模型，本地缓存绕开的正是这一次网络往返。**

### Redis 为什么单分片会满

Redis 处理命令是单线程的（网络 IO 多线程，命令执行还是单线程）。一条 `GET` 走完「读 socket → 解析 → 查哈希表 → 写回 socket」，在普通 8 核机器上，单实例大概能顶 10 万到 15 万 QPS 的简单命令。这是量级，不是精确值，跟 value 大小、网卡、客户端连接数都有关。

超过这个量级会怎样？不会报错。命令在 socket 缓冲区排队，客户端看到的是延迟从 0.3ms 涨到 20ms、80ms、200ms，然后超时。上游线程池被慢请求占满，整个接口雪崩。**Redis 挂了的时候通常不是「不可用」，是「很慢」**，这个区别很重要，慢比挂更难排查。

### 为什么扩容治不好

集群解决的是两件事：数据量装不下、总吞吐不够。它不解决「单个 key 太热」。

槽位迁移也一样。你把热 key 所在的槽迁到一台空机器上，那台机器立刻变成新的热点，等于把火从一个炉子搬到另一个炉子。

真要分散，只有两条路：把 key 拆开（比如 `product:detail:10086:shard:1..8`，读的时候随机选一个），或者干脆不让请求到 Redis——这就是本地缓存。

### 本地缓存凭什么快

一次 Redis 查询的耗时里，真正算哈希表的部分是微秒级，大头是网络：建立 socket 读写、序列化、内核态用户态来回切。同机房 RTT 通常 0.2~0.5ms。

进程内缓存就是一次 HashMap 查找加一次数组下标计算，百纳秒级。**0.3ms 和 0.0003ms，差了三个数量级。**

放到 12 万 QPS 的场景下，这个差距就是「要 6 台 Redis」和「要 1 台 Redis + 每台应用多 200MB 堆」的区别。

### Caffeine 为什么比 HashMap 合适

自己拿 `ConcurrentHashMap` 也能做，但你会缺三样东西：容量上限、过期、淘汰策略。

Caffeine 用的是 W-TinyLFU：先用一个频率草图（Count-Min Sketch）记录访问频次，再用窗口 LRU 兜住突发流量。效果是「访问过一次的冷数据」抢不掉「访问一万次的热数据」，命中率明显高于纯 LRU。热点集中的场景，这个策略正合适。

还有个白送的能力：`cache.get(key, loader)` 对同一个 key 是串行的。一百个线程同时查一个没缓存的 key，只有一个线程执行 loader，其他线程等它的结果。这就是防击穿，不用自己写分布式锁。

### 一致性才是真难点

本地缓存最大的坑不是性能，是多实例下的数据不一致。

商品改了价，A 实例的本地缓存还是旧价，B 实例已经刷新了，用户刷新页面看到两个价格——这种事故在电商是要赔钱的。

常见的三种处理：

1. **只设极短 TTL**（1~3 秒）。简单，但改价后最多 3 秒才生效，运营改完价格刷新看不到变化会来问你
2. **Redis 的 key 变更时，用 Pub/Sub 广播失效消息**。生效快（毫秒级），但消息不持久化，实例掉线期间的消息就丢了
3. **两者叠加**。广播负责快，TTL 负责兜底

选第三种。广播丢了最多脏 2 秒，这个上限是你说得出口的；只靠广播，丢了就是永久脏，说不出上限。

整体结构长这样：

```
请求 → 本地 Caffeine（命中 ~0.3μs）
          ↓ 未命中
       Redis（命中 ~0.3ms）
          ↓ 未命中
       MySQL（~20ms）
          ↓
       回填 Redis + 回填本地

写请求 → 更新 MySQL → 删 Redis → Pub/Sub 广播 → 各实例删本地
```

## 三、实战：一套能跑起来的热 key 二级缓存

代码分七块：依赖、配置、领域对象、模拟数据库、查询服务、失效监听、接口层。全部贴全，复制即可运行。本地起一个 Redis 就能跑，单机和集群都行。

### 3.1 pom.xml

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
    <artifactId>hotkey-cache</artifactId>
    <version>1.0.0</version>
    <name>hotkey-cache</name>

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
        <dependency>
            <groupId>com.github.ben-manes.caffeine</groupId>
            <artifactId>caffeine</artifactId>
            <version>3.3.1</version>
        </dependency>
        <dependency>
            <groupId>org.apache.commons</groupId>
            <artifactId>commons-pool2</artifactId>
            <version>2.13.1</version>
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

`commons-pool2` 不是可选项。Lettuce 默认用一条共享连接，配置了 `lettuce.pool` 却没有这个依赖时，连接池配置会被静默忽略，压测时你会看到所有请求排在同一条连接上。

### 3.2 application.yml

```yaml
server:
  port: 8080
  tomcat:
    threads:
      max: 400

spring:
  application:
    name: hotkey-cache
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      timeout: 500ms
      lettuce:
        pool:
          max-active: 64
          max-idle: 32
          min-idle: 8
          max-wait: 200ms

logging:
  level:
    com.example.hotkey: INFO
```

用集群的话，把 `host` / `port` 换成 `cluster.nodes` 列表，其余不动：

```yaml
spring:
  data:
    redis:
      timeout: 500ms
      cluster:
        nodes:
          - 10.0.1.11:6379
          - 10.0.1.12:6379
          - 10.0.1.13:6379
        max-redirects: 3
      lettuce:
        pool:
          max-active: 64
          max-idle: 32
          min-idle: 8
          max-wait: 200ms
```

### 3.3 启动类

```java
package com.example.hotkey;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class HotKeyCacheApplication {

    public static void main(String[] args) {
        SpringApplication.run(HotKeyCacheApplication.class, args);
    }
}
```

`@EnableScheduling` 是给后面热 key 统计的定时任务用的，不要可以删。

### 3.4 领域对象

```java
package com.example.hotkey.domain;

import java.math.BigDecimal;

/**
 * version 是全局递增的写入版本号，本地缓存失效时用它判断新旧。
 */
public record Product(Long id, String name, BigDecimal price, int stock, long version) {
}
```

用 record 而不是写一堆 getter/setter。序列化成 JSON 时字段名就是 `id`、`name`、`price`、`stock`、`version`，读写两端一致。

### 3.5 模拟数据库

```java
package com.example.hotkey.repository;

import com.example.hotkey.domain.Product;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 用内存 Map 假装是 MySQL。真实项目里换成 JdbcTemplate 或 MyBatis 代码，其余逻辑不用动。
 */
@Repository
public class ProductRepository {

    private final Map<Long, Product> table = new ConcurrentHashMap<>();
    private final AtomicLong versionSeq = new AtomicLong(1);

    public ProductRepository() {
        table.put(1L, new Product(1L, "机械键盘 87 键", new BigDecimal("399.00"), 1200, versionSeq.getAndIncrement()));
        table.put(2L, new Product(2L, "显示器 27 寸 2K", new BigDecimal("1299.00"), 300, versionSeq.getAndIncrement()));
    }

    public Product findById(Long id) {
        sleep(20);
        return table.get(id);
    }

    public Product updatePrice(Long id, BigDecimal price) {
        Product updated = table.computeIfPresent(id, (key, old) ->
                new Product(old.id(), old.name(), price, old.stock(), versionSeq.getAndIncrement()));
        sleep(5);
        return updated;
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

那两行 `sleep` 是故意留的，模拟一次数据库往返。压测时你能清楚看到命中本地缓存和穿透到库的区别。

### 3.6 缓存 key 和本地缓存配置

```java
package com.example.hotkey.cache;

public final class CacheKeys {

    public static final String PRODUCT_KEY_PREFIX = "product:detail:";
    public static final String INVALIDATE_CHANNEL = "cache:invalidate:product";

    private CacheKeys() {
    }

    public static String productKey(Long id) {
        return PRODUCT_KEY_PREFIX + id;
    }
}
```

```java
package com.example.hotkey.config;

import com.example.hotkey.domain.Product;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class LocalCacheConfig {

    /**
     * 一级缓存：最多 1 万个商品，写入 2 秒后过期。
     * 2 秒不是随便定的，它是「广播消息丢了之后，最多脏多久」的上限。
     */
    @Bean
    public Cache<Long, Product> localProductCache() {
        return Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofSeconds(2))
                .recordStats()
                .build();
    }
}
```

### 3.7 查询服务：读路径、写路径、热 key 统计

```java
package com.example.hotkey.service;

import com.example.hotkey.cache.CacheKeys;
import com.example.hotkey.domain.Product;
import com.example.hotkey.repository.ProductRepository;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.stats.CacheStats;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.LongAdder;

@Service
public class ProductQueryService {

    private static final Logger log = LoggerFactory.getLogger(ProductQueryService.class);

    /** Redis 侧 TTL。本地缓存有广播失效，Redis 侧可以设长一些。 */
    private static final Duration REDIS_TTL = Duration.ofMinutes(10);

    /** 空值占位符，防穿透。 */
    private static final String NULL_VALUE = "__NULL__";

    private static final ObjectMapper MAPPER = JsonMapper.builder().build();

    private final Cache<Long, Product> localCache;
    private final StringRedisTemplate redis;
    private final ProductRepository repository;

    /** 每个商品被访问的次数，用来找热 key。 */
    private final Map<Long, LongAdder> accessCounter = new ConcurrentHashMap<>();

    public ProductQueryService(Cache<Long, Product> localCache,
                               StringRedisTemplate redis,
                               ProductRepository repository) {
        this.localCache = localCache;
        this.redis = redis;
        this.repository = repository;
    }

    /**
     * 读路径：本地缓存 → Redis → 数据库。
     * localCache.get(id, loader) 对同一个 key 只会有一个线程执行 loader，天然防击穿。
     */
    public Product getProduct(Long id) {
        accessCounter.computeIfAbsent(id, key -> new LongAdder()).increment();
        return localCache.get(id, this::loadThrough);
    }

    private Product loadThrough(Long id) {
        String key = CacheKeys.productKey(id);

        String cached = redis.opsForValue().get(key);
        if (NULL_VALUE.equals(cached)) {
            return null;
        }
        if (cached != null) {
            return MAPPER.readValue(cached, Product.class);
        }

        Product product = repository.findById(id);
        if (product == null) {
            redis.opsForValue().set(key, NULL_VALUE, Duration.ofSeconds(30));
            return null;
        }
        redis.opsForValue().set(key, MAPPER.writeValueAsString(product), REDIS_TTL);
        return product;
    }

    /**
     * 写路径：先改库，再删 Redis，最后广播让所有实例删本地。
     * 三步顺序不能换，理由见第四节。
     */
    public Product updatePrice(Long id, BigDecimal price) {
        Product updated = repository.updatePrice(id, price);
        if (updated == null) {
            return null;
        }
        redis.delete(CacheKeys.productKey(id));
        redis.convertAndSend(CacheKeys.INVALIDATE_CHANNEL, id + ":" + updated.version());
        localCache.invalidate(id);
        log.info("商品价格已更新, id={}, price={}, version={}", id, price, updated.version());
        return updated;
    }

    public CacheStats localCacheStats() {
        return localCache.stats();
    }

    public Map<Long, Long> topKeys(int topN) {
        return accessCounter.entrySet().stream()
                .map(entry -> Map.entry(entry.getKey(), entry.getValue().sum()))
                .sorted(Map.Entry.<Long, Long>comparingByValue(Comparator.reverseOrder()))
                .limit(topN)
                .collect(LinkedHashMap::new, (map, entry) -> map.put(entry.getKey(), entry.getValue()), Map::putAll);
    }
}
```

几个关键点，值得单独说：

**`localCache.get(id, loader)` 而不是 `getIfPresent` + 手动回填。** 后者在缓存失效瞬间会被上百个并发请求同时打穿到 Redis 和数据库，前者在 Caffeine 内部分段加锁，同 key 只放一个线程进去。

**loader 返回 null 时不会写缓存。** 所以不存在的商品不会被本地缓存住，每次都要问一次 Redis。空值缓存放在 Redis 层做，30 秒过期——防止有人拿不存在的 ID 批量扫接口。

**写路径里调了两次失效。** 广播是给别的实例的，`localCache.invalidate(id)` 是给自己这台机器的——Pub/Sub 会不会把消息投回自己不好指望，顺手删掉最省心。

### 3.8 失效广播监听

```java
package com.example.hotkey.listener;

import com.example.hotkey.cache.CacheKeys;
import com.example.hotkey.domain.Product;
import com.github.benmanes.caffeine.cache.Cache;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;

/**
 * 订阅失效频道，收到消息就把本地缓存里的对应 key 删掉。
 * 容器自己起、自己停，不依赖自动配置。
 */
@Component
public class CacheInvalidationListener implements MessageListener, InitializingBean, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(CacheInvalidationListener.class);

    private final Cache<Long, Product> localCache;
    private final RedisConnectionFactory connectionFactory;
    private RedisMessageListenerContainer container;

    public CacheInvalidationListener(Cache<Long, Product> localCache,
                                     RedisConnectionFactory connectionFactory) {
        this.localCache = localCache;
        this.connectionFactory = connectionFactory;
    }

    @Override
    public void afterPropertiesSet() {
        container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(this, new ChannelTopic(CacheKeys.INVALIDATE_CHANNEL));
        container.afterPropertiesSet();
        container.start();
        log.info("已订阅本地缓存失效频道: {}", CacheKeys.INVALIDATE_CHANNEL);
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String payload = new String(message.getBody(), StandardCharsets.UTF_8);
        int split = payload.indexOf(':');
        if (split <= 0) {
            return;
        }
        Long id = Long.valueOf(payload.substring(0, split));
        long version = Long.parseLong(payload.substring(split + 1));

        Product cached = localCache.getIfPresent(id);
        if (cached == null) {
            return;
        }
        if (cached.version() <= version) {
            localCache.invalidate(id);
            log.info("本地缓存已失效, id={}, version={}", id, version);
        } else {
            log.info("本地缓存版本更新，跳过失效, id={}, cachedVersion={}, msgVersion={}",
                    id, cached.version(), version);
        }
    }

    @Override
    public void destroy() {
        if (container != null) {
            container.stop();
            container.destroy();
        }
    }
}
```

消息体是 `商品ID:版本号`。收到消息不急着删，先比版本号：只有「本地这份比消息还旧」时才删。

为什么需要这一步？批量改价时会连发几十条消息，网络或消费线程调度不保证顺序到达。如果旧消息把刚回填的新缓存删了，下一次请求就要多跑一趟数据库，热 key 场景下就是几十次多余的回源。带上版本号，版本更大的本地缓存不会被旧消息干掉。

版本号本身也简单：`AtomicLong` 全局递增，每次写入取一个新值。单机模拟够用；真上分布式写多实例，就把版本号换成 `UPDATE ... SET version = version + 1` 读回来，或者用 Redis 的 `INCR`。

### 3.9 接口层

```java
package com.example.hotkey.web;

import com.example.hotkey.domain.Product;
import com.example.hotkey.service.ProductQueryService;
import com.github.benmanes.caffeine.cache.stats.CacheStats;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/products")
public class ProductController {

    private final ProductQueryService queryService;

    public ProductController(ProductQueryService queryService) {
        this.queryService = queryService;
    }

    @GetMapping("/{id}")
    public ResponseEntity<Product> detail(@PathVariable Long id) {
        Product product = queryService.getProduct(id);
        return product == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(product);
    }

    @PutMapping("/{id}/price")
    public ResponseEntity<Product> updatePrice(@PathVariable Long id,
                                              @RequestParam BigDecimal price) {
        Product product = queryService.updatePrice(id, price);
        return product == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(product);
    }

    @GetMapping("/stats")
    public Map<String, Object> stats() {
        CacheStats stats = queryService.localCacheStats();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("hitRate", String.format("%.2f%%", stats.hitRate() * 100));
        result.put("hitCount", stats.hitCount());
        result.put("missCount", stats.missCount());
        result.put("topKeys", queryService.topKeys(5));
        return result;
    }
}
```

`/products/stats` 和 `/products/{id}` 不会打架，Spring 匹配时字面量路径优先于路径变量。

### 3.10 热 key 定时上报

```java
package com.example.hotkey.monitor;

import com.example.hotkey.service.ProductQueryService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class HotKeyReporter {

    private static final Logger log = LoggerFactory.getLogger(HotKeyReporter.class);

    private final ProductQueryService queryService;

    public HotKeyReporter(ProductQueryService queryService) {
        this.queryService = queryService;
    }

    @Scheduled(fixedDelay = 10_000)
    public void report() {
        Map<Long, Long> top = queryService.topKeys(5);
        if (top.isEmpty()) {
            return;
        }
        log.info("商品访问次数 Top5（累计）: {}", top);
    }
}
```

这是累计值，不是滑动窗口。每台机器各报各的，汇总才是真实分布。生产上应该把这份数据打到 Prometheus 或日志采集里，别只打在应用日志里。

### 3.11 跑起来看效果

```bash
# 起 Redis（本机）
docker run -d --name redis-hotkey -p 6379:6379 redis:8

# 起应用
mvn spring-boot:run
```

验证四个行为：

```bash
# 1. 第一次访问，穿透到库（约 20ms）
curl -s http://localhost:8080/products/1

# 2. 第二次访问，命中本地缓存（1ms 内）
curl -s http://localhost:8080/products/1

# 3. 改价，广播失效
curl -s -X PUT "http://localhost:8080/products/1/price?price=299.00"

# 4. 看命中率和热 key 排行
curl -s http://localhost:8080/products/stats
```

第 4 步的返回大概长这样：

```json
{"hitRate":"95.24%","hitCount":40,"missCount":2,"topKeys":{"1":38,"2":4}}
```

多起一个实例（`-Dserver.port=8081`）再改价，两个实例的日志会同时打出「本地缓存已失效」，这就是广播生效了。用 `redis-cli subscribe cache:invalidate:product` 也能直接看到消息。

## 四、踩坑：这六个地方我见过出事

**1. 只删本地缓存，没删 Redis**

顺序反了。本地删了，下一次请求回源到 Redis，拿到的还是旧值，又把旧值填回本地。数据永远脏，而且脏得很有迷惑性——你看日志发现「回源了」，就以为修好了。

正确顺序固定为：改库 → 删 Redis → 广播删本地。

**2. 广播消息当成可靠消息用**

Redis Pub/Sub 是发出去就不管的模型，没有持久化，没有 ACK。订阅端那一刻网络抖动、正在重启、连接重连中，消息就永远丢了。

所以本地 TTL 必须短。设 60 秒图省事，结果就是「改价一分钟后才生效」，运营会在群里 @ 你。2 秒是能接受的折中。

**3. 先删缓存再改库**

经典顺序错误。删了缓存，一个读请求立刻回源，把旧值填回缓存，然后你才改完库。缓存里存的还是旧值，等 TTL 到期才恢复。

必须先改库。做不到「改库和删缓存原子」，就用 TTL 兜底，别指望用代码顺序保证强一致。

**4. 本地缓存不设上限**

只写 `Caffeine.newBuilder().expireAfterWrite(...)` 不写 `maximumSize`，等于把 Redis 的热数据全搬进堆里，而且永不过期淘汰。堆一涨，Full GC 一来，接口延迟从 1ms 跳到 800ms——比不加缓存还惨。

`maximumSize` 和 `expireAfterWrite` 两个必须同时有。

**5. 缓存大对象**

一个商品详情里塞了 200 个 SKU、50 张图片 URL，JSON 序列化后 80KB。一万个 key 就是 800MB 堆，还没算 Caffeine 的额外结构开销。

热 key 缓存只放「渲染首屏必须的字段」。详情、评价、推荐位该拆就拆，别一个 key 打包全站数据。

**6. 序列化方式不统一**

同一个 key，A 服务用 JDK 序列化写，B 服务用 JSON 读，读出来直接反序列化异常，或者读出一个字段全 null 的对象。这类问题排查起来极其浪费时间，因为 Redis 里 `get` 出来的是一堆乱码。

统一用 JSON，key 就在 `CacheKeys` 里集中定义，别各处字符串拼接。

## 五、性能对比和技术选型

**二级缓存不是所有场景都值得上，判断标准是「单 key 的 QPS 是否超过单分片容量的 10%」。**

| 方案 | 单次读延迟 | 一致性 | 适用场景 | 代价 |
| --- | --- | --- | --- | --- |
| 纯 Redis | 0.2~0.5ms | 强（单一数据源） | QPS 均匀、无爆款 | 热 key 打满单分片 |
| 本地缓存 + Redis | 0.3μs / 0.3ms | 最终一致，秒级 | 有明显热点、能容忍秒级延迟 | 每实例多占内存，要处理失效 |
| key 打散（加随机后缀） | 0.2~0.5ms | 强 | 只需要分摊压力，读多写少 | 读要试多个 key，写要写多份 |
| Redis 读写分离 / 多副本 | 0.2~0.5ms | 有主从延迟 | 读多写少，能接受毫秒级脏读 | 主从延迟导致读到旧值 |
| Nginx / CDN 缓存 | 0.1~5ms | 弱，靠 TTL | 完全公开、无需登录的数据 | 动态内容难缓存，清缓存麻烦 |

我的建议很直接：

- 商品详情、活动页、配置开关这类「读远多于写、能忍一两秒不一致」的，上二级缓存，收益最大
- 库存、余额、订单状态这种不能脏的，别碰本地缓存，老老实实查 Redis 或库
- 只是流量大但没有明显热点的，先看分片是否均匀，别急着加缓存层
- 已经有 CDN 能挡住的静态内容，没必要再进本地缓存

一个常被忽略的成本：本地缓存让「清缓存」变成了分布式问题。以前 `redis-cli del` 一下就行，现在要保证所有实例都收到通知。团队没能力维护这套广播机制，就别上二级缓存，用 key 打散更省事。

## 六、总结

热 key 的本质是流量在单个分片上堆积，扩容和迁移槽位都解决不了。真正有效的是把这一份数据搬到离 CPU 最近的地方。

这套方案的四步，缺一步都不完整：

1. 本地 Caffeine 挡住绝大部分读，`get(key, loader)` 顺带解决击穿
2. Redis 作为二级，扛住本地未命中和多实例共享
3. 写操作走「改库 → 删 Redis → 广播删本地」，顺序不能换
4. 本地 TTL 设短（1~3 秒），给广播兜底，也让「最坏脏多久」有个能说出口的数字

别把它当银弹。本地缓存换来的性能，代价是一致性从「强」变成「秒级最终一致」，以及一套必须自己维护的失效通道。能接受这个代价的场景，收益大得离谱；不能接受的场景，一行代码都别加。

## 参考资料

- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Redis SUBSCRIBE command](https://redis.io/docs/latest/commands/subscribe/)
- [Redis PUBLISH command](https://redis.io/docs/latest/commands/publish/)
- [Caffeine Wiki — Population（含 single-flight 语义）](https://github.com/ben-manes/caffeine/wiki/Population)
- [Caffeine Wiki — Efficiency（W-TinyLFU 淘汰策略）](https://github.com/ben-manes/caffeine/wiki/Efficiency)
- [Spring Data Redis — Pub/Sub Messaging](https://docs.spring.io/spring-data/redis/reference/redis/pubsub.html)
- [Spring Boot — Common Application Properties](https://docs.spring.io/spring-boot/appendix/application-properties/index.html)

文 / 会编程的吕洞宾

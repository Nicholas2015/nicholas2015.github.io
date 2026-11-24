---
title: "多级缓存实战：Caffeine+Redis一次讲透"
date: 2026-10-03T09:00:00+08:00
category: "中间件"
tags: ["redis"]
---

**摘要**：单靠 Redis 扛热点，网络往返和序列化开销一样会拖慢接口。本文用 Spring Boot 把 Caffeine 本地缓存和 Redis 拼成两级缓存，讲清读路径回填、写路径驱逐、多实例一致性广播，附完整可运行代码。

> 商品详情页的 QPS 一上来，你会发现 Redis 也不够快：每次读都要走一次网络、反序列化一次 JSON，单机十几万 QPS 就到顶了。更要命的是热点 Key 集中在几个分片上，机器先被网卡拖垮。解决办法是往回退一步——把最热的那部分数据直接放进 JVM 堆里，让 Redis 只做第二道防线。这篇文章就讲这套「本地缓存 + Redis」的两级缓存怎么搭、怎么保证多实例数据不打架。

## 一、这个问题到底是什么

多级缓存就是让请求按代价从低到高逐层找数据，前面命中就不往后走。

一个典型的读请求，原来是：应用 → Redis → MySQL。加上本地缓存之后变成：应用 → Caffeine（JVM 堆内）→ Redis → MySQL。

- **Caffeine** 是进程内的缓存库，数据放在 JVM 堆里，读取就是一次哈希查找，没有网络、没有序列化，纳秒到微秒级。
- **Redis** 是进程外的缓存，走网络，一次读大概几百微秒到几毫秒，但所有实例共享同一份数据。
- **MySQL** 是最终数据源，最慢，但一定要尽量少碰。

只用一个 Redis 的痛点有三个，都是真实存在的：

1. **网络是固定成本**。哪怕 Redis 就部署在同机房的另一台机器上，一次往返也躲不掉。热点接口每秒调用几十万次，这点延迟会被放大成实打实的响应时间。
2. **序列化反复做无用功**。每次从 Redis 取出来的都是字节，要反序列化成对象。同一个热点对象被反复反序列化几万次，CPU 就浪费在这。
3. **热点打爆单分片**。Redis 集群按 Key 分槽，单个热点 Key 只会落在某一个节点上，那个节点的网卡和 CPU 先扛不住，其他节点再闲也没用。

本地缓存能解决上面三个问题，但它自带一个新麻烦：**每个实例都有一份自己的副本**。你改了数据库，A 实例把本地缓存清了，B 实例还捧着旧数据在返回，用户就会看到「刷新一下变了、再刷新又变回去」的鬼畜现象。

所以两级缓存真正难的不是「怎么加缓存」，而是「怎么让多份本地缓存在该失效的时候一起失效」。这是全文的核心。

## 二、底层原理到底怎么回事

**读路径的核心是「逐级回填」：谁命中就在谁那一层停下，顺便把上层补上。**

读流程拆开看：

1. 查 Caffeine，命中直接返回，这是最快的一条路。
2. 没命中，查 Redis。命中就反序列化，塞回 Caffeine，然后返回。
3. Redis 也没命中，查数据库。查到就同时写回 Redis 和 Caffeine。
4. 数据库也没有，往 Redis 写一个短 TTL 的空标记，防止同一个不存在的 ID 被反复打到数据库（这就是缓存穿透）。

**Caffeine 为什么快，值得单独说一句。** 它把数据放在 JVM 堆里，读取不涉及任何 I/O。它的淘汰算法叫 W-TinyLFU，思路是给每个 Key 记一个访问频率，淘汰时留下「最近既频繁又新鲜」的，把偶尔扫一眼的冷数据挤出去。打个比方：它是个人口管理严格的小区，门口保安按「最近来得多不多」决定谁有资格住进来，比单纯按时间先来后到（LRU）更抗突发扫描。

**写路径的核心是「Cache Aside + 广播驱逐」。** 更新数据时：

1. 先更新数据库。这一步必须在删缓存之前。
2. 删掉 Redis 里的 Key。
3. 通过 Redis 的发布订阅（Pub/Sub）发一条广播，告诉所有实例「这个 Key 作废了，把你本地那份也清掉」。

第 3 步是整套方案的关键。因为本地缓存天然是「各管各的」，你没法从外部直接把别的进程的堆内存删掉，只能靠广播通知。每个实例都订阅同一个频道，收到消息就把自己那份清掉。清完之后，下次读请求会重新走「Redis 回填」的流程，数据自然就一致了。

**TTL 要加随机抖动。** 如果一批热点 Key 的过期时间完全一样，它们会在同一秒集体失效，请求瞬间全压到数据库上，这就是缓存雪崩。给 TTL 加一个百分之几的随机偏移，让过期时间散开，就能避开这个尖峰。

**别先删缓存再更新数据库。** 很多人凭直觉先删缓存，结果在「删完、还没更新完」的窗口里，另一个读请求进来，从数据库读到旧值又写回了 Redis，旧数据被重新激活。正确顺序是「先更新库、再删缓存」；要更保险，可以用「延迟双删」——删一次、等一小会儿、再删一次，把并发窗口盖住。

## 三、实战：手把手写代码

下面这套代码可以直接跑：一个商品详情查询，带两级缓存和跨实例驱逐。数据库用一个内存 Map 模拟，并故意 sleep 80 毫秒，方便你看清缓存到底省了多少时间。

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
    <artifactId>multilevel-cache-demo</artifactId>
    <version>1.0.0</version>
    <name>multilevel-cache-demo</name>

    <properties>
        <java.version>21</java.version>
        <caffeine.version>3.3.0</caffeine.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.1.0</version>
        </dependency>
        <dependency>
            <groupId>com.github.ben-manes.caffeine</groupId>
            <artifactId>caffeine</artifactId>
            <version>3.3.0</version>
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

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: multilevel-cache-demo
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      timeout: 2000ms
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2

logging:
  level:
    com.example.multicache: debug
```

### 3. 启动类

```java
package com.example.multicache;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class MultilevelCacheApplication {

    public static void main(String[] args) {
        SpringApplication.run(MultilevelCacheApplication.class, args);
    }
}
```

### 4. 缓存配置：Caffeine 本地缓存 + Redis 广播容器

```java
package com.example.multicache.config;

import com.example.multicache.domain.Product;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class CacheConfig {

    public static final String PRODUCT_CACHE_PREFIX = "product:detail:";

    @Bean
    public Cache<Long, Product> productLocalCache() {
        return Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofMinutes(5))
                .recordStats()
                .build();
    }
}
```

```java
package com.example.multicache.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

@Configuration
public class RedisConfig {

    public static final String EVICT_TOPIC = "cache:evict:product";

    @Bean
    public RedisMessageListenerContainer redisMessageListenerContainer(RedisConnectionFactory connectionFactory) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        return container;
    }

    @Bean
    public ChannelTopic productEvictTopic() {
        return new ChannelTopic(EVICT_TOPIC);
    }
}
```

### 5. 领域对象和模拟数据库

Product 提供了无参构造和 getter/setter，保证 Jackson 反序列化不会翻车。

```java
package com.example.multicache.domain;

public class Product {

    private Long id;
    private String name;
    private Integer stock;
    private Long price;

    public Product() {
    }

    public Product(Long id, String name, Integer stock, Long price) {
        this.id = id;
        this.name = name;
        this.stock = stock;
        this.price = price;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public Integer getStock() { return stock; }
    public void setStock(Integer stock) { this.stock = stock; }

    public Long getPrice() { return price; }
    public void setPrice(Long price) { this.price = price; }
}
```

```java
package com.example.multicache.repository;

import com.example.multicache.domain.Product;
import org.springframework.stereotype.Repository;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@Repository
public class ProductRepository {

    private final Map<Long, Product> table = new ConcurrentHashMap<>();
    private final AtomicLong queryCount = new AtomicLong();

    public ProductRepository() {
        table.put(1L, new Product(1L, "机械键盘", 100, 39900L));
        table.put(2L, new Product(2L, "人体工学椅", 50, 129900L));
    }

    public Product findById(Long id) {
        queryCount.incrementAndGet();
        sleep(80);
        return table.get(id);
    }

    public void update(Product product) {
        sleep(80);
        table.put(product.getId(), product);
    }

    public long getQueryCount() {
        return queryCount.get();
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

### 6. 核心：两级缓存服务

这段代码是整个方案的心脏。读的时候一级级往下找、逐级回填；写的时候更新库、删 Redis、再广播通知所有实例清本地。

```java
package com.example.multicache.service;

import com.example.multicache.config.CacheConfig;
import com.example.multicache.config.RedisConfig;
import com.example.multicache.domain.Product;
import com.example.multicache.repository.ProductRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.benmanes.caffeine.cache.Cache;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

@Service
public class MultilevelCacheService {

    private static final Logger log = LoggerFactory.getLogger(MultilevelCacheService.class);

    private static final Duration REDIS_TTL = Duration.ofMinutes(30);
    private static final Duration NULL_TTL = Duration.ofMinutes(2);

    private final Cache<Long, Product> localCache;
    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final ProductRepository repository;
    private final RedisMessageListenerContainer listenerContainer;
    private final ChannelTopic evictTopic;

    public MultilevelCacheService(Cache<Long, Product> productLocalCache,
                                  StringRedisTemplate redis,
                                  ObjectMapper objectMapper,
                                  ProductRepository repository,
                                  RedisMessageListenerContainer listenerContainer,
                                  ChannelTopic productEvictTopic) {
        this.localCache = productLocalCache;
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.repository = repository;
        this.listenerContainer = listenerContainer;
        this.evictTopic = productEvictTopic;
    }

    @PostConstruct
    public void subscribeEvict() {
        listenerContainer.addMessageListener((message, pattern) -> {
            String id = new String(message.getBody(), StandardCharsets.UTF_8);
            localCache.invalidate(Long.valueOf(id));
            log.info("收到驱逐广播，已清掉本地缓存 product={}", id);
        }, evictTopic);
    }

    public Product getProduct(Long id) {
        Product local = localCache.getIfPresent(id);
        if (local != null) {
            return local;
        }

        String key = CacheConfig.PRODUCT_CACHE_PREFIX + id;
        String cached = redis.opsForValue().get(key);
        if (cached != null) {
            if (cached.isEmpty()) {
                return null;
            }
            Product fromRedis = readJson(cached);
            localCache.put(id, fromRedis);
            return fromRedis;
        }

        Product fromDb = repository.findById(id);
        if (fromDb == null) {
            redis.opsForValue().set(key, "", NULL_TTL);
            return null;
        }
        redis.opsForValue().set(key, writeJson(fromDb), withJitter(REDIS_TTL));
        localCache.put(id, fromDb);
        return fromDb;
    }

    public void updateProduct(Product product) {
        repository.update(product);
        evict(product.getId());
    }

    public void evict(Long id) {
        redis.delete(CacheConfig.PRODUCT_CACHE_PREFIX + id);
        localCache.invalidate(id);
        redis.convertAndSend(RedisConfig.EVICT_TOPIC, String.valueOf(id));
    }

    private Duration withJitter(Duration base) {
        long extra = ThreadLocalRandom.current().nextLong(0, base.toSeconds() / 10 + 1);
        return base.plusSeconds(extra);
    }

    private String writeJson(Product product) {
        try {
            return objectMapper.writeValueAsString(product);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("商品序列化失败", e);
        }
    }

    private Product readJson(String json) {
        try {
            return objectMapper.readValue(json, Product.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("商品反序列化失败", e);
        }
    }
}
```

### 7. Controller

```java
package com.example.multicache.controller;

import com.example.multicache.domain.Product;
import com.example.multicache.repository.ProductRepository;
import com.example.multicache.service.MultilevelCacheService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/products")
public class ProductController {

    private final MultilevelCacheService cacheService;
    private final ProductRepository repository;

    public ProductController(MultilevelCacheService cacheService, ProductRepository repository) {
        this.cacheService = cacheService;
        this.repository = repository;
    }

    @GetMapping("/{id}")
    public Product detail(@PathVariable Long id) {
        return cacheService.getProduct(id);
    }

    @PutMapping("/{id}")
    public Product update(@PathVariable Long id, @RequestBody Product product) {
        product.setId(id);
        cacheService.updateProduct(product);
        return product;
    }

    @GetMapping("/db-count")
    public long dbCount() {
        return repository.getQueryCount();
    }
}
```

### 8. 验证效果

先起一个 Redis，然后跑应用，用下面几条命令看缓存怎么起作用：

```bash
# 第一次：走完整链路 本地->Redis->数据库，耗时约 80ms
curl -s http://localhost:8080/products/1

# 第二次：命中本地缓存，几乎瞬时返回
curl -s http://localhost:8080/products/1

# 看数据库被查了几次：连续请求同一个 ID 只应该 +1
curl -s http://localhost:8080/products/db-count

# 更新数据，触发删除 + 广播驱逐
curl -s -X PUT http://localhost:8080/products/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"机械键盘 Pro","stock":88,"price":45900}'

# 更新后的第一次请求会重新回源，日志里能看到「收到驱逐广播」
curl -s http://localhost:8080/products/1
```

想验证多实例一致性，把应用用 `--server.port=8081` 再起一个，两个实例都连同一个 Redis；调 8080 的 update 接口，你就会在 8081 的日志里看到那句驱逐广播——这就是跨实例失效生效的证据。

## 四、踩坑经验和最佳实践

**别用默认的 RedisTemplate 存对象。** 默认序列化器是 JDK 序列化，写进 Redis 的 Key 会带一堆不可读的二进制前缀，`redis-cli` 里看着像乱码，排查问题非常痛苦。这里统一用 `StringRedisTemplate` 存 JSON 字符串，Key 和值都直观，跨语言也能读。

**本地缓存必须设上限。** Caffeine 不设 `maximumSize` 就等于往堆里无限塞数据，热点商品一多直接 OOM。上限和 `expireAfterWrite` 一起设，两者缺一不可：上限兜住内存，TTL 兜住陈旧数据。

**删除一定要广播，不然各实例看到的数据不一样。** 只在本地 `invalidate` 是自欺欺人——你的实例刷新了，别人的还旧着。用 Redis Pub/Sub 是最轻的方案；如果对可靠性要求高（比如实例重启期间的消息会丢），可以退化成更短的本地 TTL，或者换成基于 Redis Stream 的订阅。

**先更新数据库，再删缓存。** 顺序反了就会出现「旧值被重新写回」的竞态。删缓存失败时，让本地 TTL 兜底，别让它永久驻留。

**空值也要缓存，但 TTL 要短。** 不存在的 ID 每次都打到数据库，就被人用随机 ID 刷穿了。写个空字符串加两分钟过期，成本极低，效果明显。

**给缓存加监控。** Caffeine 开了 `recordStats` 就能拿到命中率，命中率突然掉下去，通常意味着有人在批量写或者 TTL 设得太短。把命中率接到监控面板上，比事后拍脑袋调参靠谱得多。

## 五、性能对比和技术选型

三种方案的定位差别很清晰：

- **只用 MySQL**：数据最新，但每次请求都吃一次磁盘/网络，适合写多读少、数据量小的场景。
- **只用 Redis**：解决多实例共享，但每次读都有网络往返和反序列化，热点打满单节点网卡。
- **Caffeine + Redis 两级**：本地缓存吃掉绝大部分最热请求，Redis 做共享兜底，数据库压力最小。代价是引入了一致性复杂度。

| 方案 | 单次读耗时量级 | 多实例一致性 | 内存成本 | 适用场景 |
| --- | --- | --- | --- | --- |
| 只用 MySQL | 毫秒到几十毫秒 | 天然一致 | 无 | 读少、强一致 |
| 只用 Redis | 百微秒到毫秒 | 天然一致 | 中（独立集群） | 读多、可容忍最终一致 |
| Caffeine + Redis | 本地纳秒/微秒 | 需广播维护 | 高（占 JVM 堆） | 极高 QPS 热点读 |

**我的建议**：只有当你确实遇到「Redis 都扛不住」的热点读，或者本地缓存能明显省下大量 Redis 带宽时才上两级缓存。普通的业务读，Redis 一层就够，别为了架构好看把一致性复杂度扛回家。上多级缓存的前提，是你能接受「短时间内的本地数据可能是旧的」——这是拿一致性换吞吐，不是白捡的。

## 六、总结

两级缓存的本质，是拿「多份副本 + 一致性维护」去换「省掉网络往返」。想清楚三件事，方案就稳了：

- 读路径逐级回填，谁命中就在谁那层停，顺手把上层补齐；
- 写路径先更新数据库、再删 Redis、最后广播清本地；
- 本地缓存一定设上限和 TTL，空值缓存防穿透，TTL 加抖动防雪崩。

代码里最容易翻车的地方不是缓存本身，而是那种「以为本地缓存删了就万事大吉」的想法。多实例环境下，本地缓存天然各管各的，广播这一步省不得。

文 / 会编程的吕洞宾

## 参考资料

- [Caffeine Wiki（官方文档与设计说明）](https://github.com/ben-manes/caffeine/wiki)
- [Spring Data Redis Reference Documentation](https://docs.spring.io/spring-data/redis/reference/)
- [Redis Pub/Sub 官方文档](https://redis.io/docs/latest/develop/interact/pubsub/)
- [Spring Boot Reference Documentation](https://docs.spring.io/spring-boot/)

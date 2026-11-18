---
title: "Redis缓存穿透击穿雪崩，实战讲透三个坑"
date: 2026-10-11T09:00:00+08:00
category: "中间件"
tags: ["redis"]
---

> 线上接口突然大面积超时，数据库 CPU 被打到 90%，排查半天才发现问题出在缓存。这类事故里，穿透、击穿、雪崩是绕不开的三兄弟。名字看着像，坑法却完全不同，防错一招就等于白干。这篇用 Spring Boot 搭一个能跑的商品查询服务，把三者的原理、完整代码和踩坑一次讲清楚。

## 一、缓存穿透、击穿、雪崩到底差在哪

结论先行：三者都会让请求绕过缓存直接砸到数据库，但触发条件完全不同，防护手段也不能互相套用。

先把三个概念摆开说。

**缓存穿透**：查询一个数据库里压根不存在的数据。缓存里没有，数据库里也没有，请求每次都穿过缓存这一层，直接落到数据库上。偶尔查不到没什么，但如果有人拿随机 id 恶意刷接口，每次都查库，数据库压力会持续飙升。

**缓存击穿**：某个被高频访问的热点 key（比如首页的爆款商品）刚好过期。就在过期那一瞬间，成百上千个并发请求同时发现缓存没了，于是一起冲向数据库查这条数据，数据库瞬间挨一记闷棍。

**缓存雪崩**：大量缓存 key 在几乎同一时间集体过期，或者 Redis 整体宕机，所有读请求同时失去缓存保护，流量像雪崩一样全压到数据库。

用一张表把区别钉死：

| 维度 | 穿透 | 击穿 | 雪崩 |
| --- | --- | --- | --- |
| 触发条件 | 查不存在的数据 | 单个热点 key 过期 | 大批 key 同时过期或 Redis 宕机 |
| 影响范围 | 一批不存在的 key | 某个热点 key | 几乎全站读请求 |
| 数据库压力 | 随攻击量上涨 | 短时尖峰 | 持续性暴涨 |
| 核心解法 | 布隆过滤器 + 空值缓存 | 互斥锁 / 逻辑过期 | TTL 随机化 + 多级缓存 + 熔断降级 |

判断口诀就一句：看数据库里到底有没有这条数据。

- 数据库里有，只是缓存刚才过期了 → 击穿。
- 数据库里根本没有 → 穿透。
- 一大批 key 同时失效，或者 Redis 直接挂了 → 雪崩。

## 二、底层原理：为什么缓存这道墙会漏风

正常的缓存读取走固定套路：请求先查 Redis，命中就直接返回；没命中才去查数据库，查到后写回 Redis 给下次用。这三兄弟的本质，都是这条链路在某个环节断了。

### 穿透：缓存对"不存在的数据"完全失效

关键在于：数据库里没有这条数据时，按正常逻辑不写缓存。于是每次请求都命中不了缓存，每次都去查库。缓存这层保护，对这类请求等于不存在。

解决方案有两个，通常一起用。

**布隆过滤器**：用一个很大的位图（bit 数组）加多个哈希函数，预先判断某个 id 到底存不存在。写入数据时，把 id 通过 k 个不同的哈希函数算出 k 个位置，把位图上这 k 个 bit 置为 1。查询时同样算这 k 个位置：只要有任意一个 bit 是 0，说明这个 id 一定不存在，直接返回；如果 k 个 bit 全是 1，只能说"可能存在"。

为什么是"可能存在"？因为不同 id 算出来的位置可能撞在一起。所以布隆过滤器会有假阳性（误判成存在），但绝不漏判——真实存在的数据，它对应的 k 个 bit 一定都是 1。这份"宁可错杀、不可放过"的特性，正好拿来挡海量随机 id。

误判率有个经典公式：p ≈ (1 - e^(-kn/m))^k。其中 m 是位图长度，n 是数据量，k 是哈希函数个数。举个例子：m 取 2^24（约 1677 万个 bit，占 2MB 内存），n 取 100 万，k 取 7，误判率大概几个百分点，用来挡攻击绰绰有余。

**空值缓存**：查库发现是空，也往 Redis 写一个特殊标记，并设一个较短的过期时间。下次同样的 id 再来，直接在缓存里读到"没有"，不会再查库。

空值缓存的 TTL 必须短。哪天数据库真补上了这条数据，缓存还在说"没有"，就会一直读到错误结果。

### 击穿：热点 key 过期那一瞬间的并发洪峰

单个 key 过期本身不可怕，可怕的是高并发。热点 key 一过期，几百个线程同时 miss，同时执行"查库 + 回填"，数据库在同一时刻被同一份查询打了几百遍。

主流解法是加锁，让同一时刻只有一个请求去回源：

- 缓存 miss 后，先抢一把分布式锁（Redis 的 SET NX）。
- 抢到锁的请求查库、回填缓存，然后释放锁。
- 没抢到锁的请求不查库，短暂自旋等待，等别人回填完再读缓存。

抢锁用 setIfAbsent(key, value, 超时时间)，对应 Redis 的 SET key value NX PX 毫秒，一条命令完成"不存在才设置 + 带过期时间"，天然原子。

释放锁不能简单地 DEL。因为可能出现这种情况：请求 A 的锁超时自动释放，请求 B 抢到了锁，这时 A 执行完回来 DEL，就把 B 的锁删了。解决办法是给锁带一个唯一 token，删除前先校验 token 是不是自己的。校验和删除必须原子，用一段 Lua 脚本完成。

### 雪崩：过期时间集中 + 单点故障

雪崩有两个源头。一是大量 key 的 TTL 设成同一个值，比如都在凌晨批量预热，结果就在同一分钟集体过期。二是 Redis 自己挂了，缓存层整个消失。

对应两招：

- **TTL 随机化**：回填缓存时，在基础过期时间上加一个随机抖动，把到期时间打散。
- **多级缓存 + 熔断降级**：本地缓存（Caffeine）挡在 Redis 前面，Redis 挂了还有本地兜底；再配合 Sentinel / Resilience4j 做限流熔断，数据库撑不住时直接返回兜底数据，而不是被打穿。

## 三、实战：给商品查询服务加上三层防护

这个例子用 Spring Boot + Spring Data Redis + JPA(H2) 搭一个商品查询接口，把布隆过滤器、空值缓存、互斥锁、TTL 随机化全部串起来。本地起一个 Redis 就能跑。

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
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>cache-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>cache-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-jpa</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>com.h2database</groupId>
            <artifactId>h2</artifactId>
            <version>2.4.240</version>
            <scope>runtime</scope>
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
            </plugin>
        </plugins>
    </build>
</project>
```

依赖各管一块：web 出接口，data-redis 提供 Redis 客户端（默认是 Lettuce），data-jpa 加 h2 模拟数据库，h2 用的是内存库，免安装。

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      database: 0
      timeout: 3s
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2
  datasource:
    url: jdbc:h2:mem:cache-demo;DB_CLOSE_DELAY=-1
    driver-class-name: org.h2.Driver
    username: sa
    password: ""
  jpa:
    hibernate:
      ddl-auto: update
    show-sql: true
  h2:
    console:
      enabled: true
      path: /h2-console
```

### 3. 实体和 Repository

```java
package com.example.cache.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "product")
public class Product {

    @Id
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private Integer stock;

    public Product() {
    }

    public Product(Long id, String name, Integer stock) {
        this.id = id;
        this.name = name;
        this.stock = stock;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Integer getStock() {
        return stock;
    }

    public void setStock(Integer stock) {
        this.stock = stock;
    }
}
```

JPA 需要无参构造，所以除了带参构造，还留了一个空构造，缓存反序列化时也靠它。

```java
package com.example.cache.repository;

import org.springframework.data.jpa.repository.JpaRepository;

import com.example.cache.entity.Product;

public interface ProductRepository extends JpaRepository<Product, Long> {
}
```

### 4. 布隆过滤器

```java
package com.example.cache.bloom;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class BloomFilterService {

    private static final String BITMAP_KEY = "bloom:product";

    /** 位图长度：2^24 ≈ 1677 万个 bit，约 2MB，存 100 万数据误判率在几个百分点 */
    private static final long BIT_SIZE = 1L << 24;

    /** 哈希函数个数，m/n 较大时取 7 已经够用 */
    private static final int HASH_COUNT = 7;

    private final StringRedisTemplate redis;

    public BloomFilterService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** 把已有数据的 id 写进布隆过滤器 */
    public void add(Long id) {
        for (long offset : hashOffsets(id)) {
            redis.opsForValue().setBit(BITMAP_KEY, offset, true);
        }
    }

    /** 返回 false 表示 id 一定不存在；返回 true 表示可能存在 */
    public boolean mightContain(Long id) {
        for (long offset : hashOffsets(id)) {
            Boolean bit = redis.opsForValue().getBit(BITMAP_KEY, offset);
            if (bit == null || !bit) {
                return false;
            }
        }
        return true;
    }

    private List<Long> hashOffsets(Long id) {
        byte[] digest = md5(id);
        long h1 = 0;
        long h2 = 0;
        for (int i = 0; i < 8; i++) {
            h1 = (h1 << 8) | (digest[i] & 0xFF);
            h2 = (h2 << 8) | (digest[i + 8] & 0xFF);
        }
        // Kirsch-Mitzenmacher 公式：用两个基础哈希组合出 k 个位置，省掉多次哈希计算
        List<Long> offsets = new ArrayList<>(HASH_COUNT);
        for (int i = 0; i < HASH_COUNT; i++) {
            long combined = h1 + (long) i * h2;
            offsets.add(Math.floorMod(combined, BIT_SIZE));
        }
        return offsets;
    }

    private byte[] md5(Long id) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            return md.digest(String.valueOf(id).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("MD5 算法不可用", e);
        }
    }
}
```

这里没有引入额外的布隆过滤器库，直接用 Redis 的位图命令 SETBIT / GETBIT 手写一个。好处是多个应用实例共享同一份位图，内存占用也可控。hashOffsets 用了 Kirsch-Mitzenmacher 的套路：拿两个基础哈希 h1、h2，用 h1 + i * h2 组合出 k 个位置，只做一次 MD5 就够，比算 k 次哈希快。

### 5. 核心缓存服务

```java
package com.example.cache.service;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

import com.example.cache.bloom.BloomFilterService;
import com.example.cache.entity.Product;
import com.example.cache.repository.ProductRepository;

import tools.jackson.databind.ObjectMapper;

@Service
public class ProductCacheService {

    /** 空值占位标记：库里也没有时写它，挡住重复穿透 */
    private static final String NULL_HOLDER = "__NULL__";
    private static final String KEY_PREFIX = "product:";
    private static final String LOCK_PREFIX = "lock:product:";

    /** 谁加的锁谁删，用 Lua 保证"校验 token + 删除"的原子性 */
    private static final String UNLOCK_LUA =
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
                    + "  return redis.call('del', KEYS[1]) "
                    + "else "
                    + "  return 0 "
                    + "end";

    private final StringRedisTemplate redis;
    private final ProductRepository repository;
    private final BloomFilterService bloomFilter;
    private final ObjectMapper objectMapper;

    public ProductCacheService(StringRedisTemplate redis,
                               ProductRepository repository,
                               BloomFilterService bloomFilter,
                               ObjectMapper objectMapper) {
        this.redis = redis;
        this.repository = repository;
        this.bloomFilter = bloomFilter;
        this.objectMapper = objectMapper;
    }

    public Product getById(Long id) {
        // 第一道：布隆过滤器拦下明确不存在的 id，Redis 都不用查
        if (!bloomFilter.mightContain(id)) {
            return null;
        }

        String key = KEY_PREFIX + id;
        String json = redis.opsForValue().get(key);
        if (NULL_HOLDER.equals(json)) {
            return null;
        }
        if (json != null) {
            Product cached = deserialize(json, key);
            if (cached != null) {
                return cached;
            }
        }

        // 第二道：抢分布式锁，只放一个请求去打数据库
        String lockKey = LOCK_PREFIX + id;
        String token = UUID.randomUUID().toString();
        Boolean locked = redis.opsForValue()
                .setIfAbsent(lockKey, token, Duration.ofSeconds(10));

        if (Boolean.TRUE.equals(locked)) {
            try {
                // 拿到锁后再查一次缓存，可能别人已经回填了（双重检查）
                String again = redis.opsForValue().get(key);
                if (NULL_HOLDER.equals(again)) {
                    return null;
                }
                if (again != null) {
                    Product cached = deserialize(again, key);
                    if (cached != null) {
                        return cached;
                    }
                }
                return loadFromDbAndCache(id, key);
            } finally {
                releaseLock(lockKey, token);
            }
        }

        // 第三道：没抢到锁的请求自旋等待，等别人回填，绝不放它们去查库
        for (int i = 0; i < 5; i++) {
            sleep(50);
            String spin = redis.opsForValue().get(key);
            if (NULL_HOLDER.equals(spin)) {
                return null;
            }
            if (spin != null) {
                Product cached = deserialize(spin, key);
                if (cached != null) {
                    return cached;
                }
            }
        }
        return null;
    }

    private Product loadFromDbAndCache(Long id, String key) {
        Product product = repository.findById(id).orElse(null);
        if (product == null) {
            // 防穿透：把"不存在"也缓存起来，TTL 一定要短
            redis.opsForValue().set(key, NULL_HOLDER, Duration.ofSeconds(60));
            return null;
        }
        // 防雪崩：TTL 加随机抖动，避免同一批 key 同时到期
        long ttl = 300 + ThreadLocalRandom.current().nextLong(120);
        redis.opsForValue().set(key, objectMapper.writeValueAsString(product),
                Duration.ofSeconds(ttl));
        return product;
    }

    private Product deserialize(String json, String key) {
        try {
            return objectMapper.readValue(json, Product.class);
        } catch (Exception e) {
            // 缓存内容坏了就当没命中：删掉，让后面重新回源
            redis.delete(key);
            return null;
        }
    }

    private void releaseLock(String lockKey, String token) {
        redis.execute(new DefaultRedisScript<>(UNLOCK_LUA, Long.class),
                List.of(lockKey), token);
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

几个关键点，逐个说：

- 布隆过滤器放在最前面，是无成本的"提前拦截"，明确不存在的请求根本不会走到 Redis。
- setIfAbsent 带过期时间，对应 SET NX PX，抢锁和自动释放一步到位，不会因为应用宕机留下死锁。
- 双重检查：抢到锁之后再查一次缓存，避免重复回源。
- TTL 用 300 秒基础值加 0 到 120 秒的随机数，同一批商品不会挤在同一秒过期。
- 释放锁走 Lua，先比对 token 再删，防止误删别人的锁。
- 注意 ObjectMapper 的包名是 tools.jackson.databind。Spring Boot 4 默认已经用 Jackson 3，很多老教程里写的 com.fasterxml.jackson 是 Jackson 2 的包，抄过来会编译不过。

### 6. 接口和启动类

```java
package com.example.cache.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.example.cache.entity.Product;
import com.example.cache.service.ProductCacheService;

@RestController
@RequestMapping("/api/product")
public class ProductController {

    private final ProductCacheService productCacheService;

    public ProductController(ProductCacheService productCacheService) {
        this.productCacheService = productCacheService;
    }

    @GetMapping("/{id}")
    public Product get(@PathVariable Long id) {
        return productCacheService.getById(id);
    }
}
```

```java
package com.example.cache;

import java.util.List;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

import com.example.cache.bloom.BloomFilterService;
import com.example.cache.entity.Product;
import com.example.cache.repository.ProductRepository;

@SpringBootApplication
public class CacheDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(CacheDemoApplication.class, args);
    }

    /** 启动时往 H2 塞几条数据，同时把 id 登记进布隆过滤器 */
    @Bean
    CommandLineRunner init(ProductRepository repository, BloomFilterService bloomFilter) {
        return args -> {
            List<Product> products = List.of(
                    new Product(1001L, "机械键盘", 200),
                    new Product(1002L, "人体工学椅", 80),
                    new Product(1003L, "显示器支架", 500));
            repository.saveAll(products);
            products.forEach(p -> bloomFilter.add(p.getId()));
        };
    }
}
```

### 7. 跑起来验证

先起 Redis，再启动应用：

```bash
redis-server
mvn spring-boot:run
```

访问存在的商品：

```bash
curl http://localhost:8080/api/product/1001
```

第一次会走查库，日志里能看到一条 SQL；第二次同样的请求，SQL 不再出现，说明缓存命中。

访问不存在的商品，比如 9999：

```bash
curl http://localhost:8080/api/product/9999
```

9999 没有登记进布隆过滤器，请求在第一步就被拦下，数据库和 Redis 都不会被打到。整体效果就是：不存在的 id 被布隆过滤器挡在门外，热点 key 过期时有锁兜底，批量过期被 TTL 随机化打散。

## 四、踩坑经验和最佳实践

- **空值缓存的 TTL 别贪长**。有人图省事设成一天，结果运营在数据库补录了这条数据，接口还一直返回空，排查半天。设几十秒到几分钟就够，它只是用来挡重复请求的。
- **布隆过滤器删不掉元素**。位图是多个 key 共享的，你把某个 id 的 bit 清 0，可能顺手把别的 id 也误判了。数据删除后要么定期重建位图，要么改用计数布隆过滤器（每一位记数而不是 0/1）。
- **释放锁必须校验 token**。直接 DEL 是线上事故的经典来源，前面解释过：锁超时后你删的可能是别人的锁。老老实实用 Lua。
- **锁一定要有过期时间**。setIfAbsent 不带超时，应用一旦在持锁期间崩溃，这把锁就永远在，后面的请求全部卡死。10 秒这种兜底 TTL 是必须的。
- **区分"数据不存在"和"系统繁忙"**。现在没抢到锁直接返回 null，和"库里没有"是一个返回值。业务上要能把两者分开，比如返回一个带状态码的对象，别让前端把"稍后重试"当成"商品下架"。
- **缓存反序列化失败要删掉重建**。实体字段改名、类型调整后，旧缓存里的 JSON 可能读不出来。读到坏数据就当缓存未命中，顺手删掉，别让它一直报错。
- **穿透攻击要在入口拦**。布隆过滤器解决的是"库里有但没有"的量级问题，真正的恶意刷接口还得靠网关层的限流、参数校验和风控。

## 五、性能对比和技术选型

先把几种防护手段放一起对比：

| 手段 | 挡什么 | 优点 | 代价 |
| --- | --- | --- | --- |
| 布隆过滤器 | 穿透 | 内存极小，能挡海量随机 id | 有误判，元素不能删 |
| 空值缓存 | 穿透 | 实现简单，零误判 | 随机 id 攻击会把 Redis 撑大，TTL 内有短暂不一致 |
| 互斥锁 | 击穿 | 保证同一时刻只有一次回源，数据强一致 | 没抢到锁的请求要等待或降级 |
| 逻辑过期 | 击穿 | 不阻塞请求，一直返回数据 | 会短暂返回旧数据，实现更复杂 |
| TTL 随机化 | 雪崩 | 改一行代码，成本极低 | 只能打散过期，防不了 Redis 宕机 |
| 多级缓存 + 熔断 | 雪崩 | Redis 挂了还有本地兜底，可用性最高 | 架构更复杂，本地缓存有一致性延迟 |

选型上的建议很直接：

- 中小规模、key 集合有限 → 空值缓存够用，别为了布隆过滤器过度设计。
- 有海量随机 id 查询或被攻击风险 → 上布隆过滤器，它挡穿透的性价比最高。
- 热点 key 并发极高 → 用互斥锁；能接受短暂旧数据就用逻辑过期，吞吐更好。
- 分布式锁别自己造轮子到极致。生产里我推荐直接用 Redisson 的 RLock，锁续期、可重入、看门狗都帮你处理好了，手写 Lua 适合理解原理，不适合长期维护。

## 六、总结

穿透、击穿、雪崩，一句话就能分开：数据库里本来就没有的叫穿透，数据库里有但缓存刚过期的叫击穿，一大片 key 同时没了的叫雪崩。

对应的三板斧也简单：布隆过滤器加空值缓存挡穿透，互斥锁挡击穿，TTL 随机化加多级缓存挡雪崩。

真正容易翻车的地方都在细节里——空值缓存 TTL 太长、布隆过滤器不能删、锁忘了超时、释放锁没校验 token。这些坑，文章里的代码都替你绕开了，剩下的是把它对照你自己的业务调一遍参数。

## 参考资料

- [Redis SET 命令官方文档（含 NX/PX 选项）](https://redis.io/docs/latest/commands/set/)
- [Redis SETBIT 命令官方文档](https://redis.io/docs/latest/commands/setbit/)
- [Spring Data Redis 官方参考文档](https://docs.spring.io/spring-data/redis/reference/)
- [Bloom filter 原始论文（Bloom, 1970）](https://dl.acm.org/doi/10.1145/362686.362692)

文 / 会编程的吕洞宾

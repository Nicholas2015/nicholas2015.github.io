---
title: 缓存和数据库不一致_Java后端先删缓存还是先更库
date: 2026-11-21 20:14:45
tags: ["Java", "Redis", "Spring Boot", "缓存"]
categories: java
---

# 缓存和数据库不一致_Java后端先删缓存还是先更库

同事上周问我：后台把商品价格改成 499，前端刷新还是 399，硬生生等了十分钟才对。查下来数据库里早就写着 499，脏的是 Redis——更库和删缓存这两步中间，一个读请求钻了空子，把旧价格又写回缓存，还带着十分钟的过期时间。缓存和数据库不一致，是 Java 后端绕不过去的坑。踩坑的原因几乎都一样：把「改库 + 删缓存」当成了一个原子动作。它根本不是。这篇从原理讲到能跑的代码，把这层窗户纸捅破。

## 一、缓存不一致到底是什么问题

缓存不一致的本质只有一句话：数据库和 Redis 是两份独立的数据，中间没有事务，任何“先写一边、再写另一边”的操作都存在时间窗口。

这个窗口有多长？短则几毫秒，长则等到缓存过期。窗口里发生了什么，决定了你看到的是“偶尔刷一下就好”，还是“脏数据常驻半个月”。

按后果分，有三类：

- **短暂不一致**：更库后的几毫秒内有人读到旧值。业务能忍，比如商品详情、文章阅读数。
- **长期脏数据**：旧值被某个读请求重新写回缓存，并且带着完整 TTL。数据库改了，缓存却要等过期才自愈。这就是我同事遇到的那种。
- **并发下的永久错误**：两个写请求交叉执行，最后缓存里躺着谁都不认识的值。库存、余额这类场景，一次就够喝一壶。

大部分团队踩的是第二类。它最阴的地方在于：日志上看不出任何异常，接口不报错，就是数据不对。

### Cache-Aside 是怎么读写的

Java 项目里最常见的是 Cache-Aside 模式，说白了就是“缓存当旁路，代码自己管”。

读请求的顺序：

1. 先查 Redis，命中就直接返回。
2. 没命中，查数据库。
3. 把查到的结果写回 Redis，设置过期时间。
4. 返回给调用方。

写请求的顺序，争议就在这一步：

1. 更新数据库。
2. 删除缓存（不是更新缓存）。

为什么是删除而不是更新？两个原因。一是并发下更新缓存会引入新的交错——两个写请求分别更新库和缓存，谁后写缓存谁赢，可能输的那一方数据库值反而更新。二是缓存值往往要经过聚合、计算，写完还不一定有人读，纯属浪费。删除是幂等的，删两次和删一次结果一样，这一点在分布式环境里特别值钱。

## 二、底层原理：那几毫秒里到底发生了什么

结论先放这儿：先删缓存再更库，必然可能留下脏数据；先更库再删缓存，只在删除失败或主从延迟时才脏。两者都不是强一致，区别只是出问题的概率。

### 先删缓存，再更库：漏洞是明摆着的

按时间轴走一遍，两个线程，商品 id = 1，缓存里原本是 399：

| 时刻 | 读线程 A | 写线程 B |
| --- | --- | --- |
| T1 | 查缓存，未命中 | — |
| T2 | 查数据库，读到 399 | — |
| T3 | — | 删除缓存 |
| T4 | — | 更新数据库为 499 |
| T5 | 把 399 写回缓存 | — |

结果：数据库 499，缓存 399，缓存还有十分钟 TTL。十分钟内所有人看到的都是错的价格。

这个交错不需要多极端的并发，读请求在 T1 到 T5 之间插进来就够了。数据库查询稍微慢一点、网络抖一下，窗口就有一两百毫秒。QPS 上千的接口，一天撞上几十次很正常。

所以“先删缓存”这个方案，基本可以直接划掉。

### 先更库，再删缓存：概率小，但不是零

同样两个线程：

| 时刻 | 读线程 A | 写线程 B |
| --- | --- | --- |
| T1 | 查缓存，命中 399，准备返回 | — |
| T2 | — | 更新数据库为 499 |
| T3 | — | 删除缓存 |
| T4 | 返回 399 | — |

这里 A 返回了旧值，但缓存已经被删掉了，下一次读会重新查库拿到 499。这属于“短暂不一致”，能接受。

真正会留下脏数据的是另一种情况——**数据库有主从，读请求走了从库**：

1. 写线程更新主库为 499，删除缓存。
2. 主从复制还没完成，从库上还是 399。
3. 读线程未命中，查从库，读到 399。
4. 读线程把 399 写回缓存，TTL 十分钟。

又脏了。MySQL 半同步复制下，这个延迟通常在几十毫秒内，但网络抖动、大事务、从库压力大时能到几百毫秒甚至秒级。

除此之外还有两个常见漏点：删除缓存这一步抛异常被 catch 吞了；或者服务刚好在更库之后、删缓存之前被发布重启。

### 延迟双删：降低概率，不是消灭问题

延迟双删的思路很朴素：更库前删一次，更库后等一小会儿再删一次。第二次删除的作用，就是干掉上面那个“从库旧值被回填”的缓存。

关键在于等多久。这个时间要覆盖住“主库到从库的复制延迟 + 读请求查库到回填的耗时”。我的经验值：

- 主从同机房、半同步：300 ~ 500 毫秒够用。
- 跨机房、异步复制：1 ~ 3 秒。
- 有大批量导入、大事务的场景：老实点，5 秒以上。

等待用异步线程做，别阻塞接口。删失败要有重试，不然延迟双删就变成了“延迟一次不删”。

延迟双删的定位要说清楚：它把脏数据的概率从“每天几十次”压到“一年几次”，但它依然不是强一致。真正的强一致只有两条路——加锁串行化，或者订阅 binlog 做异步补偿。

### 兜底：TTL 是最后一道防线

不管用哪种方案，缓存必须有过期时间。原因很实在：任何补偿逻辑都可能失效，代码有 bug、机器挂了、消息丢了。TTL 意味着“最坏情况下，脏数据活多久”。

我一般这么定：普通商品详情 10 分钟，库存类 30 秒到 1 分钟，配置类可以长一些但要配合主动刷新。别设成永不过期，那不是缓存，那是第二份数据库，还是没人维护的那种。

## 三、实战：一套能直接跑的代码

下面这个项目用 H2 模拟 MySQL，Redis 是真连的，`mvn spring-boot:run` 就能起来。先把工程骨架搭好。

### 3.1 完整 pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>cache-consistency</artifactId>
    <version>1.0.0</version>
    <name>cache-consistency</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>com.h2database</groupId>
            <artifactId>h2</artifactId>
            <version>2.5.252</version>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.2.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.2.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

选型说明：缓存值用 `StringRedisTemplate` 存成 `name|price` 的普通字符串，故意不引入 JSON 序列化依赖，这样读者少一个坑，序列化器版本不匹配导致的“删了缓存却没删对 key”问题也不会混淆进来。真实项目里换成 JSON 序列化器即可，读写两端保持一致就行。

### 3.2 application.yml 和建表脚本

```yaml
server:
  port: 8080

spring:
  application:
    name: cache-consistency
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      database: 0
      timeout: 2s
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2
  datasource:
    url: jdbc:h2:mem:shop;MODE=MySQL;DB_CLOSE_DELAY=-1
    driver-class-name: org.h2.Driver
    username: sa
    password: ""
  sql:
    init:
      mode: always
```

```sql
DROP TABLE IF EXISTS product;

CREATE TABLE product (
    id    BIGINT PRIMARY KEY,
    name  VARCHAR(64)     NOT NULL,
    price DECIMAL(10, 2)  NOT NULL
);

INSERT INTO product (id, name, price) VALUES (1, '机械键盘', 399.00);
```

`DB_CLOSE_DELAY=-1` 让内存库在连接关闭后不消失，配合 `spring.sql.init.mode=always`，每次启动都重新建表灌数据。换成 MySQL 只需要改 `datasource` 和 `driver-class-name`，代码一行不用动。

### 3.3 实体类和仓储

```java
package com.example.cache;

import java.math.BigDecimal;

public record Product(Long id, String name, BigDecimal price) {
}
```

```java
package com.example.cache;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.util.List;

@Repository
public class ProductRepository {

    private final JdbcTemplate jdbcTemplate;

    public ProductRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Product findById(Long id) {
        List<Product> list = jdbcTemplate.query(
                "SELECT id, name, price FROM product WHERE id = ?",
                (rs, rowNum) -> new Product(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getBigDecimal("price")),
                id);
        return list.isEmpty() ? null : list.get(0);
    }

    public void updatePrice(Long id, BigDecimal price) {
        jdbcTemplate.update("UPDATE product SET price = ? WHERE id = ?", price, id);
    }
}
```

### 3.4 核心：先更库、提交后删、延迟再删、失败进重试队列

这段是整个方案的主体。三个要点埋在代码里：**删缓存必须等事务提交**、**删两次**、**删失败有兜底**。

```java
package com.example.cache;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@Service
public class ProductCacheService {

    private static final Logger log = LoggerFactory.getLogger(ProductCacheService.class);

    private static final String KEY_PREFIX = "product:";
    private static final String RETRY_ZSET = "cache:delete:retry";
    private static final Duration TTL = Duration.ofMinutes(10);
    private static final long SECOND_DELETE_DELAY_MS = 500L;

    private final ProductRepository repository;
    private final StringRedisTemplate redis;
    private final ScheduledExecutorService delayer = Executors.newSingleThreadScheduledExecutor();

    public ProductCacheService(ProductRepository repository, StringRedisTemplate redis) {
        this.repository = repository;
        this.redis = redis;
    }

    public Product findById(Long id) {
        String key = KEY_PREFIX + id;
        String cached = redis.opsForValue().get(key);
        if (cached != null) {
            return decode(id, cached);
        }
        Product product = repository.findById(id);
        if (product == null) {
            return null;
        }
        redis.opsForValue().set(key, encode(product), TTL);
        return product;
    }

    @Transactional
    public void updatePrice(Long id, BigDecimal newPrice) {
        repository.updatePrice(id, newPrice);
        deleteAfterCommit(id);
    }

    private void deleteAfterCommit(Long id) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    deleteTwice(id);
                }
            });
        } else {
            deleteTwice(id);
        }
    }

    private void deleteTwice(Long id) {
        deleteOrQueue(id);
        delayer.schedule(() -> deleteOrQueue(id), SECOND_DELETE_DELAY_MS, TimeUnit.MILLISECONDS);
    }

    private void deleteOrQueue(Long id) {
        try {
            redis.delete(KEY_PREFIX + id);
        } catch (Exception e) {
            log.warn("删缓存失败，{}+3s 重试，productId={}", RETRY_ZSET, id, e);
            redis.opsForZSet().add(RETRY_ZSET, String.valueOf(id), System.currentTimeMillis() + 3000);
        }
    }

    @Scheduled(fixedDelay = 5000)
    public void retryFailedDeletes() {
        Set<String> ids = redis.opsForZSet()
                .rangeByScore(RETRY_ZSET, 0, System.currentTimeMillis(), 0, 100);
        if (ids == null || ids.isEmpty()) {
            return;
        }
        for (String id : ids) {
            try {
                redis.delete(KEY_PREFIX + id);
                redis.opsForZSet().remove(RETRY_ZSET, id);
            } catch (Exception e) {
                redis.opsForZSet().add(RETRY_ZSET, id, System.currentTimeMillis() + 3000);
            }
        }
    }

    @PreDestroy
    public void shutdown() {
        delayer.shutdown();
    }

    private String encode(Product product) {
        return product.name() + "|" + product.price().toPlainString();
    }

    private Product decode(Long id, String value) {
        int split = value.lastIndexOf('|');
        return new Product(id, value.substring(0, split), new BigDecimal(value.substring(split + 1)));
    }
}
```

逐段解释，别看着代码就滑过去：

- `deleteAfterCommit` 里判断 `TransactionSynchronizationManager.isSynchronizationActive()`，有事务就注册 `afterCommit` 回调，没事务就直接删。这一步最关键，写在下面踩坑那节细说。
- `deleteTwice` 先删一次，再交给单线程调度器 500 毫秒后删第二次。用独立线程是为了不拖慢接口，用单线程是为了保证同一个实例内顺序可控。
- `deleteOrQueue` 把 id 塞进 Redis 的 ZSet，score 是“下次可以重试的时间戳”。为什么不用本地队列？因为服务重启就丢，而 Redis 本身就在线。ZSet 天然按时间排序，`rangeByScore` 一秒取一次到期任务就行。
- `retryFailedDeletes` 用 `@Scheduled(fixedDelay = 5000)` 每 5 秒扫一次。删成功才 `remove`，删失败就把 score 往后推 3 秒，不会死循环打爆 Redis。

### 3.5 控制器和启动类

```java
package com.example.cache;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;

@RestController
@RequestMapping("/products")
public class ProductController {

    private final ProductCacheService service;

    public ProductController(ProductCacheService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    public Product get(@PathVariable Long id) {
        return service.findById(id);
    }

    @PutMapping("/{id}/price")
    public String updatePrice(@PathVariable Long id, @RequestParam BigDecimal price) {
        service.updatePrice(id, price);
        return "ok";
    }
}
```

```java
package com.example.cache;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class CacheConsistencyApplication {

    public static void main(String[] args) {
        SpringApplication.run(CacheConsistencyApplication.class, args);
    }
}
```

`@EnableScheduling` 别漏，漏了重试任务就永远不会跑，而且不报错。

### 3.6 一个复现脏数据的测试

这个测试不验证“代码对不对”，它验证“先删缓存再更库到底会留下什么”。跑一遍，你就再也不会写错顺序。

```java
package com.example.cache;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.math.BigDecimal;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class CacheRaceReproTest {

    @Autowired
    private ProductRepository repository;

    @Autowired
    private ProductCacheService service;

    @Autowired
    private StringRedisTemplate redis;

    @Test
    void 先删缓存再更库会留下脏数据() {
        Long id = 1L;
        String key = "product:" + id;
        redis.delete(key);

        // 读线程：查库拿到旧值 399，但还没来得及回填缓存
        Product old = repository.findById(id);
        assertThat(old.price()).isEqualByComparingTo("399.00");

        // 写线程：先删缓存，再更新数据库
        redis.delete(key);
        repository.updatePrice(id, new BigDecimal("499.00"));

        // 读线程：把旧值写回缓存，带上完整 TTL
        redis.opsForValue().set(key, old.name() + "|" + old.price().toPlainString(), Duration.ofMinutes(10));

        // 库里是 499，缓存里是 399
        assertThat(repository.findById(id).price()).isEqualByComparingTo("499.00");
        assertThat(redis.opsForValue().get(key)).isEqualTo("机械键盘|399.00");

        // 走正常读路径，拿到的也是脏值
        assertThat(service.findById(id).price()).isEqualByComparingTo("399.00");
    }
}
```

方法名用中文，JUnit 5 允许，读起来比 `testCacheRace` 清楚得多。跑测试前确保本机 Redis 在 6379 上，`docker run -p 6379:6379 redis:8-alpine` 一行就行。

## 四、踩坑经验：这几个地方最容易翻车

### 坑一：在事务里删缓存

最常见的翻车方式。代码长这样：

```java
@Transactional
public void update(Long id, BigDecimal price) {
    repository.updatePrice(id, price);
    redis.delete("product:" + id);  // 错
}
```

删除确实执行了，但事务还没提交。此刻另一个线程读缓存未命中，去查数据库——读到的还是未提交前的旧值，然后把这个旧值写回缓存。等事务提交，缓存已经脏了。

正确做法就是上面代码里的 `afterCommit` 回调。用 Spring 自带的 `@CacheEvict` 也一样会翻车：`@CacheEvict` 默认在方法返回后执行，而方法上的 `@Transactional` 是在方法返回之后才提交的，两者顺序靠不住。要稳妥，就自己注册同步回调，或者用 `@TransactionalEventListener(phase = AFTER_COMMIT)`。

### 坑二：删错了 key

线上真见过。写入用 `product:detail:1`，删除用 `product:1`，或者一边用 `StringRedisTemplate` 一边用自定义序列化器，删的时候 key 被序列化成带引号的字节串。现象是缓存永不过期、数据永远旧，还查不出异常。统一 key 拼装方法，别在三个类里手写字符串拼接。

### 坑三：删除异常被吞

```java
try {
    redis.delete(key);
} catch (Exception ignored) {
}
```

Redis 抖动一下，这次删除就永久丢了。缓存带着 TTL 硬撑十分钟。要么重试，要么进队列，要么至少把异常打出来配上告警。上面代码用 ZSet 做延迟重试，多花几行，省下半夜被告警叫醒。

### 坑四：以为延迟双删能解决所有问题

延迟双删等多久，取决于主从延迟。遇到过一次跨机房部署，从库延迟稳定在 800 毫秒，双删设的 300 毫秒，等于没删。后来改成 2 秒才好。这个值不能拍脑袋，去看 `SHOW SLAVE STATUS` 里的 `Seconds_Behind_Master`，或者干脆加监控。

### 坑五：批量更新只删了一个 key

后台“全店打八折”，更新了一万条商品，只删了首页那个 key。这种 bug 上线后很常见，因为测试时只点了一个商品。批量操作要么循环删除（用 pipeline 批量发，别一条条来），要么直接按前缀批量清理，更省事的是给这类数据设计一个版本号 key，版本变了整体失效。

## 五、几种方案的对比和选型建议

四种做法放在一起看，没有银弹，只有取舍。

| 方案 | 一致性 | 性能损耗 | 实现复杂度 | 适用场景 |
| --- | --- | --- | --- | --- |
| 先删缓存再更库 | 差，必然有脏窗口 | 低 | 低 | 不推荐，除非写极少且能容忍 |
| 先更库再删缓存 + TTL | 中，删除失败会脏到过期 | 低 | 低 | 绝大多数读多写少的业务 |
| 加延迟双删 + 删除重试 | 较好，脏概率极低 | 低（异步） | 中 | 商品、订单详情、用户资料 |
| 订阅 binlog 异步删（Canal 等） | 好，业务代码零侵入 | 中（多一套组件） | 高 | 多写入口、老系统改造 |
| 分布式锁串行化读写 | 强一致 | 高，写吞吐受限 | 中 | 库存扣减、账户余额 |

我的建议：

- 商品、文章、配置这类**读多写少**的数据，用“先更库 + 提交后删 + 延迟双删 + 重试”，配 5 到 10 分钟 TTL。这套能覆盖 95% 的场景，代码也不重。
- 多写入口的系统（后台、定时任务、其他服务都在改同一张表），别一个个改业务代码，上 binlog 订阅。业务代码里删缓存这件事，漏一处就是一个坑。
- 钱相关的字段，不要指望缓存一致性方案。加锁、走数据库、缓存只做读加速并且允许短暂过期。库存场景宁可多查一次库，也别让缓存决定扣减结果。

一句话：能用 TTL 兜住的，别上分布式锁；能用 binlog 一劳永逸的，别写十个地方的手动删除。

## 六、总结

先说顺序：**先更数据库，事务提交之后再删缓存**。先删缓存那条路，注定会留下脏数据，没有讨论价值。

再说兜底：删缓存会失败，所以要重试；主从会延迟，所以要延迟双删；代码会有 bug，所以要 TTL。这三层加起来，才叫一个能上生产的方案。

最后说心态。缓存一致性做不到 100%，任何声称做到的方案，要么偷偷加了锁，要么牺牲了吞吐。你要做的是判断业务能容忍多大的不一致窗口，然后选一个比窗口更紧的方案。商品晚十分钟更新价格没人投诉，库存晚十毫秒就可能超卖——两种业务，两套答案。

代码已经在上面了，跑一遍那个复现脏数据的测试，比看十篇文章都管用。

## 参考资料

- [Spring Data Redis Reference Documentation](https://docs.spring.io/spring-data/redis/reference/)
- [Redis SET command](https://redis.io/docs/latest/commands/set/)
- [Redis UNLINK command](https://redis.io/docs/latest/commands/unlink/)
- [TransactionSynchronization (Spring Framework API)](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/transaction/support/TransactionSynchronization.html)

文 / 会编程的吕洞宾

---
title: "Redis 分布式锁总失效？Java 后端避坑实战"
date: 2026-10-19T09:00:00+08:00
category: "中间件"
tags: ["redis"]
---

> 去年双十一前，一个优惠券接口把 1000 张券发成了 1100 张。代码里明明加了 Redis 锁，压测也没问题。最后定位到两行：加锁和设过期时间分开写，中间那次网络抖动，锁没设上过期。Redis 分布式锁看着简单，坑全在细节里：锁谁的、什么时候放、过期了业务还没跑完怎么办。这篇把三个高频翻车点、底层原理和一套能直接跑的完整代码讲清楚。

## 一、Redis 分布式锁为什么会失效

结论：Redis 分布式锁失效，九成不是 Redis 的问题，是加锁和释放锁的写法有漏洞。

先把常见的翻车写法摆出来。下面这几种，我在不同项目里都见过，有的还跑了好几年，直到某次大促才爆。表里的「临界区」，指的是同一段不能被两个线程同时执行的代码，比如「查库存再扣库存」。

| 写法 | 平时表现 | 出问题时会发生什么 |
| --- | --- | --- |
| `SETNX` 加锁，`EXPIRE` 单独设过期 | 一直正常 | 两条命令之间进程挂掉，锁永远不过期 |
| `SETNX` 不设过期 | 重启后接口偶尔全卡 | 锁变成永久债，只能人工删 |
| 释放时直接 `DEL` | 偶发两个线程同时进临界区 | 删掉了别人刚加的锁 |
| 过期 30 秒，业务跑 60 秒 | 压测正常，线上超发 | 锁提前失效，两个线程同时改库存 |
| 主从异步复制 | 切换主库后短暂双持锁 | 两个客户端都以为自己拿到了锁 |

第一种最冤。加锁和设过期是两次网络往返，Redis 本身没毛病，是客户端在两件事中间挂了。进程一死，锁没有过期时间，后面所有请求全堵死。

第二种是忘了设过期。有人觉得「我 finally 里会删，不会出问题」。进程被 kill -9 的时候，finally 不会执行。

第三种最隐蔽。线程 A 拿到锁，业务卡住，锁过期了。线程 B 拿到同一把锁。A 恢复后执行 `DEL`，删的是 B 的锁。C 紧接着又能进来，临界区里同时站着 B 和 C。库存该扣一次的，扣了两次。

第四种是把锁的过期时间当成了业务超时时间。Redis 到点就删 key，它不管你的业务跑没跑完。业务一旦比租期长，锁就形同虚设。

第五种和 Redis 部署方式有关，后面讲原理时展开。

这些问题的共同点是：把「加锁」当成了一次普通的缓存写入。分布式锁本质上是一份带租期的授权，租期、持有者、释放动作，三个东西必须绑在一起看。

## 二、底层原理到底怎么回事

结论：一把可靠的 Redis 锁，靠的是「一条命令完成加锁」和「一段脚本完成校验加释放」，不是靠客户端多写几个 if。

### 2.1 加锁为什么必须是一条命令

Redis 的 `SET` 命令支持一组选项：`NX` 表示 key 不存在才设置，`PX` 表示过期时间按毫秒算。把这三个东西写进同一条命令：

`SET lock:coupon:1001 3f2c1a9e-... NX PX 30000`

Redis 处理命令是单线程的，一条命令要么完整执行，要么不执行。`NX` 的判断和 `PX` 的设置发生在同一次命令处理里，中间插不进别的客户端。这就是原子性，不需要额外加锁，也不需要事务。

反过来说，`SETNX` 之后再 `EXPIRE`，是两条独立命令。Redis 单线程只能保证每条命令自己不被打断，保证不了两条命令之间不被打断。

锁的 value 不能随便写个 `1`。它得是当前线程独有的 token，比如 UUID。释放锁时先比对 value，确认锁还是自己的，再删。这个「比对 + 删除」也必须是原子的，所以要用 Lua。

### 2.2 Lua 脚本为什么能保证释放安全

Lua 是 Redis 内置支持的脚本语言。Redis 执行 Lua 脚本时，会把整个脚本当成一个不可分割的操作。脚本跑到一半，不会有别的客户端命令插进来。

释放锁的脚本只做一件事：`GET` 出来的值等于传入的 token，才执行 `DEL`，否则返回 0。比对和删除在同一段脚本里完成，不会出现「刚比对完，锁过期又被别人拿走，然后自己删掉别人锁」的时间窗。

续期同理。定时任务发现锁还是自己的，就重新 `PEXPIRE`。这个「判断持有者 + 续租」也得用 Lua 包起来。

Redis 官方对这套模式有完整说明，包括为什么推荐用随机值做 value、为什么释放要用脚本，链接放在文末。

### 2.3 租期不是承诺，只是一段时间

这是最容易被忽略的一层。

你设了 30 秒租期，不代表业务一定能在 30 秒内跑完。JVM 一次 Full GC 停了 40 秒，或者容器被调度走、网络分区，锁都会在业务还在跑的时候过期。

过期之后，另一个线程拿到锁，进入同一段临界区。前一个线程如果没死，恢复后继续写数据库，两个线程的写操作就重叠了。

看门狗（后台定时给锁续命的线程）能缓解，但解决不了所有情况。续期线程和业务线程在同一个 JVM 里，JVM 整体卡住时，续期线程也停了。Redis 连不上时，续期同样会失败。

真正兜底的是「 fencing token 」思路：每次加锁拿一个单调递增的编号，写数据库时带上编号，存储层只接受比已记录编号更大的写请求。旧线程恢复后拿着旧编号，会被存储层拒绝。

落到业务上，最常见的做法不是搞一套 fencing 机制，而是给数据库加最后一道约束。库存扣减写成 `UPDATE ... SET stock = stock - 1 WHERE id = ? AND stock > 0`，或者给领取记录加 `(user_id, coupon_id)` 唯一索引。锁负责减少冲突，数据库负责保证不超卖。这个分工要记牢。

### 2.4 主从切换时，锁为什么会丢

Redis 主从复制默认是异步的。客户端在主库上执行加锁命令，主库返回成功，但这条命令还没同步到从库，主库挂了。哨兵把从库提成新主，新主上根本没有这把锁。另一个客户端过来加锁，也能成功。

同一时刻，两个客户端都认为自己持有锁。

Redis 官方给出的 Redlock 方案，是向多个独立主节点加锁，超过半数成功才算成功。这个方案能降低单点故障的影响，但学术界和工业界一直有争论。Martin Kleppmann 那篇著名的文章指出：Redlock 依赖各节点时钟大致准确，进程暂停时仍然无法保证互斥，它更适合「效率锁」，不适合「正确性锁」。

我的观点很直接：**Redis 锁用来减少并发冲突，别拿它当强一致的正确性保证。** 真要求任何时候都不能超卖，数据库唯一索引、条件更新、状态机版本号，这些才是最后一道门。

## 三、实战：手把手写一套能跑的 Redis 锁

结论：这套示例包含完整的 Maven 配置、配置类、锁工具、业务服务和接口，启动后可以直接用并发请求验证不超卖。

项目结构很简单：

```text
redis-lock-demo
├── pom.xml
└── src/main
    ├── java/com/example/redlock
    │   ├── RedisLockApplication.java
    │   ├── lock/RedisLockService.java
    │   └── coupon
    │       ├── ClaimResult.java
    │       ├── CouponService.java
    │       └── CouponController.java
    └── resources/application.yml
```

### 3.1 依赖和配置

先看 `pom.xml`。只引入 Web 和 Redis 两个 starter，版本号全部写全，复制过去就能解析。

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
    <artifactId>redis-lock-demo</artifactId>
    <version>1.0.0</version>
    <name>redis-lock-demo</name>
    <description>Redis distributed lock demo</description>

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

配置文件只连本地 Redis。超时设短一点，Redis 挂掉时接口能快速失败，不至于把 Tomcat 线程全占住。

```yaml
spring:
  application:
    name: redis-lock-demo
  data:
    redis:
      host: localhost
      port: 6379
      database: 0
      timeout: 2s

server:
  port: 8080
```

启动类里顺手初始化一批库存。`setIfAbsent` 保证只在 key 不存在时写入，重启不会把库存重置回 100。

```java
package com.example.redlock;

import com.example.redlock.coupon.CouponService;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class RedisLockApplication {

    public static void main(String[] args) {
        SpringApplication.run(RedisLockApplication.class, args);
    }

    @Bean
    public CommandLineRunner initCouponStock(CouponService couponService) {
        return args -> couponService.initStock("coupon-1001", 100);
    }
}
```

### 3.2 锁工具类

这个类是整篇文章的核心。加锁用 `SET NX PX`，释放和续期都用 Lua，续期任务按 key + token 隔离，避免旧任务误删新锁的续期任务。

```java
package com.example.redlock.lock;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

@Component
public class RedisLockService {

    private static final Logger log = LoggerFactory.getLogger(RedisLockService.class);

    private static final String UNLOCK_SCRIPT = """
            if redis.call('get', KEYS[1]) == ARGV[1] then
                return redis.call('del', KEYS[1])
            else
                return 0
            end
            """;

    private static final String RENEW_SCRIPT = """
            if redis.call('get', KEYS[1]) == ARGV[1] then
                return redis.call('pexpire', KEYS[1], ARGV[2])
            else
                return 0
            end
            """;

    private final StringRedisTemplate redis;
    private final DefaultRedisScript<Long> unlockScript;
    private final DefaultRedisScript<Long> renewScript;
    private final Map<String, ScheduledFuture<?>> renewalTasks = new ConcurrentHashMap<>();
    private final ScheduledExecutorService watchdog = Executors.newScheduledThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "redis-lock-watchdog");
        thread.setDaemon(true);
        return thread;
    });

    public RedisLockService(StringRedisTemplate redis) {
        this.redis = redis;
        this.unlockScript = new DefaultRedisScript<>(UNLOCK_SCRIPT, Long.class);
        this.renewScript = new DefaultRedisScript<>(RENEW_SCRIPT, Long.class);
    }

    public String tryLock(String key, Duration leaseTime) {
        String token = UUID.randomUUID().toString();
        Boolean acquired = redis.opsForValue().setIfAbsent(key, token, leaseTime);
        if (!Boolean.TRUE.equals(acquired)) {
            return null;
        }

        long leaseMillis = leaseTime.toMillis();
        long renewPeriod = Math.max(1000L, leaseMillis / 3);
        String renewalId = renewalId(key, token);
        ScheduledFuture<?> task = watchdog.scheduleAtFixedRate(
                () -> renew(key, token, leaseMillis),
                renewPeriod,
                renewPeriod,
                TimeUnit.MILLISECONDS
        );
        renewalTasks.put(renewalId, task);
        return token;
    }

    public String tryLock(String key, Duration leaseTime, Duration waitTime) {
        long deadline = System.nanoTime() + waitTime.toNanos();
        while (true) {
            String token = tryLock(key, leaseTime);
            if (token != null) {
                return token;
            }
            if (System.nanoTime() >= deadline) {
                return null;
            }
            try {
                Thread.sleep(20L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
    }

    public boolean unlock(String key, String token) {
        cancelRenewal(renewalId(key, token));
        Long deleted = redis.execute(unlockScript, List.of(key), token);
        return deleted != null && deleted == 1L;
    }

    private void renew(String key, String token, long leaseMillis) {
        String renewalId = renewalId(key, token);
        try {
            Long renewed = redis.execute(
                    renewScript,
                    List.of(key),
                    token,
                    String.valueOf(leaseMillis)
            );
            if (renewed == null || renewed == 0L) {
                cancelRenewal(renewalId);
                log.warn("锁已不属于当前线程，停止续期，key={}", key);
            }
        } catch (RuntimeException e) {
            log.warn("锁续期失败，下一轮再试，key={}", key, e);
        }
    }

    private void cancelRenewal(String renewalId) {
        ScheduledFuture<?> task = renewalTasks.remove(renewalId);
        if (task != null) {
            task.cancel(false);
        }
    }

    private String renewalId(String key, String token) {
        return key + "|" + token;
    }

    @PreDestroy
    public void shutdown() {
        renewalTasks.values().forEach(task -> task.cancel(false));
        watchdog.shutdownNow();
    }
}
```

几个关键点，逐个说清楚。

`tryLock` 没有把 token 暴露给 Redis 之外的存储，调用方拿到 token 后必须原样传回来。token 是释放锁的唯一凭证。

续期周期取租期的三分之一。30 秒租期，每 10 秒续一次，留出两次失败重试的机会。续期任务用 `key + "|" + token` 做 map 的键，原因很实际：锁过期后被新线程拿走，旧线程的续期任务随后醒来，如果只按 key 找任务，会把新线程的任务取消掉。这个 bug 很难测，但线上一定会遇到。

`renew` 里捕获了 `RuntimeException`。`ScheduledExecutorService` 有个坑：任务抛异常后，后续调度会直接停掉。Redis 抖一下，续期就永久停了，锁到期后无人续租。捕获异常并打日志，下一轮还能继续。

`unlock` 先取消续期，再执行 Lua。顺序反过来也能工作，但会多一次无意义的续期。

### 3.3 优惠券业务和接口

业务层用锁包住「查重、查库存、扣库存、记领取」四步。锁的粒度是单张券，不是全局锁。

```java
package com.example.redlock.coupon;

public record ClaimResult(boolean success, String message) {
}
```

```java
package com.example.redlock.coupon;

import com.example.redlock.lock.RedisLockService;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;

@Service
public class CouponService {

    private static final String STOCK_KEY = "coupon:stock:%s";
    private static final String ISSUED_KEY = "coupon:issued:%s";

    private final StringRedisTemplate redis;
    private final RedisLockService lockService;

    public CouponService(StringRedisTemplate redis, RedisLockService lockService) {
        this.redis = redis;
        this.lockService = lockService;
    }

    public ClaimResult claim(String couponId, String userId) {
        String lockKey = "lock:coupon:" + couponId;
        String token = lockService.tryLock(
                lockKey,
                Duration.ofSeconds(30),
                Duration.ofSeconds(3)
        );
        if (token == null) {
            return new ClaimResult(false, "当前领取人数较多，请稍后重试");
        }

        try {
            String issuedKey = ISSUED_KEY.formatted(couponId);
            Boolean issued = redis.opsForSet().isMember(issuedKey, userId);
            if (Boolean.TRUE.equals(issued)) {
                return new ClaimResult(false, "你已经领过这张券了");
            }

            String stockKey = STOCK_KEY.formatted(couponId);
            String stockValue = redis.opsForValue().get(stockKey);
            int stock = stockValue == null ? 0 : Integer.parseInt(stockValue);
            if (stock <= 0) {
                return new ClaimResult(false, "券已领完");
            }

            redis.opsForValue().decrement(stockKey);
            redis.opsForSet().add(issuedKey, userId);
            return new ClaimResult(true, "领取成功，剩余 " + (stock - 1) + " 张");
        } finally {
            lockService.unlock(lockKey, token);
        }
    }

    public void initStock(String couponId, int stock) {
        redis.opsForValue().setIfAbsent(
                STOCK_KEY.formatted(couponId),
                String.valueOf(stock)
        );
    }

    public void resetStock(String couponId, int stock) {
        redis.opsForValue().set(
                STOCK_KEY.formatted(couponId),
                String.valueOf(stock)
        );
        redis.delete(ISSUED_KEY.formatted(couponId));
    }
}
```

`claim` 里的四步必须都在锁内。只锁扣库存，不锁查重，两个请求可以同时通过查重，然后各自扣一次库存。只锁查重，不锁库存，超卖照样发生。

`finally` 里释放锁，保证业务抛异常也能解锁。释放失败会由租期兜底，最坏情况是等 30 秒。

`resetStock` 是给演示用的，生产环境不要暴露这种能重置库存的接口。

控制器只做参数接收和响应包装，不掺业务逻辑。

```java
package com.example.redlock.coupon;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/coupons")
public class CouponController {

    private final CouponService couponService;

    public CouponController(CouponService couponService) {
        this.couponService = couponService;
    }

    @PostMapping("/{couponId}/claims")
    public ResponseEntity<ClaimResult> claim(
            @PathVariable String couponId,
            @RequestParam String userId
    ) {
        return ResponseEntity.ok(couponService.claim(couponId, userId));
    }

    @PostMapping("/{couponId}/stock")
    public ResponseEntity<String> resetStock(
            @PathVariable String couponId,
            @RequestParam int stock
    ) {
        couponService.resetStock(couponId, stock);
        return ResponseEntity.ok("库存和领取记录已重置，库存为 " + stock);
    }
}
```

### 3.4 跑起来，用并发请求验证

本地先起一个 Redis，然后执行 `mvn spring-boot:run`。应用启动后，把库存重置成 100：

```bash
curl -X POST "http://localhost:8080/api/coupons/coupon-1001/stock?stock=100"
```

再用 50 个并发打 300 次领取请求：

```bash
seq 1 300 | xargs -P 50 -I{} curl -s -X POST   "http://localhost:8080/api/coupons/coupon-1001/claims?userId=user-{}"   | grep -o "领取成功" | wc -l
```

输出应该是 100。再用 `redis-cli` 核对：

```bash
redis-cli GET coupon:stock:coupon-1001
redis-cli SCARD coupon:issued:coupon-1001
```

库存是 0，领取集合大小是 100。把锁工具类里的 Lua 释放逻辑临时改成直接 `DEL`，再把租期调成 1 秒、业务里加一段 `Thread.sleep(2000)`，你就能复现超卖。这种对照实验比看十篇文章都管用。

## 四、踩坑经验和最佳实践

结论：锁写对了只完成一半，锁和事务的边界、锁的粒度、失败后的兜底，才决定这套东西能不能上线。

**锁必须包在事务外面。** 这是最容易踩的坑。假设 `claim` 上加了 `@Transactional`，`finally` 里释放锁，此时方法还没返回，Spring 的事务拦截器还没提交事务。锁已经放了，下一个线程进来读数据库，读到的还是旧库存。正确做法是把锁加在事务方法外面，或者用 `TransactionSynchronizationManager` 注册 `afterCompletion` 回调，等事务提交后再解锁。

**别用锁替代唯一索引。** 锁失效的瞬间，唯一索引还能拦住重复数据。领取记录表加 `UNIQUE KEY uk_user_coupon (user_id, coupon_id)`，库存扣减加 `stock > 0` 条件，这两条是底线。锁是性能优化，约束是正确性保障。

**锁的粒度要跟着业务走。** 按券 ID 加锁，不同券互不影响。一把 `lock:coupon` 锁住所有券，流量一大就排队。热点券还可以把库存拆成多段，用 Lua 原子扣减，进一步减少锁竞争。

**重试要有退避和抖动。** 上面的示例用固定 20 毫秒轮询，请求一多就是一群线程同时醒来抢锁。生产环境用指数退避加随机抖动，或者用 Redis 发布订阅通知等待者，别让大家一起撞墙。

**续期不是免死金牌。** JVM 长时间 STW（Stop The World，暂停所有业务线程）、容器被冻结、Redis 网络分区，续期都会失效。租期要按业务耗时的 P99（99% 的请求都能在这个时间内完成）留足余量，同时接受「锁可能提前失效」这个事实，用数据库约束兜底。

**多实例测试。** 单机跑 `synchronized` 也能过压测，一上集群就原形毕露。验证分布式锁，至少起两个应用实例，把请求打到不同端口。

## 五、性能对比和技术选型

结论：锁不是越强越好，选型看你要解决的是「少冲突」还是「绝不能错」。

| 方案 | 适用场景 | 优势 | 代价 |
| --- | --- | --- | --- |
| `synchronized` / `ReentrantLock` | 单机应用 | 纳秒级，无网络开销 | 跨节点完全无效 |
| 数据库行锁 `SELECT ... FOR UPDATE` | 低并发、强一致 | 实现简单，事务内可靠 | 连接被占用，热点行排队严重 |
| Redis `SET NX` + Lua | 高并发、多实例 | 毫秒级，跨节点互斥 | 要处理续期、误删、主从切换 |
| Redisson | 想少写底层代码 | 看门狗、可重入、锁类型全 | 多一层依赖，仍受 Redis 部署模型限制 |
| Lua 原子扣减（无锁） | 纯计数、库存扣减 | 吞吐最高，一次往返 | 只能表达单命令能完成的逻辑 |

优惠券这种「查重 + 扣库存 + 写记录」的多步业务，Redis 锁加数据库唯一索引是性价比最高的组合。纯粹的库存计数，直接用 Lua 扣减，连锁都省了。金融账务这种要求绝对互斥的场景，别犹豫，上数据库事务或者共识系统。

Redisson 值得用，尤其是不想自己维护续期线程的时候。但要知道它的看门狗同样依赖 JVM 存活和 Redis 可达，主从切换丢锁的问题也不会因为换了客户端就消失。

## 六、总结

Redis 分布式锁的可靠性，取决于四个细节。

加锁必须是一条 `SET key value NX PX`，不能拆成两步。value 必须是唯一 token，释放必须用 Lua 比对后删除。租期要覆盖业务耗时，续期任务要能容忍 Redis 抖动，还要按 token 隔离。最后，永远给数据库留一道唯一索引或条件更新的底线。

我见过太多项目，锁写得漂漂亮亮，事务一包、索引一省，大促照样超卖。锁解决的是并发冲突，不是数据正确性。这两件事分清楚，方案就不会跑偏。

文 / 会编程的吕洞宾

## 参考资料

- [Redis SET command](https://redis.io/docs/latest/commands/set/)
- [Redis distributed locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)
- [Redis EVAL command](https://redis.io/docs/latest/commands/eval/)
- [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

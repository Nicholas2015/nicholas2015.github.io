---
title: Java内存只涨不降_4步揪出泄漏的那行代码
date: 2026-11-24 17:07:08
tags: ["Java", "JVM", "Spring Boot"]
categories: java
---

# Java内存只涨不降_4步揪出泄漏的那行代码

> 服务上线三天，堆内存从 2G 爬到 6G，Full GC 越来越勤。重启一次世界安静，过几天原样复发。日志干净，CPU 不高，接口也不慢——这种"慢慢烂掉"的故障最恶心，它不崩给你看，专挑凌晨动手。这篇把一套能落地的流程走完：怎么判断是"内存涨"还是"内存泄漏"，怎么从 GC 日志和堆快照里挖出那行代码，以及两种最常见的泄漏写法到底长什么样、怎么改。

## 一、这个问题到底是什么

Java 里的内存泄漏，指对象已经没人用了，但仍有一条引用链指着他，垃圾回收器判定"他还活着"，于是永远不回收。

打个比方。快递站代收点按名字存取包裹，只要运单上还写着你的名字，包裹就一直占着货架。你以为自己早就取走了，实际上货架在慢慢被撑爆。Java 的"运单"就是引用，GC 就是按图索骥的店员，他不管这包裹你还想不想要，只认名字还在不在。

**内存涨不等于内存泄漏。** 生产环境里这三种曲线要分清楚：

| 曲线形状 | 含义 | 处理方向 |
| --- | --- | --- |
| 锯齿状稳步上移，每次 Full GC 后都回不到上次的基线 | 老年代回收不掉，典型泄漏 | 抓堆快照 |
| 尖峰之后回落，基线稳定 | 正常流量波动、批量任务 | 不用管，看容量 |
| 一步登天，短时间占满 | 一次性大对象、超大查询、批量导入 | 查那一次请求 |

判断方法是看趋势，不看绝对值。取连续三次 Full GC 之后的 old 区占用，如果每次都往上抬一截，基本可以定性为泄漏。只看一次 90% 的占用就喊 OOM，容易误伤——那是该扩容，不是有 bug。

**能造成这种曲线的代码，翻来覆去就那几类。**

- 静态集合当缓存，只 put 不 remove，也不设上限
- ThreadLocal 用完不清理，而线程来自线程池，长期不死
- 监听器、回调、事件总线注册了不注销
- 流和连接没关，或者 Netty 的 ByteBuf 少了一次 release
- 自定义 ClassLoader 反复创建（热部署、脚本引擎）

按症状对号入座，能省掉一半排查时间：

| 症状 | 大概率方向 |
| --- | --- |
| 堆内存涨，class_histogram 里 `java.util.HashMap$Node` 暴涨 | 静态 Map 或 Spring 单例里的大容器 |
| 堆内存涨，`ThreadLocalMap$Entry` 和业务对象一起涨 | ThreadLocal 没 remove |
| 堆内存看着正常，进程 RSS 一直涨，最后被容器杀掉 | 堆外内存：DirectByteBuffer、Netty、JNI |
| Metaspace 涨，出现 `OutOfMemoryError: Metaspace` | 动态生成类：反射代理、Groovy/JS 引擎、热部署 |

## 二、底层原理到底怎么回事

### GC Roots：谁有资格"担保"一个对象活着

JVM 判断对象死活用的是可达性分析：从一组叫 GC Roots 的对象出发，顺着引用往下走，走得到的就是活的，走不到的就是垃圾。

GC Roots 包括这几类：

1. 虚拟机栈里正在被使用的局部变量（也就是当前方法栈帧里的引用）
2. 方法区里静态属性引用的对象
3. 方法区里常量引用的对象
4. 本地方法栈里 JNI 引用的对象
5. 活着的线程、同步锁持有的对象

第 2 条是重点：**静态字段本身就是 GC Root**。一个 `static final Map` 挂在类上，类由类加载器持有，类加载器活到进程结束。所以这个 Map 里的每一个 value，都是"根上直接挂着的"，GC 连看都不用看，直接放过。这就是为什么"写个 static HashMap 当缓存"是泄漏排行榜第一名——它不是"可能泄漏"，是"只要你不删就永远不回收"，逻辑上必然涨。

### ThreadLocal：弱引用救不了你

ThreadLocal 的引用结构值得单独拆开看，因为太多人在这里翻车。

```
Thread（线程池里的工作线程，活很久）
  └─ threadLocals: ThreadLocalMap
       └─ table: Entry[]
            └─ Entry extends WeakReference<ThreadLocal<?>>
                 ├─ referent → ThreadLocal 对象（弱引用，会被回收）
                 └─ value    → 你 set 进去的业务对象（强引用！）
```

关键在最后两行。Entry 的 key 是弱引用，value 是强引用。设计者的想法是：ThreadLocal 对象没人用了就被回收，key 变成 null，下次 get/set 时顺手把 value 清掉。

这个"顺手"只在两种情况下发生：一是你继续操作同一个 ThreadLocalMap，二是线程结束、整个 map 一起消失。

问题在于：线程池里的线程不会结束。它处理完一个请求就去处理下一个，ThreadLocalMap 一直挂在 Thread 上。你 set 进去的用户信息、分页结果、甚至整个请求上下文，就这么被一条强引用钉在那里。ThreadLocal 对象本身被回收了，key 是 null，value 还在数组里躺着——成为著名的"僵尸 Entry"。

所以结论很硬：**用了线程池，ThreadLocal 就必须手动 remove**。指望弱引用自动清理，是拿命赌 GC 的时机。

### 对象怎么一步步爬进老年代

新对象分配在 Eden。Minor GC 时还活着的，被复制到 Survivor 区，年龄加一。年龄到阈值（默认 15，还有动态年龄判定），晋升到老年代。

泄漏对象有个特征：每次 Minor GC 他都"活着"。于是每轮都 +1 岁，顺利晋升老年代。老年代占满触发 Full GC，回收一圈发现全是有引用的，一个都删不掉。接着继续分配、继续占满、继续 Full GC。最后分配不到连续空间，抛 `java.lang.OutOfMemoryError: Java heap space`。

所以你会看到一个很迷惑的现象：Full GC 次数飙升，但每次回收的效果越来越差。这不是 GC 参数没调好，是对象根本不该活那么久。

### 别忘了堆外和元空间

排查堆内存的时候容易钻牛角尖，忘了进程内存不等于堆内存。

`-Xmx4g` 的进程，真实内存占用可能是 4g 堆 + 元空间 + 每个线程的栈（默认 1M）+ 直接内存 + JVM 自身开销。一台 limit 4Gi 的容器里跑 `-Xmx4g`，结果就是 JVM 没 OOM，容器先被 OOMKilled，killer 只留一句 exit code 137，什么堆快照都没有。

DirectByteBuffer 的回收依赖 Cleaner，而 Cleaner 要等 Full GC 才执行。堆压力不大的时候 Full GC 少，直接内存反而越积越多——这就是"启用了堆外缓存，RSS 涨得离谱"的常见原因。

### Retained Size：为什么 MAT 里不看 Shallow

堆快照工具里有两个数字：Shallow Heap 和 Retained Heap。

Shallow 是这个对象自己占多少字节，比如一个 HashMap 实例可能只有 48 字节。Retained 是这个对象被回收后，能连带释放多少字节——包括他独占引用的所有东西。

一个存了 10 万个 Order 的 HashMap，Shallow 可能不到 100 字节，Retained 是十几兆。你要找的是"谁独占着这十几兆"，所以看 Retained，并且从大到小排。看完还得看 Path to GC Roots，确认是哪条引用链让他活着。

## 三、实战：手把手把泄漏复现、定位、修掉

下面这套代码是一个能直接跑起来的 Spring Boot 工程，故意写了两种泄漏。你可以自己压一压，体会一下"涨得有多快"。

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
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>mem-leak-demo</artifactId>
    <version>1.0.0</version>
    <name>mem-leak-demo</name>

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
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>com.github.ben-manes.caffeine</groupId>
            <artifactId>caffeine</artifactId>
            <version>3.3.1</version>
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

Actuator 是为了用 `/actuator/metrics/jvm.memory.used` 看堆曲线，Caffeine 是后面修复用的有界缓存。压测阶段用不上 Caffeine，但一次装齐省得来回改。

### 3.2 配置文件

```yaml
server:
  port: 8080

spring:
  application:
    name: mem-leak-demo

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,heapdump
  endpoint:
    heapdump:
      enabled: true
```

`heapdump` 端点暴露出来以后，可以在不登录服务器的情况下 curl 一份快照出来，容器环境里非常好用。生产环境记得加权限控制，快照里全是业务数据。

### 3.3 启动类

```java
package com.example.memleak;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class MemLeakApplication {

    public static void main(String[] args) {
        SpringApplication.run(MemLeakApplication.class, args);
    }
}
```

### 3.4 订单实体

```java
package com.example.memleak;

import java.math.BigDecimal;
import java.time.Instant;

public record Order(
        long id,
        String userId,
        BigDecimal amount,
        Instant createdAt,
        String remark
) {
}
```

### 3.5 泄漏写法一：静态 Map 当缓存

```java
package com.example.memleak;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class OrderCacheService {

    private static final Map<Long, Order> CACHE = new HashMap<>();

    public Order getOrder(long id, String userId) {
        Order cached = CACHE.get(id);
        if (cached != null) {
            return cached;
        }
        Order order = new Order(id, userId, new BigDecimal("99.00"), Instant.now(), "demo-order-" + id);
        CACHE.put(id, order);
        return order;
    }

    public int size() {
        return CACHE.size();
    }
}
```

这段代码一眼看上去没毛病：查缓存，没有就回源，回源后写缓存。问题全在 `static final Map` 这五个字上。没有过期时间，没有容量上限，没有淘汰策略。每个不同的订单号都会往里面塞一条永不删除的记录。

真实项目里它通常伪装得更好看一点——包一层 `ConcurrentHashMap`，写个 `ConcurrentMapCacheManager`，或者用 `@Cacheable` 却不配 `maximumSize`。本质都一样。

### 3.6 泄漏写法二：ThreadLocal 不清理

```java
package com.example.memleak;

public final class UserContext {

    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private UserContext() {
    }

    public static void set(String userId) {
        CURRENT.set(userId);
    }

    public static String get() {
        return CURRENT.get();
    }

    public static void clear() {
        CURRENT.remove();
    }
}
```

```java
package com.example.memleak;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {

    private final OrderCacheService orderCacheService;

    public OrderController(OrderCacheService orderCacheService) {
        this.orderCacheService = orderCacheService;
    }

    @GetMapping("/order/{id}")
    public Order order(@PathVariable long id,
                       @RequestParam(defaultValue = "u-1001") String userId) {
        UserContext.set(userId);
        return orderCacheService.getOrder(id, userId);
    }

    @GetMapping("/cache/size")
    public int cacheSize() {
        return orderCacheService.size();
    }
}
```

`set` 之后直接 return，没有任何清理动作。单个请求看不出问题，因为 Tomcat 处理完这个请求就结束了。可一旦用了 `@Async`、定时任务线程池、自定义线程池，线程会被复用，上一次的 value 就粘在上面。这种情况下泄漏的东西往往是整个用户上下文对象，比一个字符串重得多。

顺带说一句，就算 value 是个小字符串也别觉得无所谓——它钉住的可能是整个引用链，用户对象、关联的租户配置、甚至一个数据库连接包装类。

### 3.7 跑起来看它到底涨多快

打包启动，堆故意开小一点，方便观察：

```bash
mvn -q clean package
java -Xms256m -Xmx256m \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/tmp/dumps \
     -jar target/mem-leak-demo-1.0.0.jar
```

另一个窗口压一下，制造不同订单号，逼缓存变大：

```bash
for i in $(seq 1 30000); do
  curl -s "http://localhost:8080/order/$i" > /dev/null
done
curl -s http://localhost:8080/cache/size
```

`/cache/size` 会稳稳地等于压测次数。这个数字只增不减，就是泄漏最直接的证据——业务上"缓存条目数应该收敛"，实际却在无限增长。

### 3.8 四步定位：从怀疑到那一行代码

**第一步，确认是全量泄漏还是误会。** 连续看三次堆概况，间隔一两分钟：

```bash
jcmd <pid> GC.heap_info
```

输出里关注 `garbage-first heap` 后面的 `used` 和分区情况。如果老年代（old regions）用量三次都在涨，且没有回落，泄漏成立。同时可以看接口：

```bash
curl -s 'http://localhost:8080/actuator/metrics/jvm.memory.used?tag=area:heap'
```

**第二步，看谁在占。** 类直方图按实例字节数排序，前后各抓一次做差：

```bash
jcmd <pid> GC.class_histogram | head -30
```

`com.example.memleak.Order` 的实例数跟着请求数一起涨，`java.util.HashMap$Node` 同步涨，答案基本就出来了。这一步不用停服务，开销也小，线上可以放心跑。

**第三步，抓快照。** 定位不到具体引用链时再上快照：

```bash
jcmd <pid> GC.heap_dump /tmp/dumps/heap-$(date +%H%M).hprof
```

或者直接从 actuator 端点拉：

```bash
curl -o heap.hprof http://localhost:8080/actuator/heapdump
```

**第四步，在 MAT 里顺着引用走。** 用 Eclipse Memory Analyzer 打开 hprof，先看 Leak Suspects 报告，再进 Histogram 找那个可疑类，右键 `Merge Shortest Paths to GC Roots`，勾掉弱引用和软引用。引用链会一路指到 `OrderCacheService.CACHE` 这个静态字段。到了这一步，剩下就是改代码。

如果泄漏对象在压测里就复现了，还有个更快的土办法：前后两次 class_histogram 做差值，找出"增长量最大"的类，再去代码里搜它的集合容器，命中率相当高。

### 3.9 改对：有界缓存 + 显式清理

缓存换成 Caffeine，容量和过期时间都写死，让它自己淘汰：

```java
package com.example.memleak;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.stats.CacheStats;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import org.springframework.stereotype.Service;

@Service
public class SafeOrderCacheService {

    private final Cache<Long, Order> cache = Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofMinutes(10))
            .recordStats()
            .build();

    public Order getOrder(long id, String userId) {
        return cache.get(id, key -> loadFromDb(key, userId));
    }

    private Order loadFromDb(long id, String userId) {
        return new Order(id, userId, new BigDecimal("99.00"), Instant.now(), "demo-order-" + id);
    }

    public long estimatedSize() {
        return cache.estimatedSize();
    }

    public CacheStats stats() {
        return cache.stats();
    }
}
```

三行配置各自管一件事。`maximumSize` 是硬上限，内存再涨也有边界；`expireAfterWrite` 保证数据不会永远陈旧；`recordStats` 让命中率可以被观测——没有命中率数据的缓存，等于没有缓存，你不知道它到底在挡流量还是在裸奔。

控制器补上 `finally`，保证异常路径也清理：

```java
package com.example.memleak;

import com.github.benmanes.caffeine.cache.stats.CacheStats;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {

    private final SafeOrderCacheService orderCacheService;

    public OrderController(SafeOrderCacheService orderCacheService) {
        this.orderCacheService = orderCacheService;
    }

    @GetMapping("/order/{id}")
    public Order order(@PathVariable long id,
                       @RequestParam(defaultValue = "u-1001") String userId) {
        try {
            UserContext.set(userId);
            return orderCacheService.getOrder(id, userId);
        } finally {
            UserContext.clear();
        }
    }

    @GetMapping("/cache/size")
    public long cacheSize() {
        return orderCacheService.estimatedSize();
    }

    @GetMapping("/cache/stats")
    public CacheStats cacheStats() {
        return orderCacheService.stats();
    }
}
```

`finally` 不能省。业务方法抛异常时，没有 `finally` 的 `remove` 根本执行不到，清理逻辑形同虚设。这也是很多"加了 clear 还在漏"的根本原因。

入口在拦截器或者过滤器的场景，把清理放在 `afterCompletion` 里，而不是跟业务代码混在一起。`afterCompletion` 无论请求成功失败都会回调，是唯一靠谱的位置。

## 四、踩坑经验和最佳实践

**第一个坑：dump 完手比脑子快，先重启了。** 重启之后现场没了，问题"好了"，一周后复发，从头再查一遍。堆快照是唯一能复盘的证据，先落盘再动服务。容器里还有个细节——重启前确认 dump 文件已经写完整（文件大小不再增长），否则拿到的是个残废的 hprof。

**第二个坑：快照把磁盘写满，服务连带隔壁一起挂。** 堆 8G，dump 出来差不多也是 8G，而 /tmp 常常只有几个 G，或者是内存盘。`-XX:HeapDumpPath` 一定要指到大容量数据盘，并且配个定时清理，别让 dump 文件累积成隐形炸弹。

**第三个坑：线上高峰期做了 `jmap -dump:live`。** 加 `:live` 会先触发一次 Full GC，在大堆上停顿可能是秒级甚至更长。要快照就在低峰做，或者先用 `GC.class_histogram` 这种低开销手段缩小范围。另外 `jcmd GC.heap_dump` 默认就是全量 dump，不走 Full GC，比 `jmap` 温和。

**第四个坑：容器 limit 和 -Xmx 贴得太近。** `-Xmx4g` 配 `limit: 4Gi`，堆外内存、元空间、线程栈一并算进去就超了，容器直接 OOMKilled，JVM 根本没机会抛 OOM，也就没有 `HeapDumpOnOutOfMemoryError` 什么事。经验值：容器 limit 至少是 `-Xmx` 的 1.3 倍，堆外大户（Netty、大量 DirectByteBuffer）给到 1.5 倍。

**第五个坑：以为给 ThreadLocal 加 static 就安全。** 恰恰相反。`static` 的 ThreadLocal 生命周期和类一样长，key 更难被回收，value 留得更久。真正需要的是在正确的时机 `remove`，跟加不加 static 没关系。

落实到日常，几条能直接抄进规范的：

- 任何进程内缓存，创建时就必须填容量上限和过期时间，没有例外
- ThreadLocal 一律 `try/finally` + `remove`，或者在拦截器统一清理
- 集合字段上加注释写清楚"谁负责删除""上限多少"，让下一个人不敢乱写
- 上线前压一轮，只看一个指标：Full GC 之后的老年代占用能不能回到基线
- 生产环境固定加 `-XX:+HeapDumpOnOutOfMemoryError`，这行参数救过的人比任何监控都多

## 五、性能对比和技术选型

进程内缓存到底用什么，结论先给：**单机场景一律 Caffeine，别自己拿 HashMap 写 LRU，跨实例共享再上 Redis。**

| 方案 | 命中性能 | 内存可控性 | 淘汰能力 | 多实例一致性 | 适合场景 |
| --- | --- | --- | --- | --- | --- |
| static HashMap 手写 | 最快 | 无上限，必然泄漏 | 没有 | 各存各的 | 不要用 |
| LinkedHashMap 手写 LRU | 快，需自己加锁 | 可设上限 | 只有 LRU，无过期 | 各存各的 | 教学演示 |
| Caffeine | 接近 HashMap，分段并发 | maximumSize 硬约束 | W-TinyLFU + 多种过期策略 | 各存各的 | 单机热点数据、字典表、鉴权信息 |
| Redis | 一次网络往返 | 受实例内存约束 | 支持 TTL 和淘汰策略 | 天然共享 | 跨实例共享、需要持久化 |

Caffeine 的淘汰算法是 W-TinyLFU，比朴素 LRU 更能抗"周期性扫描"造成的缓存污染——一次性大批量查询不会把真正的热点数据挤出去。这是它比手写 LRU 强的地方，也是最容易被忽略的地方。

容量怎么定？别拍脑袋。用 `recordStats` 跑一周，看命中率和缓存条目数，把 `maximumSize` 定在条目数 P99 略高的位置，再按单条对象大小估算内存占用，控制在堆的 20% 以内。超过这个比例，缓存就开始和业务抢内存了。

## 六、总结

内存泄漏的本质从来不是"GC 不干活"，而是"有一条你不想要的引用链，帮对象续着命"。静态字段是 GC Root，所以静态集合里的东西永远不会被回收；ThreadLocal 的 value 是强引用，所以弱引用 key 救不了它。

排查路径可以固化成四步：看 Full GC 后的老年代基线确认泄漏，用 class_histogram 差值锁定嫌疑类，抓 hprof 顺引用链找到持有者，改代码并把清理写进 `finally`。

真正省时间的不是 MAT 用得有多熟，而是别写出这种代码：缓存有界、ThreadLocal 必清、容器内存留余量。前两条能消灭八成泄漏，第三条能保证剩下两成还有得查。

文 / 会编程的吕洞宾

## 参考资料

- [jcmd](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- [jmap](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jmap.html)
- [Java Platform, Standard Edition HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/)
- [Caffeine Wiki - Population](https://github.com/ben-manes/caffeine/wiki/Population)
- [Spring Boot Actuator Endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)

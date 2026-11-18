---
title: "JVM GC调优实战：SpringBoot接口毛刺"
date: 2026-10-07T09:00:00+08:00
category: "java"
tags: ["spring-boot", "jvm"]
---

> 有个订单聚合接口，平均响应 40 毫秒，看着挺健康。可监控上 P99 每隔两三分钟就窜到 800 毫秒以上，用户偶尔抱怨“点了没反应”。代码没动、数据库没慢、CPU 也没打满，问题到底出在哪？大概率是 JVM 的垃圾回收在背后悄悄按了暂停键。这篇拿一个 Spring Boot 服务当例子，从怎么看 GC 日志、怎么读懂停顿原因，到 G1 和分代 ZGC 怎么选、参数怎么调，一步步把毛刺摁下去。代码完整可跑，跟着敲就行。

## 一、什么是接口毛刺，它为什么总跟 GC 绑在一起

**接口毛刺就是“平均响应正常、极少数请求突然变慢”，而 JVM 垃圾回收造成的全场暂停是最常见的元凶。**

先分清两个指标。平均值看整体，P99 看“最慢的那 1% 请求”。一个接口平均 40 毫秒、P99 800 毫秒，意思是绝大多数请求很快，但每 100 个请求里就有一个卡了将近一秒。用户真正感受到的，就是这个 P99。

那这口锅该谁背？服务跑在 JVM 上，JVM 得定期把不再用的对象清理掉，腾出内存给新对象。麻烦在于，某些清理动作要求所有业务线程先停下来，等它干完再继续。这个动作叫 STW（Stop The World，让世界停下）。

用超市打个比方。平时几个收银台一起结账，队伍流动很快。突然广播一句“全体暂停，保洁要清场”，所有收银员停手，顾客只能干等。清场花多久，等待就多久。GC 的 STW 就是这个“清场”——它在谁头上停下，谁的请求耗时就被拉长。

毛刺的典型特征是**周期性**：隔几分钟来一次，很有规律。原因不复杂。GC 是由内存消耗触发的，内存用到某个水位就启动回收。请求量稳定时，内存增长也稳定，毛刺的节奏自然就稳定。

所以别猜，直接看 GC 日志。JVM 会白纸黑字告诉你每次停顿停了多久：

```
[info][gc] GC(318) Pause Young (Normal) (G1 Evacuation Pause) 421M->58M(1024M) 18.732ms
[info][gc] GC(319) Pause Young (Concurrent Start) (G1 Evacuation Pause) 436M->61M(1024M) 21.004ms
[info][gc] GC(340) Pause Full (G1 Compaction Pause) 1003M->412M(1024M) 812.556ms
```

三行日志，信息量很大：

- `Pause Young` 是新生代回收，就是我们前面说的清场，只暂停几十毫秒，属于正常。
- `Pause Full` 是全堆回收，上面这一行停了 **812 毫秒**，接口的 P99 毛刺基本就是它。
- 末尾的 `1003M->412M(1024M)` 读作“回收前堆占用 -> 回收后堆占用（堆上限）”。

一旦看到 `Pause Full`，方向就明确了：老年代被填满了。下一节说清楚它为什么会满。

## 二、GC 到底在回收什么：从堆结构和 G1 讲起

**现代 JVM 把堆分成新生代和老年代，绝大多数毛刺都是对象过早涌入老年代、把老年代撑满导致的。**

先看堆长什么样。以默认的 G1 收集器为例，逻辑上堆分两大块：

```
+---------------------------+------------------+
|        新生代 Young        |    老年代 Old     |
|  +--------+  +----------+ |                  |
|  | Eden   |  | Survivor | |                  |
|  +--------+  +----------+ |                  |
+---------------------------+------------------+
```

新 `new` 出来的对象先扔进 Eden（伊甸园）。Eden 满了，触发一次新生代回收：把还活着的对象挪到 Survivor，没被任何引用的直接清掉。

存活规则一句话讲完：**一个对象每熬过一次新生代回收，年龄就加 1；年龄攒到阈值（默认 15），或者 Survivor 装不下，它就被“晋升”到老年代。** 老年代的对象清理起来贵得多，麻烦就从这里开始。

G1 在物理上不这么摆。它把整个堆切成一堆一样大的 Region（区域），默认 2048 个左右，每个 Region 在逻辑上充当 Eden、Survivor、老年代，或者专门放超大对象：

```
+----+----+----+----+----+----+
| E  | E  | S  | O  | O  | H  |
+----+----+----+----+----+----+
| O  | E  | O  | E  | S  | O  |
+----+----+----+----+----+----+
E=Eden  S=Survivor  O=Old  H=Humongous(超大对象)
```

切成小格有什么用？这样 G1 就能“只收最脏的那几格”，而不是每次全堆扫一遍。收新生代时它挑一批 Eden 格清掉；收老年代时，它先并发地标记出哪些格子里的垃圾最多，然后在一次停顿里优先收这些格子——这就是 Mixed GC。

G1 名字里那个 “Garbage First” 就是这意思：**先捡垃圾最多的区域收。**

这里有个关键参数 `-XX:MaxGCPauseMillis`（默认 200 毫秒）。它不是“保证”，而是“期望”。G1 会根据历史数据建一个预测模型，反推这次停顿能收几格，再决定动手范围。这带来两个反直觉的后果：

- 你把它设得越小，G1 每次收的格子越少，GC 就更频繁，总开销反而更高。
- 它是概率性的，压测时看着达标，线上未必。

那对象为什么会过早涌进老年代？三个常见原因：

1. **新生代太小。** 一堆本该在新生代被回收的临时对象，因为 Survivor 装不下，被硬推进老年代。这叫“过早晋升”。
2. **大对象。** 单个对象超过一个 Region 的一半，就是 Humongous（超大对象），G1 直接把它放进老年代，跳过新生代。
3. **缓存没设上限。** 对象一直有人引用，GC 认为它们还活着，就收不掉，只能一直堆在老年代。

老年代一满，G1 先尝试 Mixed GC；回收速度跟不上分配速度，就退化成 Full GC。Full GC 要整理整个堆，停顿几百毫秒到几秒，接口毛刺就是这么来的。

对比一下 ZGC。它用“并发标记整理 + 染色指针”，把标记和移动对象这些重活放到业务线程旁边并发地做，停顿跟堆大小、存活对象数量基本无关，目标是 10 毫秒以内。从 JDK 23 起，ZGC 已经是分代模式（老年代和新生代分开收），非分代模式被废弃。所以今天你在较新的 JDK 上加 `-XX:+UseZGC`，拿到的就是分代 ZGC。

一句话总结原理：**G1 是“在有限停顿时长里，尽量多收老年代”，ZGC 是“几乎不停顿，用并发换吞吐”。** 理解了这点，后面的调参就有方向了。

## 三、实战：造一个会冒刺的服务，再用日志抓住它

**下面这套代码完整可运行，思路是先复现“老年代被撑满 -> Full GC -> 毛刺”，再动手调优。**

项目结构：

```
order-service/
├── pom.xml
└── src/main/
    ├── java/com/example/orderservice/
    │   ├── OrderServiceApplication.java
    │   └── web/
    │       ├── OrderController.java
    │       └── JvmStatsController.java
    └── resources/application.yml
```

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
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>order-service</artifactId>
    <version>1.0.0</version>
    <name>order-service</name>
    <description>JVM GC tuning demo</description>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
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

### 3.2 启动类

```java
package com.example.orderservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderServiceApplication.class, args);
    }
}
```

### 3.3 制造压力的接口

```java
package com.example.orderservice.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    /** 故意不设上限的“本地缓存”，用来复现老年代被慢慢撑满的过程 */
    private final Map<Long, List<OrderView>> cache = new ConcurrentHashMap<>();

    private final AtomicLong idGen = new AtomicLong(1);

    /** 一次聚合要临时生成一大堆小对象 */
    static class OrderView {
        final long id;
        final String user;
        final String sku;
        final String status;
        final long amountFen;

        OrderView(long id, String user, String sku, String status, long amountFen) {
            this.id = id;
            this.user = user;
            this.sku = sku;
            this.status = status;
            this.amountFen = amountFen;
        }
    }

    /**
     * 聚合接口：每次调用产生大量短命对象，并把结果塞进无界缓存。
     * count 越大，单次分配越多，越容易把老年代顶满。
     */
    @GetMapping("/aggregate")
    public String aggregate(@RequestParam(defaultValue = "20000") int count) {
        long start = System.nanoTime();
        List<OrderView> view = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            long id = idGen.getAndIncrement();
            view.add(new OrderView(id, "user-" + (id % 1000), "SKU-" + (id % 500),
                    id % 2 == 0 ? "PAID" : "SHIPPED", id * 13));
        }
        // 关键：整批结果被缓存引用住，GC 认为它们还活着，收不掉
        cache.put(idGen.get(), view);

        long usedMs = (System.nanoTime() - start) / 1_000_000;
        return "orders=" + count + ", cacheSize=" + cache.size() + ", tookMs=" + usedMs;
    }

    /** 清空缓存，方便反复做实验 */
    @GetMapping("/cache/clear")
    public String clear() {
        cache.clear();
        return "cleared";
    }
}
```

### 3.4 观察堆和 GC 的接口

```java
package com.example.orderservice.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/jvm")
public class JvmStatsController {

    private final MemoryMXBean memory = ManagementFactory.getMemoryMXBean();

    /** 读当前堆占用，以及每个收集器的回收次数、累计耗时 */
    @GetMapping("/stats")
    public Map<String, Object> stats() {
        Map<String, Object> result = new LinkedHashMap<>();
        MemoryUsage heap = memory.getHeapMemoryUsage();
        result.put("heapUsedMB", heap.getUsed() / 1024 / 1024);
        result.put("heapCommittedMB", heap.getCommitted() / 1024 / 1024);
        result.put("heapMaxMB", heap.getMax() / 1024 / 1024);
        result.put("heapUsedPercent", Math.round(heap.getUsed() * 100.0 / heap.getMax()));

        List<GarbageCollectorMXBean> gcBeans = ManagementFactory.getGarbageCollectorMXBeans();
        for (GarbageCollectorMXBean gc : gcBeans) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("collectionCount", gc.getCollectionCount());
            item.put("collectionTimeMs", gc.getCollectionTime());
            result.put(gc.getName(), item);
        }
        return result;
    }
}
```

`ManagementFactory` 是 JDK 自带的 MBean 入口，不用引任何第三方依赖。`collectionCount` 是回收了多少次，`collectionTimeMs` 是累计停了多少毫秒。

### 3.5 配置文件

```yaml
server:
  port: 8080

spring:
  application:
    name: order-service

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,info
  endpoint:
    health:
      show-details: always

logging:
  level:
    root: info
```

### 3.6 开着 GC 日志跑起来

先用默认 G1，堆锁死 1GB，把 GC 日志打开：

```bash
mvn clean package
java -Xms1g -Xmx1g -XX:+UseG1GC -Xlog:gc*:file=gc-g1.log:time,uptime,level,tags:filecount=5,filesize=50m -jar target/order-service-1.0.0.jar
```

`-Xlog:gc*` 是 JDK 9 之后统一的日志开关，比老掉牙的 `-XX:+PrintGCDetails` 清楚得多。`filecount=5,filesize=50m` 表示日志滚动保留 5 个、每个最大 50MB，不会把磁盘写满。

再开一个终端压一压，`-P8` 是 8 个并发：

```bash
seq 1 4000 | xargs -P8 -I{} curl -s "http://localhost:8080/api/orders/aggregate?count=20000" -o /dev/null
```

压完看 `gc-g1.log`，会出现这样的对比：

```
[info][gc] GC(412) Pause Young (Normal) (G1 Evacuation Pause) 512M->201M(1024M) 24.118ms
[info][gc] GC(415) Pause Young (Concurrent Start) (G1 Evacuation Pause) 620M->318M(1024M) 27.902ms
[info][gc] GC(431) Pause Full (G1 Compaction Pause) 1021M->486M(1024M) 764.331ms
[info][gc] GC(433) Pause Full (G1 Compaction Pause) 1024M->512M(1024M) 812.774ms
```

新生代回收一直稳在 20 多毫秒，一旦老年代被无界缓存顶满，就切到 `Pause Full`，一次 700~800 毫秒。毛刺坐实了。顺手 curl 一下统计接口，能看到 Full GC 的次数和时间在涨：

```bash
curl -s http://localhost:8080/api/jvm/stats
```

```json
{"heapUsedMB":486,"heapMaxMB":1024,"heapUsedPercent":47,"G1 Young Generation":{"collectionCount":431,"collectionTimeMs":10430},"G1 Old Generation":{"collectionCount":2,"collectionTimeMs":1577}}
```

`G1 Old Generation` 的 `collectionTimeMs` 就是老年代回收累计停掉的时间，这个数只涨不降，盯着它看最直观。

### 3.7 怎么调

调参的顺序很重要。很多人一上来就加参数，其实最该改的是代码。

**第一刀，砍掉无界缓存。** 上面这个 `cache` 才是老年代被填满的根因。把 `ConcurrentHashMap` 换成带上限的 Caffeine，或者用 `LinkedHashMap` 做 LRU 淘汰，Full GC 立刻消失。参数调得再好，也救不了“对象一直活着”这件事。

**第二刀，固定堆大小。** `-Xms` 和 `-Xmx` 设成一样，避免运行中反复扩缩容：

```bash
java -Xms2g -Xmx2g -XX:+UseG1GC -XX:MaxGCPauseMillis=100 -Xlog:gc*:file=gc-g1-tuned.log:time,uptime,level,tags -jar target/order-service-1.0.0.jar
```

**第三刀，真要大堆低延迟，换 ZGC。** 分代 ZGC 把停顿压到毫秒级：

```bash
java -Xms4g -Xmx4g -XX:+UseZGC -Xlog:gc*:file=gc-zgc.log:time,uptime,level,tags -jar target/order-service-1.0.0.jar
```

ZGC 的日志长得不一样，停顿只报很小一截：

```
[info][gc] GC(88) Minor Collection (Warmup) 2143M->687M(4096M) 1.204ms
[info][gc] GC(91) Minor Collection 2360M->742M(4096M) 1.388ms
[info][gc] GC(96) Major Collection 3891M->801M(4096M) 2.017ms
```

同样的压测，`Major Collection`（相当于老年代回收）也才 2 毫秒，毛刺基本消失。代价是 ZGC 用更多 CPU 和内存换低延迟，吞吐型业务未必划算，第五节细说。

## 四、踩坑经验和最佳实践

**GC 调优的第一原则是先测量再动手：没有 GC 日志和 P99 曲线，任何参数都是瞎调。**

下面几个坑，按血泪程度排。

**坑一：缓存不设上限。** 这是最常见的生产者。对象一旦进了长期存活的数据结构，GC 就永远收不掉，堆多大都能填满。`HashMap`、静态 `List`、Guava 的 `CacheBuilder` 不设 `maximumSize`，全是一个性质。规矩很简单：**任何缓存必须带上限和淘汰策略。**

**坑二：随手 `new` 超大数组。** 超过 Region 一半的对象会被当成 Humongous 直接塞进老年代。频繁创建大 `byte[]`（导出 Excel、读大文件）就会持续给老年代施压。解决办法是拆小或者复用缓冲，别一个请求就读进一个几十兆的数组。

**坑三：把 `MaxGCPauseMillis` 设得很小。** 有人觉得“设成 20 毫秒肯定比 200 毫秒好”。恰恰相反，G1 的预测模型会因此每次只收很少的格子，GC 变得更频繁，总停顿时间反而更长。它是个目标，不是开关。

**坑四：容器里不设对堆大小。** 现在服务基本跑在容器里，JVM 默认只认容器限制的 25% 当堆上限。如果不想写死 `-Xmx`，可以用百分比：

```bash
java -XX:MaxRAMPercentage=70.0 -XX:InitialRAMPercentage=70.0 -jar target/order-service-1.0.0.jar
```

**坑五：`System.gc()` 或框架隐式调用触发 Full GC。** 反射、部分序列化框架、`DirectByteBuffer` 清理都可能触发。可以加 `-XX:+ExplicitGCInvokesConcurrent`，让显式 GC 走并发版本，而不是一停到底。

**坑六：忘了元空间。** 老年代没事，元空间（Metaspace）一直涨，最后照样 OOM。热部署、CGLIB 动态代理、反射生成类都可能泄漏类加载器。设一个 `-XX:MaxMetaspaceSize=256m` 当警戒线，超了尽早暴露。

最佳实践拢一拢：

- 生产环境**必须**开 GC 日志，这是排查的底牌。
- 优先改代码（缓存上限、避免大对象），再谈参数。
- `-Xms` 和 `-Xmx` 设成一样。
- 每次只改一个参数，压测对比 P99，别一把梭。
- 把 GC 指标接进监控。Actuator 的 `/actuator/metrics/jvm.gc.pause` 就能拿到停顿统计，让毛刺在用户投诉之前先被你看见。

## 五、性能对比和技术选型

**JDK 21 以后，G1 是绝大多数服务的默认答案，ZGC 留给大堆和延迟敏感型场景。**

| 收集器 | 停顿时长 | 适合的场景 | 开启方式 |
| --- | --- | --- | --- |
| Serial | 几十到几百毫秒 | 内存小的客户端、单核容器 | `-XX:+UseSerialGC` |
| Parallel | 几十到几百毫秒 | 批处理、离线计算这类吞吐优先场景 | `-XX:+UseParallelGC` |
| G1 | 几十毫秒级 | 4G~16G 的通用在线服务（默认） | `-XX:+UseG1GC` 或默认 |
| 分代 ZGC | 亚毫秒到几毫秒 | 大堆（16G 以上）、延迟敏感 | `-XX:+UseZGC` |

选型的判断依据不是“哪个先进”，而是“你更在意吞吐还是延迟”：

- 普通 CRUD、QPS 中等、堆在 16G 以内，**G1 就够**。别折腾。
- 堆很大又对 P99 敏感（风控、交易、实时推荐的在线侧），**上分代 ZGC**。
- 纯跑批、算完就完、不关心单次延迟，**Parallel 的吞吐更高**。
- 内存只有几百兆的小服务，**Serial 反而省事**。

ZGC 的代价得说清楚：它靠并发换取低停顿，会多占 CPU 和一点内存，极端吞吐场景下不如 Parallel。所以它是“用资源买延迟”，不是白捡的。

## 六、总结

接口毛刺这件事，拆开看就三步。

第一步，**确认元凶**。看 GC 日志里的 `Pause Full` 和停顿时长，别对着监控瞎猜。

第二步，**搞懂原理**。G1 把堆切成 Region，优先回收垃圾最多的格子，用 `MaxGCPauseMillis` 做目标；对象过早晋升老年代，或者被缓存长期引用，都会把老年代顶满，Full GC 随即登场。

第三步，**按顺序动手**。先砍无界缓存和大对象，再固定 `-Xms`/`-Xmx`，最后才轮到换收集器——大堆低延迟选分代 ZGC，通用服务继续用 G1。

最后留一句：调 GC 这件事，日志比经验靠谱。你那台机器的日志会告诉你真相，别人博客里的“最优参数”多半只对他自己的场景成立。

## 参考资料

1. [Java Platform, Standard Edition HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/)
2. [JEP 439: Generational ZGC](https://openjdk.org/jeps/439)
3. [JEP 474: ZGC: Generational Mode by Default](https://openjdk.org/jeps/474)
4. [ZGC - OpenJDK Wiki](https://wiki.openjdk.org/display/zgc)
5. [java - Launch a Java Application (JDK 21 Reference)](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)

文 / 会编程的吕洞宾

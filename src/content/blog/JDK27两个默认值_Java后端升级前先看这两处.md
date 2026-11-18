---
title: "JDK 27 升级后内存涨了？两个默认值在作怪"
date: 2026-10-28T09:00:00+08:00
category: "java"
tags: ["jdk"]
---

> 服务从 JDK 21 换到 27，代码一行没改，压测数据却变了：小规格实例的 GC 日志从 `Using Serial` 变成 `Using G1`，堆里的对象变小了，容器 RSS 反而涨了一点。别急着怀疑自己写漏了什么，JDK 27 动了两个默认值——没指定 GC 时的兜底选择，和对象头的内存布局。默认值最阴的地方就在这：你没加任何参数，运行时行为已经换了一套。这篇把这两处拆开讲透，再给你能直接跑起来验证的代码。

## 一、这个问题到底是什么

JDK 27 改了两个"你不写参数它也会生效"的默认值：G1 成为所有环境下的默认垃圾收集器，紧凑对象头成为默认的对象布局。

先把这两个变化说清楚。

**第一个：GC 的兜底选择变了。** 从 JDK 9 开始，G1 就是"服务器环境"的默认收集器。但那句"服务器环境"有前提：机器至少 2 个 CPU、内存不少于 1792MB。达不到这条线，JVM 会退回 Serial——一个单线程、Stop-The-World 的老收集器。很多跑在 1C2G 容器里的定时任务、边缘服务、小工具，一直用的就是 Serial。JDK 27 把这个门槛拆了：只要你在命令行没写 `-XX:+UseXxxGC`，不管几核几 G，一律选 G1。

**第二个：对象头瘦身了。** 64 位 JVM 上，一个对象开头的"管理信息"占 96 位，也就是 12 字节：8 字节 mark word（存锁状态、GC 年龄、identity hash），4 字节的类指针（指向这个对象是哪个类的实例）。JDK 27 把它压到 64 位，8 字节。省下来的不是"一点点"——对海量小对象来说，这是实打实的堆占用下降。

这两件事为什么能算"坑"？

因为它们不报错、不告警、不改 API。你的代码编译照过，单测照绿，上线后行为却换了：GC 日志里收集器名字变了，同一份堆 dump 的对象大小变了，容器内存曲线也变了。等你在监控上看到 RSS 上涨、或者某个 APM agent 开始报奇怪的错，才会回头怀疑 JDK。

一张表看清谁变了：

| 项目 | JDK 21 及更早 | JDK 27 |
| --- | --- | --- |
| 小规格机器（≤1 核或 <1792MB）不指定 GC | Serial | G1 |
| 服务器不指定 GC | G1 | G1 |
| 对象头 | 96 位（12 字节） | 64 位（8 字节） |
| 关闭紧凑头的参数 | 不需要（本来就没开） | `-XX:-UseCompactObjectHeaders` |
| 显式指定的 GC | 以你写的为准 | 以你写的为准 |

注意最后一行：这次改的只是"你没说的时候选谁"。老启动脚本里如果硬写了 `-XX:+UseSerialGC`，升级后照样是 Serial。反过来，如果脚本里什么都没写，升级后就是 G1——包括那台 1 核 512MB 的定时任务容器。

判断自己有没有被影响，看三个地方：启动日志里的 `Using G1` / `Using Serial`；`/actuator/metrics/jvm.gc.pause` 的曲线形状；容器 RSS 与堆使用量的差值。

## 二、底层原理到底怎么回事

### G1 的选择逻辑：从"看机器脸色"到"一律 G1"

HotSpot 选收集器有一套"人体工学"（Ergonomics）规则，本质是一串 if-else。

JDK 9 的 JEP 248 把 G1 设成服务器默认，但保留了给弱机器用的分支：CPU 少于 2 个，或者物理内存低于 1792MB，就选 Serial。1792MB 这个怪数字来自当年的实测——在那个内存档位以下，Serial 的吞吐和内存占用确实更划算，因为它没有卡表、没有记忆集、没有并发线程，启动就能干活。

问题是这条规则把"机器规格"和"业务负载"绑死了。一台 1 核 2G 的容器，可能跑的是一个对延迟敏感的 HTTP 服务，也可能是每天跑一次、跑五分钟就退出的批处理。前者需要 G1 的增量回收来控制停顿，后者需要 Serial 的低启动开销。老规则一刀切，全给了 Serial。

JDK 27 的 JEP 523 干脆把这条分支删了。官方理由是：这些年 G1 在各档堆大小上的表现都追了上来。JEP 522 减少了 G1 的同步开销，吞吐已经接近 Serial；G1 在老年代的回收是增量的，最坏停顿一直比 Serial 的 Full GC 好；G1 的原生内存占用也降到了和 Serial 差不多的水平。

G1 的工作方式，用一句话说：把堆切成大小相等的 region（区域），每次只挑"最划算"的那批 region 回收。

- 堆被分成约 2048 个 region，每个 1MB 到 32MB，大小由堆总量决定。512MB 的堆，region 就是最小的 1MB。
- 新对象进 Eden region，Eden 满了做 Young GC，存活对象复制到 Survivor region。
- 对象活得够久就晋升到 Old region。Old 占用超过阈值（默认 45%，`-XX:InitiatingHeapOccupancyPercent`）时触发并发标记，标记完做 Mixed GC，把"垃圾多"的 Old region 一起收掉。
- 每次回收都尽量控制在 `-XX:MaxGCPauseMillis`（默认 200ms）以内，靠"这次只收多少个 region"来调节。

所以小堆上的 G1 并不是"高射炮打蚊子"。region 变小、数量变多，每次 Young GC 要扫的卡表和记忆集相对更碎，但换来的是老年代可以增量回收，不会像 Serial 那样攒到装不下再来一次全停顿。

代价在哪？G1 的辅助结构是堆外内存：卡表（card table，记录跨 region 引用，量级约堆的 0.2%）、标记位图（mark bitmap，两份）、每个 region 的记忆集（remembered set）。1C2G 的容器里，这些都算在 RSS 里，几十 MB 的上涨很正常，不是泄漏。

### 对象头：省下的 4 个字节，怎么变成 8 个字节

先看对象在内存里长什么样。一个 Java 对象分三段：对象头、实例字段、对齐填充。

对象头在 64 位 HotSpot 上是 12 字节（开启压缩类指针时）：

- **mark word，8 字节**：锁标志位、偏向/轻量锁信息、GC 分代年龄、identity hash code，全挤在这 64 位里，靠状态位切换解释方式。
- **klass pointer，4 字节**：指向方法区里的类元数据。默认开启压缩类指针（堆小于 32GB 时），所以是 4 字节而不是 8。
- 数组对象还要多 4 字节存长度。

紧凑对象头把这两段各砍一半：mark word 32 位、klass 32 位，合计 8 字节。锁状态、分代年龄、hash 这些信息重新排布到 32 位里，类指针用窄化编码（narrow Klass）寻址。

关键在这里：**JVM 要求对象起始地址 8 字节对齐**。所以省下的字节数，不等于你实际省下的内存——中间还夹着一层 padding。

举几个例子，全是能算出来的：

| 对象 | 96 位头 | 64 位头 | 说明 |
| --- | --- | --- | --- |
| `new Object()` | 16 字节 | 8 字节 | 没有字段，只剩头 |
| 类里一个 `int` 字段 | 16 字节 | 16 字节 | 12+4=16 正好对齐，白省 |
| 类里一个 `long` 字段 | 24 字节 | 16 字节 | 12+8=20，补到 24；8+8=16 |
| `int[1]` | 24 字节 | 16 字节 | 数组头 16→12，加 4 字节元素 |
| `long[1]` | 24 字节 | 24 字节 | 20 和 24 都补到 24 |

看懂这张表，你就明白为什么有人升级后觉得"没省多少"，也有人觉得"省了一大截"。真正吃到红利的，是那些原本被 padding 浪费掉一半空间的小对象。

JEP 534 引用的 SPECjbb2015 数据是：堆占用少 22%，CPU 时间少 8%；开 G1 和 Parallel 时 GC 次数都降了 15%。这是基准测试的数字，你的业务不会一模一样，但方向是对的。

还有一个容易忽略的连锁反应：对象变小 → 同样大小的堆能装更多对象 → CPU 缓存命中率上升 → 分配更快 → GC 触发次数下降。这条链路是紧凑头真正的价值，省内存只是第一层。

### 这两个改动为什么会互相放大

小规格容器上，两个默认值会叠加。

原来 1C2G 用 Serial，堆里对象大，但收集器本身几乎不吃堆外内存。现在换成 G1：对象小了，堆内占用降下来；G1 的卡表、位图、记忆集上去了。净效果可能是"堆占用下降 20%，RSS 上涨 30MB"。看起来矛盾，其实两边算的是不同的账。

如果你的容器 limit 卡得很死（比如 1G），这 30MB 就可能变成 OOMKilled 的最后一根稻草。这不是 JDK 的 bug，是容量规划没跟着变。

## 三、实战：手把手写代码

下面这套代码干三件事：暴露一个接口，报告当前 JVM 用的是哪个收集器、紧凑头开没开；暴露一个接口，实测单个对象占多少字节；用两种启动参数各跑一遍，把差异打出来。

代码用 Java 21 语法编译，跑在 JDK 27 上。这么做是有意的——对象布局和 GC 选择都是运行时行为，源码一行不用改，正好验证"默认值变了"这件事。

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
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>jdk27-footprint</artifactId>
    <version>1.0.0</version>
    <name>jdk27-footprint</name>
    <description>验证 JDK 27 默认 GC 与紧凑对象头的实际影响</description>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
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

`java.version` 写 21，是因为这段代码只用到 Java 21 的语法（record、`toList()`）。运行时用 JDK 27 就行，Maven 编译和 JVM 运行是两回事。

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: jdk27-footprint

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics
  endpoint:
    health:
      show-details: always

logging:
  level:
    root: info
```

Actuator 的 `metrics` 端点后面有用，能直接看 `jvm.gc.pause` 和 `jvm.memory.used`。

### 3. 启动类

```java
package com.example.jdk27;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Jdk27FootprintApplication {

    public static void main(String[] args) {
        SpringApplication.run(Jdk27FootprintApplication.class, args);
    }
}
```

### 4. 被测量的对象

```java
package com.example.jdk27.domain;

public record OrderItem(long skuId, int quantity, int unitPriceCents) {
}
```

这个 record 的字段是 8 + 4 + 4 = 16 字节。加上 12 字节头是 28，补到 32；换成 8 字节头后是 24，正好对齐。所以理论上每个实例能从 32 字节降到 24 字节。选它就是为了让差异落在 8 字节这个刻度上。

### 5. 测量接口

```java
package com.example.jdk27.web;

import com.example.jdk27.domain.OrderItem;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
public class FootprintController {

    private static final int WARMUP_COUNT = 10_000;
    private static final int REFERENCE_BYTES = 4;

    @GetMapping("/footprint")
    public Map<String, Object> footprint(@RequestParam(defaultValue = "1000000") int count) {
        if (count < 1 || count > 5_000_000) {
            throw new IllegalArgumentException("count 取值范围 1 ~ 5000000");
        }

        Runtime runtime = Runtime.getRuntime();
        warmUp();
        System.gc();
        sleep(300);

        long before = usedHeap(runtime);

        List<OrderItem> items = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            items.add(new OrderItem(i, 2, 1999));
        }

        long after = usedHeap(runtime);
        long delta = after - before;
        long bytesPerItem = delta / count;
        long bytesPerObject = bytesPerItem - REFERENCE_BYTES;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("count", count);
        result.put("heapDeltaBytes", delta);
        result.put("bytesPerItem", bytesPerItem);
        result.put("bytesPerObject", bytesPerObject);
        result.put("keptAlive", items.size());
        return result;
    }

    private void warmUp() {
        List<OrderItem> warmup = new ArrayList<>(WARMUP_COUNT);
        for (int i = 0; i < WARMUP_COUNT; i++) {
            warmup.add(new OrderItem(i, 1, 100));
        }
        warmup.clear();
    }

    private static long usedHeap(Runtime runtime) {
        return runtime.totalMemory() - runtime.freeMemory();
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

这段代码的测量思路：先跑一万个对象把 JIT 编译、类加载、ArrayList 扩容这些一次性开销顶掉，再 `System.gc()` 清场，记下已用堆；然后专心分配 N 个对象，再记一次已用堆，差值除以 N 就是每个对象的平均成本。

两个细节值得说：

`items` 这个 List 必须活到测量结束，否则 JIT 可能把整个循环优化掉。这里它被放进了返回值，天然逃逸。

每个元素在 `ArrayList` 的底层数组里还占一个 4 字节的压缩引用，所以算"对象本身多大"时要减掉。`bytesPerItem` 是含引用的成本，`bytesPerObject` 是纯对象大小——做容量规划看前者，验证对象头看后者。

`System.gc()` 只是建议，JVM 可以不理。所以要在固定堆（`-Xms` 等于 `-Xmx`）下跑，并且多跑几次取稳定值。

### 6. JVM 自检接口

```java
package com.example.jdk27.web;

import com.sun.management.HotSpotDiagnosticMXBean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
public class JvmController {

    @GetMapping("/jvm")
    public Map<String, Object> jvm() {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("javaVersion", System.getProperty("java.version"));
        info.put("vmName", System.getProperty("java.vm.name"));
        info.put("maxHeapMB", Runtime.getRuntime().maxMemory() / 1024 / 1024);
        info.put("availableProcessors", Runtime.getRuntime().availableProcessors());
        info.put("gcCollectors", gcCollectorNames());
        info.put("useG1GC", vmOption("UseG1GC"));
        info.put("useCompactObjectHeaders", vmOption("UseCompactObjectHeaders"));
        return info;
    }

    private List<String> gcCollectorNames() {
        return ManagementFactory.getGarbageCollectorMXBeans().stream()
                .map(GarbageCollectorMXBean::getName)
                .toList();
    }

    private String vmOption(String optionName) {
        HotSpotDiagnosticMXBean bean =
                ManagementFactory.getPlatformMXBean(HotSpotDiagnosticMXBean.class);
        if (bean == null) {
            return "not-hotspot";
        }
        try {
            return bean.getVMOption(optionName).getValue();
        } catch (IllegalArgumentException e) {
            return "not-supported";
        }
    }
}
```

`getGarbageCollectorMXBeans()` 返回的名字能直接看出收集器：G1 会给你两条，`G1 Young Generation` 和 `G1 Old Generation`；Serial 是 `Copy` 和 `MarkSweepCompact`；Parallel 是 `PS Scavenge` 和 `PS MarkSweep`。

`HotSpotDiagnosticMXBean.getVMOption()` 能读任意虚拟机参数。`UseCompactObjectHeaders` 是产品级开关（JDK 25 起），JDK 27 上应该返回 `true`；在 JDK 24 上这个参数需要先解锁实验特性才存在，读不到会抛 `IllegalArgumentException`，这里的 catch 就是为了兜住它。

### 7. 跑起来对比

```bash
# 打包
mvn -q clean package

# 第一轮：JDK 27 的默认布局
java -Xms512m -Xmx512m \
     -Xlog:gc*:file=gc-compact.log:time,level,tags \
     -jar target/jdk27-footprint-1.0.0.jar &
APP_PID=$!
sleep 8
curl -s "http://localhost:8080/jvm"
curl -s "http://localhost:8080/footprint?count=1000000"
kill $APP_PID
wait $APP_PID 2>/dev/null

# 第二轮：关掉紧凑头，回到 96 位布局
java -Xms512m -Xmx512m -XX:-UseCompactObjectHeaders \
     -Xlog:gc*:file=gc-legacy.log:time,level,tags \
     -jar target/jdk27-footprint-1.0.0.jar &
LEGACY_PID=$!
sleep 8
curl -s "http://localhost:8080/jvm"
curl -s "http://localhost:8080/footprint?count=1000000"
kill $LEGACY_PID
wait $LEGACY_PID 2>/dev/null
```

两次 `/footprint` 的 `bytesPerObject` 应该差 8 字节左右（32 对 24）。`/jvm` 里 `useCompactObjectHeaders` 一次 `true` 一次 `false`，`gcCollectors` 都应该是 G1 的两条。

想看"1 核机器上 GC 默认值的变化"，把并发限制住再对比 JDK 21 和 27：

```bash
# JDK 21：1 核、512MB 堆 → 大概率是 Serial
java -XX:ActiveProcessorCount=1 -Xmx512m -XX:+PrintFlagsFinal -version | grep -E "UseG1GC|UseSerialGC"

# JDK 27：同样条件 → G1
java -XX:ActiveProcessorCount=1 -Xmx512m -XX:+PrintFlagsFinal -version | grep -E "UseG1GC|UseSerialGC"
```

`ActiveProcessorCount` 强制告诉 JVM "你只有 1 个核"，比真找一台 1 核机器方便。`PrintFlagsFinal` 打印的是最终生效值，后面带 `{ergonomic}` 标记的，就是 JVM 自己选的，不是你写的——这个词很关键，看到它就说明你正踩在默认值上。

## 四、踩坑经验和最佳实践

### 坑一：RSS 涨了，但不是泄漏

1C2G 的容器升级后 RSS 从 780MB 涨到 830MB，运维报警。查 `jcmd <pid> VM.native_memory summary`（启动要加 `-XX:NativeMemoryTracking=summary`），看到涨的是 `GC` 那一栏，不是 `Java Heap`。

G1 的卡表、两份标记位图、记忆集全在堆外。堆 512MB 时，这些结构的量级是十几到几十 MB。容器 limit 卡在 1G 的服务，要预留这部分；`-XX:MaxRAMPercentage` 默认只给堆 25%，反而可能太小——建议显式设成 60~70，把堆外余量留够。

### 坑二：以为升级就自动换 G1

启动脚本里写着 `-XX:+UseSerialGC` 的服务，升级到 27 依然是 Serial。JEP 523 改的只是"没指定时选谁"。升级前先 `grep` 一遍所有启动参数，把显式指定的收集器列出来，再决定要不要留。

反过来，那些"什么参数都没写"的服务才是受影响的面——它们占大多数。

### 坑三：拿 `jmap -histo` 的 shallow size 当结论

`jmap -histo` 给的是对象大小，但很多工具对紧凑头的支持是滞后的，读出来的值可能还是旧布局。更稳的验证方式是本文这种"分配 N 个对象看堆差"的黑盒测量，它不依赖任何工具的内部实现。

### 坑四：APM agent 和自研 Unsafe 代码

有团队用 `Unsafe.objectFieldOffset()` 算字段偏移做序列化，或者用老版本 APM agent 读对象头。紧凑头改了布局，这些假设可能失效。升级前在预发环境跑一遍全链路，重点看 APM、分布式追踪、序列化框架。

真出问题，`-XX:-UseCompactObjectHeaders` 是官方保留的回退开关。注意它是整机开关，不能按类或按包关闭——要么全开，要么全关。

### 坑五：把小堆的 G1 调成"高射炮"

G1 的 `MaxGCPauseMillis` 默认 200ms。1 核机器上，为了压到 200ms，G1 可能把 Young GC 做得非常频繁，吞吐反而下降。

给 1C2G 服务的建议配置：

```bash
java -XX:MaxRAMPercentage=65 \
     -XX:MaxGCPauseMillis=300 \
     -XX:InitiatingHeapOccupancyPercent=40 \
     -Xlog:gc*:file=gc.log:time,level,tags \
     -jar app.jar
```

`MaxRAMPercentage=65` 给堆外留够空间；`MaxGCPauseMillis` 放宽到 300ms，减少收集频次；`IHOP` 从 45 降到 40，让并发标记早一点启动，避免老年代涨到装不下再来混合回收。这三个参数都要压测验证，别照抄。

## 五、性能对比和技术选型

官方数据摆在这：紧凑头在 SPECjbb2015 上少用 22% 堆、少花 8% CPU，GC 次数降 15%（G1 和 Parallel 都是）。G1 取代 Serial 的依据是"各档堆大小上吞吐已接近，最坏停顿更好，原生内存已接近"。

落到具体场景，我给的建议是这样：

| 场景 | 建议 | 理由 |
| --- | --- | --- |
| 2C4G 以上的常规微服务 | 用默认值，别加 `-XX:+UseG1GC` | 本来就是 G1，写了是噪音 |
| 1C1G 的定时任务、批处理 | 压测对比 G1 与 Serial | 启动快、跑完就退的任务，Serial 可能更省 |
| 依赖对象头的 agent | 预发验证，必要时 `-XX:-UseCompactObjectHeaders` | 整机回退，粒度粗，要提前发现 |
| 堆大于 16GB | 保留紧凑头，但收益占比下降 | 大对象为主时，省的是头不是数据 |
| 延迟敏感（P99 < 50ms） | 保留 G1，调小 `MaxGCPauseMillis` | 增量回收是 G1 的强项 |

一句话选型：**默认值先用着，用数据说话再改**。JDK 27 的默认组合对大多数服务是更优解，但"大多数"不等于"你的服务"。

需要警惕的是"沉默的回归"：升级后没人报错，也没人看监控，直到某天大促发现 GC 停顿变了。所以升级清单里必须有三项——启动日志确认收集器、`/jvm` 接口确认紧凑头、压测对比 P99 和 RSS。

## 六、总结

JDK 27 改的两个默认值，一个动收集器选择，一个动对象布局。两者都不改 API、不报错，却实实在在改变运行时行为。

记住三句话就够了：

没写 GC 参数的服务，1 核小容器也从 Serial 换成了 G1，堆外内存要跟着重新算。

对象头从 12 字节降到 8 字节，但对象按 8 字节对齐，实际省多少要看字段组合——有的省一半，有的一分不省。

回退开关是 `-XX:-UseCompactObjectHeaders` 和显式的 `-XX:+UseSerialGC`，都是整机粒度。

升级这种事，最怕的不是变化，是不知道哪里变了。花半小时把 `/jvm` 和 `/footprint` 这两个接口跑一遍，比上线后猜三天强。

## 参考资料

- [JEP 523: Make G1 the Default Garbage Collector in All Environments](https://openjdk.org/jeps/523)
- [JEP 534: Compact Object Headers by Default](https://openjdk.org/jeps/534)
- [JEP 519: Compact Object Headers](https://openjdk.org/jeps/519)
- [JEP 522: G1 GC: Improve Throughput by Reducing Synchronization](https://openjdk.org/jeps/522)
- [JDK 27 Project Page](https://openjdk.org/projects/jdk/27/)
- [Spring Boot System Requirements](https://docs.spring.io/spring-boot/system-requirements.html)

文 / 会编程的吕洞宾

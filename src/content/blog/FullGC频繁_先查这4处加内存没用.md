---
title: "Full GC 频繁，先查这4处，加内存没用"
date: 2026-11-07T09:00:00+08:00
category: "java"
tags: ["jvm"]
---

> 周五下午，一个订单导出接口把服务打挂了。运维说堆已经加到 16G，Full GC 还是一分钟好几次。老板问要不要再升配置，我先翻了二十分钟 GC 日志，发现问题根本不在内存大小上。这篇讲清楚三件事：Full GC 到底被谁触发、日志里怎么一眼认出来、四类常见原因怎么一个个排掉。代码全部可运行，你照着搭一遍就能复现。

## 一、这个问题到底是什么

Full GC 频繁有两种完全不同的病，用药也完全不同：一种是内存真的不够，另一种是你的代码在往老年代里扔不该扔的东西。

第一种好理解，堆就那么大，活对象比堆还多，只能一遍遍全量回收。第二种更常见，也更气人——堆用了不到一半，Full GC 却在刷屏。这时候加内存，等于给一个漏水的桶换更大的桶，水位该涨还是涨。

先看几个大家都会遇到的信号：

- 接口 P99 从 80ms 跳到 2s，监控上是一条一条的毛刺
- GC 日志里 `Pause Full` 出现得很规律，比如每隔几分钟一次
- `/actuator/metrics/jvm.gc.pause` 的 `cause` 标签里出现 `G1 Compaction Pause` 或者 `System.gc()`
- 容器被 OOMKilled 重启，但 GC 日志干干净净，一次 Full GC 都没有

前三条是真在 GC，第四条压根不是 GC 的问题，后面单独说。

判断方向只看一个动作：**Full GC 结束之后，老年代占用掉没掉下来。**

用 `jcmd` 抓两次快照对比：

```bash
jcmd <pid> GC.heap_info
```

输出大概长这样：

```
garbage-first heap   total 2097152K, used 1843200K [0x0000000700000000, 0x0000000800000000)
  region size 1024K, 512 young (524288K), 1 survivors (1024K)
Metaspace       used 98765K, committed 102400K, reserved 1114112K
```

`used` 是当前堆占用，`region size` 是 G1 的区块大小。

- Full GC 后 `used` 掉回 400M 左右，过一会儿又爬到 1.8G：说明有大量对象在短时间内被创建并晋升，问题在分配节奏，不在总容量
- Full GC 后 `used` 还是 1.7G 上下：这部分是真活对象，要么业务量真的涨了，要么有泄漏（缓存没上限、集合只加不减、ThreadLocal 没清）

这两种情况在监控上看都是"Full GC 频繁"，但一个要改代码，一个才需要动堆参数。

## 二、底层原理到底怎么回事

G1 把堆切成一块块大小相等的 Region，对象先在新一代的 Region 里分配，活过几轮 Young GC 才被挪到老年代 Region。

可以把它想成一个仓库：新货先放临时区（Eden），临时区满了就清一次，还有用的货搬到中转区（Survivor），搬了几次还在的，才正式上架到长期库位（老年代）。

平时回收只清临时区，非常快。等长期库位的占用超过一个阈值（IHOP，默认 45% 左右，JDK 9 之后是自适应调整的），G1 才会启动并发标记，算出哪些长期库位其实已经没用了，然后在后续的 Mixed GC 里顺手清掉。整个过程基本不停业务。

Full GC 是这套机制失灵时的兜底。它会把整个堆停下来，做完整的标记、清理、压缩。一次几百毫秒到几秒，这期间所有请求都在排队。所以 Full GC 不是"回收得更彻底"，是"来不及了，只能硬停"。

具体是哪些情况会让兜底被触发：

| 触发条件 | GC 日志里的样子 | 该去查什么 |
|---|---|---|
| 大对象（humongous）找不到连续空间 | `To-space exhausted` 紧跟着 `Pause Full (G1 Compaction Pause)` | 一次性 new 的大数组、大 String、大 List |
| 老年代涨太快，Mixed GC 追不上 | 连续多次 `Pause Young (Mixed)` 之后出现 Full | 无上限缓存、只增不减的集合 |
| 代码里显式调了 `System.gc()` | `Pause Full (System.gc())` | 第三方 SDK、RMI、堆外内存回收 |
| 元空间达到阈值 | `Pause Full (Metadata GC Threshold)` | 动态生成类、热部署、脚本引擎 |

这里最值得展开的是第一行，因为它的名字最唬人。

G1 里单个对象如果大于等于 Region 的一半，就叫 humongous 对象。它不走 Eden，直接占连续的若干个老年代 Region。Region 大小默认是堆的 1/2048，最小值 1MB，最大值 32MB，还必须是 2 的幂。

算一下：8G 堆对应 4MB 的 Region，那么超过 2MB 的对象就是 humongous。一个 2000 万字符的 StringBuilder，底层 char 数组大约 40MB，直接吃掉十个 Region。而且 StringBuilder 扩容是翻倍的，中间那些半成品数组全是一次性的 humongous 垃圾。

这些垃圾不参与 Young GC。要等并发标记把它们标出来，Mixed GC 才有机会清。清得慢了，新的大对象又要连续空间，找不到就 `To-space exhausted`，然后 Full GC 硬停。

还有一个容易被忽略的点：humongous 对象如果只比半个 Region 大一点点，剩下那部分空间就浪费了。几个这样的大对象一占，Region 就碎得没法用。

`Pause Full (System.gc())` 这类也很有意思。JVM 自己不会无缘无故调 `System.gc()`，但 `java.nio.Bits` 在堆外内存紧张时会调它，想通过一次 Full GC 触发 Cleaner 把 DirectByteBuffer 释放掉。所以你会看到 Full GC 之后堆外内存才降下来。有些老 SDK、RMI 的分布式 GC 也会定时调。看到这个 cause，别急着怪 GC，先找是谁在调。

## 三、实战：手把手写代码

我们搭一个最小工程，先把问题复现出来，再用工具定位，最后改成流式输出。整个工程只有四个文件。

### 3.1 项目结构

```
gc-demo
├── pom.xml
└── src/main
    ├── java/com/example/gcdemo
    │   ├── GcDemoApplication.java
    │   ├── controller
    │   │   ├── GcStatsController.java
    │   │   ├── OrderExportController.java
    │   │   └── OrderStreamExportController.java
    │   └── domain
    │       └── Order.java
    └── resources
        └── application.yml
```

### 3.2 pom.xml

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
    <artifactId>gc-demo</artifactId>
    <version>1.0.0</version>
    <name>gc-demo</name>

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

只要两个 starter，一个提供 Web 能力，一个提供 `/actuator/metrics` 的 JVM 指标。没有多余依赖，是为了让 GC 表现干净，不受别的框架干扰。

### 3.3 application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: gc-demo

management:
  endpoints:
    web:
      exposure:
        include: health,metrics
  endpoint:
    health:
      show-details: always
```

`exposure.include` 里必须显式加上 `metrics`，默认只暴露 `health`。这个坑很常见，配完访问不到别怀疑版本。

### 3.4 启动类

```java
package com.example.gcdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class GcDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(GcDemoApplication.class, args);
    }
}
```

### 3.5 一个会出事的导出接口

先写订单对象。用 record 省掉一堆样板代码，字段都是不可变的：

```java
package com.example.gcdemo.domain;

public record Order(long id, String customer, String address, String remark, long amountCents) {
}
```

然后是问题版本。注意看它一次性做了两件要命的事：

```java
package com.example.gcdemo.controller;

import com.example.gcdemo.domain.Order;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderExportController {

    private static final String HEADER = "id,customer,address,remark,amountCents\n";

    @GetMapping("/export")
    public String export(@RequestParam(defaultValue = "200000") int count) {
        List<Order> orders = loadOrders(count);
        StringBuilder sb = new StringBuilder();
        sb.append(HEADER);
        for (Order order : orders) {
            sb.append(order.id()).append(',')
                    .append(order.customer()).append(',')
                    .append(order.address()).append(',')
                    .append(order.remark()).append(',')
                    .append(order.amountCents()).append('\n');
        }
        return sb.toString();
    }

    private List<Order> loadOrders(int count) {
        List<Order> orders = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            orders.add(new Order(i,
                    "customer-" + i,
                    "浙江省杭州市西湖区文三路 " + i + " 号",
                    "客户备注：这批货请走顺丰，不要放驿站，工作日白天没人在家，麻烦送到门口并按门铃。",
                    i * 100L));
        }
        return orders;
    }
}
```

`loadOrders` 把 20 万条订单全塞进 List，大约占几十 MB，全在新生代，还好。真正的问题在 `StringBuilder`：20 万行、每行两百来个字符，最终是一个 4000 万字符的字符串，也就是 80MB 的 char 数组。扩容过程中还会产生 10MB、20MB、40MB 一系列中间数组。

在 2G 堆下，Region 只有 1MB，humongous 门槛是 512KB。上面每一个数组都是 humongous。这就是复现的核心。

顺带说一句，返回 `String` 时 Spring 还要把它编码成 byte[] 写出去，又是一次大分配。所以线上真实案例里，这个接口打完一次，老年代直接涨一大截。

### 3.6 加一个不用重启就能看 GC 状态的接口

GC 日志要登机器看，不方便。用 JDK 自带的 MXBean 暴露一份实时数据，二十行代码：

```java
package com.example.gcdemo.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/gc")
public class GcStatsController {

    @GetMapping("/stats")
    public Map<String, Object> stats() {
        Map<String, Object> result = new LinkedHashMap<>();

        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("count", gc.getCollectionCount());
            item.put("timeMs", gc.getCollectionTime());
            result.put(gc.getName(), item);
        }

        Map<String, String> pools = new LinkedHashMap<>();
        for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
            MemoryUsage usage = pool.getUsage();
            if (usage == null) {
                continue;
            }
            long max = usage.getMax();
            String maxText = max < 0 ? "unbounded" : (max / 1024 / 1024) + "MB";
            pools.put(pool.getName(), (usage.getUsed() / 1024 / 1024) + "MB / " + maxText);
        }
        result.put("pools", pools);

        return result;
    }
}
```

`getCollectionCount` 和 `getCollectionTime` 是累计值，隔十秒取两次相减，就是这十秒里 GC 了几次、停了多久。G1 会返回两个收集器名字：`G1 Young Generation` 和 `G1 Old Generation`。那个 `Old Generation` 的计数涨了，就是 Mixed GC 或者 Full GC 发生了。

`usage.getMax()` 在某些池子上返回 -1，表示没有上限，直接除会得到一个没意义的数，所以这里单独判断了一下。

### 3.7 改成流式导出

问题的根子是"全部攒完再发"。改成边查边写，内存占用就跟总条数无关了：

```java
package com.example.gcdemo.controller;

import com.example.gcdemo.domain.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.BufferedWriter;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderStreamExportController {

    private static final String HEADER = "id,customer,address,remark,amountCents\n";
    private static final int BATCH_SIZE = 500;

    @GetMapping("/export-stream")
    public ResponseEntity<StreamingResponseBody> exportStream(
            @RequestParam(defaultValue = "200000") int count) {

        StreamingResponseBody body = outputStream -> {
            Writer writer = new BufferedWriter(
                    new OutputStreamWriter(outputStream, StandardCharsets.UTF_8), 8192);
            writer.write(HEADER);
            for (int start = 0; start < count; start += BATCH_SIZE) {
                int end = Math.min(start + BATCH_SIZE, count);
                for (Order order : loadBatch(start, end)) {
                    writer.write(order.id() + "," + order.customer() + ","
                            + order.address() + "," + order.remark() + ","
                            + order.amountCents() + "\n");
                }
                writer.flush();
            }
            writer.flush();
        };

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=orders.csv")
                .contentType(new MediaType("text", "csv", StandardCharsets.UTF_8))
                .body(body);
    }

    private List<Order> loadBatch(int start, int end) {
        List<Order> batch = new ArrayList<>(end - start);
        for (int i = start; i < end; i++) {
            batch.add(new Order(i,
                    "customer-" + i,
                    "浙江省杭州市西湖区文三路 " + i + " 号",
                    "客户备注：这批货请走顺丰，不要放驿站，工作日白天没人在家，麻烦送到门口并按门铃。",
                    i * 100L));
        }
        return batch;
    }
}
```

关键在三点。`BATCH_SIZE` 把驻留量压到 500 条，怎么翻页都不会涨。`BufferedWriter` 每次刷 8KB 出去，写的是 socket 缓冲，不是堆里的大数组。`StreamingResponseBody` 让 Spring 把响应当成流处理，不会等整个内容生成完才开始发送。

真实项目里 `loadBatch` 换成 `LIMIT/OFFSET` 或者游标分页的 SQL 就行。如果非要出 Excel，用 POI 的 `SXSSFWorkbook`，它只保留滑动窗口内的行在内存里，`XSSFWorkbook` 是全量的，20 万行必炸。

### 3.8 跑起来看现场

打包，然后用带 GC 日志和 JFR 的参数启动：

```bash
mvn clean package -DskipTests

java -Xms2g -Xmx2g \
  -XX:+UseG1GC \
  -Xlog:gc*:file=/tmp/gc.log:time,uptime,level,tags:filecount=5,filesize=50m \
  -XX:StartFlightRecording=filename=/tmp/gc-demo.jfr,settings=profile,dumponexit=true \
  -jar target/gc-demo-1.0.0.jar
```

`-Xms` 和 `-Xmx` 设成一样，避免堆反复伸缩干扰观察。`-Xlog` 那串的格式是 `标签:输出:装饰器:滚动策略`，`filecount=5,filesize=50m` 表示最多五个文件、每个 50MB，总共 250MB 封顶，不设这个会把磁盘写满。

打三次有问题的接口，再打三次流式接口：

```bash
for i in 1 2 3; do
  curl -s "http://localhost:8080/api/orders/export?count=200000" -o /tmp/orders-$i.csv
done
```

然后看日志：

```bash
grep -E "Pause Full|To-space|Humongous" /tmp/gc.log | tail -20
```

你会看到类似这样的东西：

```
[1123.456s][info][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 1024M->612M(2048M) 38.221ms
[1124.981s][info][gc] GC(43) To-space exhausted
[1124.981s][info][gc] GC(43) Pause Full (G1 Compaction Pause) 1980M->820M(2048M) 876.334ms
[1125.902s][info][gc] GC(44) Pause Full (G1 Compaction Pause) 1950M->815M(2048M) 812.117ms
```

`1024M->612M(2048M)` 是回收前、回收后、堆总量。看到连续两条 `Pause Full` 挨着出现，加上前面的 `To-space exhausted`，基本可以确定是大对象把老年代挤爆了。

再确认一下是谁占着内存：

```bash
jcmd <pid> GC.class_histogram | head -15
```

输出按实例占用字节数倒序，`[B`（byte 数组）和 `[C`（char 数组）排在前面，就是典型的大数组问题。这个方法比 dump 整个堆快得多，几秒钟出结果，生产上放心用。

如果还想看时间线，JFR 更直观：

```bash
jfr summary /tmp/gc-demo.jfr
jfr print --events jdk.GCHeapSummary /tmp/gc-demo.jfr | head -40
```

`jdk.GCHeapSummary` 里每次 GC 前后各有一条，把 `heapUsed` 拉出来画个折线，什么时候涨、涨多快，一目了然。JFR 是 JVM 内置的，开销通常在 1% 以内，比各种 APM 探针轻。

## 四、踩坑经验和最佳实践

**坑一：堆设得比容器限制还大。** 这是最冤的一种。`-Xmx8g`，容器 limit 4g，JVM 还没到 Full GC 就被 cgroup 干掉了，日志里一次 Full GC 都没有，只有 `Exit Code 137`。容器 aware 在 JDK 10 之后是默认开的，但它只影响"不写 -Xmx 时的默认值"，你自己写死了 8g，它不会拦你。上线前对一遍：容器的 memory limit，减掉堆外（元空间、线程栈、DirectBuffer、JVM 自身）留 25%~30%，剩下的才是 `-Xmx`。

**坑二：用 `-XX:+DisableExplicitGC` 捂住 `System.gc()`。** 加上这个参数，日志确实干净了，`Pause Full` 不见了。但 DirectByteBuffer 的回收依赖 Cleaner，Cleaner 依赖 GC 触发。显式 GC 被禁之后，堆外内存没人清，最后炸的是 `OutOfMemoryError: Direct buffer memory`，比原来更难查。正确的做法是顺着 `Pause Full (System.gc())` 找调用方，用 JFR 的堆栈事件或者加 `-Xlog:gc+heap=debug` 看是谁触发的。

**坑三：一出问题就 `jmap -dump:live`。** 8G 堆 dump 一次，先触发一次 Full GC，再写 8G 文件到磁盘，生产环境可能直接卡死十几秒，磁盘 IO 也打满。先用 `jcmd GC.class_histogram` 看个大概，确认是大数组还是某个业务对象，再决定要不要 dump。真要 dump，挑低峰期，dump 文件落到本地盘不要落网络盘。

**坑四：把 `-XX:G1HeapRegionSize` 当成万能药。** 有人发现 humongous 多，就把 Region 从 1MB 调到 16MB，门槛变成 8MB，果然不报了。但 Region 越大，回收的粒度越粗，一次要搬的东西越多，停顿反而变长，碎片问题也更严重。参数上限是 32MB，不是想调多大调多大。治标不治本，根子还是一次性构造大对象。

**坑五：缓存没有上限。** `ConcurrentHashMap` 当缓存用，key 是用户 ID，跑一周就几十万条，永远不删。这种内存增长极慢，Full GC 后会掉一点但掉不干净，很容易被误判成"内存泄漏查不出来"。用 Caffeine 就设 `maximumSize`，用 Redis 就设过期时间。没有上限的缓存不是缓存，是定时炸弹。

实践上我坚持几条：

- 新服务上线必须带 GC 日志参数，出问题才有现场。日志记得设 `filecount` 和 `filesize`
- 堆大小不超过容器 limit 的 70%，剩下留给堆外和系统
- 所有导出、报表、批量接口默认走流式，别等到出事再改
- 缓存必须同时有容量上限和命中率监控，命中率低于 60% 的缓存基本是负担
- 压测的时候顺便把 JFR 开着，比事后猜快得多

## 五、性能对比和技术选型

三种收集器的定位差别很大，选错了不是调参能救的。

| 收集器 | 停顿表现 | 吞吐 | 适合的堆 | 典型场景 |
|---|---|---|---|---|
| Parallel | 几百毫秒到数秒 | 最高 | 不限 | 离线批处理、数据导入，不在乎单次延迟 |
| G1 | 可设目标，通常 50~200ms | 较高 | 4G~32G | 绝大多数 Web 服务，默认选择 |
| ZGC | 亚毫秒到几毫秒 | 略低 | 32G 以上优势明显 | 超大堆、P99 敏感的在线服务 |

G1 的停顿目标用 `-XX:MaxGCPauseMillis` 调，默认 200ms。这个值是"目标"不是"保证"，G1 会牺牲吞吐去凑它，设得太小（比如 20ms）会导致 Young 区被压得很小，GC 次数暴涨，反而更慢。

ZGC 在 JDK 21 上要显式开分代：`-XX:+UseZGC -XX:+ZGenerational`。不开分代的话，全堆扫描的成本会随堆大小线性上升，分配速率高的服务扛不住。更新版本的 JDK 里分代已经是默认行为，这个参数会被忽略并打一条警告，不影响启动。

我的建议很直接：堆在 16G 以内、接口 RT 要求百毫秒级，G1 配好就够，别折腾。堆超过 32G 或者 P99 卡在几十毫秒下不来，再考虑 ZGC。但要说清楚，换收集器解决的是"回收时的停顿"，解决不了"你一直在造大对象"。后者换什么 GC 都一样。

## 六、总结

Full GC 频繁，先别动 `-Xmx`。打开 GC 日志，看 cause，这一步就能把问题分掉一半。

`To-space exhausted` 加 `Pause Full (G1 Compaction Pause)`，去查一次性构造的大对象，导出接口是重灾区。`Pause Full (System.gc())`，去找谁在显式调用，通常是堆外内存或者老 SDK。老年代缓慢上涨、Full GC 后掉不干净，去查没有上限的缓存和集合。

工具链其实就三样：`-Xlog:gc*` 看现场，`jcmd GC.class_histogram` 看谁占内存，JFR 看时间线。都是 JDK 自带的，不用装东西，生产上开销也小。

真正让我省事的一条经验是：把导出、报表这类接口默认写成流式。写的时候多花十分钟，比半夜被叫起来看 GC 日志划算得多。

文 / 会编程的吕洞宾

## 参考资料

- [Java Garbage Collection Tuning Guide (JDK 21)](https://docs.oracle.com/en/java/javase/21/gctuning/)
- [Garbage-First (G1) Garbage Collector](https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html)
- [JEP 439: Generational ZGC](https://openjdk.org/jeps/439)
- [jcmd 命令手册](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- [jfr 命令手册](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jfr.html)
- [Spring Boot Actuator Metrics](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)

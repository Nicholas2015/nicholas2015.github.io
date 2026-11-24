---
title: "堆内存正常却OOM？Java后端堆外内存泄漏排查"
date: 2026-10-21T09:00:00+08:00
category: "java"
tags: ["jvm"]
---

> 上周一个做图片服务的兄弟找我：容器内存 4G，堆只给了 1.5G，GC 日志干干净净，可 Pod 每隔几天就被 OOMKilled。加内存、换收集器、调新生代，全白搭，加完内存也没撑过一周。拿 jcmd 一查，堆外那块悄悄涨到了 2G 多。这就是堆外内存泄漏——堆里看不见，GC 管不着，杀进程的偏偏是它。

## 一、堆外内存泄漏长什么样：堆正常、进程涨、GC 没动静

堆外内存泄漏的典型特征是「堆很健康、进程内存一直涨、GC 日志没有任何异常」，排查方向和堆内 OOM 完全相反。

先把概念掰开。JVM 进程占的内存，不止 Java 堆：

```
容器 RSS
├── Java 堆（-Xmx 控制）
├── 直接缓冲区 DirectByteBuffer（-XX:MaxDirectMemorySize 控制）
├── Metaspace、CodeCache
├── 线程栈（每个线程约 1MB）
└── JNI、glibc arena、mmap 文件映射
```

堆内对象由 GC 负责回收。堆外这块，JVM 只是向操作系统要了内存，回收责任落在具体的使用方身上——直接缓冲区要等对应的 Java 对象被 GC 回收，才会顺手把本地内存还回去。

两类 OOM 的表现差异很大，别混：

| 现象 | 堆内 OOM | 堆外泄漏 |
| --- | --- | --- |
| 异常信息 | `Java heap space` | `Direct buffer memory`，或者根本没有异常 |
| GC 日志 | Full GC 频繁、回收后仍降不下来 | 一切正常，甚至 GC 次数很少 |
| 堆 dump | 能看出大对象和引用链 | 对象很小，看不出问题 |
| 进程 RSS | 跟着堆涨 | 独立上涨，和堆无关 |
| 容器表现 | JVM 抛 OOM，通常能留日志 | 直接被内核 OOMKilled，日志戛然而止 |

堆外内存的常见来源有这么几类，排查看一圈基本能对上号：

- **直接缓冲区**：`ByteBuffer.allocateDirect`、Netty 的 `PooledByteBufAllocator`。文件读写、网络收发、图片处理用得最多，也是最常见的泄漏源。
- **内存映射文件**：`FileChannel.map`，映射的页算在进程地址空间里，不归 GC 管。
- **JNI 和本地库**：调用 C/C++ 库自己 malloc，JVM 完全不知情。
- **线程栈**：线程池无上限地创建线程，每根栈都是实打实的本地内存。
- **Metaspace**：动态生成类、热部署、大量反射代理，类元数据会一直涨。

那个图片服务的现场很典型：接口读原图、生成缩略图，每次都 `allocateDirect` 一块 16MB 的缓冲区。为了「省一次分配」，代码把缓冲区按图片 ID 塞进了 static Map 里复用。结果 Map 只进不出，堆里躺着几千个几十字节的 `DirectByteBuffer` 壳子，堆外压着 2G 多的本地内存。堆 dump 打开一看，风平浪静。

## 二、ByteBuffer.allocateDirect 的释放原理：为什么 GC 不管它

`ByteBuffer.allocateDirect` 分配的内存不受 GC 管理，释放时机取决于缓冲区对象本身什么时候被回收，只要对象还被强引用着，这块本地内存就永远不会还。

一次分配大致走这么条链路：

1. `ByteBuffer.allocateDirect(capacity)` 创建 `DirectByteBuffer` 对象。
2. 构造过程中调用 `Bits.reserveMemory(size, capacity)`，先在 JVM 内部记账，把本次容量加到「已用直接内存」上。
3. 账记完，调用 `Unsafe.allocateMemory(size)` 向操作系统要内存。
4. 返回对象，同时给它挂一个 `Cleaner`。这个 Cleaner 记着内存地址和大小，等对象不可达时负责调用 `freeMemory`。

关键在第 2 步和第 4 步。

**先记账，再分配。** 如果这次申请会让总量超过 `-XX:MaxDirectMemorySize`，`reserveMemory` 直接抛 `OutOfMemoryError: Direct buffer memory`，根本不会去问操作系统。所以这个参数是硬上限，不是「用超了帮你清理」的软提醒。

**释放靠 Cleaner，Cleaner 靠 GC。** 缓冲区对象被回收，Cleaner 才有机会跑，本地内存才还回去。换句话说：

```java
// 对象一直被引用，堆外内存就永远不释放
static final Map<String, ByteBuffer> CACHE = new ConcurrentHashMap<>();
CACHE.put(id, ByteBuffer.allocateDirect(16 * 1024 * 1024));
```

这段代码在堆里只占一个 Map Entry 加一个对象头，几十字节；堆外是实打实的 16MB。循环一万次，堆 dump 可能才几十 MB，进程 RSS 已经 160G 了。

还有个容易忽略的点：**不设置 `-XX:MaxDirectMemorySize` 时，默认上限等于最大堆**。你给 `-Xmx2g`，等于默许堆外再花 2g。加上 Metaspace、线程栈、CodeCache，容器限额很容易被击穿。很多「堆才用了一半就被 OOMKilled」的案子，都是这么来的。

三个观测口径要分清，不然会互相打架：

| 口径 | 看的是什么 | 怎么看 | 局限 |
| --- | --- | --- | --- |
| Java 堆 | 堆内对象 | `jcmd <pid> GC.heap_info` | 完全看不到堆外 |
| 直接缓冲区账本 | 已记账的 direct 容量 | `BufferPoolMXBean` 或 `/debug/buffers` | 只是容量估算，不含分配器开销 |
| 进程 RSS | 操作系统看到的真实占用 | `ps`、容器监控、`/proc/<pid>/status` | 包含所有本地内存，无法直接归因 |

排查顺序建议从账本入手：账本涨，说明是直接缓冲区；账本不涨但 RSS 涨，往线程栈、JNI、mmap、glibc arena 上找。

## 三、实战：复现一次堆外内存泄漏，再把它修好

这一节给出一个能直接跑的 Spring Boot 工程，两个接口：`/image/leak` 故意泄漏，`/image/fixed` 用有界缓冲池修好，再加一个 `/debug/buffers` 把 direct 区的账本暴露出来。

### 3.1 工程结构

```
direct-memory-demo
├── pom.xml
└── src/main
    ├── java/com/example/directmemory
    │   ├── DirectMemoryDemoApplication.java
    │   ├── DirectBufferPool.java
    │   ├── ImageController.java
    │   └── BufferReportController.java
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
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>direct-memory-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
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

### 3.3 application.yml

```yaml
server:
  port: 8080

demo:
  buffer:
    size: 4194304
    max: 8
```

`size` 是单个缓冲区大小，4MB；`max` 是最多允许多少块，8 块。两个数一乘就是这套服务 direct 区的天花板：32MB。

### 3.4 启动类

```java
package com.example.directmemory;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DirectMemoryDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DirectMemoryDemoApplication.class, args);
    }
}
```

### 3.5 有界缓冲池

池子的思路很简单：借之前先看有没有空闲的，没有就新建，但总数不超过上限；用完必须还，还要清空残留数据。

```java
package com.example.directmemory;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.atomic.AtomicInteger;

@Component
public class DirectBufferPool {

    private final int bufferSize;
    private final int maxBuffers;
    private final Deque<ByteBuffer> idle = new ArrayDeque<>();
    private final AtomicInteger created = new AtomicInteger();

    public DirectBufferPool(@Value("${demo.buffer.size:4194304}") int bufferSize,
                            @Value("${demo.buffer.max:8}") int maxBuffers) {
        this.bufferSize = bufferSize;
        this.maxBuffers = maxBuffers;
    }

    public ByteBuffer borrow() {
        ByteBuffer buffer = idle.pollFirst();
        if (buffer != null) {
            return buffer;
        }
        if (created.incrementAndGet() <= maxBuffers) {
            return ByteBuffer.allocateDirect(bufferSize);
        }
        created.decrementAndGet();
        throw new IllegalStateException("缓冲区池已耗尽，请稍后重试");
    }

    public void release(ByteBuffer buffer) {
        buffer.clear();
        idle.offerFirst(buffer);
    }

    public int getBufferSize() {
        return bufferSize;
    }

    public int getMaxBuffers() {
        return maxBuffers;
    }
}
```

三个细节值得说：

- `created.incrementAndGet() <= maxBuffers` 先加再比，晚点回退。这样并发借的时候也不会超发。
- `release` 里必须 `clear()`。只调 `position(0)` 不清 limit，下一次读可能读上一次的脏数据。
- 池子耗尽直接抛异常。生产环境应该把它翻译成 503，让网关限流或重试，而不是硬扛到 OOM。内存有上限，比「看起来永远成功」重要。

### 3.6 泄漏版和修复版接口

```java
package com.example.directmemory;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.ByteBuffer;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;

@RestController
@RequestMapping("/image")
public class ImageController {

    /**
     * 问题就出在这个 static 缓存：key 只增不减，value 是堆外缓冲区。
     */
    private static final Map<String, ByteBuffer> CACHE = new ConcurrentHashMap<>();

    private final DirectBufferPool pool;

    public ImageController(DirectBufferPool pool) {
        this.pool = pool;
    }

    /**
     * 泄漏版：每次分配 16MB 堆外内存，然后放进静态 Map，永不释放。
     */
    @GetMapping("/leak")
    public Map<String, Object> leak(@RequestParam String id,
                                    @RequestParam(defaultValue = "16777216") int size) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(size);
        fill(buffer, size);
        buffer.flip();
        CACHE.put(id, buffer);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", id);
        result.put("capacity", buffer.capacity());
        result.put("cacheSize", CACHE.size());
        result.put("checksum", checksum(buffer));
        return result;
    }

    /**
     * 修复版：从有界池里借，finally 里还，异常也不会漏。
     */
    @GetMapping("/fixed")
    public Map<String, Object> fixed(@RequestParam String id,
                                     @RequestParam(defaultValue = "1048576") int size) {
        if (size > pool.getBufferSize()) {
            throw new IllegalArgumentException("size 不能超过单个缓冲区大小 " + pool.getBufferSize());
        }
        ByteBuffer buffer = pool.borrow();
        try {
            buffer.clear();
            fill(buffer, size);
            buffer.flip();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", id);
            result.put("capacity", buffer.capacity());
            result.put("checksum", checksum(buffer));
            return result;
        } finally {
            pool.release(buffer);
        }
    }

    private void fill(ByteBuffer buffer, int size) {
        byte[] chunk = new byte[8192];
        ThreadLocalRandom.current().nextBytes(chunk);
        int remaining = size;
        while (remaining > 0) {
            int len = Math.min(chunk.length, remaining);
            buffer.put(chunk, 0, len);
            remaining -= len;
        }
    }

    private long checksum(ByteBuffer buffer) {
        long sum = 0;
        while (buffer.hasRemaining()) {
            sum = sum * 31 + buffer.get();
        }
        return sum;
    }
}
```

`fill` 模拟读文件、解码图片这类填充动作。`checksum` 模拟后续处理，顺便把缓冲区从头读到尾。

修复版真正值钱的是那个 `finally`。业务代码里一旦抛异常，`release` 照样执行；写成 try 后面直接 `release`，异常路径就把一块 4MB 永久漏掉了。

### 3.7 把 direct 区账本暴露出来

`BufferPoolMXBean` 是 JDK 自带的平台 MXBean，直接给出 direct 和 mapped 两个池的数量与容量，不用引任何依赖。

```java
package com.example.directmemory;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.BufferPoolMXBean;
import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/debug")
public class BufferReportController {

    @GetMapping("/buffers")
    public Map<String, Object> buffers() {
        Map<String, Object> result = new LinkedHashMap<>();
        List<BufferPoolMXBean> pools = ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class);
        for (BufferPoolMXBean pool : pools) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("count", pool.getCount());
            item.put("memoryUsed", pool.getMemoryUsed());
            item.put("totalCapacity", pool.getTotalCapacity());
            result.put(pool.getName(), item);
        }
        Runtime runtime = Runtime.getRuntime();
        result.put("heapUsed", runtime.totalMemory() - runtime.freeMemory());
        result.put("heapMax", runtime.maxMemory());
        return result;
    }
}
```

返回大概长这样：

```json
{
  "direct": { "count": 16, "memoryUsed": 268435456, "totalCapacity": 268435456 },
  "mapped": { "count": 0, "memoryUsed": 0, "totalCapacity": 0 },
  "heapUsed": 48234496,
  "heapMax": 536870912
}
```

堆才用 46MB，direct 已经 256MB，问题在哪一目了然。`memoryUsed` 是估算值，和 NMT 的数字可能对不齐，看趋势足够。

### 3.8 复现：二十次请求打爆堆外

打包并带上两个关键参数启动：

```bash
mvn clean package
java -XX:MaxDirectMemorySize=256m -XX:NativeMemoryTracking=summary \
     -jar target/direct-memory-demo-1.0.0.jar
```

然后循环调泄漏接口，每次 16MB：

```bash
for i in $(seq 1 20); do
  curl -s "http://localhost:8080/image/leak?id=$i" > /dev/null
done
```

跑到第 16、17 次左右，日志里会出现：

```
java.lang.OutOfMemoryError: Direct buffer memory
```

看账本：

```bash
curl -s http://localhost:8080/debug/buffers
```

`direct.memoryUsed` 卡在 268435456，正好 256MB；`heapUsed` 只有几十 MB。这就是「堆正常、堆外爆了」的标准现场。

再确认堆确实没事：

```bash
jcmd <pid> GC.heap_info
```

输出里 `used` 远小于 `total`，GC 也没有频繁动作。很多人在这一步就去调 GC 参数了，方向从一开始就错了。

### 3.9 看 NMT：谁在偷偷吃内存

NMT 是 JVM 自己的内存账本，必须在启动时打开，事后加参数无效。先拍个基线，再压测，再看差异：

```bash
jcmd <pid> VM.native_memory baseline

for i in $(seq 1 200); do
  curl -s "http://localhost:8080/image/fixed?id=$i&size=1048576" > /dev/null
done

jcmd <pid> VM.native_memory summary.diff
```

`summary.diff` 会按类别列出增长量。直接缓冲区的账通常落在 `Other` 一栏，压测期间涨个几十 MB 很正常；如果压完不回落、还持续上涨，基本可以锁定泄漏。不同 JDK 版本分类略有差异，重点看 `committed` 那一列的变化。

### 3.10 验证修复：压两百次也不涨

```bash
for i in $(seq 1 200); do
  curl -s "http://localhost:8080/image/fixed?id=$i&size=1048576" > /dev/null
done

curl -s http://localhost:8080/debug/buffers
```

`direct.count` 最多 8，`memoryUsed` 最多 33554432（32MB），压多少次都一样。因为池子的上限写死在配置里，内存曲线是平的，不是「大概率没事」。

## 四、堆外内存排查的踩坑清单

堆外内存排查最容易犯的错，是拿堆内那套工具去查堆外，查完得出「没问题」的结论。

- **heap dump 找不到泄漏。** dump 里只有 `DirectByteBuffer` 对象壳，几十字节一个，retained size 小得可怜，真正的 16MB 在对象外面。看到对象数量异常可以怀疑，但别指望 dump 给你引用链之外的答案。
- **`jmap -histo:live` 会破坏现场。** 它触发 Full GC，Cleaner 一跑，泄漏的缓冲区可能被释放一部分，你再看 RSS 就降了。先做 NMT baseline，再考虑要不要触发 GC。
- **NMT 必须启动时开。** `-XX:NativeMemoryTracking=summary` 加不上去就是加不上去。`detail` 级别开销更大，生产上短时间开、定位完就关。
- **容器 OOMKilled 没有 Java 异常。** 内核杀进程不给你留遗言，JVM 连 heap dump 都来不及写。去查 `dmesg`、Kubernetes 的 `lastState.reason=OOMKilled`、容器内存曲线，别只翻应用日志。
- **`-XX:MaxDirectMemorySize` 不是保险丝。** 它只会让分配失败抛 OOM，不会自动回收。真正的保险是「有界 + 复用 + 归还」。
- **`System.gc()` 不是修复手段。** 它只是建议 JVM 回收，Cleaner 什么时候跑没有保证。线上开 `-XX:+DisableExplicitGC` 的服务更别指望这招。
- **Netty 用户先查引用计数。** 继承 `ChannelInboundHandlerAdapter` 自己处理消息，忘了 `ReferenceCountUtil.release(msg)`，ByteBuf 就永远不归零。把 `-Dio.netty.leakDetection.level=paranoid` 打开，泄漏点会打印分配时的堆栈。
- **池化之后忘了 `clear()`。** 上一轮的数据留在缓冲区里，下一轮读出来就是脏数据。这种 bug 比泄漏更难查，因为内存曲线完全正常。
- **别把 direct buffer 放进缓存。** 无论叫「对象池」还是「本地缓存」，只要 key 无界、value 是堆外内存，迟早出事。要缓存就缓存磁盘路径或堆内小对象，并且给容量上限。
- **反射调 Cleaner 是下策。** JDK 17 之后模块封装收紧，要 `--add-opens java.base/sun.nio.ch=ALL-UNNAMED` 才能碰，升级就碎。能用池化解决就别走这条路。

## 五、堆内、堆外、池化怎么选

默认用堆内，只有大块 IO 或零拷贝场景才考虑堆外，而且必须是池化的堆外。

| 维度 | 堆内 byte[] | 每次新建 direct | 池化 direct |
| --- | --- | --- | --- |
| 分配成本 | 低，TLAB 上直接划 | 高，系统调用 + 清零 | 只在池子扩容时付一次 |
| GC 影响 | 大对象进老年代，增加复制和停顿 | 堆里只有小对象，但 Cleaner 依赖 GC | 堆内几乎无压力 |
| IO 拷贝 | 读写要经过中间缓冲区 | 可配合 FileChannel、SocketChannel 少一次拷贝 | 同左 |
| 内存上限 | 受 -Xmx 约束 | 受 MaxDirectMemorySize 约束 | 池大小 × 单块大小，可精确计算 |
| 适合场景 | 普通业务对象、小数据 | 偶发的大块一次性操作 | 高并发文件/网络/图片处理 |

几条实操建议：

- 单个请求的数据量小于几十 KB，用堆内数组，别碰 direct。分配的固定开销比省下的拷贝还贵。
- 明确要用 direct，就把池子大小、单块大小做成配置，和容器限额一起算总账：`Xmx + direct 上限 + Metaspace + 线程栈` 要留出余量。
- 池化用现成的更稳。Netty 的 `PooledByteBufAllocator` 带引用计数和泄漏检测，比手写 Deque 完善；规模不大时，本文这种几十行的池子够用。
- 监控别只盯堆。把 `BufferPoolMXBean` 的 `memoryUsed` 和进程 RSS 一起打到监控面板，两条线分叉的时候就是报警的时候。

## 六、总结

堆外内存泄漏的排查，核心就三句话。

**看 RSS 和 direct 账本，不要只看堆。** 堆健康不代表进程健康，`GC.heap_info` 干净不代表没事。

**`allocateDirect` 的释放靠 GC，强引用就是泄漏。** static 集合、无界缓存、忘记 release 的 Netty ByteBuf，本质都一样：对象活着，本地内存就回不去。

**修复靠池化、finally 归还、上限写死。** 内存上限应该是算出来的，不是出事之后加出来的。

真遇到 OOMKilled，按这个顺序走：确认是堆外 → 看 `BufferPoolMXBean` 是否上涨 → NMT baseline 加 diff 定位类别 → 翻代码找谁持有缓冲区 → 改成有界池。别一上来就加内存，那是最贵、也最不解决问题的办法。

文 / 会编程的吕洞宾

## 参考资料

- [ByteBuffer (Java SE 21 API)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/ByteBuffer.html)
- [BufferPoolMXBean (Java SE 21 API)](https://docs.oracle.com/en/java/javase/21/docs/api/java.management/java/lang/management/BufferPoolMXBean.html)
- [jcmd (Java SE 21 Tools Reference)](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- [Java SE Troubleshooting Guide](https://docs.oracle.com/en/java/javase/21/troubleshoot/index.html)

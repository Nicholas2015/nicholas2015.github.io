---
title: "虚拟线程实战：Spring Boot接口吞吐翻3倍"
date: 2026-10-01T09:00:00+08:00
category: "java"
tags: ["spring-boot", "virtual-thread"]
---

> 一个商品详情接口，单机压测到 900 QPS 就上不去。看监控更奇怪：CPU 才 30%，内存很闲，可 Tomcat 那 200 个工作线程全部卡在 WAITING——它们没在干活，只是在等下游返回。这是 I/O 密集服务里最典型的浪费：机器没跑满，并发却到顶了。JDK 21 的虚拟线程就是冲这个来的。下面用一个 Spring Boot 服务把它落地，顺手把三个必须先避开的坑讲清楚。

## 一、这个问题到底是什么

**平台线程（Platform Thread）是操作系统线程的一对一包装，数量有硬上限，这就是吞吐上不去的根本原因。**

Java 里的 `new Thread()`，背后是一个真实的操作系统线程。它有三个绕不开的特点：

- 创建和销毁都要进内核，慢；每个线程默认占约 1MB 栈内存。
- 一台机器撑起几千个线程就明显吃力，调度开销开始上升。
- Tomcat 默认最多同时处理 200 个请求（`server.tomcat.threads.max`，默认值是 200）。

三条合起来，就把 I/O 密集服务的并发天花板锁死了：

```
单机并发上限 ≈ 线程数 ÷ 单个请求耗时
```

按 200 个线程、每个请求等下游 200ms 算：

```
200 ÷ 0.2 秒 = 1000 QPS
```

想再往上，只能加线程。加到 2000 个，机器也许扛得住，但内存先报警，而且线程一多，上下文切换的开销会把省下的时间吃回去。最要命的是：这 2000 个线程里，绝大部分时间在发呆——等数据库、等 Redis、等下游 HTTP。

**说个真实场景。** 我们有个商品详情接口，一次请求要顺序调三个下游：库存服务、价格服务、优惠券服务，每个平均 60~80ms。整个请求约 200ms，其中真正花在 CPU 上的不到 5ms。也就是说，95% 以上的时间，线程在等。

时间线摊开是这样：

| 阶段 | 平台线程的状态 |
| --- | --- |
| 收到请求 | 占用一个操作系统线程 |
| 调库存服务（约 70ms） | 阻塞等待 |
| 调价格服务（约 60ms） | 阻塞等待 |
| 调优惠券服务（约 65ms） | 阻塞等待 |
| 组装结果、返回 | 占用 CPU 几毫秒 |

**等待期间，这个线程被钉死在这个请求上，不能去服务别的请求。** 虚拟线程要拿回来的，就是这部分浪费。注意关键词：浪费在"等待"，不是浪费在"计算"。如果接口本身是 CPU 密集的，后面会看到，虚拟线程帮不上忙。

## 二、底层原理到底怎么回事

**虚拟线程是 JVM 自己实现和调度的线程，不直接占用操作系统线程，所以数量能做到几十万。**

它不是"更快的线程"，而是"更便宜的线程"。理解这句话，抓住三个概念就行：

- **载体线程（carrier thread）**：真正跑在 CPU 上的那批操作系统线程，数量约等于 CPU 核数。
- **虚拟线程（virtual thread）**：业务代码里"看起来"的线程，可以创建成千上万个。
- **挂载 / 卸载（mount / unmount）**：虚拟线程被安排到某个载体线程上执行，叫挂载；遇到阻塞主动撤下来，叫卸载。

一次请求的完整流程是：

1. 请求进来，JVM 分配一个虚拟线程，挂到某个载体线程上开始执行。
2. 代码执行到网络调用、`Thread.sleep`、加锁这类会阻塞的操作，JVM 发现"要等了"，就把这个虚拟线程从载体线程上卸下来，栈帧存到堆里。
3. 载体线程空出来，立刻去跑下一个虚拟线程，不浪费。
4. 下游返回，JVM 再把这个虚拟线程重新挂到某个载体线程上，从断点接着跑。

结果：**几个载体线程就能撑起几万个虚拟线程。** 一台 4 核机器，载体线程也就 4 个左右，但你创建 10 万个虚拟线程也不会 OOM——它们的栈按需增长、放在堆上，初始只有几百字节到几 KB。这也是虚拟线程创建成本极低的原因。

有一个必须知道的例外，也是坑的来源：**在 JDK 21 上，虚拟线程如果在 `synchronized` 块里阻塞，会被"钉"（pin）在载体线程上，卸载不了。** 原因是监视器锁（monitor）和对象头绑定，运行时没法安全地把持有它的虚拟线程挪走。载体线程被钉住，就等于少了一个干活的工人。这个问题在 [JEP 491《Synchronize Virtual Threads without Pinning》](https://openjdk.org/jeps/491) 里修掉了，从 JDK 24 起生效。如果你还在 JDK 21/23 上跑，就得自己避开 `synchronized` 里的阻塞。

再讲清楚虚拟线程**不解决**什么，这个比讲它解决了什么更重要：

| 场景 | 平台线程 | 虚拟线程 | 原因 |
| --- | --- | --- | --- |
| 等 HTTP / DB / Redis 返回 | 吞吐受线程数限制 | 吞吐大幅提升 | 等待时间被释放，载体线程不空转 |
| CPU 密集计算（加解密、大对象序列化、图像处理） | 正常 | 基本没提升 | 没有阻塞可卸载，还是抢那几个核 |
| 用线程池做限流保护 | 有效 | 失效 | 虚拟线程不该被池化 |

最后一行容易被忽略：**虚拟线程的正确用法是"一个任务一个线程"，不要再用 `Executors.newFixedThreadPool(200)` 那套思路去池化它。** 池化是为了复用昂贵资源，而虚拟线程本身很便宜；池化反而让请求先排队，把优势抵消掉。

Spring Boot 的接入只有一行配置：`spring.threads.virtual.enabled=true`。打开之后，Tomcat 会为每个请求创建一个虚拟线程，同时 Spring 的 `applicationTaskExecutor`（`@Async`、`@Scheduled` 用的那个）也切到虚拟线程模式。但要说清楚：它**不会**改变数据库连接池、Redis 连接池的大小。这一层是另一个瓶颈，后面踩坑部分展开。

## 三、实战：手把手写代码

项目结构很简单，一个 Spring Boot 服务加一个纯 Java 压测类：

```
virtual-thread-demo
├── pom.xml
└── src/main/java/com/example/vthread
    ├── VirtualThreadDemoApplication.java
    ├── ThreadModelBenchmark.java
    ├── controller/ProductController.java
    └── service/DownstreamService.java
```

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
    <artifactId>virtual-thread-demo</artifactId>
    <version>1.0.0</version>
    <name>virtual-thread-demo</name>
    <description>Spring Boot virtual threads demo</description>

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

`java.version` 必须是 21 或更高，虚拟线程是 JDK 21 正式转正的。`spring-boot-starter-actuator` 是为了待会儿看 `/actuator/metrics`，观察线程数变化。

### 2. 启动类

```java
package com.example.vthread;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class VirtualThreadDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(VirtualThreadDemoApplication.class, args);
    }
}
```

### 3. 模拟下游的服务

```java
package com.example.vthread.service;

import org.springframework.stereotype.Service;

import java.util.concurrent.ThreadLocalRandom;

@Service
public class DownstreamService {

    /**
     * 模拟一次耗时的下游调用。
     * 真实场景里这里换成 RestClient、JdbcTemplate 或 RedisTemplate，
     * 共同点是：线程会在这里等待网络和对方处理。
     */
    public long call(String name, int baseMillis) {
        try {
            // sleep 属于可卸载的阻塞，不会占着 CPU
            Thread.sleep(baseMillis + ThreadLocalRandom.current().nextInt(20));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return ThreadLocalRandom.current().nextLong(1000);
    }
}
```

关键点：`Thread.sleep` 是虚拟线程能识别的阻塞操作，等待期间会被卸载。换成真实的 HTTP 调用、JDBC 查询也一样，只要底层走的是 JDK 的 I/O 实现。

### 4. 控制器

```java
package com.example.vthread.controller;

import com.example.vthread.service.DownstreamService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/product")
public class ProductController {

    private final DownstreamService downstreamService;

    public ProductController(DownstreamService downstreamService) {
        this.downstreamService = downstreamService;
    }

    @GetMapping("/detail")
    public Map<String, Object> detail() {
        long stock = downstreamService.call("stock", 70);
        long price = downstreamService.call("price", 60);
        long coupon = downstreamService.call("coupon", 65);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("stock", stock);
        result.put("price", price);
        result.put("coupon", coupon);
        result.put("threadName", Thread.currentThread().getName());
        result.put("isVirtual", Thread.currentThread().isVirtual());
        return result;
    }
}
```

两个自检字段很重要：`isVirtual` 返回 `true`，说明当前请求确实跑在虚拟线程上；`threadName` 会是类似 `VirtualThread[#42]/runnable@ForkJoinPool-1-worker-1` 的样子，一眼就能确认。

### 5. application.yml

```yaml
server:
  port: 8080
  tomcat:
    threads:
      max: 200

spring:
  threads:
    virtual:
      enabled: true

management:
  endpoints:
    web:
      exposure:
        include: health,metrics
```

启动后访问一下：

```bash
curl http://localhost:8080/api/product/detail
```

返回里 `"isVirtual": true` 就说明生效了。把 `spring.threads.virtual.enabled` 改成 `false` 再对比一次，这个字段会变成 `false`，差别一眼可见。

### 6. 纯 Java 压测类

不依赖 Spring，直接对比三种线程模型在"等待型任务"下的表现：

```java
package com.example.vthread;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class ThreadModelBenchmark {

    /** 总任务数 */
    private static final int TASKS = 4000;
    /** 每个任务阻塞的毫秒数，模拟一次下游调用 */
    private static final long BLOCK_MILLIS = 200;

    public static void main(String[] args) throws Exception {
        System.out.println("任务数 = " + TASKS + "，单任务阻塞 " + BLOCK_MILLIS + "ms");
        System.out.println("CPU 核数 = " + Runtime.getRuntime().availableProcessors());
        System.out.println("-------------------------------------------------");

        run("平台线程池（200）", Executors.newFixedThreadPool(200));
        run("平台线程池（1000）", Executors.newFixedThreadPool(1000));
        run("虚拟线程（一任务一线程）", Executors.newVirtualThreadPerTaskExecutor());
    }

    private static void run(String name, ExecutorService executor) throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(TASKS);

        long begin = System.nanoTime();
        for (int i = 0; i < TASKS; i++) {
            executor.execute(() -> {
                try {
                    start.await();
                    Thread.sleep(BLOCK_MILLIS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        done.await();
        long cost = System.nanoTime() - begin;

        executor.shutdown();
        executor.awaitTermination(1, TimeUnit.MINUTES);

        double seconds = cost / 1_000_000_000.0;
        System.out.printf("%-24s 耗时 %6.2f 秒   QPS %9.0f%n",
                name, seconds, TASKS / seconds);
    }
}
```

`CountDownLatch` 在这里的作用是让所有任务在同一时刻开跑，避免"前一批跑完了后一批才提交"，这样测出来的才是真实的并发能力。

跑法（不需要额外插件）：

```bash
mvn -q compile
java -cp target/classes com.example.vthread.ThreadModelBenchmark
```

在一台 4 核 8G 的机器上，4000 个任务、每个阻塞 200ms，结果大致是：

| 线程模型 | 总耗时 | 折算 QPS | 峰值线程数 | 栈内存开销 |
| --- | --- | --- | --- | --- |
| 平台线程池（200） | 约 4.0 秒 | 约 1000 | 200 | 约 200MB |
| 平台线程池（1000） | 约 0.8 秒 | 约 5000 | 1000 | 约 1GB |
| 虚拟线程 | 约 0.2 秒 | 约 20000 | 4000（虚拟） | 几十 MB |

平台的 200 个线程要分 20 批排队，一批 200ms，堆出 4 秒；虚拟线程相当于把 4000 个任务全部挂起，总耗时几乎只比单个任务多一点点。把上面那个 Spring Boot 服务接上真实的下游和数据库，真实项目里这个接口从约 900 QPS 提到约 2800 QPS，接近 3 倍。

## 四、踩坑经验和最佳实践

**坑 1：`synchronized` 里的阻塞会把载体线程钉住（JDK 21/23）。**

反面写法：

```java
// 反面：JDK 21 上，网络调用发生在 synchronized 里，载体线程会被钉住
public synchronized String query() {
    return restClient.get()
            .uri("http://downstream/api/query")
            .retrieve()
            .body(String.class);
}
```

正面写法：

```java
private final ReentrantLock lock = new ReentrantLock();

public String query() {
    lock.lock();
    try {
        // 同样的网络调用，ReentrantLock 下虚拟线程可以正常卸载
        return restClient.get()
                .uri("http://downstream/api/query")
                .retrieve()
                .body(String.class);
    } finally {
        lock.unlock();
    }
}
```

诊断办法：JDK 21 上启动时加 `-Djdk.tracePinnedThreads=full`，一旦发生钉住，控制台会直接打出被钉住的调用栈，定位哪一段 `synchronized` 包了 I/O 特别快。

**坑 2：数据库连接池没动，虚拟线程再多也白搭。**

这是最容易翻车的地方。HikariCP 默认最大连接数是 10，你就算起了一万个虚拟线程，也只能有 10 个真正查库，剩下的全堵在"拿连接"这一步。调优顺序应该是：先看连接池，再看下游限流，最后才是线程模型。

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 50
      minimum-idle: 10
      connection-timeout: 3000
```

别盲目调大，数据库自己的 `max_connections` 是硬上限。50 是个常见起点，具体要压测决定。

**坑 3：别往虚拟线程里塞 ThreadLocal 大对象，也别池化虚拟线程。**

两个都是"贵在量上"的问题：

- `ThreadLocal`：虚拟线程数量多，每个都持有一份副本，内存会被成倍放大。较新的 JDK 提供了 `ScopedValue` 作为替代方向，能用参数显式传递的上下文就别藏进 ThreadLocal。
- 池化：用 `Executors.newFixedThreadPool` 去包虚拟线程，等于给便宜的东西加了一道昂贵的排队，纯属白折腾。

**其他实践清单：**

- 只给 I/O 密集服务开虚拟线程，CPU 密集服务保持原样。
- 用 `Executors.newVirtualThreadPerTaskExecutor()`，别池化。
- `synchronized` 尽量换 `ReentrantLock`，尤其是临界区里包了 I/O 的。
- 顺手收紧超时。没有超时的等待，在虚拟线程下会把"等待"放大成资源堆积。
- CPU 密集任务单独用固定的平台线程池隔离，别和虚拟线程共用一个 Executor。

## 五、性能对比和技术选型

一句结论：**I/O 密集、并发高、单请求等待时间长 → 上虚拟线程；CPU 密集 → 别上。**

| 维度 | 平台线程池 | 虚拟线程 |
| --- | --- | --- |
| 每线程成本 | 约 1MB 栈 + 内核对象 | 几百字节~几 KB，放在堆上 |
| 数量上限 | 几千个就吃力 | 几十万个没问题 |
| 阻塞时行为 | 占着线程空等 | 卸载，载体线程去干别的 |
| 适合的任务 | CPU 密集、需要限流 | I/O 密集、高并发等待 |
| 迁移成本 | — | 一行配置 + 排查 `synchronized` |
| 调试体验 | 成熟 | 线程名变成 VirtualThread[#n]，栈更浅，需要适应 |

选型建议：

- 新项目、纯 I/O 密集型（网关、BFF、聚合查询接口）：直接开。
- 老项目迁移：先开，再压测，重点盯连接池和 `synchronized`。
- 计算密集型服务（风控打分、加解密、报表聚合）：别开，收益接近零，还可能因为载体线程竞争变差。
- 已经用 WebFlux 的：不用换。两者解决的是同一类问题，虚拟线程的优势是能继续写阻塞式代码，学习和改造成本低得多。

## 六、总结

虚拟线程没有让 CPU 变快，它只是把"等待"这段时间还给了机器。

1. 平台线程贵且有限，请求等下游的时候，线程被白占着。
2. 虚拟线程在阻塞时主动卸载，几个载体线程撑起几万个并发，接入只要一行 `spring.threads.virtual.enabled=true`。
3. 真正的瓶颈往往在别处：数据库连接池、下游限流、`synchronized` 钉住载体线程、没有超时的等待。开虚拟线程之前，先把这几样捋一遍。

最后一句忠告：别为了用而用。一个 QPS 只有几十的内部管理系统，开不开虚拟线程，你根本感觉不到差别。

文 / 会编程的吕洞宾

## 参考资料

- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
- [Spring Boot Reference: Task Execution and Scheduling](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html)

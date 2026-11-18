---
title: "虚拟线程开了没提速，Java后端先改这4处"
date: 2026-11-11T09:00:00+08:00
category: "java"
tags: ["virtual-thread"]
---

> 订单详情接口卡在 900 QPS，CPU 才 20%，Tomcat 线程池先满了。把 `spring.threads.virtual.enabled` 打开，QPS 冲到 1200 又不动了，P99 从 300ms 拉到 3 秒，下游风控开始回 429。虚拟线程不是开关一开就变快，它只拆掉了「线程不够」这一堵墙，后面还有三堵等着你。这篇把四堵墙一个个拆开，代码能直接跑。

## 一、虚拟线程没提速，问题到底出在哪

结论先放这：虚拟线程只让你「等得起」，不负责让下游「扛得住」。

先把场景说清楚。一个订单详情接口，一次请求干三件事：查风控（远程调用，150ms）、查订单（MySQL 主键点查，5ms）、拼装返回（45ms）。平均 200ms，其中 150ms 纯粹在等网络。

平台线程模式下，Tomcat 默认 200 个工作线程。每个请求占一个线程 200ms，理论上限就是 200 / 0.2 = 1000 QPS，实测 900 左右。CPU 只用了 20%，因为 200 个线程里有 150ms 是在 `socketRead` 上干等，内核线程睡着，CPU 无事可做。

这不是「算得慢」，是「线程不够用」。虚拟线程正好治这个：等待的时候把底层线程让出来。所以打开开关后 QPS 上去了，到 1200。

然后就卡住了。为啥？

因为线程不再是瓶颈，下一个瓶颈浮出来了。数据库连接池这次不是问题：1200 QPS × 5ms = 6 个连接同时在用，Hikari 给了 10 个，够。真正撑不住的是下游风控，它单实例稳定扛 1200 QPS 左右，你正好把它打满，多出来的请求全变成 429。它一开始限流，你的线程就堵在等响应上，P99 从 300ms 飙到 3 秒。

这里有件事值得记住：不是每个连接池都会成为瓶颈。瓶颈永远出现在「容量最小、又没人管」的那一环，可能是一次第三方调用，也可能是对方网关的限流阈值。

**这就是虚拟线程最反直觉的地方：它把你的并发能力放大了，也把压力原封不动传给了下游。**

四堵墙，按撞上的顺序排：

| 墙 | 典型表现 | 怎么确认 |
| --- | --- | --- |
| 下游容量（DB 连接池、第三方配额、HTTP 连接池） | QPS 涨一点就停，下游 429 / 超时 | 看连接池 active 数、下游错误率 |
| `@Async` 执行器 | 异步任务把下游打爆，堆内存上涨 | 看 `spring.task.execution` 有没有配上限 |
| `synchronized` 钉住载体线程 | 开了虚拟线程反而更慢 | `-Djdk.tracePinnedThreads=full`（JDK 21）或 JFR |
| 可观测性和生命周期 | 日志丢 traceId、定时任务把 JVM 弄退出 | 线程 dump、`spring.main.keep-alive` |

下一节说清楚虚拟线程到底是怎么让出线程的，你才知道为什么 `synchronized` 会成为例外。

## 二、底层原理：虚拟线程怎么"让出"线程

结论：虚拟线程是 JVM 自己调度的「任务」，只有在 JDK 认识的阻塞点上才会交出底层线程。

### 平台线程和虚拟线程的区别

平台线程是 1:1 包着操作系统线程的。创建一个平台线程，操作系统就得给它分配内核线程和栈空间，默认栈预留 1MB。创建贵、切换贵、数量上限低，200 个线程等网络，就是 200 个内核线程陪着一起睡。

虚拟线程是 JVM 在用户态实现的。它的栈放在 Java 堆上，用多少长多少，不预先占 1MB。你开一万个虚拟线程，JVM 也只是多分配一些对象。

真正干活的是「载体线程」（carrier thread）。载体线程就是平台线程，数量默认等于 CPU 核数，由 JVM 内部一个 ForkJoinPool 管理。

### mount 和 unmount：让出的那一刻发生了什么

虚拟线程跑起来的时候，会被「挂载」到一个载体线程上执行。它一旦碰到阻塞操作，JVM 做两件事：

1. 把这个虚拟线程的调用栈从载体线程上摘下来（unmount），存回堆里；
2. 载体线程立刻去跑别的虚拟线程。

等阻塞结束，虚拟线程重新排队，等一个空闲载体线程再挂载上去接着跑（mount）。

拿餐厅打个比方。平台线程模式是：服务员带客人到桌边，客人看菜单看十分钟，服务员就站旁边等十分钟，别的客人没人管。虚拟线程模式是：客人说「我先看看」，服务员转身去招呼其他桌，客人想好了举手，谁空谁过来。

所以 4 个核的机器，8 个载体线程，就能撑住上万个同时在等 IO 的请求。前提是——它们真的在「等 IO」。

### 为什么 synchronized 是例外

关键在于「JDK 认识的阻塞点」。Socket 读写、文件 IO、`Thread.sleep`、`LockSupport.park`、阻塞队列、`ReentrantLock`，这些 JDK 都知道怎么让虚拟线程下车。

`synchronized` 在 JDK 21 上不行。虚拟线程在 `synchronized` 块里阻塞时，JVM 没法安全地把栈摘下来，只能让虚拟线程死死钉在载体线程上。这叫 pinning（钉住）。你开了 5000 个虚拟线程，只要有一批卡在 `synchronized` 里，8 个载体线程全被占死，整个应用直接停摆——比平台线程还惨，因为平台线程至少还有 200 个。

JDK 24 的 [JEP 491](https://openjdk.org/jeps/491) 把这个问题解决了：虚拟线程在 `synchronized` 里阻塞时也能释放载体线程。所以 JDK 24 之后 pinning 基本只剩两种情况：JNI 调用里回调 Java 再阻塞、类初始化时的锁。日常业务代码很难碰到。

如果你还卡在 JDK 21，遇到老代码里成片的 `synchronized`，要么换 `ReentrantLock`，要么先别开虚拟线程。

### Spring Boot 打开开关后到底改了什么

`spring.threads.virtual.enabled=true` 不是一句空话，Boot 在启动时替换了好几处：

- **Web 请求处理**：Tomcat 的请求不再从固定大小的线程池里取线程，而是每个请求一个虚拟线程。`server.tomcat.threads.max` 这时已经是摆设。
- **`@Async` 执行器**：默认的 `ThreadPoolTaskExecutor` 换成 `SimpleAsyncTaskExecutor`，每个任务开一个虚拟线程。
- **`@Scheduled` 调度器**：换成 `SimpleAsyncTaskScheduler`，同样忽略池大小配置。
- **线程池配置失效**：`spring.task.execution.pool.*`、`spring.task.scheduling.pool.size` 这些参数不再生效，因为虚拟线程不归这些池子管。

最后一条是很多人踩坑的起点。你原来靠 `core-size: 8 / queue-capacity: 100` 控制的并发上限，打开开关之后一夜之间消失了。

还有一个坑藏在细节里：虚拟线程是守护线程。JVM 在所有线程都是守护线程时会退出。如果你的应用主要靠 `@Scheduled` 撑着，调度线程变成守护线程后，主线程一结束 JVM 就退出了。官方给的解法是加一行 `spring.main.keep-alive=true`。

## 三、实战：一个能跑起来的压测项目

光讲原理没意义，搭个项目自己压一遍。目标：同一个接口，先看平台线程的吞吐，再看虚拟线程的吞吐，再看加了并发上限之后的表现。

### 项目结构

```
virtual-thread-demo
├── pom.xml
└── src/main
    ├── java/com/example/vtdemo
    │   ├── VtDemoApplication.java
    │   ├── ThreadInfoController.java
    │   ├── config/AsyncConfig.java
    │   ├── config/MdcTaskDecorator.java
    │   └── order
    │       ├── AsyncReportService.java
    │       ├── Order.java
    │       ├── OrderController.java
    │       ├── OrderRepository.java
    │       ├── OrderService.java
    │       └── OrderView.java
    └── resources
        ├── application.yml
        ├── schema.sql
        └── data.sql
```

### pom.xml

`src/main/resources` 同级，项目根目录：

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
    <artifactId>virtual-thread-demo</artifactId>
    <version>1.0.0</version>
    <name>virtual-thread-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
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
            <version>4.1.2</version>
            <scope>test</scope>
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

注意这里用的是 `spring-boot-starter-webmvc`。`spring-boot-starter-web` 在这个版本里已经被标记为废弃（描述里写着 deprecated in favor of spring-boot-starter-webmvc），两个都能跑，新项目直接用新的，省得以后升级时再改。

### application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: virtual-thread-demo
  threads:
    virtual:
      enabled: true
  main:
    keep-alive: true
  datasource:
    url: jdbc:h2:mem:demo;DB_CLOSE_DELAY=-1
    driver-class-name: org.h2.Driver
    username: sa
    password: ""
    hikari:
      maximum-pool-size: 10
      minimum-idle: 10
      connection-timeout: 1000
  sql:
    init:
      mode: always

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,threaddump
```

`spring.threads.virtual.enabled` 是总开关，`spring.main.keep-alive` 防 JVM 提前退出。连接池故意只给 10 个，后面讲踩坑时你会看到它什么时候才变成瓶颈。`connection-timeout` 设成 1 秒，是为了让排队现象快速暴露，而不是等 30 秒超时。

### 建表和初始数据

`src/main/resources/schema.sql`：

```sql
DROP TABLE IF EXISTS orders;

CREATE TABLE orders (
    id      BIGINT         NOT NULL PRIMARY KEY,
    user_id BIGINT         NOT NULL,
    amount  DECIMAL(10, 2) NOT NULL,
    status  VARCHAR(16)    NOT NULL
);
```

`src/main/resources/data.sql`：

```sql
INSERT INTO orders (id, user_id, amount, status) VALUES (1, 1001, 199.00, 'PAID');
INSERT INTO orders (id, user_id, amount, status) VALUES (2, 1002, 299.50, 'CREATED');
INSERT INTO orders (id, user_id, amount, status) VALUES (3, 1003, 88.80, 'PAID');
```

### 启动类

`src/main/java/com/example/vtdemo/VtDemoApplication.java`：

```java
package com.example.vtdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class VtDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(VtDemoApplication.class, args);
    }
}
```

### 订单模型和查询

`src/main/java/com/example/vtdemo/order/Order.java`：

```java
package com.example.vtdemo.order;

import java.math.BigDecimal;

public record Order(Long id, Long userId, BigDecimal amount, String status) {
}
```

`src/main/java/com/example/vtdemo/order/OrderView.java`：

```java
package com.example.vtdemo.order;

import java.math.BigDecimal;

public record OrderView(Long id, Long userId, BigDecimal amount, String status) {
}
```

`src/main/java/com/example/vtdemo/order/OrderRepository.java`：

```java
package com.example.vtdemo.order;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public class OrderRepository {

    private static final RowMapper<Order> ROW_MAPPER = (rs, rowNum) -> new Order(
            rs.getLong("id"),
            rs.getLong("user_id"),
            rs.getBigDecimal("amount"),
            rs.getString("status")
    );

    private final JdbcTemplate jdbcTemplate;

    public OrderRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Optional<Order> findById(long id) {
        return jdbcTemplate
                .query("SELECT id, user_id, amount, status FROM orders WHERE id = ?", ROW_MAPPER, id)
                .stream()
                .findFirst();
    }
}
```

### 业务层：模拟那个 200ms 的接口

`src/main/java/com/example/vtdemo/order/OrderService.java`：

```java
package com.example.vtdemo.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public OrderView query(long id) {
        // 模拟 150ms 的风控远程调用，真实项目里这里是 RestClient 或 Feign
        sleep(150);

        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("订单不存在: " + id));

        // 模拟 45ms 的组装和序列化开销
        sleep(45);

        Thread current = Thread.currentThread();
        log.info("订单查询完成, id={}, virtual={}, thread={}", id, current.isVirtual(), current.getName());
        return new OrderView(order.id(), order.userId(), order.amount(), order.status());
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("任务被中断", ex);
        }
    }
}
```

`Thread.sleep` 在这里是替身。真实项目里换成 `RestClient` 调风控、`JdbcTemplate` 查库都行，阻塞行为一样，虚拟线程的处理方式也一样。

### 控制器：同步接口和异步接口

`src/main/java/com/example/vtdemo/order/OrderController.java`：

```java
package com.example.vtdemo.order;

import org.slf4j.MDC;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;
    private final AsyncReportService asyncReportService;

    public OrderController(OrderService orderService, AsyncReportService asyncReportService) {
        this.orderService = orderService;
        this.asyncReportService = asyncReportService;
    }

    @GetMapping("/{id}")
    public OrderView query(@PathVariable long id) {
        return orderService.query(id);
    }

    @GetMapping("/{id}/report")
    public CompletableFuture<String> report(@PathVariable long id) {
        MDC.put("traceId", UUID.randomUUID().toString().substring(0, 8));
        try {
            return asyncReportService.buildReport(id);
        } finally {
            MDC.remove("traceId");
        }
    }
}
```

再加一个专门看线程信息的控制器，路径单独放，避免和 `/{id}` 抢路由。

`src/main/java/com/example/vtdemo/ThreadInfoController.java`：

```java
package com.example.vtdemo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class ThreadInfoController {

    @GetMapping("/api/thread-info")
    public Map<String, Object> threadInfo() {
        Thread current = Thread.currentThread();
        return Map.of(
                "name", current.getName(),
                "virtual", current.isVirtual(),
                "daemon", current.isDaemon()
        );
    }
}
```

开了虚拟线程之后，这个接口返回的 `virtual` 是 `true`，`name` 里带 `VirtualThread`。如果还是 `false`，说明开关没生效或者被别的配置覆盖了。

### 异步执行的配置：并发上限和 MDC 传递

`src/main/java/com/example/vtdemo/config/MdcTaskDecorator.java`：

```java
package com.example.vtdemo.config;

import org.slf4j.MDC;
import org.springframework.core.task.TaskDecorator;

import java.util.Map;

public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable runnable) {
        // decorate 在提交任务的线程里执行，这里能拿到调用方的 MDC
        Map<String, String> context = MDC.getCopyOfContextMap();
        return () -> {
            if (context != null) {
                MDC.setContextMap(context);
            }
            try {
                runnable.run();
            } finally {
                MDC.clear();
            }
        };
    }
}
```

`src/main/java/com/example/vtdemo/config/AsyncConfig.java`：

```java
package com.example.vtdemo.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.scheduling.annotation.EnableAsync;

@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean
    public AsyncTaskExecutor applicationTaskExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("vt-async-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(50);
        executor.setRejectTasksWhenLimitReached(true);
        executor.setTaskDecorator(new MdcTaskDecorator());
        return executor;
    }
}
```

这几行是全篇最值钱的配置：

- `setVirtualThreads(true)`：每个任务一个虚拟线程。
- `setConcurrencyLimit(50)`：同时在跑的任务最多 50 个，多的拒绝。不加这个，虚拟线程默认不限并发，一秒能给你开十万个。
- `setRejectTasksWhenLimitReached(true)`：超限直接抛 `TaskRejectedException`，快速失败，而不是无限排队把堆撑爆。
- `setTaskDecorator(...)`：把调用方的 MDC 带进异步线程，日志里的 traceId 才不会断。

定义了 `AsyncTaskExecutor` 这个 Bean 之后，Boot 的自动配置会让位，`spring.task.execution.*` 那些配置项也就不再生效了——上限由你写的 `concurrencyLimit` 决定。

### 异步服务

`src/main/java/com/example/vtdemo/order/AsyncReportService.java`：

```java
package com.example.vtdemo.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletableFuture;

@Service
public class AsyncReportService {

    private static final Logger log = LoggerFactory.getLogger(AsyncReportService.class);

    @Async
    public CompletableFuture<String> buildReport(long orderId) {
        try {
            Thread.sleep(300);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("报表任务被中断", ex);
        }
        log.info("报表生成完成, orderId={}, virtual={}", orderId, Thread.currentThread().isVirtual());
        return CompletableFuture.completedFuture("report-" + orderId);
    }
}
```

日志里会同时出现 `vt-async-` 前缀和 `virtual=true`，`traceId` 也在——三件事一次验证完。

### 跑起来压一遍

启动：

```bash
mvn spring-boot:run
```

先确认线程类型：

```bash
curl -s http://localhost:8080/api/thread-info
```

返回 `"virtual":true` 就对了。

压测用 200 并发打 2000 个请求，记录总耗时：

```bash
time seq 1 2000 | xargs -P 200 -I{} curl -s -o /dev/null http://localhost:8080/api/orders/1
```

再把 `application.yml` 里的 `spring.threads.virtual.enabled` 改成 `false`，重启，跑同一条命令。对比两次的总耗时，比例就是虚拟线程在这个场景里给你的收益。接口本身 180ms 是睡出来的，所以这个对比只反映「线程是否成为瓶颈」，不代表真实业务能提速这么多。

### 诊断：线程到底卡在哪

看虚拟线程的完整线程栈：

```bash
jcmd <pid> Thread.dump_to_file -format=json /tmp/threads.json
```

这个 JSON 里包含所有虚拟线程，数量可能是几万个，`jstack` 看不到它们。

抓 pinning（JDK 21）：

```bash
java -Djdk.tracePinnedThreads=full -jar target/virtual-thread-demo-1.0.0.jar
```

只要虚拟线程在 `synchronized` 里阻塞，控制台就会打完整堆栈，附带 `reason=monitor`。JDK 24 之后这个参数已经不需要了，因为 `synchronized` 不再钉住线程，改成看 `jdk.VirtualThreadPinned` 事件：

```bash
jcmd <pid> JFR.start name=vt settings=profile duration=60s filename=/tmp/vt.jfr
```

用 JDK Mission Control 打开 `/tmp/vt.jfr`，搜 `VirtualThreadPinned` 事件。

## 四、踩坑：四个真实坑

### 坑一：连接池不调，虚拟线程白开

**虚拟线程不会让数据库多出一个连接。**

每个请求占数据库连接的时间没变，池子大小没变，数据库侧的吞吐上限就没变。虚拟线程能做的是让请求「排队等连接」而不是「占着线程等连接」，所以现象会从「Tomcat 线程池满」变成「Hikari 连接超时」。

池子大小别拍脑袋。粗略算：`连接数 ≈ 目标 QPS × 单次持有时间（秒）`。1200 QPS × 0.02s = 24 个连接，给 10 个肯定不够。但也别一把调到 200，数据库的连接数、CPU、锁竞争都有上限，MySQL 单机超过一两百个活跃连接，上下文切换的损耗比收益大。

正确做法是先看 `HikariPool` 的 `active` 和 `pending` 指标，`pending` 长期大于 0 才是真的不够。

### 坑二：`@Async` 变成了不限并发的执行器

这是开虚拟线程后最容易炸的地方。

平台线程模式下，`@Async` 用的是 `ThreadPoolTaskExecutor`，默认核心 8 个线程、队列容量 `Integer.MAX_VALUE`。任务多了就排队，虽然延迟高，但不会瞬间把下游打死。

开了虚拟线程，执行器换成 `SimpleAsyncTaskExecutor`，默认 `concurrencyLimit = -1`，也就是不限并发。来一万个任务就开一万个虚拟线程，同时打到下游。下游扛不住，你的任务全超时；虚拟线程的栈虽然小，一万个堆栈同时存在也不是免费的。

两种解法：

- 简单场景，一行配置：`spring.task.execution.simple.concurrency-limit=50`，需要快速失败再加 `spring.task.execution.simple.reject-tasks-when-limit-reached=true`。
- 要传 MDC 或自定义线程名，就按上面的 `AsyncConfig` 自己定义 Bean，把上限写死在代码里。

记住一句话：**虚拟线程负责「能开很多」，限流负责「该开多少」。这两件事不能互相替代。**

### 坑三：JDK 21 上 `synchronized` 把你的吞吐打回去了

老代码里到处是 `synchronized` 的 DAO、单例工具类、老版本 HTTP 客户端。JDK 21 上这些地方会 pin 住载体线程。

现象很典型：并发一上来，QPS 不升反降，CPU 上不去，线程 dump 里几千个虚拟线程全是 `BLOCKED`，载体线程只有 8 个，每个都被钉住。

处理顺序：先开 `-Djdk.tracePinnedThreads=full` 找出钉住的位置；能改的改成 `ReentrantLock`；改不动的（第三方 jar）评估能不能升 JDK 24+。升不上去又改不动，那就先别开虚拟线程，这不是配置能绕过去的问题。

### 坑四：日志丢 traceId，定时任务消失

两个小问题，排查起来能耗一下午。

MDC 存在 `ThreadLocal` 里。`@Async` 换了线程，`ThreadLocal` 不会跟过去，日志里的 traceId 直接变成空。解法就是上面的 `MdcTaskDecorator`，提交任务时把 MDC 快照带走。

定时任务的问题更隐蔽。虚拟线程是守护线程，`@Scheduled` 的调度线程也变成守护线程后，如果 JVM 里没有非守护线程撑着，主线程一结束进程就退了。表现是「本地跑着好好的，打包部署后启动完就退出，日志没有任何异常」。加 `spring.main.keep-alive=true`。

顺便说一句，`jvm.threads.live` 这个指标不统计虚拟线程，看着一直是个位数别慌。要看虚拟线程数量，用 `jcmd Thread.dump_to_file`，或者 JFR。

## 五、性能对比：什么时候该开，什么时候别碰

结论：虚拟线程是 IO 密集型应用的吞吐工具，不是通用加速器。

| 维度 | 平台线程 | 虚拟线程 |
| --- | --- | --- |
| 每个线程的内存成本 | 默认预留 1MB 栈 | 栈在堆上按需增长，通常几 KB 起 |
| 阻塞时的代价 | 内核线程陪着等 | 释放载体线程，别人接着跑 |
| 并发上限来源 | 线程池大小 | 下游容量 + 内存 + 你自己设的限流 |
| CPU 密集任务 | 正常 | 没有收益，甚至因为调度多一层略慢 |
| 调试难度 | `jstack` 一把梭 | 需要 `jcmd` / JFR，工具链要跟上 |

适合开的场景：

- 接口以等待为主：调下游 HTTP、查库、读 Redis、发消息，CPU 利用率长期低于 40%。
- 并发量远超 CPU 核数，且请求之间互不依赖。
- 已经有明确的限流手段（连接池、信号量、网关限流），知道自己能打多少。

别开的场景：

- 计算密集：加解密、图片处理、复杂规则计算。核数不变，开多少线程都一样。
- 大量 `synchronized` 且短时间升不了 JDK 24。
- 已经在用 WebFlux 且跑得挺好。响应式已经把线程占用压到极低，换虚拟线程属于折腾。
- 下游没有任何配额保护，你也不知道它能扛多少。先做限流，再谈虚拟线程。

还有一个常被忽略的成本：可观测性。几千个虚拟线程的 dump 是好几百 MB，传统的「看线程数报警」全部失效。团队得先把 JFR、指标、结构化日志补齐，再上虚拟线程。

## 六、总结

虚拟线程解决的是「线程太贵，等不起」的问题，不是「系统慢」的问题。

打开开关只要一行配置，真正的工作在开关之外：算清楚下游能给多少并发，把连接池和限流配到匹配，把 `synchronized` 的老账翻出来，把 MDC 和监控补齐。这四件事做完，虚拟线程才会给你应有的回报。

判断要不要上，问自己一个问题：**你的接口时间花在等，还是花在算？** 答案在等，就值得试；答案在算，加机器比加线程有用。

文 / 会编程的吕洞宾

## 参考资料

- [Spring Boot Reference - Virtual threads](https://docs.spring.io/spring-boot/reference/features/spring-application.html)
- [Spring Boot Reference - Task Execution and Scheduling](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html)
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
- [HikariCP - About Pool Sizing](https://github.com/brettwooldridge/HikariCP)

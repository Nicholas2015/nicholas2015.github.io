---
title: "Spring Boot 优雅停机实战：发版重启不丢请求"
date: 2026-10-09T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> 发版重启的那几秒钟，用户最容易撞上 502 和 Connection reset。你按下重启，正在下单的人页面直接报错；运维说「就重启一下」，客服说订单炸了。问题往往不在你的业务代码，而在 Spring Boot 默认的停机方式——它相当于直接拔电源，不等任何请求处理完。好消息是，几行配置加两段代码，就能让应用在关闭前先把手上的活干完。这篇文章用一个下单服务的例子，把 Spring Boot 优雅停机的原理、完整代码和踩坑一次讲透。

## 一、这个问题到底是什么

**优雅停机的本质是：应用收到关闭信号后，先停止接收新请求，把手头正在处理的请求跑完，再释放数据库连接、线程池这些资源，最后才真正退出。**

先说默认行为。Spring Boot 应用收到关闭信号（比如 `kill` 或容器停止）时，默认是 `immediate`（立即）模式：它几乎不等待，直接把整个应用上下文关掉。正在执行的请求线程被中断，数据库连接被关，用户那边看到的就是一个断掉的连接。

会出现哪些报错？这几类最常见：

- `Connection reset by peer` / `Broken pipe`：请求发到一半，服务端进程没了。
- `502 Bad Gateway`：网关（Nginx）还往这个实例转发，实例已经关了。
- `Unexpected end of file from server`：响应还没写完，连接就断了。
- 业务侧偶发的「重复下单，一笔也查不到」：请求其实执行完了，但响应没发出去。

这些问题平时压测看不出来，只在重启、发版、扩缩容的时候集中爆发。频率不高，但每次发版都可能踩，属于典型的「线上才知道疼」。

用生活里的场景类比一下。一家餐厅到了打烊时间，有两种做法：

1. **直接拉闸（immediate）**：正在吃饭的客人桌上还摆着菜，灯一关，人赶走。客人体验极差。
2. **优雅打烊（graceful）**：门口挂上「今日已满」，不再放新客人进来；已经坐下的客人把饭吃完，结账离开；然后服务员收拾、关灯、锁门。

优雅停机就是第二种。它保证「已经在处理的活」不被打断，代价只是关门时间多花几秒到几十秒。

要触发关闭，通常有三种方式，后文都会用到：

- 操作系统发 `SIGTERM` 信号（容器停止、`kill <pid>` 默认发的就是它）。
- Actuator 的 `POST /actuator/shutdown` 端点（需要手工开启）。
- `SIGKILL`（`kill -9`），这个**无法优雅**，进程被内核直接干掉，任何代码都来不及执行。

## 二、底层原理到底怎么回事

**核心机制是 Spring 把「关闭」拆成了有序的若干阶段：先让 Web 服务器停止接收新连接并排空在途请求，等请求处理完，再依次关闭其他 Bean 和资源。**

先看信号是怎么传到 Java 代码里的。JVM 收到 `SIGTERM` 后，会执行注册好的 shutdown hook。Spring Boot 注册的 hook 做的事就是调用 `ApplicationContext.close()`。所以「优雅停机」并不是操作系统提供的，而是 Spring 在收到信号后主动做的一套收尾流程。

`ApplicationContext.close()` 里的顺序大致是这样：

1. 发布 `ContextClosedEvent` 事件。
2. 按 **phase（阶段）从大到小** 的顺序，依次调用所有 `Lifecycle` / `SmartLifecycle` Bean 的 `stop()` 方法。阶段值越大，越早停。
3. 停止并销毁普通 Bean。
4. 关闭内嵌的 Web 服务器（如果还没关的话）。

关键在第 2 步的 **phase 排序**。

Web 服务器的优雅关闭被注册成一个很大的 phase 值，所以它**最先执行**：一收到关闭信号，Tomcat 立刻进入「不再接受新连接」的状态，但已经在处理的请求线程继续跑。此刻数据库连接池、你的线程池、各种 Bean 都还活着，所以在途请求能正常查库、调下游、返回结果。

等 Web 服务器的在途请求排空（或者等超时），Spring 才继续往下走，去关闭别的 Bean。你看到的现象就是：慢接口照常返回，新来的请求被拒绝。

这个「等多久」由配置控制，两个超时别搞混：

- `spring.lifecycle.timeout-per-shutdown-phase`：**每个关闭阶段**最多等多久，默认 30 秒。超时不会报错，只是继续往下走。
- `server.shutdown=graceful`：把 Web 服务器切成优雅模式的那个开关，不开就是 `immediate`。

还有一个容易忽略的点：**Spring 只保证 Web 层被排空，不保证你自定义的线程池、`@Async` 任务、MQ 消费者被排空。**

因为那些东西不在 Web 服务器的生命周期里。关闭时，Web 服务器先停了，但如果你的异步任务还在跑，Spring 会继续往下关闭上下文，轮到线程池 Bean 销毁时，如果没配置「等待任务完成」，`ExecutorService.shutdown()` 会拒绝新任务但不一定等在途任务——很多人的 `@Async` 任务就是这么被丢掉的。

所以完整的优雅停机要分两块：

- Web 层：靠 `server.shutdown=graceful` 自动搞定。
- 后台任务层：靠线程池的等待配置，或者自己实现 `SmartLifecycle`。

另外，Spring Boot 在关闭时还会发布「可用性」事件（readiness 变为 `REFUSING_TRAFFIC`），上游如果监听了这个状态，就能提前把流量摘走，这属于锦上添花，不是必须。

## 三、实战：手把手写代码

**这一节给出一个完整可运行的下单服务示例：包含配置、慢接口、以及一个自己管理线程池并实现优雅收尾的组件。代码可以直接复制跑。**

### 3.1 项目骨架与依赖（完整 pom.xml）

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
    <artifactId>graceful-shutdown-demo</artifactId>
    <version>1.0.0</version>
    <name>graceful-shutdown-demo</name>
    <description>Spring Boot 优雅停机示例</description>

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

这里只引了两个 starter：`web` 提供内嵌 Tomcat 和 MVC，`actuator` 提供健康检查和手动触发停机的端点。

### 3.2 配置文件（完整 application.yml）

```yaml
server:
  port: 8080
  # 关键开关：打开优雅停机。不写这行就是默认的 immediate（立即关闭）
  shutdown: graceful

spring:
  application:
    name: graceful-shutdown-demo
  lifecycle:
    # 每个关闭阶段最多等 30 秒，超时就继续往下走
    timeout-per-shutdown-phase: 30s
  task:
    execution:
      # Spring 自带的线程池（@Async 用的那个）也等在途任务做完
      shutdown:
        await-termination: true
        await-termination-period: 20s
    scheduling:
      # 定时任务同理
      shutdown:
        await-termination: true
        await-termination-period: 20s

management:
  endpoints:
    web:
      exposure:
        # 暴露 health、info 和最关键的 shutdown 端点
        include: health,info,shutdown
  endpoint:
    shutdown:
      # 允许远程调用 POST /actuator/shutdown 来触发停机
      access: unrestricted
```

`server.shutdown: graceful` 是整篇文章的核心。下面 `spring.task.*` 那几行是给 Spring 自带线程池兜底的，`management.*` 那几行是为了让我们能手动测试触发停机。生产环境里 `shutdown` 端点必须加认证，不能裸奔，后面踩坑部分会讲。

### 3.3 启动类（完整类）

```java
package com.example.gracefulshutdown;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class GracefulShutdownApplication {

    public static void main(String[] args) {
        SpringApplication.run(GracefulShutdownApplication.class, args);
    }
}
```

### 3.4 一个「故意很慢」的下单接口（完整类）

要验证优雅停机有没有生效，得先有一个「处理很久」的接口，否则请求一瞬间就跑完了，根本看不出区别。

```java
package com.example.gracefulshutdown.web;

import com.example.gracefulshutdown.task.OrderTaskService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private static final Logger log = LoggerFactory.getLogger(OrderController.class);

    private final AtomicLong seq = new AtomicLong();
    private final OrderTaskService orderTaskService;

    public OrderController(OrderTaskService orderTaskService) {
        this.orderTaskService = orderTaskService;
    }

    /**
     * 模拟一个处理很久的下单接口。
     * 真实场景里这 5 秒可能是：调用支付、扣库存、写多张表。
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> createOrder() throws InterruptedException {
        long id = seq.incrementAndGet();
        log.info("收到下单请求 id={}，开始处理", id);
        Thread.sleep(5000);
        log.info("下单请求 id={} 处理完成", id);
        return ResponseEntity.ok(Map.of("orderId", id, "status", "CREATED"));
    }

    /**
     * 提交一个后台异步通知任务。
     */
    @PostMapping("/{id}/notify")
    public ResponseEntity<Map<String, Object>> notify(@PathVariable long id) {
        orderTaskService.sendNotification(id);
        return ResponseEntity.ok(Map.of("orderId", id, "notify", "submitted"));
    }
}
```

`createOrder()` 里的 `Thread.sleep(5000)` 就是在模拟「正在处理中的请求」。它存在的时候去重启应用，能直接看出 immediate 和 graceful 的区别。

### 3.5 自己管理线程池的组件（完整类，最容易踩坑的地方）

下单成功后要异步发通知，这类任务通常扔进自己的线程池。默认情况下，应用关闭时这些任务会被直接丢弃。下面这个类通过实现 `SmartLifecycle`，在关闭时先把「接收开关」关掉，再等在途任务跑完。

```java
package com.example.gracefulshutdown.task;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 负责发送订单异步通知的组件。
 * 实现 SmartLifecycle，让容器关闭时能"等我把活干完"。
 */
@Component
public class OrderTaskService implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(OrderTaskService.class);

    /** 排空在途任务最多等 20 秒 */
    private static final long DRAIN_TIMEOUT_SECONDS = 20;

    private final ExecutorService executor = Executors.newFixedThreadPool(4);

    /** 是否还接收新任务 */
    private final AtomicBoolean accepting = new AtomicBoolean(false);

    /** 当前在途任务数 */
    private final AtomicInteger running = new AtomicInteger(0);

    /**
     * 提交一个异步通知任务。
     */
    public void sendNotification(long orderId) {
        if (!accepting.get()) {
            throw new RejectedExecutionException("服务正在关闭，已停止接收新任务");
        }
        running.incrementAndGet();
        executor.execute(() -> {
            try {
                log.info("开始给订单 {} 发送通知", orderId);
                Thread.sleep(3000);
                log.info("订单 {} 通知发送完成", orderId);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                running.decrementAndGet();
            }
        });
    }

    /** 容器启动完成后，打开接收开关 */
    @Override
    public void start() {
        accepting.set(true);
        log.info("OrderTaskService 已启动，开始接收任务");
    }

    /** 容器关闭时，SmartLifecycle 会调用这里做优雅收尾 */
    @Override
    public void stop() {
        accepting.set(false);
        log.info("停止接收新任务，等待在途任务完成，当前在途 {} 个", running.get());

        executor.shutdown();
        try {
            if (!executor.awaitTermination(DRAIN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                log.warn("等待 {} 秒仍有任务未完成，强制关闭", DRAIN_TIMEOUT_SECONDS);
                executor.shutdownNow();
            } else {
                log.info("在途任务已全部完成，OrderTaskService 安全退出");
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public boolean isRunning() {
        return accepting.get();
    }

    /**
     * 阶段值比 Web 服务器的优雅关闭更小，所以关闭时"更晚"执行。
     * 这样能保证：HTTP 入口先关掉，没有新任务进来，再慢慢排空队列。
     */
    @Override
    public int getPhase() {
        return SmartLifecycle.DEFAULT_PHASE - 2048;
    }

    @Override
    public boolean isAutoStartup() {
        return true;
    }
}
```

三个要点：

- `stop()` 里先把 `accepting` 置为 false，新任务直接抛 `RejectedExecutionException`，不再往里塞。
- `executor.awaitTermination(20, TimeUnit.SECONDS)` 才是「等在途任务跑完」的关键，超时了才 `shutdownNow()` 强杀。
- `getPhase()` 返回一个较小的值，让这一步排在 Web 服务器优雅关闭**之后**，顺序不能反。

### 3.6 跑起来验证

打包并启动：

```bash
mvn clean package -DskipTests
java -jar target/graceful-shutdown-demo-1.0.0.jar
```

另开一个终端，打一个慢请求，然后马上给应用发关闭信号：

```bash
# 1) 发一个要处理 5 秒的下单请求（先别等它返回）
curl -i -X POST http://localhost:8080/api/orders &

# 2) 立刻给 Java 进程发 SIGTERM，触发关闭
kill -TERM $(pgrep -f graceful-shutdown-demo-1.0.0.jar)
```

你会看到日志大致是这样：请求 `id=1` 正常打出「处理完成」，之后进程才退出；如果此时再来一个新请求，会被直接拒绝，而不是连接被重置。

也可以不用 `kill`，改用 Actuator 端点触发同样的流程：

```bash
curl -X POST http://localhost:8080/actuator/shutdown
```

## 四、踩坑经验和最佳实践

**优雅停机的坑集中在两点：一是以为它管所有线程，二是以为光靠它就够。前者让你丢异步任务，后者让你发版依旧报 502。**

**坑一：以为 `server.shutdown=graceful` 能管到异步任务。** 它只管 Web 层。你的 `@Async`、自定义线程池、MQ 消费者都不在保护范围内。要么按 3.5 那样自己实现 `SmartLifecycle`，要么用 Spring 自带线程池并打开 `spring.task.execution.shutdown.await-termination`。

**坑二：忘了先摘流量。** 应用自己优雅了，但如果注册中心（比如 Nacos）里它还挂着，上游网关照样把新请求打过来，而这时候它已经不接新连接了。正确顺序是：**先从注册中心下线 → 等几秒让上游刷新路由 → 再发 SIGTERM**。这个「先下线」的动作通常放在发布脚本或容器的 preStop 钩子里。

**坑三：超时时间拍脑袋。** 优雅关机的总时长，取决于几个超时里最大的那个：`timeout-per-shutdown-phase`、线程池排空时间、上游网关的读超时。如果你接口最长要跑 60 秒，却只给 30 秒排空，那长的请求还是会被掐掉。建议按接口耗时的 P99 来设。

**坑四：以为打 war 包也生效。** `server.shutdown=graceful` 只对**内嵌**的 Web 服务器生效。如果你把应用打成 war 丢进外部 Tomcat，这条配置不起作用，得去配外部容器自己的优雅关闭。现在绝大多数项目都是内嵌 Tomcat/Jetty/Netty 的方式，问题不大，但要知道边界在哪。

**坑五：长连接会被切断。** SSE、WebSocket 这类长连接不吃「等在途请求」这一套，关闭时照样断。这类接口得在客户端做重连，别指望服务端优雅。

**坑六：Actuator shutdown 端点裸奔。** 前面为了让演示能跑，把 `management.endpoint.shutdown.access` 设成了 `unrestricted`。生产环境这等于给了一个「远程关机」接口，必须配上认证和网络隔离，或者干脆不用它、只靠 `SIGTERM`。

几个我推荐的默认做法：

- 生产一律开 `server.shutdown: graceful`，成本几乎为零。
- 排空超时按接口 P99 设，通常 20 到 60 秒。
- 发布流程固定成「先摘注册中心 → 等待 → SIGTERM → 等进程退出」。
- 所有自建线程池要么实现 `SmartLifecycle`，要么换成 `ThreadPoolTaskExecutor` 并打开等待选项。

## 五、性能对比和技术选型

**优雅停机不消耗运行时的性能，它只让关闭过程多花几秒到几十秒；换来的收益是发版期间几乎零请求失败，这笔买卖非常划算。**

| 停机方式 | 在途请求 | 发版错误率 | 关闭耗时 | 适用场景 |
| --- | --- | --- | --- | --- |
| `immediate`（默认） | 直接中断 | 有 502/连接重置 | 秒级 | 本地开发、无所谓丢请求的场景 |
| `graceful`（优雅） | 跑完再退 | 接近 0 | 取决于最长请求，通常十几秒 | 生产环境、滚动发布 |
| `kill -9`（SIGKILL） | 无法保护 | 有 | 立即 | 卡死时不得已才用 |

触发方式怎么选：

- **`SIGTERM`**：推荐。容器编排、进程管理工具默认就发它，配合 `signal` 配置无需额外代码。
- **Actuator shutdown 端点**：适合运维手动操作或脚本触发，但要自己做鉴权和隔离。
- **`SIGKILL`**：只有在进程完全卡死、优雅关闭无论如何都退不出去时，作为最后手段。

如果应用里完全没有异步任务、没有长连接，那 `server.shutdown=graceful` 一行就够了，不需要 3.5 那段代码。有后台任务或 MQ 消费者时，才需要自己实现收尾逻辑。

## 六、总结

**Spring Boot 优雅停机的全部要点可以浓缩成三句话：配置里打开 `server.shutdown=graceful`，给后台线程池补上排空逻辑，发布时先摘流量再发信号。**

回到开头的那次发版。默认的 Spring Boot 是「拔电源式」关闭，慢请求正跑着就被打断，用户看到的是 502 和连接重置。打开优雅停机后，应用会先关上大门，把已经在处理的请求跑完，再收拾东西走人。

落地就三步：

1. 在 `application.yml` 里加上 `server.shutdown: graceful` 和合理的 `timeout-per-shutdown-phase`。
2. 检查所有自建线程池、`@Async`、定时任务、MQ 消费者，用 `SmartLifecycle` 或等待配置补上排空逻辑。
3. 把发布流程改成「先摘注册中心 → 等几秒 → 发 SIGTERM」。

搞完这三步，你的发版就从「赌用户运气」变成了「稳如老狗」。停机多花的那十几秒，跟你半夜被人叫起来抓 bug 的时间比，不值一提。

## 参考资料

- [Spring Boot 官方文档 · Graceful Shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)
- [Spring Boot 官方文档 · Actuator Endpoints（含 shutdown 端点与访问控制）](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)
- [Spring Framework API · SmartLifecycle](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/context/SmartLifecycle.html)

文 / 会编程的吕洞宾

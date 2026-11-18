---
title: "Spring Boot优雅停机总丢请求，Java后端补这4处"
date: 2026-10-30T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> 每次上线发布，监控里都会冒出几十个 502 和 Connection reset。翻服务端日志，一条异常都没有——因为请求根本没走到业务代码，进程已经没了。更隐蔽的是另一类问题：接口看着一切正常，可异步任务跑到一半凭空消失，MQ 消息已经确认消费、库里却没有数据。这些都不是代码 bug，是进程的退出方式有问题。Spring Boot 默认的停机动作，是把正在处理的请求直接掐断。

## 一、这个问题到底是什么

优雅停机的本质只有一句话：进程收到"要关机"的通知后，先把手上的活干完，再退出。

对比一下两种退出方式。

**强制退出**：进程收到 SIGKILL，操作系统直接回收内存。没有任何收尾机会，正在执行的线程当场消失，客户端看到的是连接被重置。

**默认退出**（Spring Boot 不开任何配置时的行为）：进程收到 SIGTERM，JVM 执行 shutdown hook，Spring 容器开始关闭，Web 容器被 `stop()` 掉。这时候正在处理的请求会被中断，客户端拿到的可能是空响应、502，或者一个 `java.io.IOException: Connection reset by peer`。

**优雅退出**：还是收到 SIGTERM，但 Web 容器先"暂停接客"——不再接受新连接，已经进来的请求继续跑完，跑完了容器才真正关闭。

听起来只要加一行 `server.shutdown=graceful` 就完事了。问题在于，真实项目里丢请求的地方不止 Web 容器这一处。

我见过一个订单服务，开了优雅停机之后发布仍然丢数据。排查了两天，最后发现丢的是异步导出任务：主线程的 HTTP 请求 3 秒就返回了，真正的活儿丢给线程池在后台跑，Web 容器关掉时压根不管线程池里还有没有任务。

下面这张表是我总结的四类漏点，对着自查基本能覆盖九成场景。

| 漏点 | 典型现象 | 谁来兜底 |
| --- | --- | --- |
| Web 容器直接关闭 | 502、Connection reset、no healthy upstream | `server.shutdown=graceful` |
| 在途请求超过等待上限 | 日志出现处理到一半中断，TaskRejected 或线程被打断 | 调大等待时间 + 排查慢接口 |
| 线程池里的异步任务 | 接口返回成功，后台任务没跑完就没了 | 线程池的 shutdown 等待参数 |
| 定时任务 / MQ 消费者 | 消息已 ack 但业务没落库；定时任务跑一半 | 业务自己实现生命周期回调 |

一句话总结这张表：**Web 请求有框架帮你等，Web 之外的活儿没人帮你等**。

## 二、底层原理到底怎么回事

### 从 kill 到容器关闭，中间发生了什么

`kill <pid>` 默认发的是 SIGTERM，不是 SIGKILL。这个区别很关键：SIGTERM 是可以被程序处理的，SIGKILL 不行。

JVM 收到 SIGTERM 后，会启动所有注册过的 shutdown hook。Spring Boot 在里面注册了一个，负责调用 `ConfigurableApplicationContext.close()`。整个关闭流程是这样走的：

1. 发布 `ContextClosedEvent` 事件，此时容器和所有 bean 都还活着。
2. 按 phase 从大到小，依次停止所有实现了 `SmartLifecycle` 的 bean。
3. 销毁所有单例 bean，触发 `@PreDestroy` 和 `DisposableBean.destroy()`。
4. 关闭 bean 工厂，释放资源。

注意第 2 步的"从大到小"。Spring 用 phase 控制停机顺序：phase 数值越大，停得越早。这个设计就是为了让"接客的"先关，"干活的"后关。

### graceful 到底做了什么

`server.shutdown=graceful` 打开后，Spring Boot 会给内嵌 Web 容器注册一个生命周期组件。它在停机时的动作是：暂停 Connector，不再接收新连接；已经建立的连接上正在执行的请求继续跑；等所有请求结束，才真正关闭线程池。

关键就在"等"这个字。等多久？由 `spring.lifecycle.timeout-per-shutdown-phase` 控制，默认 30 秒。

这个等待是分 phase 的——每个 phase 单独计时 30 秒，不是整个停机过程总共 30 秒。等待超时后，Spring 打一条 warn 日志，然后强制往下走。所以如果你的接口有跑 60 秒的，默认配置下它必死。

### 为什么异步任务等不到

`@Async` 用的线程池，本质上是个 `ThreadPoolTaskExecutor`。它确实实现了 `DisposableBean`，容器关闭时会被 `destroy()`。但 `destroy()` 的默认行为是调 `shutdown()`——**它不等待队列里的任务**。

线程池的 `shutdown()` 语义是：不再接新任务，正在跑的任务继续跑，但 JVM 不会为它们保活。容器关完、主线程走完，JVM 就退了，剩下的任务跟着一起没。

要让它等，必须显式设置两个参数：`setWaitForTasksToCompleteOnShutdown(true)` 和 `setAwaitTerminationSeconds(n)`。前者说"我要等"，后者说"最多等多久"。

### readiness 与摘流的时间差

还有一个常被忽略的环节：流量是怎么停的。

进程要退出，但上游的网关、负载均衡、注册中心并不知道。它们还在按老配置往这个实例发请求。Spring Boot 在准备停机时会把就绪状态切成 `REFUSING_TRAFFIC`，健康检查接口立刻返回 503——这是给上游的"别发给我了"信号。

但上游刷新实例列表需要时间，注册中心推送也有延迟。这段窗口里发过来的请求，正好撞在停机过程中。所以光靠应用层优雅停机不够，得配合"先摘流、等几秒、再停机"的动作。

```text
时间轴（理想情况）
0s    收到 SIGTERM，就绪状态切为 REFUSING_TRAFFIC
0-5s  上游健康检查失败，把实例摘掉（这段必须等）
5s    Web 容器暂停接客，等在途请求跑完
5-35s 在途请求陆续结束
35s   线程池/业务组件收尾
40s   进程退出
```

## 三、实战：手把手写代码

### 项目结构

```text
graceful-demo
├── pom.xml
└── src/main
    ├── java/com/example/graceful
    │   ├── GracefulDemoApplication.java
    │   ├── config/AsyncConfig.java
    │   ├── lifecycle/ReportDrainLifecycle.java
    │   ├── service/ReportService.java
    │   └── web/SlowController.java
    └── resources/application.yml
```

### pom.xml

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
    <artifactId>graceful-demo</artifactId>
    <version>1.0.0</version>
    <name>graceful-demo</name>

    <properties>
        <java.version>21</java.version>
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

两个 starter 都显式写了版本。父 POM 里其实已经管了这些版本，写出来是为了让这份文件脱离父 POM 也能对得上——版本对齐最怕的就是"以为 BOM 管了，其实没管"。

### 启动类

`@EnableAsync` 是必须的，否则 `@Async` 不生效，任务会在调用线程里同步跑，这个坑我们后面还会提。

```java
package com.example.graceful;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;

@SpringBootApplication
@EnableAsync
public class GracefulDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(GracefulDemoApplication.class, args);
    }
}
```

### 一个能被打断的接口

这个接口故意睡一段时间，用来模拟慢请求。日志里记录开始和结束时间，停机时就能看出它到底跑完了没有。

```java
package com.example.graceful.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SlowController {

    private static final Logger log = LoggerFactory.getLogger(SlowController.class);

    @GetMapping("/slow")
    public String slow(@RequestParam(defaultValue = "5000") long ms) throws InterruptedException {
        long start = System.currentTimeMillis();
        log.info("收到请求, 预计耗时 {} ms", ms);
        Thread.sleep(ms);
        long cost = System.currentTimeMillis() - start;
        log.info("请求处理完成, 实际耗时 {} ms", cost);
        return "done in " + cost + " ms";
    }
}
```

`Thread.sleep` 被中断时会抛 `InterruptedException`，这里没捕获，异常会冒到 Spring MVC。这不是偷懒，是为了让"请求被掐断"这件事在日志和响应里都看得见——如果吞掉异常返回 200，你就永远发现不了停机丢请求。

### 线程池配置

这里是第一个真正的坑点。三个 setter，少一个都不行。

```java
package com.example.graceful.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@Configuration
public class AsyncConfig {

    @Bean("reportExecutor")
    public ThreadPoolTaskExecutor reportExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("report-");
        // 关键一：停机时等队列里的任务跑完
        executor.setWaitForTasksToCompleteOnShutdown(true);
        // 关键二：最多等 30 秒，避免卡死
        executor.setAwaitTerminationSeconds(30);
        executor.initialize();
        return executor;
    }
}
```

只设 `setWaitForTasksToCompleteOnShutdown(true)` 不设 `setAwaitTerminationSeconds`，等于说"我要等，但等多久随缘"——实际上会一直等到任务全跑完，遇到死循环任务就永远关不掉。两个一起用才是完整的。

### 业务侧的生命周期钩子

线程池会等，但"别再往里塞新任务"这件事它管不了。这个组件干的就是这件事：停机时先把闸门关上，后续进来的任务直接拒绝并记日志。

```java
package com.example.graceful.lifecycle;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicBoolean;

@Component
public class ReportDrainLifecycle implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(ReportDrainLifecycle.class);

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean accepting = new AtomicBoolean(true);

    public boolean isAccepting() {
        return accepting.get();
    }

    @Override
    public void start() {
        running.set(true);
        accepting.set(true);
        log.info("报表组件已启动, 开始接收任务");
    }

    @Override
    public void stop() {
        accepting.set(false);
        log.warn("报表组件进入排空状态, 不再接收新任务");
        running.set(false);
        log.info("报表组件已停止");
    }

    @Override
    public boolean isRunning() {
        return running.get();
    }

    /**
     * 数值越大越早停。这里给一个比默认值大的数，
     * 让它在 Web 容器停掉之前先关闸门。
     */
    @Override
    public int getPhase() {
        return Integer.MAX_VALUE - 1000;
    }
}
```

`getPhase()` 返回 `Integer.MAX_VALUE - 1000` 是刻意的：想让它比 Spring Boot 给 Web 容器注册的生命周期组件更早执行，就不能用默认的 0，得往上顶到一个足够大的数，同时留出余量避免和别人撞。

### 报表服务

```java
package com.example.graceful.service;

import com.example.graceful.lifecycle.ReportDrainLifecycle;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class ReportService {

    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    private final ReportDrainLifecycle drainLifecycle;

    public ReportService(ReportDrainLifecycle drainLifecycle) {
        this.drainLifecycle = drainLifecycle;
    }

    @Async("reportExecutor")
    public void generate(long id, long ms) {
        if (!drainLifecycle.isAccepting()) {
            log.warn("服务正在停机, 拒绝报表任务 id={}", id);
            return;
        }
        log.info("报表任务开始 id={}", id);
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.error("报表任务被中断 id={}", id);
            return;
        }
        log.info("报表任务完成 id={}", id);
    }
}
```

注意 `@Async` 方法里 `Thread.sleep` 抛的 `InterruptedException` 必须自己处理——`@Async` 方法返回 void 时，异常不会往上抛给调用方，只会在日志里留一行。这是很多人排查异步任务丢失时找不到线索的原因。

### 配置文件

```yaml
server:
  port: 8080
  shutdown: graceful
  tomcat:
    threads:
      max: 200

spring:
  application:
    name: graceful-demo
  lifecycle:
    timeout-per-shutdown-phase: 40s

management:
  endpoint:
    health:
      probes:
        enabled: true
  endpoints:
    web:
      exposure:
        include: health,info
```

`timeout-per-shutdown-phase` 设成 40 秒，是因为最慢的接口要跑 30 秒左右。这个值的算法很简单：**取你 P99 接口耗时，再加 5-10 秒缓冲**。拍脑袋写 30 秒默认值，遇到报表导出接口必炸。

### 验证一遍

打包启动：

```bash
mvn clean package -DskipTests
java -jar target/graceful-demo-1.0.0.jar
```

另开一个终端，发一个 20 秒的慢请求，同时在第三个终端 kill 进程：

```bash
# 终端 A：发请求
curl "http://localhost:8080/slow?ms=20000"

# 终端 B：拿到 pid 后发 SIGTERM
kill -TERM $(pgrep -f graceful-demo)
```

应用日志里应该能看到这个顺序：

```text
收到请求, 预计耗时 20000 ms
报表组件进入排空状态, 不再接收新任务
请求处理完成, 实际耗时 20004 ms
报表组件已停止
```

请求完整返回，客户端拿到 `done in 20004 ms`，而不是连接被重置。把 `server.shutdown` 改回默认值再试一次，日志里第二条就没了，curl 直接报 `Connection reset by peer`。

想看就绪状态怎么变，停机过程中轮询这个接口：

```bash
curl -i http://localhost:8080/actuator/health/readiness
```

停机开始后它会返回 503，状态是 `OUT_OF_SERVICE`。这个信号就是给上游看的。

## 四、踩坑经验和最佳实践

**坑一：只开了 graceful，以为万事大吉。**

`server.shutdown=graceful` 只管 Web 容器的请求。异步任务、定时任务、MQ 消费、Netty 长连接，全都不在它的管辖范围里。我们那个订单服务就是这么翻车的：HTTP 请求 3 秒返回，后台导出要跑 40 秒，容器一停，任务消失，用户第二天来问报表怎么没有了。

**坑二：等待时间小于最长接口耗时。**

`timeout-per-shutdown-phase` 是每个 phase 的上限，超时就强杀。你的接口如果有 60 秒的批量操作，配 30 秒等于没配。这里还有个外部约束容易被忽略：`docker stop` 默认只等 10 秒，10 秒后直接 SIGKILL。容器里的等待时间再长也没用，得一起改：

```bash
docker stop -t 60 <container>
```

同理，容器编排里的 `terminationGracePeriodSeconds` 也要大于应用的等待时间，否则平台先动手，应用连收尾的机会都没有。

**坑三：上游摘流慢于进程退出。**

应用已经停了，网关还在转发。这种情况光调应用参数没用，得在停机前加一段"等待"：收到信号后先睡 5 秒，让注册中心把实例摘掉，再开始真正关闭。这段等待放在 `ContextClosedEvent` 监听里最合适，因为它在所有 bean 销毁之前触发。

```java
package com.example.graceful.lifecycle;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class PreStopDelay {

    private static final Logger log = LoggerFactory.getLogger(PreStopDelay.class);

    @EventListener(ContextClosedEvent.class)
    public void onClosed() {
        log.warn("收到停机信号, 等待上游摘流");
        try {
            Thread.sleep(5000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        log.warn("摘流等待结束, 开始关闭容器");
    }
}
```

这 5 秒是纯浪费的 5 秒，但比丢请求划算。具体等多久，看你们注册中心的心跳和健康检查周期，一般 2 到 3 个周期比较稳。

**坑四：在 `@PreDestroy` 里做耗时清理。**

`@PreDestroy` 触发时，Web 容器早就停了，数据源可能也关了。在里面查库、发 HTTP 请求，大概率报 `Connection is closed`。要做收尾就放在 `SmartLifecycle.stop()` 里，别放 `@PreDestroy`。

**最佳实践清单：**

- 慢接口必须能被打断，别用 `catch (InterruptedException e) {}` 吞掉
- `@Async` 方法返回 `CompletableFuture` 而不是 void，异常才能传出来
- 停机期间返回 503 + `Retry-After`，比 500 更让上游好处理
- 每次发布跑一遍"慢请求 + kill"的验证，别等线上丢单才发现
- 数据库事务不在优雅停机的保护范围内，写操作要幂等

## 五、性能对比和技术选型

三种停机方式的取舍很清楚，没有银弹。

| 方式 | 在途请求 | 发布耗时 | 适用场景 |
| --- | --- | --- | --- |
| 立即关闭（默认） | 全部中断 | 最快，秒级 | 本地开发、无状态且可重试的服务 |
| 优雅停机 | 等待完成，超时强杀 | 增加 5-40 秒 | 绝大多数线上 Web 服务 |
| 优雅停机 + 摘流等待 | 完整完成 | 增加 10-60 秒 | 有支付、订单等不可重试写操作的服务 |

开销方面，优雅停机本身几乎不占资源——它只是让进程多活一会儿，CPU 和内存占用跟正常运行没区别。真正的成本是发布窗口变长：10 个实例滚动发布，每个多等 30 秒，总时长就多 5 分钟。

我推荐的做法是分环境区别对待。开发和测试环境保持默认的立即关闭，改代码重启快；生产环境全部开 graceful，等待时间按接口 P99 算；核心交易链路再加摘流等待。别一套配置打天下。

如果服务里异步任务特别多、又不想逐个改线程池，还有个思路：把所有后台执行器收敛到一个统一的 `TaskExecutor` 上，用 `@Bean` 集中配置等待参数。散落各处的 `new ThreadPoolExecutor(...)` 是优雅停机的天敌——那些线程池根本不归 Spring 管，容器关了它们还在跑，然后被 JVM 一起带走。

## 六、总结

优雅停机不是一行配置的事，它是一整条链路上的配合。

应用层要做三件事：让 Web 容器停止接收新请求并等在途请求跑完；让线程池和业务组件知道"该收尾了"；让健康检查提前返回 503，给上游摘流的时间。

平台层要做两件事：摘流等待窗口要留够；强杀的超时时间要大于应用的等待时间。

这两层任何一层缺失，都会表现成同一个现象——发布时丢请求，而且日志里什么都看不到。

排查这类问题有个笨办法但很好用：在接口入口和出口各打一行日志，中间带上请求 id。发布一次，对比一下"有进无出"的请求有多少，就知道漏在哪一层了。

代码不复杂，难的是把每一处都想到。上次我一个同事说"我开了 graceful 啊"，我问他线程池配了吗，他愣了三秒。

---

文 / 会编程的吕洞宾

## 参考资料

1. [Graceful Shutdown — Spring Boot Reference Documentation](https://docs.spring.io/spring-boot/reference/web/servlet.html#web.servlet.graceful-shutdown)
2. [SmartLifecycle — Spring Framework Javadoc](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/context/SmartLifecycle.html)
3. [ThreadPoolTaskExecutor — Spring Framework Javadoc](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/scheduling/concurrent/ThreadPoolTaskExecutor.html)

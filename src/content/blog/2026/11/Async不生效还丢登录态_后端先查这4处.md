---
title: "@Async 不生效还丢登录态，后端先查这4处"
date: 2026-11-13T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> 排查一个导出功能时遇到两个怪事：接口 200 毫秒就返回了，日志里却一条记录都没有；另一个服务更离谱，方法明明标了 `@Async`，写进库的 `create_by` 全是 null。两件事看着不相关，根子是同一个——你以为 Spring 帮你开了个线程，其实它只是给 Bean 套了个代理。代理没走到、线程换了人、上下文没跟过去，问题就全出来了。下面按排查顺序，把这四个地方挨个拆开。

## 一、@Async 不生效的 4 种典型现象

`@Async` 的作用只有一个：把方法调用从当前线程挪到另一个线程执行，调用方立刻拿到返回值走人。它不创建线程池，不改变业务逻辑，也不负责异常处理。

真正让人头疼的是它失效的方式特别安静。不报错，不警告，代码看起来完全正常。

**现象一：断点打进去，发现还在原来的线程。** 方法上标了 `@Async`，调用方也正常返回，但日志里的线程名还是 `http-nio-8080-exec-1`。这说明方法压根没异步，同步跑完了才返回。最常见的原因是同类内部调用，后面细说。

**现象二：异步是异步了，登录用户没了。** 主线程里 `UserContext.get()` 有值，异步方法里返回 null。MDC 里的 traceId 也断了，一条链路在日志系统里碎成两段。

**现象三：返回值永远是 null。** 方法声明 `String`，异步执行完也确实算出了结果，但调用方拿到的就是 null，一点脾气没有。

**现象四：线程池参数改了没反应。** 你把 `maxPoolSize` 调到 50，压测时线程数死活停在 8。这不是配置没生效，是队列没设上限，池子根本没机会扩容。

这四种现象对应四个不同的机制问题，混在一起排查只会越查越乱。分开看，每个都能一两句话讲清楚。

下面这张表是速查版，先对号入座再往下读：

| 现象 | 直接原因 | 去哪一节看 |
| --- | --- | --- |
| 还在原线程执行 | 同类自调用，没经过代理 | 二、三节 |
| 用户信息、traceId 丢失 | ThreadLocal 不跨线程 | 二、三节 |
| 返回值是 null | 返回类型不是 void/Future | 四节 |
| 线程数上不去 | 队列无界，扩容条件不成立 | 二、四节 |

## 二、@Async 为什么失效：代理、线程池、ThreadLocal 三件事

`@Async` 能生效的唯一前提是：调用必须经过 Spring 生成的代理对象。这是理解所有失效场景的第一把钥匙。

### 2.1 异步是靠代理"劫持"调用实现的

Spring 启动时会扫描所有 Bean，发现方法或类上有 `@Async`，就给这个 Bean 生成一个代理。代理里包了一层拦截器，逻辑很直白：

```text
调用方 -> 代理对象 -> 拦到 @Async -> 把方法包装成任务丢进线程池 -> 立刻返回
                          |
                          +-> 线程池里的线程真正执行方法体
```

关键点在于：调用方手里拿到的必须是代理，不是原始对象。你从容器里 `@Autowired` 注入的、`@Resource` 拿到的，都是代理。所以跨 Bean 调用没问题。

同一类里 `this.xxx()` 调用就绕过了代理。`this` 是原始对象自己，方法体直接执行，拦截器连影子都没有。这不是 Spring 的 bug，任何基于代理的 AOP 都这样，`@Transactional`、`@Cacheable` 全部同一个毛病。

还有一个容易忽略的边界：`private` 方法和 `final` 方法也拦不住。CGLIB 靠继承生成子类，私有方法不参与继承，final 方法不允许覆盖。标了也没用。

### 2.2 Spring 找线程池有一个固定顺序

`@Async` 自己不创建线程池，它得问容器要一个。查找顺序是这样的：

1. 容器里有 `AsyncConfigurer` 类型的 Bean，就用它 `getAsyncExecutor()` 返回的。
2. 没有的话，找容器里 `TaskExecutor` 类型的 Bean。
3. 还没有，找名字叫 `taskExecutor` 的 Bean。
4. 实在找不到，兜底 `SimpleAsyncTaskExecutor`——每次调用新建一个线程，不池化，不限制数量。

Spring Boot 在这条链上插了一脚。它默认会创建一个名字叫 `applicationTaskExecutor` 的线程池，并且注册一个内置的 `AsyncConfigurer` 指向它。所以正常项目里，`@Async` 用的就是这个自动配置的池。

这个池的默认参数值得记一下，因为很多"参数改了没反应"的疑惑都来自这里：

| 参数 | 默认值 | 后果 |
| --- | --- | --- |
| corePoolSize | 8 | 平时最多 8 个线程干活 |
| maxPoolSize | Integer.MAX_VALUE | 纸面上能无限扩 |
| queueCapacity | Integer.MAX_VALUE | 队列永远不满，所以永远不会扩 |
| keepAlive | 60 秒 | 空闲线程一分钟后回收 |

`ThreadPoolTaskExecutor` 的扩容条件写得很明确：核心线程占满 **并且** 队列也满了，才创建新线程。队列容量是 `Integer.MAX_VALUE`，等于告诉它"别扩了，排队就行"。所以 `maxPoolSize` 那个最大值，在生产上几乎从来没被触发过。

代价是队列会一直吃内存。任务堆到几十万个，每个任务还抓着请求参数和对象引用，OOM 只是时间问题。这个默认值属于"能用但别信"的级别。

### 2.3 ThreadLocal 是"线程自己的抽屉"

`ThreadLocal` 的存储结构可以想成一排带锁的抽屉，每个线程只认自己那把钥匙。你在线程 A 里 `set` 的值，线程 B 打开抽屉看到的是空的。

```text
Thread A 的抽屉: { userContext = "10086", traceId = "a1b2" }
Thread B 的抽屉: { }   <- 刚被线程池创建，空的
```

Spring Security 的 `SecurityContextHolder` 默认就是 ThreadLocal 实现，MDC 底层也是 ThreadLocal，很多团队自己写的 `UserContext`、`TenantContext` 同样是。异步把任务交给线程 B，B 的抽屉自然是空的。

这事还有个更阴的变种：线程池的线程是复用的。如果上一次任务往抽屉里塞了东西没清理，下一个任务打开抽屉会看到上一个人的数据。日志串号、数据串租户，排查起来能耗一整天。

解决办法不是"别用 ThreadLocal"，而是**在线程切换的那一刻，把抽屉里的东西抄一份带过去，用完再恢复原样**。Spring 为这个场景留了接口：`TaskDecorator`。

## 三、实战：一个能跑起来的完整 demo

这一节给出一个完整工程，用 5 个接口把"自调用失效""上下文丢失""返回值陷阱""线程池参数"四件事全演示一遍。代码可以直接复制运行。

### 3.1 项目结构

```text
async-demo
├── pom.xml
└── src/main
    ├── java/com/example/asyncdemo
    │   ├── AsyncDemoApplication.java
    │   ├── config/AsyncConfig.java
    │   ├── context/UserContext.java
    │   ├── context/UserContextFilter.java
    │   ├── service/AuditService.java
    │   ├── service/OrderService.java
    │   └── web/OrderController.java
    └── resources/application.yml
```

### 3.2 pom.xml

只用 Web 和测试两个依赖。注意 Boot 4 里 `spring-boot-starter-web` 已经标记为废弃，官方推荐换成 `spring-boot-starter-webmvc`，功能一样，包名变了。

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
    <artifactId>async-demo</artifactId>
    <version>1.0.0</version>
    <name>async-demo</name>

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

### 3.3 启动类

`@EnableAsync` 必须加，没有它所有 `@Async` 都是装饰品。

```java
package com.example.asyncdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;

@EnableAsync
@SpringBootApplication
public class AsyncDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(AsyncDemoApplication.class, args);
    }
}
```

### 3.4 用户上下文：一个再普通不过的 ThreadLocal

真实项目里这里放的是登录用户 ID、租户 ID、权限之类的信息。demo 里简化成一个字符串。

```java
package com.example.asyncdemo.context;

public final class UserContext {

    private static final ThreadLocal<String> CURRENT_USER = new ThreadLocal<>();

    private UserContext() {
    }

    public static void set(String userId) {
        CURRENT_USER.set(userId);
    }

    public static String get() {
        return CURRENT_USER.get();
    }

    public static void clear() {
        CURRENT_USER.remove();
    }
}
```

`clear()` 里用的是 `remove()` 而不是 `set(null)`。前者会把整个 Entry 删掉，后者只是把值置空，Entry 还挂在 ThreadLocalMap 上，长生命周期的线程池里这就是内存泄漏。

### 3.5 过滤器：请求进来时写入上下文和 traceId

用请求头 `X-User-Id` 模拟登录态。真实项目里换成从 Token 解析就行，位置一样。

```java
package com.example.asyncdemo.context;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class UserContextFilter extends OncePerRequestFilter {

    private static final String USER_HEADER = "X-User-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String userId = request.getHeader(USER_HEADER);
        if (userId == null || userId.isBlank()) {
            userId = "anonymous";
        }
        String traceId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);

        UserContext.set(userId);
        MDC.put("traceId", traceId);
        MDC.put("userId", userId);
        response.setHeader("X-Trace-Id", traceId);

        try {
            chain.doFilter(request, response);
        } finally {
            UserContext.clear();
            MDC.clear();
        }
    }
}
```

`finally` 里必须清理。Tomcat 的请求线程也是复用的，不清理就会把上一个请求的用户带到下一个请求里，这种串号在生产上非常难复现。

### 3.6 核心配置：线程池 + 上下文装饰器

这是整篇文章最值钱的一段代码。它做了四件事：把池子命名成 Spring 认识的名字、设一个会真正扩容的有界队列、挂上上下文装饰器、配置优雅停机。

```java
package com.example.asyncdemo.config;

import com.example.asyncdemo.context.UserContext;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.TaskDecorator;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@Configuration(proxyBeanMethods = false)
public class AsyncConfig {

    private static final Logger log = LoggerFactory.getLogger(AsyncConfig.class);

    @Bean("applicationTaskExecutor")
    public ThreadPoolTaskExecutor applicationTaskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(32);
        executor.setQueueCapacity(200);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("biz-async-");
        executor.setTaskDecorator(new ContextCopyingTaskDecorator());
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        executor.initialize();
        return executor;
    }

    @Bean
    public AsyncConfigurer asyncConfigurer(ThreadPoolTaskExecutor applicationTaskExecutor) {
        return new AsyncConfigurer() {
            @Override
            public Executor getAsyncExecutor() {
                return applicationTaskExecutor;
            }

            @Override
            public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
                return (ex, method, params) ->
                        log.error("异步任务执行失败 method={} params={}", method, params, ex);
            }
        };
    }

    static class ContextCopyingTaskDecorator implements TaskDecorator {

        @Override
        public Runnable decorate(Runnable runnable) {
            String user = UserContext.get();
            Map<String, String> mdc = MDC.getCopyOfContextMap();

            return () -> {
                String previousUser = UserContext.get();
                Map<String, String> previousMdc = MDC.getCopyOfContextMap();
                try {
                    if (user != null) {
                        UserContext.set(user);
                    }
                    if (mdc != null) {
                        MDC.setContextMap(mdc);
                    }
                    runnable.run();
                } finally {
                    if (previousUser != null) {
                        UserContext.set(previousUser);
                    } else {
                        UserContext.clear();
                    }
                    if (previousMdc != null) {
                        MDC.setContextMap(previousMdc);
                    } else {
                        MDC.clear();
                    }
                }
            };
        }
    }
}
```

几个关键决定说一下。

Bean 名字必须叫 `applicationTaskExecutor`。Spring MVC 的异步请求处理、GraphQL 的异步返回值、JPA 的 bootstrap 线程都按这个名字找池子。名字对不上，启动时可能直接报找不到 Bean。

`decorate()` 在**提交任务的那个线程**里执行，所以能读到调用方的 `UserContext` 和 MDC。真正干活的是返回的那个 lambda，它跑在池线程里。进去先备份池线程原有的值，再覆盖，最后在 `finally` 里还原——这样同一个池线程连续跑两个任务也不会串。

`CallerRunsPolicy` 的意思是队列满了就由提交线程自己跑。看着像降级，其实是保护：压测时接口会变慢，但不会有任务被悄悄扔掉。换成 `DiscardPolicy` 你会发现"少量订单没写审计日志"，而且查不出来。

`setWaitForTasksToCompleteOnShutdown(true)` 加 `awaitTerminationSeconds(30)` 是给发版准备的。没有这两行，容器关闭时线程池直接 `shutdownNow`，队列里剩下的任务全部蒸发。

这里的 `AsyncConfigurer` 其实只为了接管异常处理器。池子既然叫 `applicationTaskExecutor`，Boot 内置的逻辑本来就会把它交给 `@Async` 用。

### 3.7 异步服务：三种返回值和上下文读取

```java
package com.example.asyncdemo.service;

import com.example.asyncdemo.context.UserContext;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);

    @Async
    public void writeAuditLog(String orderNo) {
        log.info("写审计日志 orderNo={} user={} thread={}",
                orderNo, UserContext.get(), Thread.currentThread().getName());
    }

    @Async
    public CompletableFuture<String> readUserInAsync() {
        String user = UserContext.get();
        log.info("异步线程里读用户 user={} thread={}", user, Thread.currentThread().getName());
        return CompletableFuture.completedFuture(String.valueOf(user));
    }

    @Async
    public CompletableFuture<String> slowQuery(String sku) {
        try {
            Thread.sleep(500);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return CompletableFuture.failedFuture(ex);
        }
        log.info("慢查询完成 sku={} user={} thread={}", sku, UserContext.get(), Thread.currentThread().getName());
        return CompletableFuture.completedFuture("stock-of-" + sku);
    }
}
```

`CompletableFuture` 的返回值要用 `completedFuture` 包一层。异步方法体是在别的线程里算的，Spring 需要一个 Future 句柄来接结果，返回裸值它接不住。方法体里写的 `completedFuture` 只负责把值递出去，调用方拿到的是代理生成的另一个 Future。

### 3.8 订单服务：故意写一个自调用

```java
package com.example.asyncdemo.service;

import com.example.asyncdemo.context.UserContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final AuditService auditService;

    public OrderService(AuditService auditService) {
        this.auditService = auditService;
    }

    public String createOrderBySelfCall(String orderNo) {
        String callerThread = Thread.currentThread().getName();
        writeAuditLog(orderNo);
        return callerThread;
    }

    public String createOrderByProxy(String orderNo) {
        String callerThread = Thread.currentThread().getName();
        auditService.writeAuditLog(orderNo);
        return callerThread;
    }

    @Async
    public void writeAuditLog(String orderNo) {
        log.info("这里本该异步 orderNo={} user={} thread={}",
                orderNo, UserContext.get(), Thread.currentThread().getName());
    }
}
```

`createOrderBySelfCall` 里的 `writeAuditLog(orderNo)` 等价于 `this.writeAuditLog(orderNo)`，绕开代理，日志里的线程名会和调用方一模一样。`createOrderByProxy` 走的是注入进来的 `auditService` 代理，线程名会变成 `biz-async-1`。

### 3.9 接口层：把结果摆到台面上

```java
package com.example.asyncdemo.web;

import com.example.asyncdemo.context.UserContext;
import com.example.asyncdemo.service.AuditService;
import com.example.asyncdemo.service.OrderService;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;
    private final AuditService auditService;
    private final ThreadPoolTaskExecutor applicationTaskExecutor;

    public OrderController(OrderService orderService,
                           AuditService auditService,
                           ThreadPoolTaskExecutor applicationTaskExecutor) {
        this.orderService = orderService;
        this.auditService = auditService;
        this.applicationTaskExecutor = applicationTaskExecutor;
    }

    @GetMapping("/self-call")
    public Map<String, Object> selfCall(@RequestParam String orderNo) {
        String callerThread = orderService.createOrderBySelfCall(orderNo);
        return Map.<String, Object>of("callerThread", callerThread,
                "tip", "看日志：审计那行的线程名和这里一样，说明没异步");
    }

    @GetMapping("/proxy")
    public Map<String, Object> proxy(@RequestParam String orderNo) {
        String callerThread = orderService.createOrderByProxy(orderNo);
        return Map.<String, Object>of("callerThread", callerThread,
                "tip", "审计那行应该变成 biz-async-1 这种线程名");
    }

    @GetMapping("/context")
    public Map<String, Object> context() throws Exception {
        CompletableFuture<String> future = auditService.readUserInAsync();
        String asyncUser = future.get(3, TimeUnit.SECONDS);
        return Map.<String, Object>of("callerUser", String.valueOf(UserContext.get()),
                "asyncUser", asyncUser);
    }

    @GetMapping("/parallel")
    public Map<String, Object> parallel(@RequestParam(defaultValue = "sku-1") String sku) throws Exception {
        long start = System.currentTimeMillis();
        CompletableFuture<String> first = auditService.slowQuery(sku);
        CompletableFuture<String> second = auditService.slowQuery(sku);
        CompletableFuture.allOf(first, second).get(5, TimeUnit.SECONDS);
        long cost = System.currentTimeMillis() - start;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("first", first.join());
        result.put("second", second.join());
        result.put("costMillis", cost);
        return result;
    }

    @GetMapping("/pool")
    public Map<String, Object> pool() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("corePoolSize", applicationTaskExecutor.getCorePoolSize());
        result.put("maxPoolSize", applicationTaskExecutor.getMaxPoolSize());
        result.put("poolSize", applicationTaskExecutor.getPoolSize());
        result.put("activeCount", applicationTaskExecutor.getActiveCount());
        result.put("queueSize", applicationTaskExecutor.getQueueSize());
        result.put("queueRemaining", applicationTaskExecutor.getThreadPoolExecutor().getQueue().remainingCapacity());
        return result;
    }
}
```

### 3.10 配置文件

```yaml
server:
  port: 8080

spring:
  application:
    name: async-demo

logging:
  pattern:
    console: "%d{HH:mm:ss.SSS} %-5level [%thread] %logger{36} traceId=%X{traceId} user=%X{userId} - %msg%n"
```

### 3.11 跑起来验证

启动后依次执行四条命令：

```bash
curl -s -H "X-User-Id: 10086" "http://localhost:8080/orders/self-call?orderNo=A001"
curl -s -H "X-User-Id: 10086" "http://localhost:8080/orders/proxy?orderNo=A002"
curl -s -H "X-User-Id: 10086" "http://localhost:8080/orders/context"
curl -s -H "X-User-Id: 10086" "http://localhost:8080/orders/parallel?sku=sku-9"
```

第一条的日志里，`这里本该异步` 那行的线程名是 `http-nio-8080-exec-1`，和 `callerThread` 一致，说明同步执行了。第二条会变成 `biz-async-1`，`user=10086` 也在——装饰器把上下文带过去了。第三条返回的 `callerUser` 和 `asyncUser` 都是 10086。第四条 `costMillis` 只有 500 出头，两个 500 毫秒的查询并行跑完了。

如果想看队列的真实情况，压测时多刷几次 `/orders/pool`：`queueSize` 超过 200 之后 `poolSize` 才会往上涨，最多到 32。

## 四、踩坑经验：这 6 个地方最容易被忽略

**第一坑：同类自调用。** 上面已经演示过。修复方式有三种：把异步方法拆到另一个 Bean；注入自己（`ObjectProvider<OrderService>` 绕开循环依赖）；用 `AopContext.currentProxy()` 配合 `@EnableAspectJAutoProxy(exposeProxy = true)`。我推荐拆 Bean，前两种都是给架构埋债。

**第二坑：返回类型不是 void 或 Future。** 方法声明 `String`，`@Async` 照样把任务提交出去，但拦截器只处理 `void` 和 `Future` 两种返回，其余情况直接返回 null。编译通过，测试也能过，线上就是拿不到结果。

**第三坑：void 方法吞掉异常。** 异步方法抛异常，调用方永远收不到。默认的异常处理器只是打一条日志，事务也不会回滚。要么在方法体里自己 try-catch，要么像 demo 那样注册 `AsyncUncaughtExceptionHandler` 并接进告警。

**第四坑：@Async 加 @Transactional 顺序搞错。** 异步方法跑在新线程里，外层事务的 ThreadLocal 根本传不过去，它开的是自己独立的事务。更麻烦的是外层事务还没提交，异步任务就去查刚插入的数据，查不到。正确做法是用 `TransactionSynchronizationManager` 注册 `afterCommit` 回调，事务提交后再提交异步任务。

**第五坑：随手定义了一个 Executor Bean。** Boot 的自动配置带 `@ConditionalOnMissingBean(Executor.class)`，你只要往容器里扔任何一个 `Executor`，它整套 `applicationTaskExecutor` 就不创建了。结果 `@Async` 用的是你那个不知道什么参数的小池子，MVC 异步还找不到 Bean。要么把池子命名成 `applicationTaskExecutor`，要么设置 `spring.task.execution.mode=force` 强制自动配置照常生效。

**第六坑：装饰器只拷不还。** `TaskDecorator` 里进去设了值，`finally` 忘了恢复。池线程被下一个任务复用时，用户 ID 还是上一个人的。这种 bug 在日志里表现为"张三的操作记到了李四头上"，靠 code review 很难看出来，必须靠代码结构强制保证。

## 五、性能对比：线程池、虚拟线程怎么选

三种执行器各有各的适用面，选错了不是慢一点的问题，是会炸。

| 方案 | 线程模型 | 适合场景 | 主要风险 |
| --- | --- | --- | --- |
| SimpleAsyncTaskExecutor | 每任务新建平台线程 | 几乎不用 | 无上限，流量一大线程数失控 |
| ThreadPoolTaskExecutor | 固定核心 + 有界队列 | 通用，需要限流的场景 | 队列参数配错，扩不了容 |
| 虚拟线程执行器 | 每任务一个虚拟线程 | 阻塞 IO 多、并发高的场景 | 池参数失效，限流要靠别的组件 |

虚拟线程这块要单独说一句。打开 `spring.threads.virtual.enabled=true` 之后，Boot 自动配置的 `applicationTaskExecutor` 会变成 `SimpleAsyncTaskExecutor`，每个任务一个虚拟线程，`core-size`、`max-size`、`queue-capacity` 这些参数全部失效——文档里写得很清楚，池化参数会被忽略。

虚拟线程适合"线程大部分时间在等"的场景：等数据库、等 HTTP、等文件。一个请求里串行调五个下游服务，用虚拟线程能省掉大量线程栈内存。但它是无限流能力的，数据库连接池只有 20 个连接，你开一万个虚拟线程去抢，最后卡在连接池上，还可能把数据库打死。限流得靠 `Semaphore` 或者连接池本身。

CPU 密集的任务别用虚拟线程。算力就那么多核，线程再多也是排队，反而多了调度开销。这种场景固定大小的小池子最稳，`corePoolSize` 设成核数左右。

我自己的默认选择：新项目 JDK 21 以上、IO 等待占大头，开虚拟线程，配一个有界 `Semaphore` 兜底；老项目不动，把 `ThreadPoolTaskExecutor` 的队列改成有界、拒绝策略改成 `CallerRunsPolicy`，收益已经很大。

## 六、总结

`@Async` 的坑集中在三个地方，记住这三句就够用。

代理决定它生不生效。同类 `this` 调用、私有方法、final 方法都绕不过去，跨 Bean 调用才是正道。

线程决定上下文在不在。ThreadLocal 不跨线程，`TaskDecorator` 在提交那一刻抄一份带过去，用完必须还原。

参数决定它扛不扛得住。无界队列让 `maxPoolSize` 形同虚设，有界队列加 `CallerRunsPolicy` 才是能上生产的组合。

下次再遇到"方法标了异步但没异步"，别急着怀疑 Spring，先看线程名。线程名不会骗人。

## 参考资料

- [Task Execution and Scheduling](https://docs.spring.io/spring-boot/4.1/reference/features/task-execution-and-scheduling.html)
- [Annotation Interface Async](https://docs.spring.io/spring-framework/docs/7.0.x/javadoc-api/org/springframework/scheduling/annotation/Async.html)
- [Interface TaskDecorator](https://docs.spring.io/spring-framework/docs/7.0.x/javadoc-api/org/springframework/core/task/TaskDecorator.html)
- [Interface AsyncConfigurer](https://docs.spring.io/spring-framework/docs/7.0.x/javadoc-api/org/springframework/scheduling/annotation/AsyncConfigurer.html)

文 / 会编程的吕洞宾

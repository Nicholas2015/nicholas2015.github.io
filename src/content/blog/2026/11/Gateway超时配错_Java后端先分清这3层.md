---
title: "Gateway超时配错？Java后端先分清这3层"
date: 2026-11-03T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 摘要：网关配了 5 秒超时，调用方 2 秒就收到兜底，下游却还在跑——Spring Cloud Gateway 的超时从来不是一个值。这篇拆开取连接、建连接、等响应、熔断限时四层计时器，讲清两套单位怎么写、fallback 到底什么时候触发，附一套能直接跑的双服务工程和排查清单。

线上有个订单列表接口，平时 200 毫秒，大促抖到 3 秒。运维把 Spring Cloud Gateway 的 `response-timeout` 从 3 秒调到 10 秒，结果调用方 2 秒就收到了兜底返回，下游日志还在刷 SQL，3 秒后才打印“查询结束”。三个现象凑在一起，看着像灵异事件。

一点都不灵异。网关里同时跑着好几个计时器，各管一段，谁先到点谁先炸。你改的那个值，未必是真正生效的那个。

## 一、这个问题到底是什么：四个计时器各管一段

Spring Cloud Gateway 的超时是四个独立计时器，任何一个到点都会结束这次调用。

| 计时器 | 配置项 | 单位 | 管哪一段 | 不配的后果 |
| --- | --- | --- | --- | --- |
| 取连接 | `httpclient.pool.acquire-timeout` | 毫秒 | 从连接池排队拿一条连接 | 池满时一直等 |
| 建连接 | `httpclient.connect-timeout` | 毫秒（整数） | TCP 握手到连接可用 | 默认 30 秒 |
| 等响应 | `httpclient.response-timeout` | 全局是 `Duration`，单路由是毫秒 | 请求发出到响应回来 | 一直等，等到天荒地老 |
| 熔断限时 | Resilience4j `TimeLimiter` | 毫秒 | 整条调用链最多允许多久 | 默认 1 秒 |

四个值不是取最大值，也不是取最小值，而是各自独立计时。一次请求的真实耗时上限，大致是取连接 + 建连接 + 等响应。你配了 5 秒响应超时，前面再排 500 毫秒的连接、1 秒的握手，最坏情况 6.5 秒才返回。

这就是第一个认知修正：`response-timeout: 5s` 不等于“这个接口 5 秒必返回”。

第二个认知修正：兜底返回的快慢，由最短的那个计时器决定。上面例子里网关兜底 2 秒返回，是因为熔断器的 `TimeLimiter` 设了 2 秒，跟 `response-timeout` 的 5 秒没关系。

第三个认知修正：网关不等了，不代表下游停了。HTTP/1.1 没有“取消请求”的标准语义，网关只是把自己的响应流关掉，下游的 Tomcat 线程、SQL 该跑多久还跑多久。

三个修正串起来，就是那晚的全部真相：兜底由熔断器触发，所以 2 秒；下游没人管，所以 3 秒；`response-timeout` 改到 10 秒，纯属白改。

## 二、底层原理：超时到底是怎么被判定的

Gateway 跑在 Reactor Netty 上，请求处理是非阻塞的。一个连接进来不占一个线程干等，而是注册回调，数据到了再往下走。

所以这里的“超时”，不是某个线程 `sleep` 到点醒来，而是 Reactor Netty 在连接上挂了定时器，到点用异常把这条响应流终止掉。异常沿着 Reactor 的链路往上冒，冒到谁手里，谁负责收场。

### 取连接和建连接，是两件事

连接池的存在是为了复用 TCP 连接。请求进来先去池子里借一条，池子里没有空闲的、又到了最大连接数，就得排队。排队超过 `acquire-timeout`，抛 `PoolAcquireTimeoutException`。

借到连接之后才谈握手。`connect-timeout` 管的是三次握手到连接可用这段时间，DNS 解析慢、下游机器半死不活，都耗在这。默认 30 秒，对一个 API 网关来说太长了，必须改。

这两段加起来，才是“请求真正发出去”之前的耗时。很多“我明明配了 3 秒，怎么 8 秒才报错”的疑问，答案就在这。

### response-timeout 的判定点，是响应回来，不是业务跑完

`response-timeout` 计的是从请求写出，到收到下游响应（响应头或响应体）的时间。下游业务处理 10 秒、第 11 秒才开始写响应，那这 10 秒全算在里面。

它有两种写法，单位还不一样，这是最容易踩的地方：

- 全局 `spring.cloud.gateway.server.webflux.httpclient.response-timeout`，类型是 `Duration`，写 `5s`、`500ms` 都行。
- 单路由 `metadata.response-timeout`，单位是毫秒，只能写数字，比如 `800`。

单路由的优先级高于全局。但有个坑得提前说：单路由的值如果写成 `5s`，解析会失败，而 Gateway 的处理是**捕获异常、静默回落到全局值**，不报错、不打日志。你以为覆盖了，其实没有。

单路由写负数则是另一层意思：关闭全局超时，这条路由愿意等多久等多久。导出报表、跑批这类接口用得上。

`connect-timeout` 的写法更别扭：全局是 `Integer` 毫秒，写 `1s` 直接启动失败；单路由是 `Integer.parseInt` 硬解析，写 `1s` 会在请求时抛 `NumberFormatException`，然后被熔断器当成一次失败调用，直接走兜底。配错了还能“正常”返回，排查起来很折磨人。

### 熔断器在链路里的位置，决定了 fallback 什么时候触发

路由上挂了 `CircuitBreaker` 过滤器之后，过滤器链变成了这样：

```text
客户端 → CircuitBreaker 过滤器 → 转发过滤器（NettyRoutingFilter）→ 下游
                ↑______ 异常往回冒，进 fallback ______|
```

`CircuitBreaker` 用 Resilience4j 的 `TimeLimiter` 给整段调用套了个闹钟。闹钟一响，抛 `TimeoutException`，fallback 接管。

关键在于：fallback 不是只接“熔断打开”这一种情况，它是**任何异常都接**。建连失败、读超时、连接池借不到、下游 500 被 `statusCodes` 标记成失败，统统进 fallback。

响应超时在转发过滤器里会被包装成状态码 504 的 `ResponseStatusException`。没挂熔断器的路由，调用方看到的就是 504；挂了的，它只是触发兜底的众多异常之一。

于是就有了一个反直觉的结论：`TimeLimiter` 比 `response-timeout` 长，fallback 照样会触发，只是触发它的是读超时异常，不是熔断器的闹钟。两种路径的表现都是“返回兜底 JSON”，但耗时不同、熔断器记的账也不同。

想让降级逻辑只有一条路径、统计口径干净，就让 `TimeLimiter` 略小于 `response-timeout`。闹钟先响，读超时根本没机会发生。

### 超时之后，下游为什么还在跑

网关和下游是两条独立的连接。网关这端把响应流 `cancel` 掉，Reactor Netty 会关闭或归还连接，但已经写进下游 socket 的请求不会撤回，下游的线程池、数据库连接、事务都还在。

结果就是：用户看到兜底，数据库还在执行一条大 SQL，连接被占着，严重时把下游拖死。

所以网关超时只是“止损”，不是“停止”。真要停，得在下游自己设超时：JDBC 的 `socketTimeout`、`queryTimeout`、HTTP 客户端的读超时，一个都不能少。

## 三、实战：手把手搭一套网关超时工程

准备两个服务：下游订单服务跑 8081，网关跑 8080。目录结构：

```text
gateway-timeout-demo/
├── order-service/
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/example/order/
│       │   ├── OrderApplication.java
│       │   └── OrderController.java
│       └── resources/application.yml
└── gateway-demo/
    ├── pom.xml
    └── src/main/
        ├── java/com/example/gateway/
        │   ├── GatewayApplication.java
        │   ├── FallbackController.java
        │   └── TimeoutConfig.java
        └── resources/application.yml
```

### 3.1 下游订单服务

先看 `order-service/pom.xml`。父工程用官方的 starter parent，语言级别 21，只依赖 Web：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.9</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>order-service</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.0.9</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.0.9</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.9</version>
            </plugin>
        </plugins>
    </build>
</project>
```

`order-service/src/main/resources/application.yml`，只改端口和名字：

```yaml
server:
  port: 8081

spring:
  application:
    name: order-service
```

启动类：

```java
package com.example.order;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}
```

控制器里放两个接口。`/slow` 故意睡一段时间，用来模拟慢查询；`/ok` 是正常接口，用来验证链路没断。日志打两行，是为了证明网关超时之后下游还在干活：

```java
package com.example.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class OrderController {

    private static final Logger log = LoggerFactory.getLogger(OrderController.class);

    @GetMapping("/slow")
    public Map<String, Object> slow(@RequestParam(defaultValue = "3000") long ms) throws InterruptedException {
        log.info("订单查询开始，预计耗时 {} ms", ms);
        Thread.sleep(ms);
        log.info("订单查询结束，实际耗时 {} ms", ms);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", 0);
        body.put("data", "订单列表");
        body.put("cost", ms);
        return body;
    }

    @GetMapping("/ok")
    public Map<String, Object> ok() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", 0);
        body.put("data", "订单列表");
        return body;
    }
}
```

### 3.2 网关

`gateway-demo/pom.xml`。网关 starter 用的是新的 `spring-cloud-starter-gateway-server-webflux`，老的 `spring-cloud-starter-gateway` 已经不在同一条线上了，别混着引。熔断器用 Reactive 版的 Resilience4j：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.9</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>gateway-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2025.1.4</spring-cloud.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-gateway-server-webflux</artifactId>
            <version>5.0.4</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-circuitbreaker-reactor-resilience4j</artifactId>
            <version>5.0.3</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.0.9</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.0.9</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>${spring-cloud.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.9</version>
            </plugin>
        </plugins>
    </build>
</project>
```

启动类：

```java
package com.example.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
```

兜底接口。它就是个普通的 `@RestController`，`forward:` 会把请求转到网关本机的 DispatcherHandler，不走下游：

```java
package com.example.gateway;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class FallbackController {

    @GetMapping("/fallback/order")
    public Mono<ResponseEntity<Map<String, Object>>> orderFallback(ServerWebExchange exchange) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", 503);
        body.put("message", "订单服务暂时不可用，请稍后再试");
        body.put("path", exchange.getRequest().getURI().getPath());
        body.put("time", Instant.now().toString());

        return Mono.just(ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(body));
    }
}
```

熔断器的默认限时是 1 秒，太激进，改成 2 秒。`configureDefault` 对所有熔断器生效；只想改某一个，用 `factory.configure(builder -> ..., "orderCircuitBreaker")`：

```java
package com.example.gateway;

import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.github.resilience4j.timelimiter.TimeLimiterConfig;
import org.springframework.cloud.circuitbreaker.resilience4j.ReactiveResilience4JCircuitBreakerFactory;
import org.springframework.cloud.circuitbreaker.resilience4j.Resilience4JConfigBuilder;
import org.springframework.cloud.client.circuitbreaker.Customizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class TimeoutConfig {

    @Bean
    public Customizer<ReactiveResilience4JCircuitBreakerFactory> circuitBreakerCustomizer() {
        return factory -> factory.configureDefault(id -> new Resilience4JConfigBuilder(id)
                .circuitBreakerConfig(CircuitBreakerConfig.custom()
                        .slidingWindowSize(20)
                        .failureRateThreshold(50)
                        .waitDurationInOpenState(Duration.ofSeconds(10))
                        .build())
                .timeLimiterConfig(TimeLimiterConfig.custom()
                        .timeoutDuration(Duration.ofMillis(2000))
                        .build())
                .build());
    }
}
```

核心配置在这里。全局四个值，两条路由做对比：

```yaml
server:
  port: 8080

spring:
  application:
    name: gateway-demo
  cloud:
    gateway:
      server:
        webflux:
          httpclient:
            connect-timeout: 1000
            response-timeout: 5s
            pool:
              type: fixed
              max-connections: 200
              acquire-timeout: 500
          routes:
            - id: order-service
              uri: http://127.0.0.1:8081
              predicates:
                - Path=/order/**
              filters:
                - StripPrefix=1
                - name: CircuitBreaker
                  args:
                    name: orderCircuitBreaker
                    fallbackUri: forward:/fallback/order
            - id: order-service-fast
              uri: http://127.0.0.1:8081
              predicates:
                - Path=/fast/**
              filters:
                - StripPrefix=1
                - name: CircuitBreaker
                  args:
                    name: fastCircuitBreaker
                    fallbackUri: forward:/fallback/order
              metadata:
                connect-timeout: 300
                response-timeout: 800

management:
  endpoints:
    web:
      exposure:
        include: health,gateway
```

两条路由的差别只在 `metadata`：`/fast/**` 把建连压到 300 毫秒、响应压到 800 毫秒。`StripPrefix=1` 把 `/order` 和 `/fast` 前缀去掉，下游收到的还是 `/slow`。

### 3.3 跑起来看结果

两个终端分别启动：

```bash
cd order-service && mvn spring-boot:run
cd gateway-demo && mvn spring-boot:run
```

先打正常接口，确认路由通：

```bash
curl -i http://localhost:8080/order/ok
```

返回 `200`，`code` 是 0。

再打慢接口，这是全局超时那条路：

```bash
curl -i "http://localhost:8080/order/slow?ms=3000"
```

大约 2 秒后返回 `503`，body 是兜底 JSON。下游日志这时还没打印“查询结束”，再等 1 秒，它才慢悠悠地出来。

最后打 `/fast` 那条：

```bash
curl -i "http://localhost:8080/fast/slow?ms=3000"
```

大约 0.8 秒返回同样的兜底 JSON。下游照样跑满 3 秒。

| 请求 | 返回耗时 | 谁先到点 | 下游是否继续 |
| --- | --- | --- | --- |
| `/order/ok` | 几十毫秒 | 无 | 正常结束 |
| `/order/slow?ms=3000` | 约 2 秒 | TimeLimiter 2000ms | 是，3 秒结束 |
| `/fast/slow?ms=3000` | 约 0.8 秒 | 单路由 response-timeout 800ms | 是，3 秒结束 |

现在把 `/fast` 的 `response-timeout` 改成 `5s`，重启网关再请求。不会报错，仍是 2 秒兜底——单路由解析失败，静默用了全局值。这个坑，光看配置文件和启动日志永远发现不了。

## 四、踩坑经验和最佳实践

**单位写错，全局和单路由各一套。** 全局 `response-timeout` 是 `Duration`，`5s` 合法；全局 `connect-timeout` 是整数毫秒，写 `1s` 启动直接挂。单路由两个都是毫秒数字。我的做法是全局只用 `5s` 这种带单位的写法，单路由一律纯数字，并且在上线前用 actuator 的 `/actuator/gateway/routes` 对一遍。

**单路由写错不报错，最坑。** `5s` 解析异常被捕获后回落到全局，行为“看起来正常”，但你的覆盖失效了。排查时别猜，直接看路由定义有没有生效，或者在 `NettyRoutingFilter` 上打个断点看最终 `Duration`。

**`connect-timeout` 写错会伪装成业务故障。** `1s` 解析异常发生在上游调用链里，被熔断器接住，用户看到的是兜底，熔断器记的是失败。连续几次之后熔断打开，整个路由都不可用，你会以为是下游挂了。

**熔断限时要小于响应超时。** 默认 1 秒太短，正常业务都可能被砍；设成比 `response-timeout` 大，则读超时先发生，兜底虽然还能走，但熔断统计里混进了超时异常，降级原因就说不清了。

**超时不会停下游。** 网关侧超时只是不再等。数据库那条 SQL 该跑还跑，事务该占锁还占锁。下游必须自己设 `socketTimeout`、`queryTimeout`，慢 SQL 该杀就杀。指望网关兜底来解决数据库压力，方向就错了。

**重试会把超时放大。** 网关加了 `Retry` 过滤器，3 次重试乘 5 秒，最坏 15 秒，而客户端可能 3 秒就断了。重试只适合幂等接口，且总时长要算进 SLA。

**兜底接口别走网关路由。** `fallbackUri` 用的是 `forward:`，只取路径、不带原查询串，转发到本机控制器最稳。如果兜底地址又匹配了某条路由，容易绕回来打成死循环。

**连接池要有上限。** 默认 elastic、不限最大连接数，下游一慢，连接越建越多，最后把自己和下游一起拖垮。固定池 + `acquire-timeout`，让排队有明确上限。

## 五、性能对比和技术选型

不同配法的代价不一样，按场景选：

| 配法 | 优点 | 代价 | 适用 |
| --- | --- | --- | --- |
| 只配全局 `response-timeout` | 一行配置，立刻止损 | 一刀切，长任务被砍；无兜底 | 内部简单网关、快速上线 |
| 全局 + 单路由覆盖 | 默认严格，个别放宽 | 两套单位，易写错 | 大多数生产网关，推荐 |
| 再加 `CircuitBreaker` | 有兜底、有熔断、有统计 | 多一层调度，语义变复杂 | 核心链路、需要降级 |
| 完全不设，靠下游超时 | 网关简单 | 慢请求占满连接，雪崩 | 不推荐 |

给一组能直接用的数值：连接池 `acquire-timeout` 200ms，`connect-timeout` 500ms，`response-timeout` 3s，`TimeLimiter` 2500ms。最坏情况下客户端 3.7 秒左右拿到结果，其中 0.7 秒花在拿连接和建连上。

这个组合的逻辑是：建连必须快，慢的下游直接判死；响应超时给正常业务留足余量；熔断限时略短于响应超时，让兜底走一条路径。三层都设，且满足 `acquire < connect < response`，比单独调大某一个值有用得多。

如果下游本身就有明确的 SLA，比如支付 2 秒、查询 1 秒，那就按路由分别覆盖，不要指望一个全局值包打天下。

## 六、总结

Gateway 的超时不是一个数字，是四个计时器：取连接、建连接、等响应、熔断限时。

记住四句话就够了：

- 真实耗时上限约等于取连接 + 建连接 + 等响应，不是单个配置值。
- 全局和单路由两套单位，单路由只认毫秒，写错静默回落。
- fallback 由熔断器触发，兜底快慢取决于最短的计时器。
- 网关超时不等于下游停止，下游必须有自己的超时。

下次再遇到“配了 5 秒怎么 2 秒就返回”，别急着改 `response-timeout`。先看熔断器的 `TimeLimiter`，再看单路由的 `metadata`，最后看下游日志有没有跑完。三分钟能定位的事，别排查一晚上。

文 / 会编程的吕洞宾

## 参考资料

- [Http timeouts configuration](https://docs.spring.io/spring-cloud-gateway/reference/5.0/spring-cloud-gateway-server-webflux/http-timeouts-configuration.html)
- [Spring Cloud Gateway Configuration Properties](https://docs.spring.io/spring-cloud-gateway/reference/5.0/spring-cloud-gateway-server-webflux/configuration-properties.html)
- [CircuitBreaker GatewayFilter Factory](https://docs.spring.io/spring-cloud-gateway/reference/5.0/spring-cloud-gateway-server-webflux/gatewayfilter-factories/circuitbreaker-filter-factory.html)
- [Resilience4j TimeLimiter](https://resilience4j.readme.io/docs/timeout)

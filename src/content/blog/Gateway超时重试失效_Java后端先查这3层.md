---
title: "Gateway超时重试失效？Java后端先查这3层"
date: 2026-10-25T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 线上常出现这种怪事：网关明明配了 4 秒超时，接口却转了 12 秒才返回 504；把重试打开想提高成功率，结果支付接口扣了两次款。超时和重试不是填两个数字就完事，它们分成好几层，配错一层，现象就完全变样。排查时只盯一个参数，很容易被表象带偏。这篇用一个能跑起来的网关加订单服务，把三层超时的分工、默认值和踩坑点一次讲清。

## 一、这个问题到底是什么

网关超时配置失效，本质不是配置没生效，是三个不同的超时在互相打架。

很多团队排查时只看一个地方：路由上写的 `response-timeout`。看到 4000 毫秒，就默认任何请求最多 4 秒结束。实际跑起来却发现：

- 下游服务睡 6 秒，客户端等了 12 秒才拿到 504
- 下游明明 1 秒就返回了 500，网关却重试到第三次才把错误抛出来
- 开了重试，GET 接口成功率上去了，POST 接口开始出现重复数据
- 日志里下游显示处理成功，客户端却收到 504

这些现象都指向同一个事实：请求从浏览器到数据库，中间有好几段路，每段都有自己的计时器。网关这一层至少有三个开关：

1. 连接超时（`connect-timeout`）：TCP 握手多久算失败
2. 响应超时（`response-timeout`）：请求发出去后，多久没收到响应算失败
3. 重试次数（`retries`）：失败之后再来几次

这三个参数不是并列关系，是相乘关系。超时管单次，重试管次数，最终用户等待时间约等于「单次超时 × (重试次数 + 1)」。只改其中一个，另外两个会立刻把效果抵消掉。

还有一个容易被忽略的角色：下游服务自己的超时。网关设 4 秒，下游的 Feign 设 5 秒，结果就是网关先放弃，下游还在兢兢业业跑。用户看到 504，数据库里却多了一条记录。

这篇不讲概念堆砌，直接建两个 Spring Boot 服务：一个网关、一个订单服务，把每个参数的效果跑出来给你看。

## 二、底层原理到底怎么回事

### 2.1 一次请求要过三道计时器

浏览器把请求发给网关，网关再用 Netty HttpClient 转发给订单服务。链路是这样的：

```
浏览器 → 网关(9000) → Netty HttpClient → 订单服务(8081) → 数据库
```

网关能控制的只有中间两段：

- **建连阶段**：网关和订单服务之间要建立 TCP 连接。`connect-timeout` 只管这一段，连上了就不管了。
- **等待响应阶段**：请求写出去之后，网关开始等订单服务返回。`response-timeout` 管这一段，从请求发出算到收到响应。
- **失败重试阶段**：上面任一步失败，Retry 过滤器决定要不要再来一次。

把 `connect-timeout` 当成接口超时，是最常见的误用。它管的是 TCP 握手，默认 30 秒，跟业务处理快慢没有半点关系。下游服务卡在数据库查询上 30 秒，连接早就建好了，`connect-timeout` 根本不会触发，最终仍然是 `response-timeout` 兜底。

### 2.2 全局超时和路由超时的写法不一样

全局超时写在 `spring.cloud.gateway.server.webflux.httpclient` 下面，响应超时用 `Duration` 类型：

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          httpclient:
            connect-timeout: 1000
            response-timeout: 5s
```

路由级超时写在路由的 `metadata` 里，单位是毫秒整数：

```yaml
metadata:
  connect-timeout: 1000
  response-timeout: 4000
```

两个地方格式不同，这是官方文档明确规定的。全局用 `Duration` 写法，`5s` 就是 5 秒，只写 `5` 会被当成 5 毫秒；路由 `metadata` 只认毫秒整数，照着全局写 `5s` 会在请求时解析失败。抄配置的时候，单位必须跟着位置走。

路由级配置优先于全局配置。如果某条路由的 `response-timeout` 写成负数，等于告诉网关「这条路由不要全局超时」，适合文件下载、报表导出这种本来就很慢的接口。这个负数不是关闭超时，是关闭「继承全局值」，别拿它当万能开关。

### 2.3 Retry 过滤器到底重试什么

Retry 的默认值，官方文档和源码写得很清楚：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| retries | 3 | 失败后最多再试 3 次 |
| series | 5XX | 只重试 5xx 状态码 |
| methods | GET | 只重试 GET 请求 |
| exceptions | IOException、TimeoutException | IO 异常和响应超时 |
| backoff | 关闭 | 两次重试之间不等待 |

重点在 `methods: GET`。这个默认值救了很多人的命：POST 天然不重试，避免重复下单、重复扣款。只要你不动它，写操作是安全的。

响应超时会不会触发重试？会。网关的响应超时最终被包装成 504，但异常的 cause 是 `TimeoutException`，Retry 判断可重试异常时会检查直接 cause，所以 GET 请求超时后确实会重发。

这就解释了两个现象：

- 4 秒超时 + 2 次重试，最坏等待不是 4 秒，而是约 12 秒
- 用户端如果设了 5 秒超时，他早跑了，网关还在后台认真重试第三次

### 2.4 为什么超时返回的是 504

网关等不到响应，抛的是 `ResponseStatusException`，状态码 `GATEWAY_TIMEOUT`。所以 504 的含义很明确：**网关没等到下游**。它不代表下游一定失败，只代表网关放弃了等待。

如果下游自己抛异常，返回的是 500。500 是「下游明确告诉你出错了」，504 是「下游什么都没说」。排查方向完全不同：看到 504 先查下游耗时和网关超时，看到 500 直接去看下游日志。

## 三、实战：手把手写代码

这两个服务都能独立启动。目录结构：

```
gateway-demo/
  pom.xml
  src/main/java/com/example/gateway/GatewayApplication.java
  src/main/java/com/example/gateway/filter/ResponseTimeFilter.java
  src/main/resources/application.yml
order-service/
  pom.xml
  src/main/java/com/example/order/OrderApplication.java
  src/main/java/com/example/order/OrderController.java
  src/main/resources/application.yml
```

### 3.1 网关的 pom.xml

注意依赖坐标：Spring Cloud Gateway 5.x 这条线里，旧的 `spring-cloud-starter-gateway` 已经取不到了，要用 `spring-cloud-starter-gateway-server-webflux`。从旧教程复制坐标，项目会直接起不来。

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
    <name>gateway-demo</name>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2025.1.4</spring-cloud.version>
    </properties>

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

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-gateway-server-webflux</artifactId>
            <version>5.0.4</version>
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

### 3.2 网关启动类和响应耗时过滤器

启动类就是标准写法：

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

再写一个全局过滤器，把网关实际等待了多久写进响应头。排查 504 时，这个头比日志好用：客户端一眼就能看到「网关到底等了 4 秒还是 12 秒」。

```java
package com.example.gateway.filter;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class ResponseTimeFilter implements GlobalFilter, Ordered {

    private static final String START_TIME = "gateway.startTime";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        exchange.getAttributes().put(START_TIME, System.nanoTime());
        ServerHttpResponse response = exchange.getResponse();
        response.beforeCommit(() -> {
            Long start = exchange.getAttribute(START_TIME);
            if (start != null) {
                long costMs = (System.nanoTime() - start) / 1_000_000;
                response.getHeaders().set("X-Gateway-Cost-Ms", String.valueOf(costMs));
            }
            return Mono.empty();
        });
        return chain.filter(exchange);
    }

    @Override
    public int getOrder() {
        return -1;
    }
}
```

`getOrder()` 返回 `-1`，让它在过滤器链里尽量靠前，计时才准。`beforeCommit` 只在响应真正写回客户端前执行，用它加头不会干扰业务响应体。

### 3.3 网关的 application.yml

这份配置是全文的核心。路由和 HttpClient 超时都挂在 `spring.cloud.gateway.server.webflux` 下面，旧版本用的 `spring.cloud.gateway.routes` 和 `spring.cloud.gateway.httpclient` 都不再生效。

```yaml
server:
  port: 9000

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
          routes:
            - id: order-service
              uri: http://localhost:8081
              predicates:
                - Path=/api/orders/**
              filters:
                - StripPrefix=1
                - name: Retry
                  args:
                    retries: 2
                    methods: GET
                    series: SERVER_ERROR
                    backoff:
                      firstBackoff: 200ms
                      maxBackoff: 1s
                      factor: 2
                      basedOnPreviousValue: false
              metadata:
                connect-timeout: 1000
                response-timeout: 4000

management:
  endpoints:
    web:
      exposure:
        include: health,gateway
```

这条路由的意思是：访问 `/api/orders/**`，去掉第一段路径后转发到 8081。比如 `/api/orders/slow` 会变成 `/orders/slow`。

路由级 `response-timeout: 4000` 覆盖了全局的 5 秒，所以这条路由单次最多等 4 秒。`retries: 2` 表示最多再试 2 次，成功的话总耗时是 12 秒上限。

### 3.4 订单服务的 pom.xml

下游就是一个普通 Web 服务，不需要任何网关依赖：

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
    <name>order-service</name>

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

### 3.5 订单服务的接口

三个接口分别模拟慢查询、偶发失败和「扣款后报错」：

```java
package com.example.order;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final AtomicInteger flakyCounter = new AtomicInteger();
    private final AtomicInteger payCounter = new AtomicInteger();

    @GetMapping("/slow")
    public Map<String, Object> slow(@RequestParam(defaultValue = "3000") long sleep)
            throws InterruptedException {
        Thread.sleep(sleep);
        return Map.of("orderId", "A1001", "slept", sleep);
    }

    @GetMapping("/flaky")
    public ResponseEntity<Map<String, Object>> flaky() {
        int attempt = flakyCounter.incrementAndGet();
        if (attempt % 2 == 1) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("attempt", attempt, "result", "failed"));
        }
        return ResponseEntity.ok(Map.of("attempt", attempt, "result", "ok"));
    }

    @PostMapping("/pay")
    public Map<String, Object> pay() throws InterruptedException {
        int count = payCounter.incrementAndGet();
        Thread.sleep(3000);
        throw new IllegalStateException("扣款后下游报错，count=" + count);
    }
}
```

`/flaky` 第一次调用返回 500，第二次返回 200，专门用来验证重试有没有发生。`/pay` 先累加计数再抛异常，计数就是扣款次数，用来验证 POST 会不会被重试。

这里的 `Thread.sleep` 只是模拟慢查询，真实项目里不要这么写，它会把 Tomcat 线程白白占住。

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

`application.yml` 把错误信息带出来，方便在响应里看到 `count`：

```yaml
server:
  port: 8081
  error:
    include-message: always

spring:
  application:
    name: order-service
```

### 3.6 跑起来，看三个现象

先启动订单服务，再启动网关。然后依次执行：

**现象一：正常请求，响应头有耗时**

```bash
curl -i "http://localhost:9000/api/orders/slow?sleep=1000"
```

返回 200，响应头里能看到 `X-Gateway-Cost-Ms: 1000` 左右。这一步证明路由和过滤器都正常。

**现象二：超时被重试，总耗时翻倍**

```bash
time curl -i "http://localhost:9000/api/orders/slow?sleep=6000"
```

单次超时是 4 秒，重试 2 次，最终大约 12 秒后返回 504。如果你只盯着 `response-timeout: 4000`，会以为 4 秒就该结束，实际用户等了 12 秒。

想验证得更直接，把 `retries` 改成 0，再跑一次，4 秒就返回 504。差别非常明显。

**现象三：GET 自动重试，POST 不重试**

```bash
curl -i "http://localhost:9000/api/orders/flaky"
```

第一次内部返回 500，网关重试后第二次成功，客户端拿到 200，响应体里 `attempt` 是 2。这说明 Retry 对 GET 和 5xx 生效了。

```bash
curl -i -X POST "http://localhost:9000/api/orders/pay"
```

返回 500，响应体里的 `count` 是 1。下游只被调用了一次，因为默认 `methods: GET` 把 POST 挡在重试之外。

现在做一次危险实验：把路由配置里的 `methods: GET` 改成 `methods: GET,POST`，重启网关，再 POST 一次。`count` 会变成 2。

一次用户点击，两次扣款。这就是重试最贵的坑。

## 四、踩坑经验和最佳实践

**坑一：升级后路由全部 404，或者超时完全不生效，配置却没报错**

Spring Cloud Gateway 5.x 把路由和 HttpClient 配置都收进了 `spring.cloud.gateway.server.webflux`。旧配置写在 `spring.cloud.gateway.routes` 或 `spring.cloud.gateway.httpclient` 下，启动不报错，路由就是不生效：访问全是 404，超时也悄悄退回默认值。升级时先搜一遍配置文件里的前缀，别只看依赖版本。

**坑二：starter 坐标没换，项目起不来**

`spring-cloud-starter-gateway` 在 5.x 这条线已经不存在，Maven 直接拉不到包。换成 `spring-cloud-starter-gateway-server-webflux` 才能启动。老项目升级时，pom 和配置文件要一起改。

**坑三：给 POST 开了重试**

重试的前提是幂等：同一个请求执行一次和执行三次，结果一样。GET、HEAD 天然幂等，POST 不是。支付、下单、发券这类接口，一旦进了重试名单，重复数据只是时间问题。

我的建议很直接：网关层只重试 GET。写接口要重试，就在业务层用幂等键，别在网关图省事。

之前见过一个支付项目，网关的 `methods` 被改成了 `GET,POST`，本意是提高成功率。上线后碰到下游偶发 500，同一笔订单被重试两次，用户只点了一次付款，账单出了三条记录。后来靠对账和退款收拾，代价远比重试省下的那点成功率大。

**坑四：下游超时比网关还长**

网关 4 秒放弃，下游 Feign 配了 5 秒，数据库 `socketTimeout` 配了 10 秒。结果就是网关返回 504，下游过一会儿把业务跑完，数据已经改了。

超时要从内到外逐层变短：数据库 < 下游服务 < 网关 < 客户端。任何一层反过来，都会出现「客户端失败、服务端成功」的鬼故事。

**坑五：客户端超时比网关总耗时短**

网关 4 秒 × 3 次 = 12 秒，前端 Axios 超时设了 5 秒。用户在第 5 秒看到失败提示，点了重试，网关那边的第一次请求还在跑。一次点击变成两次业务请求，雪崩就是这么来的。

客户端超时至少要大于「网关单次超时 × (重试次数 + 1)」，或者干脆别让网关重试，把重试交给客户端，配合幂等键。

**几条落地建议：**

- 每条路由单独设 `response-timeout`，核心查询 2 秒，导出接口单独放宽
- 网关的 `retries` 默认 2 次够用，不要为了「提高成功率」调到 5 次
- 监控 504 比例，比监控平均耗时更早发现问题
- 日志里同时记录路由 id、下游耗时、重试次数，否则排查只能靠猜
- 压测时把下游故意调慢，观察 504 和重试次数的关系，比看文档印象深刻

## 五、性能对比和技术选型

网关超时参数没有「最优值」，只有「和下游匹配的值」。可以参考这张表：

| 场景 | connect-timeout | response-timeout | retries |
| --- | --- | --- | --- |
| 普通查询接口 | 500ms | 2s | 1 |
| 聚合接口（调多个下游） | 500ms | 3s | 1 |
| 报表导出 | 1000ms | 60s | 0 |
| 支付/下单（POST） | 1000ms | 5s | 0 |
| 内部低延迟服务 | 200ms | 500ms | 2 |

几个判断原则：

- **重试次数不是越多越好**。每多一次重试，故障时的流量就多一份，下游恢复会更慢。2 次已经能覆盖大部分网络抖动。
- **超时不是越长越安全**。超时设 30 秒，线程和连接被占住 30 秒，并发一高，网关先自己崩。
- **WebFlux 网关适合大多数团队**。非阻塞模型在大量慢请求下内存占用更稳；团队全是 Spring MVC 经验、又不想引入响应式排障成本，可以选 WebMVC 版本的网关，但别两边混着用。
- **重试放在哪一层，要看谁有幂等能力**。网关不知道业务是否幂等，业务层知道。写操作的重试应该离业务最近。

## 六、总结

网关超时配不对，通常不是某一个参数写错，而是三层没有对齐。

记住三句话：

1. `connect-timeout` 只管建连接，不管业务快慢
2. `response-timeout` 管单次等待，重试会把它乘以次数
3. Retry 默认只碰 GET 和 5xx，改 `methods` 之前先想清楚幂等

排查 504 的顺序也很固定：先看响应头里的网关耗时，再看下游日志的时间戳，再对一遍两边配置。三层对齐了，超时和重试才会按你预期的样子工作。

文 / 会编程的吕洞宾

## 参考资料

- [Http timeouts configuration](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/http-timeouts-configuration.html)
- [Retry GatewayFilter Factory](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/gatewayfilter-factories/retry-factory.html)
- [Route Metadata Configuration](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/route-metadata-configuration.html)

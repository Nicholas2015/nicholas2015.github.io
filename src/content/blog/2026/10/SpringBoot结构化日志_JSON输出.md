---
title: "SpringBoot 结构化日志：JSON 输出"
date: 2026-10-02T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> 上周同事排查线上超时，登录服务器 grep 日志，翻了半小时才从几十万行文本里挑出几条线索。后来日志接进 ELK，也没好多少——文本日志在 ES 里就是一整行字符串，想筛「耗时超过 500ms 的接口」只能靠正则，又慢又不准。根子在于：我们打的日志是写给人看的文本，机器读不懂。结构化日志把每条日志变成一行 JSON，字段各归各位，采集端直接按字段建索引、做聚合、发告警。这篇就讲怎么用 Spring Boot 自带的能力把日志变成 JSON，再喂给 ELK。

## 一、这个问题到底是什么

结构化日志就是把一条日志从「一整行文本」改成「一行 JSON」，让机器按字段读取，而不是当字符串硬扫。

先看一条典型的文本日志：

```
2026-10-02 10:15:00.123  INFO 8123 --- [nio-8080-exec-1] c.e.order.OrderService : 订单创建成功 orderId=ORD1001 userId=88 costMs=12
```

这行日志人看着很舒服。丢进 Elasticsearch（下面简称 ES）之后，它整行进了 message 一个字段。现在产品经理要你回答两个问题：

- 今天下单耗时超过 500ms 的有多少笔？
- userId=88 的用户一共下了几单？

在文本日志里，这两个问题都得写正则去抠，或者全文检索。日志量上到千万行，这种查询又慢又容易漏。原因很直接：时间、级别、userId、orderId 这些信息混在一行字符串里，机器根本没「看见」它们，只知道这是一串字符。

改成结构化日志后，同一件事长这样：

```
{"@timestamp":"2026-10-02T10:15:00.123Z","log":{"level":"INFO","logger":"c.e.order.OrderService"},"process":{"pid":8123,"thread":{"name":"nio-8080-exec-1"}},"service":{"name":"order-service"},"message":"订单创建成功","orderId":"ORD1001","userId":"88","costMs":12,"traceId":"a1b2c3d4"}
```

差别在哪：

- 时间、级别、线程、进程、服务名是固定字段，不用解析，采集端开箱就能用。
- orderId、userId、costMs 是结构化字段，ES 可以单独建索引、做范围查询、做聚合。
- traceId 直接把一次请求串起来，跨服务排查不用再拼字符串。

谁该用？判断标准就一条：日志量大、并且已经接了或准备接 ELK / Loki / ClickHouse / Graylog 这类集中式日志系统。如果你的项目总共就一台机器、日志靠 tail -f 看，那现在上结构化日志属于自我感动，先不用。

还有一个概念必须说清楚——MDC。MDC 全称 Mapped Diagnostic Context，可以理解成日志框架给每个线程配的一块「小黑板」。你把 traceId 往上一写，这个线程后面打的每一条日志都会自动带上它，不用你每条都手写。结构化日志会自动把 MDC 里的键值对并进 JSON，这是把 traceId 变成可检索字段最省事的办法。

## 二、底层原理到底怎么回事

Spring Boot 的结构化日志，本质上就是换掉日志框架的「编码器」：原来把日志事件拼成文本，现在拼成 JSON。

一步步拆开看。Java 里打一行日志，走的是这条链：

1. 你在代码里调 log.info(...)，SLF4J 把参数和上下文打包成一个「日志事件」。
2. 日志框架（Spring Boot 默认是 Logback）拿到事件，交给某个 Appender，也就是决定「往哪写」。
3. 写出去之前，Appender 会用一个 Encoder（编码器）把事件渲染成最终形态。传统情况下这个编码器是 PatternLayout，按 pattern 里定义的模板拼成一行文本。
4. 结构化日志做的事，就是把 PatternLayout 换成 StructuredLogEncoder，它输出的不是文本，而是 JSON。

所以并不是引入了另一套日志系统，只是换了个渲染器。Spring Boot 内置了三种 JSON 格式，选哪个取决于你后端用什么采集：

- ECS：Elastic Common Schema，Elastic 公司定义的字段规范，配合 Filebeat / Elastic Agent 进 ES 最顺。
- GELF：Graylog Extended Log Format，Graylog 的原生格式。
- Logstash：Logstash 的事件格式，字段名是 @timestamp、log.level 那一套。

开启方式就两行配置，分别控制「控制台输出」和「文件输出」：

```
logging.structured.format.console=ecs
logging.structured.format.file=ecs
```

只要设了这两个属性，Boot 启动时就会自动把对应 Appender 的编码器换掉，业务代码一行都不用改。

那 JSON 里固定的那些字段从哪来？时间戳、日志级别、logger 名字、线程名、进程 pid，这些日志事件本身就带着，编码器直接读。service.name、service.version 这类则来自 spring.application.name、spring.application.version，也可以单独覆盖。以 ECS 为例：

```
logging.structured.ecs.service.name=MyService
logging.structured.ecs.service.version=1.0.0
logging.structured.ecs.service.environment=prod
```

自定义字段有三条路，从简单到复杂：

- MDC：MDC.put("traceId", id)，之后这个线程的日志都带上，不用改每一条打日志的代码。
- SLF4J 2 的流式 API：log.atInfo().addKeyValue("orderId", id).log("下单成功")。适合只给某一条日志加字段的场景。
- 配置调整：logging.structured.json.include / exclude 过滤字段，rename 改字段名，add 加固定字段。

这里有个容易忽略的点：MDC 是线程绑定的。你用线程池或虚拟线程，线程会被复用，如果日志处理完不清理 MDC，下个请求就可能带上上个请求的 traceId。清理动作必须写在 finally 里，下面的实战代码就是这么做的。

栈追踪也能调。异常日志默认会把完整堆栈塞进 JSON，采集端处理起来很贵。可以用 logging.structured.json.stacktrace.max-length 限长，include-common-frames 关掉那些公共帧，include-hashes 给堆栈算个哈希方便聚合去重。日志平台里同一类异常反复出现时，哈希能把它们归成一类，而不是每次都当新日志。

## 三、实战：手把手写代码

下面搭一个真实场景：商品下单接口，接口日志直接输出 JSON，并且每条日志带 traceId。

### 3.1 最小可跑：把日志变成 JSON

三个文件就能跑起来。

pom.xml，注意 Java 用 21，依赖版本写全，照抄即可：

```
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
    <artifactId>structured-logging-demo</artifactId>
    <version>1.0.0</version>
    <name>structured-logging-demo</name>

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
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.1</version>
            <scope>test</scope>
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

启动类：

```
package com.example.logdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class StructuredLoggingApplication {

    public static void main(String[] args) {
        SpringApplication.run(StructuredLoggingApplication.class, args);
    }
}
```

application.yml，核心就是 logging.structured 这几行：

```
spring:
  application:
    name: structured-logging-demo
  threads:
    virtual:
      enabled: true

logging:
  structured:
    format:
      console: ecs
    ecs:
      service:
        name: structured-logging-demo
        version: 1.0.0
        environment: prod
  level:
    root: INFO
    com.example.logdemo: DEBUG

server:
  port: 8080
```

跑起来：

```
mvn spring-boot:run
```

启动日志会变成一行行 JSON，类似这样：

```
{"@timestamp":"2026-10-02T10:15:00.067Z","log":{"level":"INFO","logger":"org.springframework.boot.web.embedded.tomcat.TomcatWebServer"},"process":{"pid":8123,"thread":{"name":"main"}},"service":{"name":"structured-logging-demo"},"message":"Tomcat started on port 8080 (http)","ecs":{"version":"8.11"}}
```

看到没，pid、线程、服务名都自动带上了，ECS 版本号也在里面。业务代码一个字没改。

### 3.2 加上 traceId 和业务字段

光有固定字段还不够，排查问题靠的是 traceId 和业务参数。下面三个类补齐。

TraceIdFilter，负责给每个请求生成 traceId 并塞进 MDC，注意 finally 里的清理：

```
package com.example.logdemo.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    public static final String TRACE_ID = "traceId";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String traceId = request.getHeader("X-Trace-Id");
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        MDC.put(TRACE_ID, traceId);
        response.setHeader("X-Trace-Id", traceId);
        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.remove(TRACE_ID);
        }
    }
}
```

OrderService，演示流式 API 怎么加业务字段：

```
package com.example.logdemo.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    public Order create(String userId, String skuId, int quantity) {
        long start = System.nanoTime();
        Order order = new Order(
                "ORD" + System.currentTimeMillis(),
                userId,
                skuId,
                quantity,
                new BigDecimal("59.90").multiply(BigDecimal.valueOf(quantity))
        );
        long costMs = (System.nanoTime() - start) / 1_000_000;

        log.atInfo()
           .addKeyValue("orderId", order.orderId())
           .addKeyValue("userId", userId)
           .addKeyValue("skuId", skuId)
           .addKeyValue("amount", order.amount())
           .addKeyValue("costMs", costMs)
           .log("订单创建成功");

        return order;
    }

    public List<Order> query(String userId) {
        log.debug("查询用户订单 userId={}", userId);
        return List.of();
    }

    public record Order(String orderId, String userId, String skuId, int quantity, BigDecimal amount) {
    }
}
```

OrderController：

```
package com.example.logdemo.order;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    public OrderService.Order create(@RequestParam String userId,
                                     @RequestParam String skuId,
                                     @RequestParam(defaultValue = "1") int quantity) {
        return orderService.create(userId, skuId, quantity);
    }

    @GetMapping
    public List<OrderService.Order> list(@RequestParam String userId) {
        return orderService.query(userId);
    }
}
```

把 application.yml 里的日志级别调到 root: INFO、com.example.logdemo: DEBUG 就能看到 debug 行。发一个请求：

```
curl -X POST 'http://localhost:8080/orders?userId=88&skuId=SKU-1&quantity=2'
```

控制台会吐出这样一行，traceId 是过滤器加进去的，orderId、userId、costMs 是流式 API 加的：

```
{"@timestamp":"2026-10-02T10:16:22.301Z","log":{"level":"INFO","logger":"com.example.logdemo.order.OrderService"},"process":{"pid":8123,"thread":{"name":"tomcat-handler-0"}},"service":{"name":"structured-logging-demo"},"message":"订单创建成功","orderId":"ORD1760000182301","userId":"88","skuId":"SKU-1","amount":119.80,"costMs":0,"traceId":"c9f1d2e3a4b5c6d7e8f9012345678abc"}
```

现在在 ES 里按 traceId 一搜，整个请求链路的日志一次捞全；按 costMs > 500 做范围查询，慢请求自动冒出来。这才是日志该有的样子。

### 3.3 自定义字段和自定义 Logback

字段名对不上采集端的规范，或者觉得某些字段没用，用配置直接改。application.yml 追加：

```
logging:
  structured:
    format:
      console: ecs
      file: ecs
    json:
      exclude: log.level
      rename:
        process.id: procid
      add:
        corp: acme
      stacktrace:
        max-length: 2048
        include-common-frames: false
        include-hashes: true
```

这段配置的意思：不输出 log.level，把 process.id 改名成 procid，额外加一个固定字段 corp=acme，堆栈最多 2048 字符、去掉公共帧、带上哈希。file 格式设成 ecs 后，如果配了 logging.file.name，文件里也是 JSON。

如果你已经有一份自定义的 logback-spring.xml，需要手动把编码器换掉。新建 src/main/resources/logback-spring.xml：

```
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="org.springframework.boot.logging.logback.StructuredLogEncoder">
            <format>${CONSOLE_LOG_STRUCTURED_FORMAT}</format>
            <charset>${CONSOLE_LOG_CHARSET}</charset>
        </encoder>
    </appender>

    <root level="INFO">
        <appender-ref ref="CONSOLE"/>
    </root>
</configuration>
```

关键就是 encoder 这行，把默认的 PatternLayoutEncoder 换成 StructuredLogEncoder，format 从 CONSOLE_LOG_STRUCTURED_FORMAT 系统属性读，也就是你在 yml 里配的 ecs。

## 四、踩坑经验和最佳实践

**MDC 不清理，traceId 会串号。** 这是最常见的坑。线程池和虚拟线程都会复用线程，如果不 remove，A 请求的 traceId 会粘到 B 请求的日志上，排查问题时被带进沟里。清理必须放 finally。如果用了 @Async 或自己提交线程池任务，MDC 不会自动传过去，得手动透传或使用支持上下文传播的 TaskDecorator。

**本地开发别强行 JSON。** 一行 JSON 在 IDE 控制台里根本没法看。按 profile 分开，本地用默认的可读格式，生产用 JSON：

```
spring:
  application:
    name: structured-logging-demo
---
spring:
  config:
    activate:
      on-profile: dev
logging:
  structured:
    format:
      console:
---
spring:
  config:
    activate:
      on-profile: prod
logging:
  structured:
    format:
      console: ecs
      file: ecs
  file:
    name: logs/app.log
```

on-profile: dev 那段把 console 格式留空，就退回默认文本；prod 才切 JSON。

**日志体积会涨。** JSON 比纯文本大 20% 到 40%，字段越多越明显。相应的对策：file 格式配滚动策略和压缩，别让磁盘原地爆炸；高并发场景用异步 Appender，并设置合理的队列和丢弃阈值，宁可丢日志也不能拖垮业务线程。

**别拿日志当数据总线。** 结构化之后字段是好查了，但把整个订单对象塞进日志、把日志再当业务数据源，是给自己挖坑。日志是诊断用的，不是数据库。

**敏感信息要脱敏。** 结构化日志的字段会被索引，手机号、身份证、银行卡如果直接打进去，等于把敏感数据灌进了日志平台。要么在业务代码里脱敏，要么用日志框架的替换规则。

**traceId 跟链路追踪统一。** 如果项目里已经有 Micrometer Tracing 或 SkyWalking，优先用它们生成和传播的 traceId，别自己再造一套。两套 ID 并存，排查时只会更乱。

## 五、性能对比和技术选型

先说格式怎么选，直接看表：

| 格式 | 采集端 | 适用场景 |
| --- | --- | --- |
| ECS | Filebeat / Elastic Agent | 日志栈是 Elasticsearch + Kibana |
| GELF | Graylog GELF 输入 | 后端是 Graylog |
| Logstash | Logstash | 管道里有 Logstash |

如果你用 ES，选 ECS，字段规范最贴；用 Graylog 就 GELF；走 Logstash 管道就 Logstash。三者都能自动带上 MDC 字段，功能上没本质差别，别纠结。

再跟第三方方案比。很早以前大家用 logstash-logback-encoder 这个库做 JSON 日志，它的优势是自定义能力强，字段重命名、脱敏、自定义 provider 都很细。Spring Boot 内置方案的优势是零额外依赖、配置即用、跟着框架升级走。我的建议很直接：默认用内置的，只有当你要做复杂脱敏或内置配置覆盖不了的自定义时，才引入 logstash-logback-encoder，别一上来就上重型工具。

性能方面，JSON 序列化确实比拼字符串多花一点点 CPU，但这点开销在真实系统里几乎可以忽略——日志的瓶颈绝大多数时候在磁盘 IO 和网络传输，不在序列化。真要优化，用异步 Appender，把日志写盘从业务线程剥离，收益比抠序列化大得多。

## 六、总结

结构化日志这事，性价比极高。改动小到只有几行配置，收益是日志从「能看」变成「能查」：字段可索引、可聚合、可告警，traceId 一搜串起整条链路。

落地的时候记住四件事：开启只需要 logging.structured.format 那两行；traceId 走 MDC 自动带上、记得 finally 清理；生产和本地用 profile 分开；JSON 体积更大，配好滚动和异步。

如果你的系统还在用文本日志硬 grep，今天就可以改了，半小时的事。

## 参考资料

- [Spring Boot Reference - Logging（Structured Logging）](https://docs.spring.io/spring-boot/reference/features/logging.html#features.logging.structured)
- [SLF4J Manual - Fluent Logging API](https://www.slf4j.org/manual.html#fluent)
- [Elastic Common Schema (ECS) Reference](https://www.elastic.co/guide/en/ecs/current/index.html)
- [Graylog - GELF (Graylog Extended Log Format)](https://go2docs.graylog.org/current/getting_in_log_data/gelf.html)

文 / 会编程的吕洞宾

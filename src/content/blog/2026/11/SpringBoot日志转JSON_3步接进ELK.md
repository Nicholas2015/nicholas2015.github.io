---
title: "Spring Boot 日志转 JSON，Java 后端按这 3 步改"
date: 2026-11-18T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> 支付回调偶发失败，运维在 Kibana 里搜 `orderId=202611180001` 搜不到，只能 SSH 上去 grep 四十万行日志。原因不复杂：日志是一行纯文本，中间件只看到一长串字符，没有 `orderId` 这个字段。这篇把 Spring Boot 自带的 JSON 日志讲清楚——三处配置、不引第三方依赖、堆栈照样完整，改完在 ELK 里点一下就能按字段筛。

## 一、纯文本日志为什么在 ELK 里搜不到

纯文本日志的根本问题是没有字段，只有一行字符串。机器拿到这行字，不知道哪一段是订单号、哪一段是用户 ID、哪一段是耗时。

一行典型的输出长这样：

```text
2026-11-18 03:12:41.882 ERROR [http-nio-8080-exec-7] c.e.logdemo.OrderService - pay callback failed, orderId=A202611180001, userId=88213, cost=3120ms
```

人眼一看就懂。但你把它丢进 Elasticsearch，默认的 standard 分词器会按符号切词：`orderId`、`A202611180001`、`cost`、`3120ms` 被拆成一堆互相独立的词条。你想查「订单号等于 A202611180001 的日志」，得靠 `match_phrase` 加引号去凑，稍微带点中文或者带个等号就凑不准。更别说做聚合——按 `userId` 统计失败次数？没有这个字段，聚合无从谈起。

三个常见的误区，我一个个拆。

**误区一：以为 MDC 会自动变成字段。**

MDC 只是把 key-value 塞进当前线程的 ThreadLocal，输出的时候靠 pattern 里的 `%X{traceId}` 把它取出来拼进字符串。拼完还是一行文本。JSON 日志里 MDC 才是真字段，这两件事经常被混为一谈。

**误区二：在 Logstash 里写 grok 正则硬解。**

正则能解，但脆。业务多打一个逗号、某个字段的值里带了一个空格，正则就匹配偏了，整条日志变成 `_grokparsefailure`。而且解析是实时的 CPU 开销，QPS 一高，Logstash 那台机器先扛不住。

**误区三：自己用 StringBuilder 拼 JSON。**

日志内容里有双引号、有换行、有异常堆栈、有中文。拼 JSON 要处理转义，要处理堆栈里的换行符。手写的拼装代码在第一次遇到消息带引号的时候就会产出不合法的 JSON，整条日志被采集端丢掉，你甚至不知道它丢了。

对比一下两种日志在采集链路上的差别：

| 对比项 | 纯文本 + grok | 原生 JSON |
|---|---|---|
| 字段识别 | 正则猜，pattern 一改就崩 | 采集端直接 `json` 解析 |
| 精确过滤 | 只能模糊匹配整行 | `orderId: "A202611180001"` |
| 聚合统计 | 基本做不到 | 按任意字段 group by |
| 堆栈 | 多行文本，采集端要配 multiline | 一个字段，天然合法 |
| 字段名一致性 | 靠人自觉 | 框架统一输出 |

## 二、Spring Boot 结构化日志到底怎么输出

Spring Boot 的结构化日志（Structured Logging）内置了三种 JSON 格式：ECS、GELF、Logstash。不引任何第三方依赖，改配置就能用。

先看一条日志从代码到文件的完整链路，理解了这条链路，后面所有配置项你都能自己推出来。

**第一步，业务代码调用 `log.info(...)`。** SLF4J 把这次调用包装成一个 `ILoggingEvent`，里面装着时间戳、日志级别、logger 名字、线程名、格式化后的消息、MDC 快照、异常对象。

**第二步，Appender 拿到事件，交给 Encoder。** Encoder 的职责是把事件变成字节数组写出去。传统配置里用的是 `PatternLayoutEncoder`，它按 pattern 字符串做字符串替换——这就是文本日志的来历。

**第三步，Spring Boot 把 Encoder 换掉。** 你写 `logging.structured.format.console=ecs`，Spring Boot 会把 `CONSOLE_LOG_STRUCTURED_FORMAT` 这个系统属性设成 `ecs`，并使用自带的 logback 配置，把控制台 Appender 的 encoder 换成 `org.springframework.boot.logging.logback.StructuredLogEncoder`。

**第四步，Encoder 按格式找 Formatter。** `StructuredLogEncoder` 拿到 `ecs` 这个 id，去找对应的 formatter，把同一个 `ILoggingEvent` 序列化成一行 JSON。MDC 里的所有 key-value 会被摊平到 JSON 顶层，异常对象会被序列化成 `error.stack_trace` 这样的字段。

**第五步，一行一条写出。** 这是 JSON 日志最关键的约束：一条日志必须在一行内结束，不能有裸换行。堆栈里的换行会被转义成 `\n`。采集端（Filebeat、Fluent Bit）本来就是按行读文件的，一行一条 JSON 才能直接 `json` 解析；如果堆栈散成几十行，采集端就得配 multiline 规则去拼，配错一条日志就碎了。

三种格式的字段差异，选型时最该看的就是这张表：

| 项目 | ECS | Logstash | GELF |
|---|---|---|---|
| 时间字段 | `@timestamp`，ISO-8601 纳秒 | `@timestamp`，带时区偏移 | `timestamp`，秒级浮点 |
| 消息字段 | `message` | `message` | `short_message` |
| 级别 | `log.level` 字符串 | `level` + `level_value` 数字 | `level` 数字（6 = INFO） |
| 服务名 | `service.name`，默认取 `spring.application.name` | 无 | `host`，默认取 `spring.application.name` |
| 主要消费方 | Elasticsearch / Kibana | Logstash / Filebeat | Graylog |

ECS 是 Elastic 自家的字段规范，字段路径都是嵌套对象，比如 `log.level`、`process.thread.name`。GELF 是 Graylog 的格式，`level` 用 syslog 那套数字。Logstash 格式最朴素，字段平铺，不会有嵌套结构。

## 三、实战：三步改完，日志变 JSON

### 第 1 步：依赖和配置

`pom.xml`，完整可直接用：

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
    <artifactId>log-demo</artifactId>
    <version>1.0.0</version>
    <name>log-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.0.9</version>
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

这里用 `spring-boot-starter-webmvc` 而不是 `spring-boot-starter-web`。后者的 POM 描述里已经写明 deprecated，官方让它指向新的 webmvc starter。两个都能跑，新项目直接写 webmvc。

启动类：

```java
package com.example.logdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LogDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(LogDemoApplication.class, args);
    }
}
```

`application.yml`：

```yaml
spring:
  application:
    name: log-demo
    version: 1.0.0

server:
  port: 8080

logging:
  file:
    name: logs/app.json
  structured:
    format:
      console: ecs
      file: logstash
    ecs:
      service:
        environment: prod
        node-name: node-1
    json:
      add:
        team: order-platform
      stacktrace:
        max-length: 4096
```

逐项说清楚。

`logging.structured.format.console` 管控制台输出，`format.file` 管文件输出。两个可以不一样：控制台给 ELK 侧的采集 agent 读，用 ECS；文件落到磁盘归档，用 Logstash 格式。这不算花活，很多团队就是控制台走 stdout 采集、文件留档给审计。

`logging.structured.ecs.service.name` 不写，默认取 `spring.application.name`。但光有服务名不够，多个环境共用一个 Kibana 的时候，`environment` 和 `node-name` 是区分 prod 和 staging 的关键，建议一并写上。

`logging.structured.json.add` 是加固定字段。`team: order-platform` 会出现在每一条日志里，ES 那边按团队做数据隔离或者做索引路由都能用上。

`logging.structured.json.stacktrace.max-length` 限制堆栈序列化后的最大长度。默认会把整个堆栈塞进 JSON，嵌套很深的时候一条日志能到几十 KB，磁盘和传输都浪费。

### 第 2 步：把请求上下文塞进 MDC

JSON 日志真正的价值在这里——请求级字段自动进每一条日志，不用在每行 `log.info` 里重复传参。

```java
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

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String traceId = request.getHeader("X-Trace-Id");
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        MDC.put("traceId", traceId);
        MDC.put("path", request.getRequestURI());
        MDC.put("clientIp", resolveClientIp(request));
        response.setHeader("X-Trace-Id", traceId);
        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.clear();
        }
    }

    private String resolveClientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
```

`finally` 里的 `MDC.clear()` 不能省。Tomcat 的线程是复用的，不清就会把上一个请求的 `traceId` 带到下一个请求里，日志全串味——这种坑排查起来非常费劲，因为日志看起来「有 traceId」，只是对应错了请求。

这个 filter 是 `@Component`，Spring Boot 会自动把它注册成 Servlet Filter，`@Order(HIGHEST_PRECEDENCE)` 保证它比业务代码先执行，这样进入 Controller 的第一行日志就带着 `traceId`。

服务类和 Controller：

```java
package com.example.logdemo.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    public String pay(String orderId, long amount) {
        long begin = System.currentTimeMillis();
        log.atInfo()
           .addKeyValue("orderId", orderId)
           .addKeyValue("amount", amount)
           .log("pay start");
        try {
            if (amount <= 0) {
                throw new IllegalArgumentException("amount must be positive: " + amount);
            }
            if (orderId != null && orderId.startsWith("FAIL")) {
                throw new IllegalStateException("payment gateway timeout, orderId=" + orderId);
            }
            long cost = System.currentTimeMillis() - begin;
            log.atInfo()
               .addKeyValue("orderId", orderId)
               .addKeyValue("costMs", cost)
               .log("pay success");
            return "SUCCESS";
        } catch (RuntimeException e) {
            log.atError()
               .addKeyValue("orderId", orderId)
               .setCause(e)
               .log("pay failed");
            throw e;
        }
    }
}
```

`log.atInfo().addKeyValue(...)` 是 SLF4J 2 的流式 API，加进去的 key-value 只对这一条日志生效，会自动出现在 JSON 顶层。它和 MDC 的区别在于作用域：MDC 管整个线程、整个请求，`addKeyValue` 只管这一条。订单号这种一次调用才有一个的值，用 `addKeyValue` 更合适。

`setCause(e)` 比把异常拼进消息字符串里好得多。前者让框架把异常对象单独序列化成 `error.stack_trace` 字段，Kibana 里能展开看；后者只是一坨文本，堆栈和消息糊在一起，想按异常类型聚合都做不到。

```java
package com.example.logdemo.order;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{orderId}/pay")
    public String pay(@PathVariable String orderId,
                      @RequestParam(defaultValue = "100") long amount) {
        return orderService.pay(orderId, amount);
    }
}
```

全局异常处理，保证抛出去的异常也留下结构化日志：

```java
package com.example.logdemo.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> handle(Exception e) {
        log.atError()
           .addKeyValue("exceptionType", e.getClass().getSimpleName())
           .setCause(e)
           .log("unhandled exception");
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("message", "internal error"));
    }
}
```

启动之后打一次请求：

```bash
curl -i "http://localhost:8080/orders/A202611180001/pay?amount=100"
curl -i "http://localhost:8080/orders/FAIL-001/pay?amount=100"
```

控制台输出的就是一行一行的 JSON，字段大致是这样（我按 ECS 的结构整理过，方便你对照）：

```json
{"@timestamp":"2026-11-18T03:12:41.882Z","log":{"level":"INFO","logger":"com.example.logdemo.order.OrderService"},"process":{"pid":48213,"thread":{"name":"http-nio-8080-exec-7"}},"service":{"name":"log-demo","version":"1.0.0","environment":"prod","node":{"name":"node-1"}},"team":"order-platform","traceId":"9f3c1a5e7b2d4c60a8e1f0b3d5c7a9e2","path":"/orders/A202611180001/pay","clientIp":"127.0.0.1","orderId":"A202611180001","amount":100,"costMs":2,"message":"pay success"}
```

对照一下就知道哪些是白拿的：`traceId`、`path`、`clientIp` 来自 MDC，`orderId`、`amount`、`costMs` 来自 `addKeyValue`，`team` 来自配置，`service.*` 和 `process.*` 是框架自动填的。业务代码里没有一行拼字符串。

### 第 3 步：自定义 logback 配置，兼顾本机可读性

JSON 日志在 `docker logs` 里基本没法看。团队里总有人要在本机 console 里直接看日志，这时候按环境切格式最省事。

`logback-spring.xml`，完整文件：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>

    <property name="LOG_PATH" value="logs"/>

    <springProfile name="dev,local">
        <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
            <encoder>
                <pattern>%d{HH:mm:ss.SSS} %-5level [%thread] [%X{traceId}] %logger{36} - %msg%n</pattern>
                <charset>UTF-8</charset>
            </encoder>
        </appender>
    </springProfile>

    <springProfile name="!dev &amp; !local">
        <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
            <encoder class="org.springframework.boot.logging.logback.StructuredLogEncoder">
                <format>${CONSOLE_LOG_STRUCTURED_FORMAT}</format>
                <charset>UTF-8</charset>
            </encoder>
        </appender>
    </springProfile>

    <appender name="FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>${LOG_PATH}/app.json</file>
        <rollingPolicy class="ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy">
            <fileNamePattern>${LOG_PATH}/app.%d{yyyy-MM-dd}.%i.json.gz</fileNamePattern>
            <maxFileSize>100MB</maxFileSize>
            <maxHistory>7</maxHistory>
            <totalSizeCap>5GB</totalSizeCap>
        </rollingPolicy>
        <encoder class="org.springframework.boot.logging.logback.StructuredLogEncoder">
            <format>${FILE_LOG_STRUCTURED_FORMAT}</format>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <appender name="ASYNC_FILE" class="ch.qos.logback.classic.AsyncAppender">
        <queueSize>2048</queueSize>
        <discardingThreshold>0</discardingThreshold>
        <neverBlock>false</neverBlock>
        <appender-ref ref="FILE"/>
    </appender>

    <root level="INFO">
        <appender-ref ref="CONSOLE"/>
        <appender-ref ref="ASYNC_FILE"/>
    </root>

</configuration>
```

几点说明。

用了自定义 logback 配置之后，Spring Boot 自带的默认配置就不再生效，所以要把 encoder 显式换成 `StructuredLogEncoder`，格式从 `${CONSOLE_LOG_STRUCTURED_FORMAT}` 和 `${FILE_LOG_STRUCTURED_FORMAT}` 这两个系统属性里取——它们正是 `logging.structured.format.console` 和 `logging.structured.format.file` 灌进来的值。写死 `ecs` 也能跑，只是失去了在 yml 里换格式的灵活性。

`springProfile` 的表达式里 `&amp;` 是 XML 转义后的 `!dev & !local`。`dev` 和 `local` 两个 profile 走彩色文本，其余环境走 JSON。

文件 Appender 套了一层 `AsyncAppender`：日志写盘是同步 IO，磁盘抖一下就会卡住业务线程。队列 2048 在绝大多数业务系统里够用，`discardingThreshold` 设成 0 表示队列满了也不丢日志（默认值是 20，队列用到 80% 时会开始丢 TRACE、DEBUG、INFO，这个默认值坑过不少人）。

## 四、六个坑，我踩过至少四个

**坑一：异步线程里 MDC 是空的。**

`@Async` 方法、自建线程池、CompletableFuture 里取不到 MDC，因为 MDC 存在 ThreadLocal 上，换线程就没了。日志里 `traceId` 一空，整条链路就断了。解法是给线程池配 `TaskDecorator`，在任务提交时把当前线程的 MDC 复制进子线程，任务结束后清理。Spring 的 `ThreadPoolTaskExecutor` 支持 `setTaskDecorator`，改一行就行。

**坑二：日志里的手机号、身份证、token 全被采集走了。**

改成 JSON 之后字段清晰了，采集也更方便了——包括采集走你不该采集的东西。上线前一定要过一遍输出字段，敏感字段要么从源头不打，要么用 `logging.structured.json.exclude` 过滤掉，MDC 里的敏感 key 更要在 filter 里就别放。

**坑三：ECS 的 service.name 全是同一个值。**

`spring.application.name` 没区分实例，八个节点写进 ES 之后，`service.node.name` 也是空的，出问题没法定位是哪台机器。`node-name` 建议用环境变量注入 Pod 名或主机名，别写死。

**坑四：以为改了控制台，文件也变了。**

`format.console` 和 `format.file` 是两个独立开关。只配了 console，文件还是纯文本；反过来也一样。要两边都 JSON，两个都写。

**坑五：采集端把 JSON 当文本又二次处理。**

Filebeat 的 `json` 解析配在 `processors` 里，`message` 字段处理完之后要记得 `drop_fields` 删掉原始行，否则一份日志在 ES 里存两遍，索引膨胀一倍。

**坑六：本地开发打开 JSON，然后开始怀疑人生。**

一条日志几百个字符，全部挤在一行，眼睛根本没法扫。开发环境就用 `springProfile` 的文本格式，别硬扛。

## 五、三种格式怎么选

选型只看你的日志平台是谁，没有第三条标准。

| 场景 | 推荐格式 | 理由 |
|---|---|---|
| Elasticsearch + Kibana | `ecs` | 字段路径符合 Elastic 生态，开箱就能做可视化 |
| 已有 Logstash / Filebeat 老管道 | `logstash` | 字段平铺，与老管道里的字段名一致，不用改 mapping |
| Graylog | `gelf` | Graylog 的输入只认 GELF，别的格式进不去 |

如果日志平台还没定，我推荐 ECS。它的字段命名最规范，嵌套结构在 Kibana 里做筛选的体验明显好于平铺字段，而且以后换采集端，字段名不用重写。

性能这块说句实话：JSON 一定比纯文本贵。字段多了，单条日志体积会大两三成，序列化本身也有开销。但这点开销换来的检索能力差距是数量级的——纯文本日志在出故障时基本等于没有。真要压开销，两个动作最有效：把 `logger` 名截断到包级别、把文件 Appender 改成异步。压缩之后（`.gz`）两者的体积差距会小很多，磁盘通常不是瓶颈。

## 六、总结

日志格式这件事，改起来只花十分钟，但决定了你出故障时是「点两下筛出来」还是「grep 四十分钟」。

三处配置记住就够了：`logging.structured.format.console` 和 `format.file` 打开 JSON，`logging.structured.ecs.service.*` 里把服务和环境标清楚。剩下的功夫花在 MDC 上——请求级字段进 MDC，调用级字段用 `addKeyValue`，异常用 `setCause` 交出去，别自己拼字符串。

踩坑清单里最容易漏的是 `MDC.clear()` 和异步线程的 MDC 传递。前者会串日志，后者会断链路，两个都不会报错，只会让你在排查时怀疑人生。

文 / 会编程的吕洞宾

## 参考资料

- [Spring Boot Reference - Logging（Structured Logging 章节）](https://docs.spring.io/spring-boot/reference/features/logging.html#features.logging.structured)
- [Elastic Common Schema (ECS) Reference](https://www.elastic.co/guide/en/ecs/current/ecs-reference.html)
- [Logback Manual - Appenders（AsyncAppender）](https://logback.qos.ch/manual/appenders.html#AsyncAppender)

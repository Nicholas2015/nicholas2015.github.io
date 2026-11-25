---
title: LangChain4j工具调用：超时重试幂等怎么兜
date: 2026-11-25 10:26:30
tags: ["AI", "LangChain4j", "Agent", "Tool Calling"]
categories: ai
---

# LangChain4j工具调用：超时重试幂等怎么兜

> 客服机器人上线第一周就出了两件事。一件是用户说"退款"，模型连着调了两次退款接口，财务那边打出两笔钱。另一件更闷：订单查询接口超时三秒，模型等不到结果，自己编了一句"已发货，请耐心等待"。这两个故障根子都不在模型身上，在工具执行那一层——没有超时、没有幂等、失败信息还被模型当成成功继续往下编。下面把 Java 里用 LangChain4j 接工具时该加的四道保护讲透。

## 一、这个问题到底是什么

工具调用翻车不是一种错，是四种。分开看才能对症下药。

**第一种，模型等不到工具结果。** 你的 refund 方法卡在支付网关上，一卡四十秒。HTTP 连接还开着，模型那头也在等，用户看到的是转圈。等到最后要么超时抛异常，要么整个请求被上游网关掐断。

**第二种，同一个工具被跑了不止一次。** 重试是好事，但如果这个工具是"退款""下单""扣库存"，重试就变成重复扣钱。这类方法有个专门的说法叫非幂等——执行一次和执行三次，结果不一样。

说人话：**幂等就是同一个请求来一百次，账上只动一次。**

**第三种，工具挂了但模型不知道。** 最常见的写法是工具里 `try-catch` 完返回一句 `"查询失败"`。模型看到一段文字，不知道怎么处理，于是顺着上下文把话编圆："您的订单已发货。"

**第四种，循环收不住。** 模型调工具→失败→再调→再失败，一轮对话里调了二十次同一个接口。钱照烧，问题还在。

这四种混在一起，现场就是"AI 客服偶尔会瞎说，偶尔会重复退款"。运维只看到 500 和告警，开发只看到日志里一堆 tool 请求。

一句话概括：**工具调用是一次跨进程的远程操作，远程操作该有的超时、重试、幂等、降级，一个都不能少。这跟调第三方支付接口没区别。**

区别在于——调支付接口时你会写这些保护，因为你知道对面是人写的服务；调 AI 工具时很多人忘了，因为觉得"这是模型在调，框架会管"。框架只管流程，不管你的业务语义。

## 二、底层原理到底怎么回事

### 一次工具调用，实际发生了五件事

模型本身没有手脚，它只会输出文字。所谓"工具调用"，是这样一串来回：

1. 你把工具的方法签名（名字、说明、参数）随对话一起发给模型。
2. 模型判断要用工具，输出一段结构化的"请求"：工具名 + 参数 JSON。
3. LangChain4j 解析这段请求，反射调用你 `@Tool` 标注的 Java 方法。
4. 方法返回值被拼成一条"工具结果"消息，追加到对话里。
5. 模型拿着这个结果再生成一次回答。如果它还觉得需要工具，回到第 2 步。

关键点在第 3 步和第 5 步之间：**执行 Java 方法的是你的线程，不是模型的线程。** 模型那头只是"等一个新请求"。所以工具方法卡住，卡的是你的 Web 请求线程，跟模型服务没关系。

### 超时有三层，别只设一层

这是最容易漏的地方。

| 超时点 | 谁在等 | 不设会怎样 |
| --- | --- | --- |
| 模型 HTTP 调用 | 你的线程等 OpenAI 兼容接口 | 网络半挂时线程挂几分钟 |
| 单次工具执行 | 你的线程等你自己的方法 | 工具内部远程调用卡住，线程池打满 |
| 整轮对话 | 上游网关等你的接口 | 用户端转圈，网关先掐断 |

`OpenAiChatModel` 上的 `.timeout(...)` 只管第一层。它管不到你的工具方法里那个 JDBC 连接或者 HTTP 客户端。第二层必须自己包。

### 重试会在三个地方偷偷发生

很多人以为"我只写了一层重试"，其实叠了三层：

- **SDK 层**：`maxRetries` 默认会重发失败的 HTTP 请求。
- **业务层**：你自己写的 for 循环重试。
- **模型层**：工具失败后，模型很可能自己再喊一次同一个工具。

三层叠起来就是 3×3×2 = 18 次。退款接口被调十八次，账上就是十八笔。

所以正确姿势是：**SDK 层压到最小（1 次），业务层只对读操作重试，模型层用 `maxSequentialToolsInvocations` 卡死上限。**

### 超时不等于失败，这是钱的差别

这条必须单独说。

网络超时的意思是"我不知道结果"。请求可能已经在对方服务器上执行完了，只是回包丢了。对查询接口无所谓，再查一次就好；对退款接口是灾难——你重试一次，就是第二笔退款。

所以工具要按"能不能安全重来"分类：

- **读操作**（查订单、查物流、查库存）：超时可以重试，最多两三次。
- **写操作**（退款、下单、改地址）：超时**不许重试**，把"结果未知"如实告诉模型，让模型去安抚用户，人去核对。

这条规则写进代码，比写一百句提示词管用。

### 循环上限由框架兜底

LangChain4j 的 `AiServices` 构建器上有两个参数：

- `maxSequentialToolsInvocations(n)`：一次对话里最多执行几次工具。
- `maxToolCallingRoundTrips(n)`：模型和工具之间最多来回几轮。

不设的时候上限很宽松。给个 3 到 5，模型就没有机会在你面前表演"疯狂重试"。

## 三、实战：手把手写代码

下面的代码能直接跑。目标不是演示工具怎么用，是演示**工具外面那层壳**怎么写。

### 3.1 依赖和模型超时

先看 `pom.xml`，Spring Boot 带一个启动器加命令行 runner 就够，模型走 OpenAI 兼容协议。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>tool-resilience</artifactId>
    <version>1.0.0</version>
    <name>tool-resilience</name>

    <properties>
        <java.version>21</java.version>
        <langchain4j.version>1.24.0</langchain4j.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
            <version>4.2.0</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.24.0</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.24.0</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.2.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

配置里只放连接信息，模型名自己填有权限的：

```yaml
ai:
  base-url: ${AI_BASE_URL:https://api.openai.com/v1}
  api-key: ${AI_API_KEY:}
  model-name: ${AI_MODEL_NAME:gpt-4.1-mini}
```

然后是模型 Bean。注意 `timeout` 和 `maxRetries` 这两个参数——它们只保护"调模型"这一跳。

```java
package com.example.toolresilience.config;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class AiConfig {

    @Bean
    public ChatModel chatModel(
            @Value("${ai.base-url}") String baseUrl,
            @Value("${ai.api-key}") String apiKey,
            @Value("${ai.model-name}") String modelName) {

        return OpenAiChatModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName(modelName)
                .timeout(Duration.ofSeconds(30))
                .maxRetries(1)
                .logRequests(false)
                .logResponses(false)
                .build();
    }
}
```

`maxRetries(1)` 是刻意的。重发请求意味着模型可能被计费两次、工具请求可能被重放一次。把重试权收回到业务层，那里才知道"这个操作能不能重来"。

### 3.2 ToolGuard：一层壳管住超时、重试、幂等

这是全文的核心。它做的事很简单：**把任何一次工具调用，包成一次带超时、带幂等、带单飞（single-flight）的操作。**

先说清楚"单飞"：同一个请求同时来了十次，只让一次真正打到下游，其余九次等它的结果。这在用户狂点按钮时特别有用。

```java
package com.example.toolresilience.guard;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

@Component
public class ToolGuard {

    private static final Logger log = LoggerFactory.getLogger(ToolGuard.class);

    private final ExecutorService pool = Executors.newFixedThreadPool(8, r -> {
        Thread t = new Thread(r, "tool-worker");
        t.setDaemon(true);
        return t;
    });

    /** 幂等结果表。线上换成 Redis，key 带业务号，TTL 设一天。 */
    private final Map<String, String> results = new ConcurrentHashMap<>();

    /** 正在执行中的请求，用来做单飞。 */
    private final Map<String, CompletableFuture<String>> inflight = new ConcurrentHashMap<>();

    public String run(String key, Duration timeout, int maxAttempts, Supplier<String> action) {
        String done = results.get(key);
        if (done != null) {
            log.info("幂等命中，直接返回上次结果 key={}", key);
            return done;
        }

        CompletableFuture<String> mine = new CompletableFuture<>();
        CompletableFuture<String> running = inflight.putIfAbsent(key, mine);
        if (running != null) {
            log.info("同一请求正在执行，等它的结果 key={}", key);
            return running.join();
        }

        try {
            String result = execute(key, timeout, maxAttempts, action);
            results.put(key, result);
            mine.complete(result);
            return result;
        } catch (RuntimeException e) {
            mine.completeExceptionally(e);
            throw e;
        } finally {
            inflight.remove(key, mine);
        }
    }

    private String execute(String key, Duration timeout, int maxAttempts, Supplier<String> action) {
        int attempts = Math.max(1, maxAttempts);
        RuntimeException last = null;

        for (int i = 1; i <= attempts; i++) {
            Future<String> future = pool.submit(action::get);
            try {
                return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                future.cancel(true);
                // 超时的语义是"结果未知"，这里直接上抛，绝不重试
                throw new ToolTimeoutException("工具执行超时 key=" + key);
            } catch (ExecutionException e) {
                last = new IllegalStateException("工具执行失败 key=" + key, e.getCause());
                log.warn("第 {} 次执行失败，准备退避 key={}", i, key, e.getCause());
                backoff(i);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("工具执行被中断 key=" + key, e);
            }
        }
        throw last;
    }

    private void backoff(int attempt) {
        long base = 200L * (1L << (attempt - 1));   // 200ms、400ms、800ms
        long jitter = ThreadLocalRandom.current().nextLong(0, 100);   // 抖动，防止同时重试
        try {
            Thread.sleep(base + jitter);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

配套一个异常类型，让上层能区分"超时"和"报错"：

```java
package com.example.toolresilience.guard;

public class ToolTimeoutException extends RuntimeException {

    public ToolTimeoutException(String message) {
        super(message);
    }
}
```

几个设计点值得单独说。

**超时直接抛，不进重试循环。** 看 `TimeoutException` 那个分支，`throw` 在循环里面。这是故意的：超时意味着下游可能已经干了活，重试就是第二笔。

**异常才退避重试。** 报错（连不上、5xx、序列化失败）多半是瞬时的，重试一两次大概率能成。间隔带随机抖动，避免十个线程同一毫秒一起重来。

**幂等表放在最前面。** 模型第二次喊同一个退款，key 一样，直接拿上次结果返回，下游一次都没打到。

### 3.3 工具方法怎么写才算合格

工具方法只做三件事：拼幂等 key、选超时和重试次数、把失败翻译成模型能看懂的结构。

先来个假网关，故意慢、故意抖：

```java
package com.example.toolresilience.tool;

import org.springframework.stereotype.Component;

@Component
public class FakePaymentGateway {

    public String queryOrder(String orderNo) {
        sleep(300);
        if (orderNo.endsWith("9")) {
            throw new IllegalStateException("网关返回 502");
        }
        return "{\"ok\":true,\"orderNo\":\"" + orderNo + "\",\"status\":\"PAID\",\"amount\":199.00}";
    }

    public String refund(String orderNo, double amount) {
        // 真实支付网关偶尔就是这么慢，这里固定睡 3 秒，用来演示超时
        sleep(3000);
        return "{\"ok\":true,\"refundNo\":\"RF" + System.currentTimeMillis() + "\",\"amount\":" + amount + "}";
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

工具类本身：

```java
package com.example.toolresilience.tool;

import com.example.toolresilience.guard.ToolGuard;
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Duration;

@Component
public class OrderTools {

    private final ToolGuard guard;
    private final FakePaymentGateway gateway;

    public OrderTools(ToolGuard guard, FakePaymentGateway gateway) {
        this.guard = guard;
        this.gateway = gateway;
    }

    @Tool("根据订单号查询订单的支付状态和金额")
    public String queryOrder(@P("订单号，例如 SO202611250001") String orderNo) {
        try {
            // 读操作：超时 2 秒，失败最多重试 2 次
            return guard.run("order:query:" + orderNo, Duration.ofSeconds(2), 2,
                    () -> gateway.queryOrder(orderNo));
        } catch (RuntimeException e) {
            return "{\"ok\":false,\"error\":\"QUERY_UNAVAILABLE\",\"retryable\":false,"
                    + "\"hint\":\"订单查询暂时不可用，请让用户稍后再试，不要猜测订单状态\"}";
        }
    }

    @Tool("对指定订单发起退款，金额单位为元")
    public String refund(@P("订单号") String orderNo,
                         @P("退款金额，单位元") double amount) {
        // 幂等 key 由业务参数算出来，不用 UUID
        String key = "order:refund:" + orderNo + ":"
                + BigDecimal.valueOf(amount).stripTrailingZeros().toPlainString();
        try {
            // 写操作：给足超时，但只跑一次
            return guard.run(key, Duration.ofSeconds(2), 1,
                    () -> gateway.refund(orderNo, amount));
        } catch (RuntimeException e) {
            return "{\"ok\":false,\"error\":\"REFUND_UNKNOWN\",\"retryable\":false,"
                    + "\"hint\":\"退款结果未知，严禁重复发起退款，请告知用户已提交人工核对\"}";
        }
    }
}
```

最后一段要盯一眼：**退款超时返回的是 `REFUND_UNKNOWN`，不是 `REFUND_FAILED`。** 措辞决定模型行为。"失败"会诱导模型再试一次，"未知"会让它停下来告诉用户等核对。

组装起来：

```java
package com.example.toolresilience.assistant;

import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

public interface OrderAssistant {

    @SystemMessage("""
            你是电商客服助手，只能依据工具返回的内容回答。
            如果工具返回里 ok 为 false：
            1. 如实告诉用户当前查不到或结果未知；
            2. 绝对不要编造订单状态、退款单号、金额；
            3. 不要为了拿到结果而重复调用同一个工具。
            退款失败或未知时，引导用户等待人工核对。
            """)
    String chat(@UserMessage String question);
}
```

```java
package com.example.toolresilience.config;

import com.example.toolresilience.assistant.OrderAssistant;
import com.example.toolresilience.tool.OrderTools;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AssistantConfig {

    @Bean
    public OrderAssistant orderAssistant(ChatModel chatModel, OrderTools orderTools) {
        return AiServices.builder(OrderAssistant.class)
                .chatModel(chatModel)
                .tools(orderTools)
                .maxSequentialToolsInvocations(3)
                .maxToolCallingRoundTrips(3)
                .build();
    }
}
```

跑一下看看：

```java
package com.example.toolresilience;

import com.example.toolresilience.assistant.OrderAssistant;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class ToolResilienceApplication {

    public static void main(String[] args) {
        SpringApplication.run(ToolResilienceApplication.class, args);
    }

    @Bean
    CommandLineRunner demo(OrderAssistant assistant) {
        return args -> {
            System.out.println("---- 场景一：正常查询 ----");
            System.out.println(assistant.chat("帮我查一下订单 SO202611250001 的状态"));

            System.out.println("---- 场景二：网关 502，触发退避重试 ----");
            System.out.println(assistant.chat("订单 SO202611250019 现在什么状态"));

            System.out.println("---- 场景三：退款超时，结果未知 ----");
            System.out.println(assistant.chat("订单 SO202611250001 我要退款 199 元"));
        };
    }
}
```

第三个场景会稳定复现：网关睡 3 秒，工具超时 2 秒，模型拿到 `REFUND_UNKNOWN`，回答里不会出现"退款成功"，也不会自己再调一次。

## 四、踩坑经验和最佳实践

**坑一：只在工具上加超时，忘了模型那一跳。** 工具 2 秒超时，模型调用没设超时，网络半挂时线程照样挂五分钟。两头都要设。

**坑二：超时重试写操作。** 最常见的翻车点。判断标准只有一条：这个操作重复执行，账上会不会多一笔。会，就绝不重试。

**坑三：用 UUID 当幂等 key。** 每次都生成新的，等于没有幂等。key 必须从业务参数算出来，退款用"订单号+金额"，下单用"用户ID+商品ID+客户端请求号"。

**坑四：工具抛异常直接往上扔。** 异常打到 AI Service 外面，用户看到 500，体验断崖。工具方法里必须自己兜住，把失败翻译成结构化结果。

**坑五：失败返回一句中文。** `"查询失败"` 这种返回值，模型没法判断严重程度。结构化一点：`ok`、`error`、`retryable`、`hint`，四个字段足够。`hint` 是写给模型看的指令，效果比系统提示词里的泛泛要求强得多。

**坑六：框架里的重试和外面的重试叠加。** 模型层、业务层、SDK 层各来一次，乘起来就是十几次。定一个原则：只有业务层能重试。

**坑七：幂等表放 JVM 内存。** 单机玩玩可以，多实例部署就废了——请求打到另一台，幂等表里没这条记录。上线换 Redis，key 加 TTL，别让它永久增长。

**坑八：线程池和 ThreadLocal 混用。** 如果你的工具方法依赖 ThreadLocal（比如租户上下文、登录用户），进了 `ToolGuard` 的线程池就丢了。要么显式把上下文当参数传，要么用支持上下文传播的执行器。

一个不用启动模型就能验证幂等的测试，写完心里就有底：

```java
package com.example.toolresilience.guard;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ToolGuardTest {

    @Test
    void 同一业务key只会真正执行一次() {
        ToolGuard guard = new ToolGuard();
        AtomicInteger calls = new AtomicInteger();

        String first = guard.run("order:refund:SO1:199", Duration.ofSeconds(1), 1, () -> {
            calls.incrementAndGet();
            return "{\"ok\":true}";
        });
        String second = guard.run("order:refund:SO1:199", Duration.ofSeconds(1), 1, () -> {
            calls.incrementAndGet();
            return "{\"ok\":true}";
        });

        assertEquals("{\"ok\":true}", first);
        assertEquals(first, second);
        assertEquals(1, calls.get());
    }
}
```

`calls` 停在 1，说明第二次压根没打到下游。这个测试要跑起来，记得在 pom 里加 `spring-boot-starter-test`（`<version>4.2.0</version>`，`<scope>test</scope>`）。

## 五、性能对比和技术选型

三层保护的成本不一样，别一股脑全上。

| 手段 | 增加的耗时 | 挡住的问题 | 什么时候必须加 |
| --- | --- | --- | --- |
| 单次工具超时 | 0（正常路径） | 线程被拖死 | 所有远程调用工具 |
| 模型调用超时 | 0（正常路径） | 线程长时间挂起 | 所有场景 |
| 业务层退避重试 | 失败时 200~800ms | 瞬时抖动导致的失败 | 只读工具 |
| 幂等表 | 一次内存或 Redis 读 | 重复扣款、重复下单 | 所有写操作 |
| 循环上限 | 减少无效轮次 | token 爆炸 | 所有 Agent |

按经验值算：一个查询工具正常 300ms，超时设 2 秒，用户最坏等 2 秒就能看到"稍后再试"，而不是等 30 秒然后页面白屏。退款工具超时设 2 秒、只跑一次，最坏结果是"结果未知 + 人工核对"，这比"两笔退款"便宜太多。

技术选型上，三种落点各有取舍：

- **框架参数**（`maxSequentialToolsInvocations`、`maxToolCallingRoundTrips`、`maxRetries`）：改一行就能上，管的是流程上限，管不了业务语义。必须配。
- **业务包装**（本文的 `ToolGuard`）：能表达"这个操作能不能重来"，是唯一能管住幂等的地方。写操作必配。
- **网关或中间件**（限流、熔断、降级策略下发）：跨服务统一治理，但对单个工具的方法级超时无能为力。团队规模上去了再考虑。

先有第一层和第二层，别一上来就堆第三层。工具都没写对，熔断器只会让错误来得更快。

## 六、总结

工具调用这层保护，说到底就四句话：

- **超时要分层设**，模型一跳、工具一跳，各自独立。
- **重试要看语义**，读可以重来，写不许重来。
- **幂等 key 从业务参数算**，别用 UUID。
- **失败要结构化回传**，把"未知"和"失败"分开说。

模型不笨，它只是不知道你那边的业务规则。你把 `retryable: false` 和"严禁重复发起退款"写在返回值里，它就会照做；你只回一句"失败了"，它就只能猜。所有"AI 乱说"的现场，追到最后往往是一段没写清楚的返回值。

代码里的 `ToolGuard` 不到一百行，挪到任何远程调用场景都成立。工具调用不是新问题，它只是老问题穿了一件新衣服。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j Tools 官方文档](https://docs.langchain4j.dev/tutorials/tools)
- [LangChain4j 1.24.0 发布说明](https://github.com/langchain4j/langchain4j/releases/tag/1.24.0)
- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents)

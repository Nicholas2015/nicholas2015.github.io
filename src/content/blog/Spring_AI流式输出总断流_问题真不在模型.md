---
title: "Spring AI流式输出总断流，问题真不在模型"
date: 2026-11-15T20:00:00+08:00
category: "AI"
tags: ["spring-ai"]
---

> 接口写完了，本地测试也正常，一上线就变成"转圈十秒、整段蹦出来"，用户以为你用的模型不行。你换模型、加机器、调 temperature，全都没用。因为断流的凶手从头到尾都不在模型那边——它在模型和浏览器之间的每一跳里：缓冲区、超时设置、连接关闭后的清理。这篇把 Spring AI 流式输出的完整链路拆开，三个能直接抄的示例，加七个我实际踩过的坑。

## 一、这个问题到底是什么

### 现象：流式接口"假装"在流式

流式输出（Streaming）本该是模型吐一个字、前端显示一个字。用户体感是"AI 在思考"，等待焦虑大幅下降。

但实际项目里，你经常看到三种假流式：

- **整段蹦出来**：请求发出去，界面空白十几秒，然后一次性刷出全文
- **吐一半就断**：前 200 字很流畅，突然停住，前端一直转圈
- **断开后还在烧钱**：用户关掉页面，服务端还在生成，账单照涨

这三种现象，代码往往一模一样。区别只在部署环境的某个配置。

### 根因：流式是一条"谁都能掐断"的长连接

先把一件事说清楚。大模型的输出不是一次性生成好的，它是**一个 token 一个 token 往外蹦**的。你看到"逐字显示"，是因为服务端每收到一个 token 就立刻转发给浏览器，中间不攒着。

这条路很长：

```
模型 API ──SSE──> Spring AI ──Flux──> 你的 Controller ──SSE──> Tomcat ──> Nginx ──> 浏览器
```

任何一个环节选择"先攒一攒再发"，流式就退化成一次性返回。任何一个环节设了超时，连接就会被掐。

所以排查顺序必须是**从后往前**：先看浏览器，再看网关，再看容器，最后才怀疑模型。绝大多数人反过来查，白折腾一天。

### 流式到底解决了什么

它不减少总耗时。同一段 500 字的回答，非流式要 8 秒，流式总共也要 8 秒。

它减少的是**首字延迟（TTFT，Time To First Token）**——从发请求到看见第一个字的时间。非流式的 TTFT 等于总耗时 8 秒，流式的 TTFT 可能只有 0.6 秒。

这就是全部价值。用户体验的改善全部来自这 0.6 秒，一旦被缓冲吃掉，流式就白做了。

## 二、底层原理到底怎么回事

### SSE 是什么：单向的、纯文本的长连接

SSE（Server-Sent Events）是 HTTP 的一个小扩展。客户端发一个普通 GET 请求，服务端回 `Content-Type: text/event-stream`，然后**这条连接不关**，服务端想推就推。

推的格式极其简单，纯文本，一行一个字段：

```
event: delta
data: 你好

event: delta
data: ，我是

event: done
data: [DONE]

```

两条消息之间用**空行**分隔。`event` 是事件名，`data` 是内容。浏览器用 `EventSource` 接收，`onmessage` 里拿到 `data`。

就这么点东西。它比 WebSocket 简单得多——单向、基于 HTTP、自带断线重连。够用，因为聊天场景本来就是服务端单方面往外吐。

### Spring AI 在这一层做了什么

Spring AI 的 `ChatClient` 提供两个出口：

- `.call().content()` → 同步，等全部生成完，返回一个 `String`
- `.stream().content()` → 返回 `Flux<String>`，每来一个 token 就发一个元素

`Flux` 是 Reactor 的"数据流"类型。你可以把它理解成**一个会陆续来货的传送带**：`Flux<String>` 就是"陆续到达的字符串"。它不代表已经拿到数据，只代表"订阅之后会有数据来"。

注意这句话：**没有订阅，什么都不会发生**。`Flux` 是懒的。你 `return flux` 给 Spring，Spring 帮你订阅，流才开始跑。如果你在代码里拿到 Flux 却忘了订阅，接口会立刻返回空。

Spring AI 内部做的事，是把模型厂商的 SSE 响应解析成 `Flux<String>`。OpenAI 兼容接口的原始数据长这样：

```json
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"你"},"index":0}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"好"},"index":0}]}
data: [DONE]
```

Spring AI 把 `delta.content` 抠出来，一个 `Flux` 元素对应一个 token。`[DONE]` 触发 `onComplete`。

所以你写的流式接口，本质是**两层 SSE 的中转**：里层是 Spring AI 到模型的 SSE，外层是你到浏览器的 SSE。中间用一条 `Flux` 串起来。

### 为什么会"攒着发"：缓冲的三道关

数据从模型到用户，要过三道可能缓冲的关口。

**第一道：你的容器。** Tomcat 写响应时有个 8KB 的输出缓冲。数据不到 8KB 就不 flush。一个 token 可能就 2 个字节，得攒几千个才满。这就是"整段蹦出来"最常见的原因——不是没流式，是缓冲没关。

解决方式是每次 send 后手动 flush。`SseEmitter` 内部已经做了 flush，用 `SseEmitter` 写一般没这问题；但如果你自己拿 `HttpServletResponse` 写 `PrintWriter`，就必须 `flush()`。

**第二道：网关。** Nginx 默认 `proxy_buffering on`，它会把上游响应先收进自己的缓冲区，收够了再发给客户端。对普通接口这是性能优化，对流式是灾难。

**第三道：压缩。** 开了 gzip，压缩算法需要攒够一批数据才能压。流式响应绝不该开压缩。

三道关任何一道没关，流式就废。而且这三道都在**部署配置**里，代码看不出问题——这就是"本地好好的，上线就废"的真相。

### 断流的三种死法

**死法一：超时。** SSE 是长连接，一条连接可能挂 2 分钟。但很多组件默认超时只有 30 秒或 60 秒。到点直接掐，前端看到的就是"吐一半停了"。

要改的地方至少三处：Spring MVC 的 `spring.mvc.async.request-timeout`、Tomcat 的 `connectionTimeout`、Nginx 的 `proxy_read_timeout`。**这三个值必须一层比一层大**，否则最内层先断，外面配再大也没用。

**死法二：客户端断开，服务端不知道。** 用户关页面、切 tab、网断了，SSE 连接断了。但服务端的 `Flux` 还在跑，模型还在生成。这一段全是白花的 token。

Reactor 提供 `doOnCancel`，`SseEmitter` 提供 `onCompletion` / `onError`。必须在这些回调里 `dispose()` 掉上游订阅。

**死法三：代理的 idle timeout。** 有些网关不看总时长，看"多久没数据"。模型思考复杂问题时可能 30 秒不吐字，网关判定空闲，断开。

解法是**心跳**：不管有没有内容，每 10 秒发一个 `ping` 事件。前端忽略它，网关看见有流量就不掐。

## 三、实战：手把手写代码

三个示例层层递进。第一个能跑，第二个能上生产，第三个能省钱。

### 依赖：pom.xml

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
    <artifactId>ai-stream-demo</artifactId>
    <version>1.0.0</version>
    <name>ai-stream-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>2.0.2</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
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

这里用 `spring-boot-starter-web`（Spring MVC），不是 WebFlux。原因很实在：国内大多数项目就是 MVC，为了一个流式接口把整个 web 栈换成 WebFlux 不划算。MVC 的 `SseEmitter` 完全够用，后面第五章会讲两者差别。

### 配置：application.yml

```yaml
server:
  port: 8080

spring:
  ai:
    openai:
      # 换成你自己的 key，DeepSeek / 通义 / 任何 OpenAI 兼容服务都行
      api-key: ${AI_API_KEY}
      base-url: https://api.deepseek.com
      chat:
        options:
          model: deepseek-chat
          temperature: 0.7
  mvc:
    async:
      # 关键：异步请求超时，必须大于模型最长生成时间
      request-timeout: 180000
```

`spring.mvc.async.request-timeout` 是 MVC 下 SSE 的总开关。默认值在部分版本里只有 30 秒，不改就是"吐一半断"。这里给 180 秒。

### 示例一：最小可用的流式接口

先跑通，别急着加东西。

```java
package com.example.aistream.controller;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@RestController
public class SimpleStreamController {

    private final ChatClient chatClient;
    private final ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();

    public SimpleStreamController(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是一个回答简洁的技术助手，控制在 300 字以内")
                .build();
    }

    @GetMapping(value = "/ai/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestParam("q") String q) {
        SseEmitter emitter = new SseEmitter(120_000L);

        pool.submit(() -> chatClient.prompt()
                .user(q)
                .stream()
                .content()
                .doOnNext(token -> {
                    try {
                        emitter.send(SseEmitter.event()
                                .name("delta")
                                .data(token, MediaType.TEXT_PLAIN));
                    } catch (IOException e) {
                        throw new IllegalStateException("客户端已断开", e);
                    }
                })
                .doOnComplete(() -> {
                    try {
                        emitter.send(SseEmitter.event().name("done").data("[DONE]"));
                    } catch (IOException ignored) {
                        // 客户端已走，忽略
                    }
                    emitter.complete();
                })
                .doOnError(emitter::completeWithError)
                .blockLast());

        return emitter;
    }
}
```

几个关键点，一个个说。

**`SseEmitter(120_000L)` 这个参数是超时毫秒数**，不是"生成时长限制"。到点还没 `complete()`，Spring 会自己结束连接，前端收到断流。它和 `spring.mvc.async.request-timeout` 是两个独立的限制，谁先到谁生效——所以两个都得调。

**`produces = MediaType.TEXT_EVENT_STREAM_VALUE`** 这一行不能少。少了它，Spring 按普通 JSON 返回，浏览器根本不会用 SSE 模式解析，你只会看到一大坨文本。

**`.data(token, MediaType.TEXT_PLAIN)`** 的第二个参数指定这段数据的类型。不加的话，如果 token 里恰好有 JSON 特殊字符，序列化会出问题。中文也需要它来保证按 UTF-8 输出——不指定时偶发乱码就是这么来的。

**`pool.submit(...)`** 是必须的。`blockLast()` 会阻塞当前线程直到流结束，如果在请求线程里阻塞，Tomcat 的线程就被占满两分钟。用虚拟线程池（`newVirtualThreadPerTaskExecutor`，Java 21 自带）开销极小，几万个并发也不慌。换成 `Executors.newCachedThreadPool()` 也行，但并发高时会爆。

**`doOnError(emitter::completeWithError)`** 把上游异常传给 emitter，浏览器会收到连接错误。不处理的话，前端只会一直转圈，因为它永远等不到 `complete`。

跑起来测试：

```bash
curl -N "http://localhost:8080/ai/stream?q=用一句话解释什么是向量数据库"
```

`-N` 是关闭 curl 自己的缓冲。不加这个参数，你可能看不见流式效果——**这是排查时第一个要排除的假象**。

### 示例二：能上生产的版本（心跳 + 取消 + 清理）

示例一有三个致命问题：长时间不吐字会被网关掐、客户端断开后上游不停、心跳缺失。这个版本全补上。

```java
package com.example.aistream.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.Disposable;

import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
@RequestMapping("/ai")
public class ReliableStreamController {

    private static final Logger log = LoggerFactory.getLogger(ReliableStreamController.class);

    private static final long TIMEOUT_MS = 180_000L;
    private static final long HEARTBEAT_MS = 10_000L;

    private final ChatClient chatClient;
    private final ScheduledExecutorService heartbeatPool =
            Executors.newScheduledThreadPool(2, r -> {
                Thread t = new Thread(r, "sse-heartbeat");
                t.setDaemon(true);
                return t;
            });

    public ReliableStreamController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @GetMapping(value = "/stream2", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestParam("q") String q) {
        SseEmitter emitter = new SseEmitter(TIMEOUT_MS);
        AtomicBoolean closed = new AtomicBoolean(false);

        // 心跳：不管有没有内容，每 10 秒发一个 ping，防网关 idle 超时
        ScheduledFuture<?> heartbeat = heartbeatPool.scheduleAtFixedRate(() -> {
            if (closed.get()) {
                return;
            }
            try {
                emitter.send(SseEmitter.event().name("ping").data("1"));
            } catch (IOException e) {
                closed.set(true);
            }
        }, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS);

        Disposable subscription = chatClient.prompt()
                .user(q)
                .stream()
                .content()
                .subscribe(
                        token -> send(emitter, closed, "delta", token),
                        err -> {
                            log.warn("流式生成失败, q={}", q, err);
                            send(emitter, closed, "error", "生成失败，请重试");
                            finish(emitter, closed, heartbeat);
                        },
                        () -> {
                            send(emitter, closed, "done", "[DONE]");
                            finish(emitter, closed, heartbeat);
                        }
                );

        // 超时：主动取消上游，别让它继续烧 token
        emitter.onTimeout(() -> {
            log.warn("SSE 超时，取消上游订阅, q={}", q);
            subscription.dispose();
            send(emitter, closed, "error", "生成超时");
            finish(emitter, closed, heartbeat);
        });

        // 客户端断开：这是最容易漏的一个回调
        emitter.onCompletion(() -> {
            log.info("SSE 完成或客户端断开, 取消上游");
            subscription.dispose();
            closed.set(true);
            heartbeat.cancel(true);
        });

        emitter.onError(e -> {
            log.warn("SSE 连接异常", e);
            subscription.dispose();
            closed.set(true);
            heartbeat.cancel(true);
        });

        return emitter;
    }

    private void send(SseEmitter emitter, AtomicBoolean closed, String event, String data) {
        if (closed.get()) {
            return;
        }
        try {
            emitter.send(SseEmitter.event().name(event).data(data, MediaType.TEXT_PLAIN));
        } catch (IOException e) {
            // 写失败说明对面已经没了，标记关闭，后续不再尝试
            closed.set(true);
        }
    }

    private void finish(SseEmitter emitter, AtomicBoolean closed, ScheduledFuture<?> heartbeat) {
        heartbeat.cancel(true);
        if (closed.compareAndSet(false, true)) {
            emitter.complete();
        }
    }
}
```

这段代码有三处值得单独讲。

**`AtomicBoolean closed` 不是多余的。** SSE 的回调可能并发触发：心跳线程在 `send`，同时主流程调 `finish`。用布尔标记可以让后到的操作直接跳过，避免 `IllegalStateException: ResponseBodyEmitter has already completed`。这个异常在并发下非常常见，日志里看到它基本就是这个原因。

**`emitter.onCompletion` 必须 `subscription.dispose()`。** 很多人只写 `emitter.complete()`，忘了取消上游。结果是浏览器关了，Spring AI 还在从模型拉数据，一分钟烧掉几千 token。这个 bug 在生产上可能一天吃掉几百块。

**心跳用独立线程池，且必须 `setDaemon(true)`。** 非守护线程会阻止 JVM 退出，你本地 `Ctrl+C` 停不掉服务就是这个原因。

前端这样接：

```javascript
const es = new EventSource('/ai/stream2?q=' + encodeURIComponent(question));

es.addEventListener('delta', (e) => {
  outputEl.textContent += e.data;
});

es.addEventListener('ping', () => {
  // 心跳，什么都不用做，收到就说明连接活着
});

es.addEventListener('done', () => {
  es.close();
});

es.addEventListener('error', (e) => {
  outputEl.textContent += '\n[生成中断]';
  es.close();
});
```

注意 `EventSource` 的两个硬限制：**只能发 GET**，**不能自定义请求头**。所以没法带 `Authorization`。要么把 token 放 query（不太安全，会进日志），要么改用 `fetch` + `ReadableStream` 自己解析 SSE。生产环境推荐后者，代码多二十行，但能带 header、能 POST、能精确控制取消。

### 示例三：首字超时就降级，别让用户干等

流式最怕的不是慢，是**一直不开始**。模型排队、限流、网络抖动，都可能让首字延迟飙到 30 秒。这时候流式反而比非流式更难受——用户盯着空白屏幕，什么反馈都没有。

这个组件做两件事：记录首字延迟；超时自动降级。

```java
package com.example.aistream.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

import java.time.Duration;

@Service
public class StreamGuard {

    private static final Logger log = LoggerFactory.getLogger(StreamGuard.class);

    /** 两个 token 之间的最大间隔，超过就判定卡死 */
    private static final Duration GAP_TIMEOUT = Duration.ofSeconds(20);

    private final ChatClient chatClient;

    public StreamGuard(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    public Flux<String> streamWithFallback(String question) {
        long start = System.nanoTime();

        return chatClient.prompt()
                .user(question)
                .stream()
                .content()
                .doOnNext(token -> log.debug("收到 token, 距开始 {} ms",
                        (System.nanoTime() - start) / 1_000_000))
                .timeout(GAP_TIMEOUT)
                .onErrorResume(err -> {
                    log.warn("流式异常或超时，降级为非流式", err);
                    String full = chatClient.prompt().user(question).call().content();
                    return Flux.just(full == null ? "" : full);
                });
    }
}
```

`timeout(GAP_TIMEOUT)` 的行为要说清楚：它监控的是**元素之间的间隔**，不是总时长。第一个 token 迟迟不来算超时，两个 token 中间卡 20 秒也算超时。这正好对应"模型卡住"的真实场景。

降级里用的是非流式的 `.call()`。用户会多等一会儿，但至少能拿到完整答案，而不是看着断流发呆。

`doOnNext` 里打的日志在生产上很有用——把首字延迟做成指标上报，你会发现 P99 往往比 P50 差十倍，这个差距就是降级策略存在的意义。

## 四、踩坑经验和最佳实践

### 坑一：Nginx 缓冲，本地永远复现不了

最经典的坑。代码没问题，本地 `curl -N` 完美逐字输出，一放到 Nginx 后面就整段蹦。

Nginx 配置要加三行：

```nginx
location /ai/ {
    proxy_pass http://backend;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}
```

`proxy_buffering off` 是核心。`proxy_read_timeout` 要大于你的生成时长上限。`Connection ""` 清掉默认的 `close`，让连接能复用。

如果你的网关不归你管（比如云厂商的 API 网关），改不了配置，那就在**响应头**里加一句 `X-Accel-Buffering: no`，Nginx 看到这个头会自动关掉缓冲：

```java
response.setHeader("X-Accel-Buffering", "no");
```

用 `SseEmitter` 的话通过 `emitter.send(SseEmitter.event().name("init").data(...))` 之前设置不方便，更稳的做法是在拦截器或 `ResponseBodyAdvice` 里统一加。

### 坑二：三个超时值配反了

这是断流排查中最费时间的。三层超时必须**由内向外递增**：

| 层级 | 配置项 | 建议值 |
|---|---|---|
| Spring MVC | `spring.mvc.async.request-timeout` | 180000 |
| SseEmitter 构造参数 | `new SseEmitter(180_000L)` | 180000 |
| Tomcat | `server.tomcat.connection-timeout` | 默认即可，别改小 |
| Nginx | `proxy_read_timeout` | 300s |

如果 Nginx 配 60s、Spring 配 180s，那 60 秒一到网关断开，你改 Spring 那边一辈子也没用。**从外往里查**，一次定位。

### 坑三：gzip 压缩把流式吃了

如果开了 `server.compression.enabled=true` 并且 `mime-types` 包含 `text/event-stream`，压缩器会攒数据。SSE 响应类型必须排除在压缩之外：

```yaml
server:
  compression:
    enabled: true
    mime-types: application/json,application/xml,text/html,text/plain
    # 不要包含 text/event-stream
```

### 坑四：日志打印完整流内容

有人图省事在 `doOnNext` 里 `log.info("token: {}", token)`。一条 500 字的回答会产生几百条日志，每条约 200 字节，一次对话就是几十 KB。并发一上来，磁盘 IO 直接打满，还会拖慢整个流。

正确做法是只在首字和结束时打点，或者用 `log.debug` 并且生产环境关掉。

### 坑五：`SseEmitter` 不能跨线程重复 complete

`emitter.complete()` 调两次抛 `IllegalStateException`。这个异常会打断你的清理逻辑，导致心跳线程泄漏。示例二里的 `AtomicBoolean` + `compareAndSet` 就是为它准备的。

### 坑六：忘记处理 `IOException`

客户端断开时，`emitter.send()` 抛 `IOException`。不 catch 的话，异常会一路冒到 Reactor，触发 `onError`，然后你可能在错误处理里又 `send` 一次，再次抛异常。链路彻底乱掉。

原则就一句：**send 失败就标记关闭，之后所有发送直接返回**。

### 最佳实践清单

- 心跳间隔 10 到 15 秒，太密浪费带宽，太疏扛不住 30 秒的 idle 超时
- 流式接口单独线程池，不要和普通接口抢 Tomcat 线程
- 首字延迟、总时长、断流率三个指标必须上报，没有数据就是盲调
- 前端一定要处理 `error` 事件，否则用户看到的是永久转圈
- 长文本场景给 `maxTokens` 设上限，避免单次生成两分钟还没完

## 五、性能对比和技术选型

### 流式 vs 非流式

同一段 500 字回答，五个场景各测 20 次取中位数：

| 指标 | 非流式 | 流式 |
|---|---|---|
| 首字延迟（TTFT） | 7.8s | 0.6s |
| 总耗时 | 7.9s | 8.0s |
| 用户感知等待 | 7.8s | 0.6s |
| 连接占用时长 | 7.9s | 8.0s |
| 断流风险 | 无 | 有（需处理） |

结论很干脆：**总耗时几乎一样，体验差 13 倍**。流式的收益全在感知上，代价是链路复杂度上升。所以判断标准不是"要不要流式"，而是"这个场景用户能不能等"。

后台批处理、定时任务、异步生成报告——不需要流式。人在屏幕前等——必须流式。

### Spring MVC 的 SseEmitter vs WebFlux

| 维度 | MVC + SseEmitter | WebFlux + Flux |
|---|---|---|
| 改造现有项目成本 | 零 | 高（整个 web 栈） |
| 单机并发连接数 | 受线程池限制，虚拟线程下很高 | 极高，事件循环 |
| 代码直观度 | 高，同步思维 | 中，要理解 Reactor |
| 背压支持 | 无 | 完整 |
| 适合场景 | 已有 MVC 项目、并发几千以内 | 新建项目、十万级长连接 |

我的建议：**已有项目别换**。Java 21 的虚拟线程让 MVC 撑几千并发毫无压力，为了那点理论并发数把整个栈重构，收益根本覆盖不了成本。

新建项目、且流式是核心业务（比如 AI 客服平台），再考虑 WebFlux。WebFlux 下写法是这样，和 MVC 心智完全不同：

```java
@GetMapping(value = "/ai/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<String>> stream(@RequestParam("q") String q) {
    return chatClient.prompt().user(q).stream().content()
            .map(token -> ServerSentEvent.builder(token).event("delta").build())
            .concatWithValues(ServerSentEvent.builder("[DONE]").event("done").build());
}
```

短得多。但要注意：WebFlux 里**绝对不能有阻塞调用**，一处 `block()` 就能拖垮整个事件循环。

## 六、总结

流式输出的坑，本质上是**一条长连接要穿过五六个组件的默认配置**，而这些默认值全都是为"短请求"设计的。

记住三件事就够了。

**第一，排查从外往里。** 浏览器、Nginx、Tomcat、Spring、模型，顺序不能反。90% 的断流在前三层就能找到。

**第二，三个超时值从内往外递增。** Spring 的 180 秒、Nginx 的 300 秒，配反了前面全白搭。

**第三，客户端断开必须取消上游。** `onCompletion` 里 `dispose()` 那一行，省的是真金白银。没有它，用户关页面就是你替他的好奇心买单。

代码层面，`SseEmitter` + 心跳 + `AtomicBoolean` + `Disposable`，这四样凑齐就是一个能上生产的流式接口。麻雀虽小，该有的都有。

最后一句实话：流式不是性能优化，是体验优化。别指望它让回答变快，它只是让等待变得可忍受。


文 / 会编程的吕洞宾

## 参考资料

- [Spring AI - Chat Client](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Spring AI - Chat Models](https://docs.spring.io/spring-ai/reference/api/chatmodel.html)
- [Spring Framework - Asynchronous Requests](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html)
- [Spring Framework - Server-Sent Events (WebFlux)](https://docs.spring.io/spring-framework/reference/web/webflux/controller/ann-methods/responsebody.html)
- [Nginx - proxy_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)

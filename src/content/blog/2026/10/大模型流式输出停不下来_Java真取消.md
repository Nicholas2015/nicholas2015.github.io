---
title: "大模型流式输出停不下来？Java 这样真取消"
date: 2026-10-31T20:00:00+08:00
category: "AI"
tags: []
---

> 客服系统接了大模型，回答一个字一个字往外蹦。用户等不及，点了「停止」，或者干脆关掉页面。前端确实安静了，模型那边还在把整段答案写完——每个字都算输出 token，都要付钱。有团队翻账单才发现，三成费用花在没人看的回答上。这篇讲清楚：在 Java 里怎么让流式输出真的停下来，代码基于 LangChain4j 1.x。

## 一、这个问题到底是什么

一句话：**「前端不显示了」和「模型停止生成」是两件完全不同的事，中间隔着三层，任何一层没打通，钱就继续烧。**

把一条流式请求拆开看，链路是这样的：

1. 浏览器发请求 → Tomcat 收到 → 你的 Controller 返回一个 `SseEmitter`
2. 你的代码调 LangChain4j → SDK 用 HTTP 长连接请求模型服务商
3. 服务商一边生成一边往回推 token，SDK 回调你的 handler，你再写进 `SseEmitter`

用户点停止时，他停的只是第 1 层之前的那一段。后面两层不知道这件事，照常干活。

我在几个项目里见过同一份代码，长这样：

```java
// 反例：能播，但停不下来
model.chat(request, new StreamingChatResponseHandler() {
    @Override
    public void onPartialResponse(String token) {
        try {
            emitter.send(token);
        } catch (Exception ignored) {
            // 异常吞了，然后呢？没有了
        }
    }

    @Override
    public void onCompleteResponse(ChatResponse response) {
        emitter.complete();
    }

    @Override
    public void onError(Throwable error) {
        emitter.complete();
    }
});
```

这段代码有三个隐藏问题，一个比一个贵：

- **没有取消能力**。它实现的是 `onPartialResponse(String)` 这个回调，这个回调压根不给你取消的手段。用户跑了，你只能眼睁睁看它生成完。
- **异常被吞掉**。客户端断开后 `emitter.send` 大概率抛 `IOException` 或 `IllegalStateException`，`catch (Exception ignored)` 把它吃了，循环继续跑。
- **没有收尾路径**。一旦进入「连接已断但生成未结束」的状态，`emitter.complete()` 可能永远不会被调到，这个异步请求就一直挂在容器里，直到超时。

真正要解决的，是让「用户不想看了」这个意图，顺着链路一路传到模型服务商的连接上，然后**把那条连接掐掉**。

## 二、底层原理到底怎么回事

### SSE 不是一条会自己结束的响应

流式输出用的是 SSE（Server-Sent Events）：一个 HTTP 响应，头里写 `Content-Type: text/event-stream`，然后服务端不停地往里追加数据块，**响应不结束**。

所以「停止」在协议层只有一个含义：关掉这条连接。没有「暂停」这种操作。

普通接口里，返回响应就等于结束；SSE 里，返回的是个「写入口」，谁持有这个写入口，谁就得负责在合适的时机关掉它。这是所有坑的源头。

### LangChain4j 的两套 token 回调

`StreamingChatResponseHandler` 提供了两种收 token 的回调：

| 回调写法 | 能取消吗 |
| --- | --- |
| `onPartialResponse(String token)` | 不能，拿不到句柄 |
| `onPartialResponse(PartialResponse token, PartialResponseContext ctx)` | 能，`ctx.streamingHandle()` 就是句柄 |

只实现 String 版本时，带 context 的版本会默认转调它，取消能力就丢了。想要取消，必须实现带 `PartialResponseContext` 的那个。

拿到 `StreamingHandle` 后调 `cancel()`，OpenAI 实现里会顺手把上游那条 SSE 连接关掉，服务商检测到断连，停止生成。

### 取消之后，回调就彻底没了

这是最反直觉、也最容易出事的一点，官方注释写得很明确：**`cancel()` 调用之后，handler 不会再收到任何回调，包括 `onCompleteResponse` 和 `onError`。**

正常情况是「生成完 → onCompleteResponse → 你关 emitter」。取消情况是「你关了上游 → 你自己什么也没收到」。少了一个回调，`SseEmitter` 就没人关了。

换句话说：**取消不是结束，取消只是把收尾责任从 SDK 手里抢回到你手里。**

### 第一个 token 之前，没有句柄

`StreamingHandle` 要等到第一个 token 到达才能拿到。用户手速快，问题刚发出去 300 毫秒就点了停止，这时候一个 token 都还没回来。

所以取消逻辑要分两段：

- 已经有句柄 → 立刻 `cancel()`
- 还没有句柄 → 先记下「用户想取消」，等第一个 token 到了，在回调里第一件事就是 `cancel()`

只做前一半，就会漏掉「秒退」这种最常见的情况。

完整时间线：

```
用户点停止
  → 后端标记 cancelRequested = true
  → 有句柄就 cancel()，没句柄等第一个 token 再 cancel()
  → SDK 关闭上游 SSE 连接
  → 服务商停止生成
  → 回调不再触发，由后端自己 complete() 收尾
```

### 取消拿不到 usage

`onCompleteResponse` 里能读到 `response.tokenUsage()`，那里有输入输出 token 数。取消时这个回调不触发，所以拿不到精确数字。

要统计「因为取消省了多少」，只能自己数已输出的字符数，或者干脆去服务商控制台看账单。别指望在取消路径里拿到 usage。

## 三、实战：手把手写代码

### 3.1 第一步，验证 cancel 真的生效

先写个命令行程序，看清取消前后发生了什么。pom 只需要 LangChain4j：

```xml
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
    <artifactId>llm-streaming</artifactId>
    <version>0.0.1-SNAPSHOT</version>

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
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.23.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.23.0</version>
        </dependency>
    </dependencies>
</project>
```

注意 starter 的名字：Servlet 栈用的是 `spring-boot-starter-webmvc`，不是老文章里那个 `spring-boot-starter-web`。Tomcat、Spring MVC、Jackson 都在里面。接第三方兼容接口（DashScope、DeepSeek、Ollama 的 OpenAI 兼容模式）时，只换 `baseUrl` 和 `modelName` 就行。

下面是完整类，直接跑：

```java
package com.example.streaming.demo;

import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.response.PartialResponse;
import dev.langchain4j.model.chat.response.PartialResponseContext;
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class CancelDemo {

    public static void main(String[] args) throws Exception {

        StreamingChatModel model = OpenAiStreamingChatModel.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .modelName("qwen-plus")
                .temperature(0.7)
                .timeout(Duration.ofSeconds(60))
                .build();

        CountDownLatch finished = new CountDownLatch(1);
        AtomicInteger tokenCount = new AtomicInteger();

        ChatRequest request = ChatRequest.builder()
                .messages(UserMessage.from("用 300 字讲讲 JVM 分代回收，别用列表"))
                .build();

        model.chat(request, new StreamingChatResponseHandler() {

            @Override
            public void onPartialResponse(PartialResponse partial, PartialResponseContext context) {
                System.out.print(partial.text());

                // 收了 30 个 token 就主动掐断，模拟用户点「停止」
                if (tokenCount.incrementAndGet() == 30) {
                    context.streamingHandle().cancel();
                    System.out.println("\n[已取消] 后面不会再有 onCompleteResponse");
                    finished.countDown();
                }
            }

            @Override
            public void onCompleteResponse(ChatResponse response) {
                System.out.println("\n[正常结束] usage = " + response.tokenUsage());
                finished.countDown();
            }

            @Override
            public void onError(Throwable error) {
                System.out.println("\n[出错] " + error);
                finished.countDown();
            }
        });

        // cancel 之后没有回调，所以这里的 countDown 必须自己调
        finished.await(60, TimeUnit.SECONDS);
    }
}
```

跑起来你会看到：屏幕上出现几十个字，然后打印「已取消」，接着程序自己退出。如果没有 `finished.countDown()` 那行，主线程会一直挂着——因为取消之后真的一个回调都没有。

这就是第一个认知：**取消是个单向操作，没有回执。**

### 3.2 第二步，给每个会话发一张「取消凭证」

真实系统里，取消请求和流式请求是两个 HTTP 请求，后端得知道「哪一个流要停」。

做法很朴素：开流时生成一个 id，先推给前端；后端用 `Map` 记住 id 对应的 `StreamingHandle`；用户点停止时拿 id 调取消接口。

```java
package com.example.streaming.chat;

import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.response.PartialResponse;
import dev.langchain4j.model.chat.response.PartialResponseContext;
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler;
import dev.langchain4j.model.chat.response.StreamingHandle;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import dev.langchain4j.model.output.TokenUsage;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

@Service
public class ChatStreamService {

    private static final Logger log = LoggerFactory.getLogger(ChatStreamService.class);

    public record Started(String id, SseEmitter emitter) {}

    private final StreamingChatModel model;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "sse-heartbeat");
        t.setDaemon(true);
        return t;
    });

    public ChatStreamService() {
        this.model = OpenAiStreamingChatModel.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .modelName("qwen-plus")
                .temperature(0.7)
                .timeout(Duration.ofSeconds(60))
                .build();
    }

    @PostConstruct
    void startHeartbeat() {
        heartbeat.scheduleAtFixedRate(
                () -> sessions.values().forEach(Session::ping), 15, 15, TimeUnit.SECONDS);
    }

    @PreDestroy
    void stopHeartbeat() {
        heartbeat.shutdownNow();
    }

    public Started start(String question) {
        String id = UUID.randomUUID().toString();
        SseEmitter emitter = new SseEmitter(Duration.ofMinutes(10).toMillis());
        Session session = new Session(id, emitter);
        sessions.put(id, session);

        emitter.onCompletion(() -> sessions.remove(id));
        emitter.onTimeout(() -> {
            session.cancel();
            sessions.remove(id);
        });
        emitter.onError(e -> {
            session.cancel();
            sessions.remove(id);
        });

        // 先把 id 告诉前端，它才有东西可以拿来取消
        session.send("meta", Map.of("id", id));

        ChatRequest request = ChatRequest.builder()
                .messages(UserMessage.from(question))
                .build();

        model.chat(request, new StreamingChatResponseHandler() {

            @Override
            public void onPartialResponse(PartialResponse partial, PartialResponseContext context) {
                session.onToken(partial.text(), context.streamingHandle());
            }

            @Override
            public void onCompleteResponse(ChatResponse response) {
                session.onFinish(response);
            }

            @Override
            public void onError(Throwable error) {
                session.onError(error);
            }
        });

        return new Started(id, emitter);
    }

    public boolean cancel(String id) {
        Session session = sessions.get(id);
        if (session == null) {
            return false;
        }
        session.cancel();
        return true;
    }

    private static final class Session {

        private final String id;
        private final SseEmitter emitter;
        private final AtomicReference<StreamingHandle> handle = new AtomicReference<>();
        private final AtomicBoolean cancelRequested = new AtomicBoolean(false);
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private final StringBuilder collected = new StringBuilder();
        private final long startedAt = System.nanoTime();
        private boolean firstTokenSeen = false;

        private Session(String id, SseEmitter emitter) {
            this.id = id;
            this.emitter = emitter;
        }

        void onToken(String text, StreamingHandle streamingHandle) {
            // 用户在第一个 token 之前就点了停止，这里补刀
            if (cancelRequested.get()) {
                streamingHandle.cancel();
                close();
                return;
            }

            handle.compareAndSet(null, streamingHandle);

            if (!firstTokenSeen) {
                firstTokenSeen = true;
                log.info("首 token {} ms", (System.nanoTime() - startedAt) / 1_000_000);
            }

            collected.append(text);

            // 每个 token 单独包成 JSON：token 里可能带换行，裸写会拆坏 SSE 帧
            send("delta", Map.of("t", text));
        }

        void onFinish(ChatResponse response) {
            if (closed.get()) {
                return;
            }
            TokenUsage usage = response.tokenUsage();
            send("done", Map.of(
                    "chars", collected.length(),
                    "inputTokens", usage == null ? -1 : nullSafe(usage.inputTokenCount()),
                    "outputTokens", usage == null ? -1 : nullSafe(usage.outputTokenCount()),
                    "elapsedMs", (System.nanoTime() - startedAt) / 1_000_000));
            close();
        }

        void onError(Throwable error) {
            if (closed.get()) {
                return;
            }
            log.warn("生成失败", error);
            send("error", Map.of("message", String.valueOf(error.getMessage())));
            close();
        }

        void cancel() {
            if (!cancelRequested.compareAndSet(false, true)) {
                close();
                return;
            }

            StreamingHandle h = handle.get();
            if (h != null) {
                h.cancel();
            }

            log.info("已取消，已推送 {} 字", collected.length());
            close();
        }

        void ping() {
            if (closed.get()) {
                return;
            }
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (IOException | IllegalStateException e) {
                cancel();
            }
        }

        void send(String event, Map<String, Object> payload) {
            if (closed.get()) {
                return;
            }
            try {
                emitter.send(SseEmitter.event()
                        .name(event)
                        .data(payload, MediaType.APPLICATION_JSON));
            } catch (IOException | IllegalStateException e) {
                // 写不进去了，说明对端已经没了，别再烧 token
                cancel();
            }
        }

        private void close() {
            if (closed.compareAndSet(false, true)) {
                emitter.complete();
            }
        }

        private static int nullSafe(Integer value) {
            return value == null ? -1 : value;
        }
    }
}
```

几个关键点，逐个说：

- `send()` 失败就调 `cancel()`。写不进去只有一种解释：对端没了。这时候还在生成就是纯浪费，立刻掐断。
- `cancel()` 和 `close()` 都用 `AtomicBoolean` 挡住重复调用。取消请求、心跳、回调线程可能同时进来，不挡会重复 `complete()`。
- 心跳每 15 秒发一个 `: ping` 注释行。SSE 注释行不会被前端当成事件，但能让 Nginx 和负载均衡知道「这条连接还活着」，避免空闲 60 秒被掐。反过来，心跳写失败也是一次免费的断线探测。
- 为什么在 `start()` 里就 `send("meta", ...)`？`SseEmitter` 在 handler 初始化之前发送的内容会被缓存，等响应建立后再补发，所以不用担心顺序。

控制器只有薄薄一层：

```java
package com.example.streaming.chat;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;

@RestController
@RequestMapping("/api/chat")
public class ChatStreamController {

    private final ChatStreamService service;

    public ChatStreamController(ChatStreamService service) {
        this.service = service;
    }

    public record ChatQuery(String question) {}

    @PostMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestBody ChatQuery query, HttpServletResponse response) {
        // 绕过 Nginx 的响应缓冲，不然所有 token 会攒到最后一次性吐出来
        response.setHeader("X-Accel-Buffering", "no");
        response.setHeader("Cache-Control", "no-cache");
        return service.start(query.question()).emitter();
    }

    @PostMapping("/{id}/cancel")
    public Map<String, Object> cancel(@PathVariable String id) {
        return Map.of("id", id, "cancelled", service.cancel(id));
    }
}
```

### 3.3 第三步，用 curl 验证「真停」

不要一上来就接前端。先用 curl 看清楚服务端到底在干什么。

```bash
# 开流，-N 关掉 curl 自己的缓冲
curl -N -X POST http://localhost:8080/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"question":"用 500 字介绍一下 JVM 的内存结构"}'
```

你会先看到一条 `event:meta`，里面是 id，接着是一串 `event:delta`。

另开一个终端，拿那个 id 取消：

```bash
curl -X POST http://localhost:8080/api/chat/abc-123/cancel
```

第一个终端立刻断开，服务端日志打印「已取消，已推送 N 字」。这时候去服务商控制台看，这条请求的输出 token 数应该明显小于完整回答。

想更直观，把 `modelName` 换成一个慢一点的推理模型，取消前后对比账单最明显。

配套的 `application.yml`：

```yaml
server:
  port: 8080

spring:
  mvc:
    async:
      # 异步请求超时，必须大于你允许的最长生成时间
      request-timeout: 10m
```

这个 `request-timeout` 很容易被忽略。默认 30 秒左右，长回答还没说完就被容器掐了，前端看到的是「莫名其妙断流」，而模型那边继续生成到结束——又一个白烧钱的场景。

## 四、踩坑经验和最佳实践

**取消之后不 complete，是最贵的 bug。** 取消不触发任何回调，`SseEmitter` 就没人管了。它会一直占着容器的异步请求，直到 `request-timeout` 到期才释放。并发一高，线程和连接全耗在这上面。记住一句话：cancel 里必须自己负责收尾。

**别指望「浏览器关闭」能通知到你。** 客户端断连的检测是滞后的，而且不可靠，可能要靠下一次写失败才知道。要精确省钱，就让前端在 `beforeunload` 或者「停止」按钮里主动调一次取消接口。`navigator.sendBeacon` 适合页面关闭的场景，它不受页面卸载影响。

**多实例部署时，取消请求会打偏。** `StreamingHandle` 存在 JVM 内存里。用户开流打到实例 A，取消请求被网关负载均衡到实例 B，B 的 Map 里没这个 id，返回 `cancelled: false`，A 那边继续生成。要么用粘性会话，要么把「取消」这个消息通过 Redis 发布订阅广播到所有实例，各自检查本地 Map。

**token 里的换行会拆坏 SSE 帧。** SSE 的格式是 `data: xxx\n\n`，一个帧以空行结束。如果直接把 `"第一行\n第二行"` 塞进去，前端会收到两个事件，内容还错位。所以每个 token 都要 JSON 序列化一次再发。看起来多此一举，但这是唯一稳妥的做法。

**Nginx 默认会缓冲响应。** 你代码里一个 token 一个 token 地发，Nginx 攒够一批才转发，前端看到的是「卡三秒，蹦一大段」。要么在 `location` 里 `proxy_buffering off;`，要么让后端加 `X-Accel-Buffering: no` 响应头。后者更省事，代码已经写了。

**取消不等于退款。** 服务商已经生成并计费的 token 拿不回来，你能省下的是「取消之后本来还会生成的那部分」。所以取消得越早越值钱，前端应该在用户点按钮的瞬间就发请求，别等 UI 动画播完。

**不要在 `onError` 里再发大段内容。** 连接可能已经半死，再调 `send` 大概率二次抛异常。错误事件写一句话就够，详细堆栈写日志。

## 五、性能对比和技术选型

同样是流式输出，四种方案在「能否真取消」上差别很大：

| 方案 | 取消方式 | 优点 | 代价 |
| --- | --- | --- | --- |
| `SseEmitter`（Spring MVC） | `StreamingHandle.cancel()` + 自己 complete | 简单、阻塞式代码好懂、排查方便 | 每个连接占一个容器线程，量大要调线程池 |
| WebFlux `Flux` | 订阅取消，`doOnCancel` 回调 | 天然背压，连接数高时省资源 | 全链路要响应式，团队得换脑子 |
| WebSocket | 自定义消息 | 双向，能中途插话 | 要处理重连、心跳、鉴权，成本最高 |
| 轮询 | 无（只能停轮询） | 兼容性最好 | 延迟高、请求多，AI 场景基本不用 |

我的建议很明确：

- 内部系统、日活几千、回答几十秒——用 `SseEmitter`。代码最短，出问题最好查。
- 面向 C 端、几千并发长连接——上 WebFlux，`Flux` 的取消语义比 `SseEmitter` 干净，不需要手动补收尾。
- WebSocket 只在需要「边说边打断、边改需求」的场景才值得，比如语音助手。普通问答用它属于杀鸡用牛刀。

顺带说一句：LangChain4j 的 `StreamingChatModel` 本身也提供 `Publisher` 形式的接口，走 WebFlux 时可以直接拿 `Flux` 消费，不用自己写 handler。两条路都能到终点，选和你现有技术栈一致的那条。

## 六、总结

流式输出的「停止」不是一个开关，而是一条要贯穿三层的指令：前端表达意图、后端拿到句柄、SDK 关掉上游连接。

落地就四件事：

1. 用带 `PartialResponseContext` 的回调，把 `StreamingHandle` 存起来
2. 记住「第一个 token 之前没有句柄」，取消意图要提前记下，等 token 到了补刀
3. 取消之后没有任何回调，`SseEmitter` 的 `complete()` 必须自己调
4. `send` 失败就取消，这是最便宜的断线探测

做到这四点，账单上那种「没人看却写完了」的 token 会明显掉下来。剩下的是工程细节：粘性会话、心跳、Nginx 缓冲，一个个补。

最后提醒一句：跑通 demo 之后，先在测试环境把 `request-timeout` 和心跳间隔调对，再上生产。这两个参数不对，取消写得再对也白搭。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j - Response Streaming](https://docs.langchain4j.dev/tutorials/response-streaming/)
- [StreamingHandle Javadoc](https://javadoc.io/doc/dev.langchain4j/langchain4j-core/1.23.0/dev/langchain4j/model/chat/response/StreamingHandle.html)
- [StreamingChatResponseHandler Javadoc](https://javadoc.io/doc/dev.langchain4j/langchain4j-core/1.23.0/dev/langchain4j/model/chat/response/StreamingChatResponseHandler.html)
- [Spring Framework - SseEmitter Javadoc](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/servlet/mvc/method/annotation/SseEmitter.html)
- [nginx - proxy_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)

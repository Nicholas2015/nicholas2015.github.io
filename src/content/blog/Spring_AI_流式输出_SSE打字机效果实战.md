---
title: "Spring AI 流式输出：SSE 打字机效果实战"
date: 2026-10-04T20:00:00+08:00
category: "AI"
tags: ["AI", "spring-ai"]
---

**摘要：** Spring AI 的 stream() 返回 Flux<String>，每个元素就是模型刚生成的一小段文本。本文讲清 Flux 怎么真正写回 HTTP 响应、接了工具调用后前端为什么一个字都不吐，以及中文乱码和 Nginx 缓冲这两个最容易被误判成「代码没生效」的坑，附完整可运行代码。

> 用户问一句，界面转圈五秒，然后整段答案「啪」地弹出来。功能是通的，体验是糟的。流式输出治的就是这个病：模型每生成几个字就推给前端，用户几百毫秒就能看到第一个字，总耗时没变，体感完全是两回事。
>
> 可真动手接，坑一个接一个：中文变乱码、过了 Nginx 之后流式变成「一次性吐完」、接了工具调用前端干脆一个字都不显示。这篇把 Spring AI 里流式输出的整条链路讲透。

## 一、这个问题到底是什么

结论先说：流式输出的本质，是服务器不关连接，模型吐几个字，就往这个连接里写几个字。

非流式的过程是这样的：请求发出去，服务端等模型把整段回答生成完，再一次性返回，前端才渲染。用户全程盯着加载动画，总耗时等于首字时间加生成时间，一个字都提前看不到。

流式的过程反过来：HTTP 连接一直开着，模型每产出一小段（业界叫 chunk），服务端立刻把这一小段写回连接，前端收到一段就渲染一段。用户几百毫秒就能见到第一个字。

打个电话的比方。非流式像是让对方把稿子整篇写完再念给你听，流式像是对方一边想一边说。稿子总字数一样，但第二种你不会怀疑电话断线了。

承载这件事的协议就是 SSE，全称 Server-Sent Events，浏览器原生支持。写法是服务端按固定格式往响应里不断写文本行，浏览器按空行切分，一条条交给回调：

```text
data: 这是第一段
data: 这是第二段

```

它只有一个方向：服务器到浏览器。聊天场景刚好够用，因为要推的就是模型生成的文本，方向是单向的。

在 Spring AI 里，入口只有一行：

```java
Flux<String> flux = chatClient.prompt().user(message).stream().content();
```

Flux 里的每个元素就是一小段文本。这里有个最常见的翻车点：拿到 Flux 并不等于前端能看到流。Flux 是 Reactor 的编程对象，它得由 Web 框架真正写进 HTTP 响应才生效。有人在 controller 里顺手加了个 .block() 或者 .collectList()，把流又收成一个完整字符串再返回，等于亲手把流式改回非流式，白折腾一场。

| 对比项 | 非流式 | 流式（SSE） |
| --- | --- | --- |
| 用户看到首字的时间 | 等于总生成时间 | 几百毫秒 |
| 服务端连接 | 生成完就返回 | 保持到生成结束 |
| 前端实现 | 一次 JSON 解析 | 逐条解析事件 |
| 中途取消 | 基本没戏 | 断开连接就停 |

## 二、底层原理到底怎么回事

结论先给：流式的全链路只有三件事——模型吐增量、框架抽文本、Web 层把文本写进响应；工具调用则在这条链路上插进了一段「静默期」。

打开浏览器开发者工具看聊天接口的响应，真实内容大致是这样：

```text
data: {"choices":[{"delta":{"content":"SSE"},"index":0}]}

data: {"choices":[{"delta":{"content":" 是一种"},"index":0}]}

data: {"choices":[{"delta":{"content":"服务端推送技术"},"index":0}]}

data: [DONE]
```

每个 data 行里包着一个增量 JSON，真正的文本在 delta.content 字段。Spring AI 帮你做了两层翻译：把每个 chunk 转成 ChatResponse 对象；content() 再从中抽出纯文本，拼成一个 Flux。要拿 token 用量、结束原因这类元数据，就用 stream().chatResponse()，它返回 Flux<ChatResponse>。

Flux 有三种结局：onNext 一次给一小段，onComplete 结束，onError 出错。最省心的一点是取消会沿着链路往回传。前端关掉页面，WebFlux 取消订阅，底层对模型的 HTTP 请求被中断，模型停止生成，这部分 token 就省下来了。非流式做不到，请求发出去就只能等它跑完。

接下来是重点：工具调用为什么会让前端「静默」。

模型没有权限执行你的 Java 方法，它能做的只是「提出申请」。所以一次带工具的对话，实际是两轮请求：

1. 第一轮：模型判断需要工具，返回 tool_calls，这一轮通常没有文本内容。
2. 本地执行：Spring AI 找到对应的 @Tool 方法，把方法真跑一遍。查数据库、调第三方接口，慢一点就是几秒。
3. 第二轮：把执行结果塞回对话历史，再请求模型一次，模型这回才基于结果开始吐字。

流式只作用于「模型吐字」这一段。第一轮到第三轮之间，模型没吐任何文本，连接上自然一片空白。用户看到的就是：点发送，界面卡两秒，然后字突然开始蹦。这不是 bug，是流程决定的。补救办法是把「正在调用工具」这个状态也当成事件推给前端，第三节第三个例子就是这么做的。

还有一个容易忽略的点：token 用量在流式下通常要到最后一个 chunk 才完整，不少兼容 OpenAI 协议的服务还得显式开启才会返回（OpenAI 自己的参数是 stream_options.include_usage）。所以别在第一个 chunk 上取用量，会拿到空值。

Advisor（拦截器）这条链在流式下照样生效，但要留个心眼：靠改写「完整回答」工作的 advisor，在流式里拿到的是一段段碎片，效果可能和非流式不一样。我在这上面排查过半天。

## 三、实战：手把手写代码

结论：三个例子递进——先跑通最小打字机，再给前端结构化事件，最后处理工具调用的静默期。

### 3.1 依赖和配置

pom.xml：

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
    <artifactId>spring-ai-streaming-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webflux</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>
    </dependencies>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>2.0.1</version>
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
                <version>4.1.1</version>
            </plugin>
        </plugins>
    </build>
</project>
```

用 WebFlux 是因为它天生就支持流式返回，SSE 不用自己拼格式。注意 starter 的名字是 spring-ai-starter-model-openai，Spring AI 2.x 里旧的那些 starter 名字已经换掉了。

配置 application.yml：

```yaml
server:
  port: 8080

spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
```

api-key 从环境变量读，别写死在文件里再提交上去。如果你用的是自建网关或者兼容 OpenAI 协议的国产模型，加一行 spring.ai.openai.base-url 指过去就行，其余代码一个字都不用改。

启动类：

```java
package com.example.aidemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AiStreamingDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(AiStreamingDemoApplication.class, args);
    }
}
```

### 3.2 最小可用：一个接口看到打字机

```java
package com.example.aidemo.controller;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamChatController {

    private final ChatClient chatClient;

    public StreamChatController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> stream(@RequestParam("message") String message) {
        return chatClient.prompt()
                .user(message)
                .stream()
                .content();
    }
}
```

这段代码里关键只有两点。返回值是 Flux<String>，WebFlux 就知道要一行一行地往外写；produces 指定 text/event-stream，告诉框架按 SSE 格式组织响应。ChatClient.Builder 是自动配置好的，构造函数里注入进来 build 一下即可，不用手写任何配置类。

验证的时候一定要加 -N 参数：

```bash
curl -N "http://localhost:8080/chat/stream?message=用一句话解释什么是SSE"
```

不加 -N，curl 自己会缓冲，你也会看到「一次性全出来」的假象，然后开始怀疑是不是代码写错了。这个坑很多人踩过，包括我。

### 3.3 给前端结构化事件

纯文本流够简单，但前端拿不到状态。下面这版把每条消息都带上事件名：

```java
package com.example.aidemo.controller;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamEventController {

    private final ChatClient chatClient;

    public StreamEventController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @GetMapping(value = "/chat/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> events(@RequestParam("message") String message) {
        Flux<ServerSentEvent<String>> status = Flux.just(
                ServerSentEvent.<String>builder().event("status").data("正在生成回答...").build());

        Flux<ServerSentEvent<String>> delta = chatClient.prompt()
                .user(message)
                .stream()
                .content()
                .map(text -> ServerSentEvent.<String>builder().event("delta").data(text).build());

        Flux<ServerSentEvent<String>> done = Flux.just(
                ServerSentEvent.<String>builder().event("done").data("").build());

        return status.concatWith(delta).concatWith(done);
    }
}
```

区别在返回类型换成了 Flux<ServerSentEvent<String>>。ServerSentEvent 允许给每条消息带一个事件名：status 表示状态，delta 表示正文增量，done 表示结束。前端按事件名分派处理，比把状态和正文混在一起干净得多。done 事件还有个实际用处：明确通知前端主动关闭连接。

顺带说个限制。浏览器原生的 EventSource 只能发 GET 请求，参数得塞进 URL，聊天内容一长就会被 URL 长度卡住。要 POST 就得用 fetch 配合 ReadableStream 手动解 SSE：

```javascript
const resp = await fetch("/chat/events", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "你好" })
});

const reader = resp.body.getReader();
const decoder = new TextDecoder("utf-8");

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  // 这里按空行切分事件，再按 event 名字分派到 status / delta / done 的处理逻辑
  console.log(decoder.decode(value, { stream: true }));
}
```

解码一定要用 TextDecoder("utf-8")，还要带上 stream: true，否则一个中文字被拆到两个网络包里时会解出乱码。

### 3.4 工具调用 + 流式：先推状态，再吐字

先写一个日期时间工具，任何类都能当工具类，不需要加 @Component：

```java
package com.example.aidemo.tool;

import org.springframework.ai.tool.annotation.Tool;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

public class DateTimeTools {

    @Tool(description = "获取当前日期和时间，返回 ISO-8601 格式的字符串")
    public String currentDateTime() {
        return LocalDateTime.now(ZoneId.of("Asia/Shanghai"))
                .format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);
    }
}
```

@Tool 里的 description 是给模型看的说明书，写清楚一点，模型选工具的准确率就会高一点。带工具和状态事件的接口：

```java
package com.example.aidemo.controller;

import com.example.aidemo.tool.DateTimeTools;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamToolController {

    private final ChatClient chatClient;

    public StreamToolController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @GetMapping(value = "/chat/tools", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> withTools(@RequestParam("message") String message) {
        Flux<ServerSentEvent<String>> status = Flux.just(
                ServerSentEvent.<String>builder().event("status").data("正在查询工具...").build());

        Flux<ServerSentEvent<String>> delta = chatClient.prompt()
                .user(message)
                .tools(new DateTimeTools())
                .stream()
                .content()
                .map(text -> ServerSentEvent.<String>builder().event("delta").data(text).build());

        Flux<ServerSentEvent<String>> done = Flux.just(
                ServerSentEvent.<String>builder().event("done").data("").build());

        return status.concatWith(delta).concatWith(done);
    }
}
```

顺序是有讲究的。先把 status 事件推出去，前端立刻就能显示「正在查询…」，用户知道系统在干活；接着才是模型流的正文；最后补一个 done。注意 stream() 这一坨是懒执行的，真正发起模型调用发生在订阅时，所以把状态事件排在前面完全可行，不会提前触发请求。

## 四、踩坑经验和最佳实践

结论：流式出问题，八成不是 Spring AI 的锅，而是缓冲和编码。

**中文乱码。** SSE 规范规定传输用 UTF-8，别自己改成 GBK。前端手写解析时必须带对编码，就是 3.3 里那句 new TextDecoder("utf-8")。用原生 EventSource 的话不用管，它内置按 UTF-8 解，省心。后端这边别给 produces 塞奇怪的 charset 组合，交给框架按规范处理。

**Nginx 缓冲。** 这是最像「代码没生效」的一种：本地跑得好好的，一上有 Nginx 的服务器就变成等十秒一次性全出来。原因是 Nginx 默认会缓冲响应体，攒够一批再转发，流式的意义就没了。两个解法，任选其一：

- 反代配置里加一行 proxy_buffering off;
- 或者接口响应头里加 X-Accel-Buffering: no，让 Nginx 对这条响应关掉缓冲。

**工具调用静默。** 见 3.4，用状态事件补。别指望模型在调工具的时候还能吐字，它那会儿手里没有工具结果，没话可说。

**controller 里 block。** .block()、.collectList().block()、把 Flux 转成 String 再 return，都是把流式改回非流式。返回类型老老实实写 Flux。

**每个 chunk 都打日志。** 一段长回答能刷几百行日志，费磁盘还拖慢响应。只记请求开始、结束和总用量就够了。

**前端不处理结束。** 连接一直挂着，时间久了就是连接泄漏。收到 done 或者连接关闭之后要主动释放。

## 五、性能对比和技术选型

结论：单向的文本推送，SSE 就是最优解，不用犹豫。

| 方案 | 首字延迟 | 总耗时 | 实现复杂度 | 适用场景 |
| --- | --- | --- | --- | --- |
| 非流式 | 高 | 不变 | 最低 | 后台批处理、不需要即时反馈 |
| SSE | 低 | 基本不变 | 低 | 聊天、日志推送、进度反馈 |
| WebSocket | 低 | 基本不变 | 中高 | 双向推送，如语音、协同编辑 |

SSE 的额外好处是协议简单。服务端就是普通 HTTP 响应，不用操心连接升级、心跳、鉴权那一套，浏览器还自带断线重连。WebSocket 强在双向，聊天用不上这个能力——用户的输入走一次普通 POST 就够了。

别用轮询假装流式。前端每 500 毫秒问一次「生成完了吗」，服务端多了一堆无用请求，首字延迟反而更差。

## 六、总结

三句话收尾。

Flux 是入口，真正让它变成流的是 Web 框架把元素一个个写回响应。谁在中间 block 或者聚合，谁就退化成非流式。

工具调用天然有静默期：模型先申请、框架再执行、模型最后才吐字。想让体验好，就把这段状态显式推给前端，别让用户对着空白猜。

流式「看起来没生效」，九成是两个原因：Nginx 缓冲，或者客户端自己在缓冲。先拿 curl -N 直连服务排除客户端因素，再查反代，比盯着 Java 代码猜快得多。

## 参考资料

- [ChatClient（Spring AI Reference）](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Tool Calling（Spring AI Reference）](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [Using server-sent events（MDN Web Docs）](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

文 / 会编程的吕洞宾

---
title: "MCP工具模型不调用？Java服务端到客户端打通"
date: 2026-11-03T20:00:00+08:00
category: "AI"
tags: ["AI", "mcp"]
---

> 工具写好了，MCP 服务也起来了，可模型就是不调用。你问订单状态，它笑眯眯地回答「建议您联系客服」。日志干干净净，连一次 tools/call 都没有。问题很少出在模型身上，多半是工具描述写废了、传输方式选错了，或者客户端压根没拿到工具列表。这篇从服务端开局，一路写到 Java 客户端真正把工具交给模型，每一段都能独立验证。

## 一、这个问题到底是什么

先给结论：**MCP 不是「给大模型加插件」的魔法，它只是一套让外部程序把工具清单和调用结果讲清楚的协议。**

协议讲清楚了，模型才会用；讲不清楚，模型只会绕开。

多数人第一次接触 MCP，是在 Claude Desktop 或 Cursor 里配一个 `mcpServers`，然后发现某个服务能查文件、能搜网页。于是自然以为：Java 后端照葫芦画瓢写个 MCP Server，模型就能用了。真动手才发现三个环节各有一道坎。

第一道坎在服务端。`@McpTool` 注解加了，启动也没报错，但工具根本没注册上。原因通常很朴素：方法不是 Spring Bean，或者参数类型没被正确转成 JSON Schema。

第二道坎在传输。stdio、SSE、Streamable HTTP 三种方式，配置项完全不一样。抄了 SSE 的配置去连 Streamable HTTP 的端点，表现就是 404 或者连接直接断。SSE 在 MCP 新版规范里已经被 Streamable HTTP 取代，网上大量教程还是旧的。

第三道坎在客户端。工具拿到了，但没挂到 `ChatClient` 上；或者挂上了，工具描述写得像函数注释，模型看不懂什么时候该用。

这篇文章解决的就是这三道坎：写一个能跑的服务端，配一个能连的客户端，再让模型真的把工具调起来。中间穿插一个不经过模型的调试方法，让你在怀疑模型之前，先确认协议层是通的。

## 二、底层原理到底怎么回事

### MCP 的本质是一套 JSON-RPC 方法名

MCP 全称 Model Context Protocol，跑在 JSON-RPC 2.0 上。一句话解释：客户端发一个带 `method` 和 `params` 的 JSON，服务端回一个带 `result` 或 `error` 的 JSON。跟你调 REST 接口没本质区别，只是方法名和数据结构被规范固定了。

服务端能对外提供三类东西：

| 类型 | 干什么 | 典型例子 |
| --- | --- | --- |
| Tools | 可执行的动作，模型能主动调用 | 查订单、发邮件、跑 SQL |
| Resources | 只读数据，按 URI 取 | `policy://refund` 退款政策 |
| Prompts | 预置的提示词模板 | 客服话术模板 |

模型真正会主动调的只有 Tools。Resources 和 Prompts 通常由客户端界面呈现给用户选择。搞混这一点，会写出「把知识库塞进 Resource 然后指望模型自己去读」的代码，然后困惑为什么模型不读。

### 一次工具调用，网络上发生了什么

完整的握手有四步，少一步都不行：

1. 客户端发 `initialize`，带上自己支持的协议版本和能力
2. 服务端回 `initialize` 结果，带上服务名、版本、支持的能力
3. 客户端发 `notifications/initialized` 通知，握手结束
4. 客户端发 `tools/list` 拿工具清单，之后每次调用发 `tools/call`

这四步是协议层的事，Spring AI 的 starter 已经封装好了。你只需要知道：**`tools/list` 只发生一次**，在客户端启动连接的时候。这意味着服务端后来新增的工具，客户端不重启是看不到的，除非服务端主动发 `notifications/tools/list_changed`。

工具清单长这样，注意 `inputSchema` 是标准 JSON Schema：

```json
{
  "name": "query_order_status",
  "description": "按订单号查询订单状态、金额和下单时间。订单号必须是纯数字。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "orderNo": {
        "type": "string",
        "description": "纯数字订单号，8 到 20 位"
      }
    },
    "required": ["orderNo"]
  }
}
```

**模型看到的全部信息，就是这段 JSON。** 它看不到你的 Java 方法体，看不到注释，也看不到参数上的校验注解。方法名叫 `queryOrderStatus`，经注解改名后模型看到的是 `query_order_status`；`description` 写「查询订单」，模型就只能靠猜。

这就是「模型不调用工具」最常见的原因：不是它不愿意，是它不知道这工具能干什么、什么时候该干。

### 模型调用工具的真实流程

大模型本身不能执行任何代码。它只会输出一段结构化的「我想调用这个工具，参数是这些」，行业里叫 tool call。真正执行的是你的客户端代码。

所以一次完整的往返是这样的：

1. 客户端把用户问题 + 工具清单发给模型
2. 模型回：「调 `query_order_status`，参数 `orderNo=20261103001`」
3. 客户端通过 MCP 把这次调用转发给服务端
4. 服务端执行 Java 方法，把返回值序列化成文本或 JSON
5. 客户端把结果塞回对话，再问模型一次
6. 模型基于结果生成最终回答

第 3 步到第 5 步，就是 MCP 存在的意义。没有 MCP，这层转发得你自己写 HTTP 接口、自己定参数格式、自己处理错误。

这里有个容易忽略的成本：**工具返回的内容会原样进入上下文，按 token 计费。** 返回一个嵌套五层、字段三十个的 Java 对象，模型可能只用到其中两个字段，剩下的全在烧钱。工具返回值要像给人看的短信，不是给数据库看的全量快照。

### 三种传输方式的区别

| 传输 | 进程关系 | 适用场景 | 配置特征 |
| --- | --- | --- | --- |
| stdio | 客户端拉起服务端子进程，走标准输入输出 | 本地工具、桌面客户端 | 配启动命令和参数 |
| Streamable HTTP | 服务端独立部署，客户端发 HTTP 请求 | 跨机器、多客户端、生产环境 | 配 URL，默认端点 `/mcp` |
| SSE | 长连接推事件 | 旧版，已被 Streamable HTTP 取代 | 不建议新项目使用 |

stdio 最大的坑跟协议无关：**标准输出被 JSON-RPC 独占**。Spring Boot 启动时那行 banner、每条控制台日志，只要写进 stdout，就会混进 JSON 报文里，客户端解析直接失败。表现是「服务启动成功，但客户端说连接断开」。

Streamable HTTP 没这个问题，代价是要处理网络层的鉴权、超时和会话。

## 三、实战：手把手写代码

分三个独立的部分：服务端、客户端、协议层自测。建议按顺序来，每步都能单独验证。

### 示例一：写一个订单查询 MCP 服务端

先建 Maven 项目。依赖只有 MCP 服务端 starter，它自带 Web 容器，不需要再引 `spring-boot-starter-web`。

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
    <artifactId>order-mcp-server</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-mcp-server-webmvc</artifactId>
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

启动类没什么特别的：

```java
package com.example.mcpserver;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderMcpServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderMcpServerApplication.class, args);
    }
}
```

订单模型用 record，字段刻意保持少而扁平。原因前面讲过：模型会为每个字段付 token。

```java
package com.example.mcpserver.order;

public record OrderStatus(
        String orderNo,
        String status,
        String amount,
        String createdAt
) {
}
```

仓库先用内存 Map 顶着，方便你直接跑起来：

```java
package com.example.mcpserver.order;

import java.util.Map;
import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {

    private final Map<String, OrderStatus> orders = Map.of(
            "20261103001", new OrderStatus("20261103001", "已支付", "199.00", "2026-11-03 09:12"),
            "20261103002", new OrderStatus("20261103002", "已发货", "89.50", "2026-11-02 20:03")
    );

    public OrderStatus findByOrderNo(String orderNo) {
        return orders.get(orderNo);
    }
}
```

工具类是本篇的重点。仔细看 `description` 的写法：它不描述「这个方法做了什么」，它描述「什么时候该用、什么时候不该用、参数长什么样」。

```java
package com.example.mcpserver.order;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

@Component
public class OrderTools {

    private final OrderRepository repository;

    public OrderTools(OrderRepository repository) {
        this.repository = repository;
    }

    @McpTool(
            name = "query_order_status",
            description = "按订单号查询订单的当前状态、支付金额和下单时间。"
                    + "订单号是纯数字，例如 20261103001。"
                    + "用户只提供商品名、手机号或模糊描述时，不要调用本工具，先向用户索要订单号。"
    )
    public OrderStatus queryOrderStatus(
            @McpToolParam(description = "纯数字订单号，8 到 20 位", required = true)
            String orderNo) {

        if (orderNo == null || !orderNo.matches("\\d{8,20}")) {
            return new OrderStatus(orderNo, "参数格式错误：订单号必须是 8 到 20 位纯数字", null, null);
        }

        OrderStatus status = repository.findByOrderNo(orderNo);
        if (status == null) {
            return new OrderStatus(orderNo, "未找到该订单", null, null);
        }
        return status;
    }
}
```

两个设计决定值得说明。

参数非法和查不到，都返回一个正常的结果对象，没有抛异常。异常在 MCP 层会变成 `isError=true` 的错误响应，有些模型看到错误就反复重试，反而更糟。把「没查到」当成一种正常业务结果告诉模型，它能直接转述给用户。

返回类型是 record，框架会用 JSON 序列化后作为文本内容回给客户端。所以字段名就是模型看到的字段名，别用 `flag`、`type`、`data` 这种含糊命名。

配置文件只需要指定服务名、版本和传输方式：

```yaml
server:
  port: 8080

spring:
  application:
    name: order-mcp-server
  ai:
    mcp:
      server:
        name: order-mcp-server
        version: 1.0.0
        protocol: STREAMABLE
        instructions: 订单查询服务。调用工具前先确认用户给出的是纯数字订单号。
```

启动后 MCP 端点就在 `http://localhost:8080/mcp`，HTTP 方法 POST。

### 示例二：Java 客户端把工具交给模型

客户端是另一个 Spring Boot 应用，端口改成 8081，避免和刚刚的服务端打架。

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
    <artifactId>order-mcp-client</artifactId>
    <version>0.0.1-SNAPSHOT</version>

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
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-mcp-client</artifactId>
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

客户端配置里，`streamable-http.connections` 下面可以挂多个服务，键名随你起。这里叫 `order-server`，后面排查日志时能对上号。

```yaml
server:
  port: 8081

spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4.1-mini
    mcp:
      client:
        type: SYNC
        request-timeout: 30s
        streamable-http:
          connections:
            order-server:
              url: http://localhost:8080/mcp
```

`request-timeout` 默认是 20 秒。查询类工具够用，跑批量任务就得调大，否则模型收到的是超时错误，然后开始编答案。

关键的一步在 `ChatClient` 的构造：把 MCP 自动装配出来的 `SyncMcpToolCallbackProvider` 挂到默认工具上。挂上之后，这个客户端发出的每次对话都会带上工具清单。

```java
package com.example.mcpclient;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.mcp.SyncMcpToolCallbackProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ChatClientConfig {

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder,
                                 SyncMcpToolCallbackProvider mcpToolCallbackProvider) {
        return builder
                .defaultSystem("你是订单客服。涉及具体订单状态时必须调用工具查询，不要凭猜测回答。")
                .defaultToolCallbacks(mcpToolCallbackProvider)
                .build();
    }
}
```

对外暴露一个接口，方便用浏览器直接试：

```java
package com.example.mcpclient;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ChatController {

    private final ChatClient chatClient;

    public ChatController(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @GetMapping("/ask")
    public String ask(@RequestParam String q) {
        return chatClient.prompt()
                .user(q)
                .call()
                .content();
    }
}
```

启动类：

```java
package com.example.mcpclient;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderMcpClientApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderMcpClientApplication.class, args);
    }
}
```

跑起来后访问 `http://localhost:8081/ask?q=订单20261103001到哪了`，模型应该先调 `query_order_status`，再根据返回的「已支付」组织回答。

### 示例三：绕开模型，先验证协议层

模型不调用工具时，最浪费时间的行为是反复改提示词。先确认工具到底有没有被客户端发现。

加一个只读接口，把 MCP 客户端拿到的工具清单原样打出来：

```java
package com.example.mcpclient;

import io.modelcontextprotocol.client.McpSyncClient;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class McpDebugController {

    private final List<McpSyncClient> clients;

    public McpDebugController(List<McpSyncClient> clients) {
        this.clients = clients;
    }

    @GetMapping("/mcp/tools")
    public List<String> tools() {
        return clients.stream()
                .flatMap(client -> client.listTools().tools().stream())
                .map(tool -> tool.name() + " => " + tool.description())
                .toList();
    }
}
```

访问 `http://localhost:8081/mcp/tools`，三种结果对应三种问题：

- 返回空数组：客户端连上了但服务端没注册工具，回服务端查 `@McpTool` 所在类是不是 Bean
- 请求直接 500：连接没建起来，看 URL、端口、传输方式是否匹配
- 有工具但名字怪：多个服务存在同名工具，客户端自动加了前缀，去查 `McpToolNamePrefixGenerator` 的规则

这一步过了，再怀疑模型。工具清单正确但模型仍不调用，问题一定在描述和参数上。

服务端本身也可以用 curl 单独验证。Streamable HTTP 要求 `Accept` 同时接受 JSON 和事件流，第一次 `initialize` 的响应头里会带 `Mcp-Session-Id`，后续请求必须原样带上：

```bash
curl -i -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
          "protocolVersion": "2025-06-18",
          "capabilities": {},
          "clientInfo": {"name": "curl", "version": "1.0.0"}
        }
      }'
```

响应体是 SSE 格式，真正的 JSON 在 `data:` 那一行。很多人看到 `event: message` 就以为接口坏了，其实正常。

## 四、踩坑经验和最佳实践

### 坑一：stdio 模式下控制台日志毁掉一切

用 stdio 传输时，Spring Boot 的 banner 和日志默认写 stdout，和 JSON-RPC 报文混在一起。客户端读到第一行 `:: Spring Boot ::` 就解析失败。

处理方式是把日志全部改成文件输出，并关掉 banner：

```yaml
spring:
  main:
    banner-mode: off

logging:
  file:
    name: logs/mcp-server.log
```

再配一个 `logback-spring.xml`，只保留文件 appender，不挂控制台：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <appender name="FILE" class="ch.qos.logback.core.FileAppender">
        <file>logs/mcp-server.log</file>
        <append>true</append>
        <encoder>
            <pattern>%d{yyyy-MM-dd HH:mm:ss} %-5level %logger{36} - %msg%n</pattern>
        </encoder>
    </appender>

    <root level="INFO">
        <appender-ref ref="FILE"/>
    </root>
</configuration>
```

只有 HTTP 传输才可以把日志大大方方打到控制台。

### 坑二：HTTP 端点默认谁都能调

MCP 服务端的 HTTP 传输不带任何鉴权。端点一暴露，任何能访问到它的人都能列出并执行你注册的全部工具。查订单是只读的还好，要是转账、删库、发邮件，这就是一个没有门锁的后台。

上线前必须在前面加一层 Spring Security，用 Token 或网关鉴权。stdio 没这个问题，它跑在本地进程里，外部网络碰不到。

### 坑三：工具描述写成函数注释

对比两种写法：

```java
// 模型看不懂这是干什么的
@McpTool(name = "query", description = "查询订单")

// 模型知道何时用、怎么用、何时不该用
@McpTool(
    name = "query_order_status",
    description = "按纯数字订单号查询订单状态、金额和下单时间。"
            + "用户只给商品名或手机号时不要调用，先索要订单号。"
)
```

第二种描述里包含了三样模型需要的信息：能力边界、参数形态、反例。工具少于十个时，描述质量对调用准确率的影响，比换模型大得多。

### 坑四：一个工具干太多事

`handle_request(action, params)` 这种万能工具，模型几乎用不好。`action` 该传什么值，全凭它猜。拆成 `query_order_status`、`cancel_order`、`refund_order` 三个独立工具，每个参数都明确，调用准确率立刻不一样。

工具数量也要控制。三十个工具塞进上下文，光是清单就几千 token，模型还容易选错。按业务域拆成多个 MCP 服务，客户端按需连接。

### 坑五：把 MCP 会话当成用户会话

自动装配出来的 `McpSyncClient` 是单例，整个应用共享一个 MCP 会话。`initialize` 和 `tools/list` 只在启动时执行一次。如果服务端按调用者身份过滤工具，第二个用户看到的还是第一个用户的清单。

多租户场景要么用无状态服务端，要么自己按用户创建客户端并负责关闭。别在共享会话上存用户状态。

### 坑六：超时时间没算上模型

`request-timeout` 管的是 MCP 这一次调用的耗时，不包括模型思考时间。工具本身跑 25 秒，配置却是默认 20 秒，模型收到的是超时，然后开始编。慢工具要么调大超时，要么改成异步任务加进度通知。

## 五、性能对比和技术选型

同样是让模型调一个 Java 方法，三条路差别很大：

| 方案 | 调用路径 | 额外开销 | 适合谁 |
| --- | --- | --- | --- |
| 本地 `@Tool` | 模型 → 同进程方法调用 | 一次 JSON 序列化 | 单体应用、工具只给自己用 |
| MCP + stdio | 模型 → 子进程 stdin/stdout | 进程通信 + 序列化 | 桌面客户端、本地工具 |
| MCP + HTTP | 模型 → HTTP → 远程服务 | 网络往返 + 序列化 + 鉴权 | 跨团队、跨语言、多客户端复用 |

延迟的主要来源不是协议本身，是调用次数。一次对话里模型连调五次工具，HTTP 方案就是五个来回。本地 `@Tool` 在这个场景下优势明显，因为它没有网络这一层。

选型我给三条明确建议。

工具只服务一个 Java 应用，用本地 `@Tool`。少一层部署，少一套鉴权，调试直接断点。

工具要被多个客户端复用，或者要用非 Java 写，上 MCP。协议的价值在于解耦：服务端换语言，客户端不用改。

跨机器部署一律用 Streamable HTTP，别用 SSE。新项目没有理由选一个已被取代的传输方式。

MCP 不是性能优化手段，它是集成手段。为了「架构先进」把同进程的方法调用改成 HTTP 往返，是纯粹的倒退。

## 六、总结

模型不调用 MCP 工具，九成情况能归到三个具体原因：工具没注册上、传输配置对不上、描述没写清使用场景。

排查顺序别搞反。先看 `/mcp/tools` 有没有返回工具，再看工具名和描述是否准确，最后才动提示词和模型。跳过前两步直接调 prompt，等于在黑箱里摸开关。

写 MCP 服务端，记住三件事：返回结构要扁平，字段名要给人看；业务上的「没查到」不要抛异常；HTTP 端点上线前必须加鉴权。

写客户端，记住一件事：工具清单是在连接建立时拉取的，服务端改了工具，客户端得重连。

真要说最容易被低估的，是工具描述。它不是注释，它是模型唯一的说明书。你写「查询订单」，模型就只会猜；你写清「只接受纯数字订单号，用户给商品名时先索要订单号」，它才知道什么时候该停下来问一句。

协议只是管道。管道通了，决定效果的是管道两端的人怎么说话。

文 / 会编程的吕洞宾

## 参考资料

- [Spring AI 官方文档：MCP Server Boot Starter](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-server-boot-starter-docs.html)
- [Spring AI 官方文档：MCP Client Boot Starter](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-client-boot-starter-docs.html)
- [Model Context Protocol：Server Concepts](https://modelcontextprotocol.io/docs/learn/server-concepts)
- [Model Context Protocol 规范：Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Model Context Protocol 规范：Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

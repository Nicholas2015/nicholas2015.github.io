---
title: "Java接口变AI工具：MCP Server实战"
date: 2026-10-14T20:00:00+08:00
category: "AI"
tags: ["mcp"]
---

**摘要：** 用 Spring AI 的 MCP Server Starter，把普通 Java 业务方法变成 AI 客户端能直接调用的工具。本文讲清 MCP 协议原理和三种传输方式的取舍，用注解式和编程式两种写法落地，附完整 pom、完整类和 curl 调用验证，让 Claude 这类客户端开箱即用。

> 你肯定遇到过这种事：公司想让 AI 助手帮忙查订单、查库存，于是你在 Claude、Cursor、内部聊天机器人里各接一遍工具。schema 写三份，接口改一次改三处，换个客户端又要重做。MCP（Model Context Protocol）就是为了终结这种重复劳动——它把"给 AI 用的工具"标准化成一个协议，你只写一次 MCP Server，所有支持 MCP 的客户端都能连。这篇文章用一个真实场景，带你用 Spring AI 把一个普通 Java 业务接口变成 MCP 工具，让 Claude 直接调用，全程可复现。

## 一、这个问题到底是什么

MCP Server 解决的问题一句话：一次开发，所有 AI 客户端通用。

先说背景。大模型自己不会查你的数据库。它靠的是"工具调用"（Tool Calling）：你把函数的名字、参数、说明告诉模型，模型自己决定什么时候调、传什么参数进去。过去这套东西没有统一标准，每家客户端各写各的：

- OpenAI 的函数调用格式一份
- Claude 的 tools 格式一份
- 自家聊天机器人再写一份

工具一多，维护成本就上去了；换个客户端，全部重做。这就是所谓 N×M 问题——N 个工具乘以 M 个客户端。

MCP 是一个开放协议，由 Anthropic 提出并开源，现在已经被主流 AI 客户端支持。你可以把它理解成"AI 世界的 USB-C"：工具这边按协议实现一次，客户端那边按协议连接，两边不用互相认识，就像你的充电线不用知道充电头是哪家做的。

对 Java 开发者来说，Spring AI 提供了 MCP Server 的 Spring Boot Starter。你要做的只有两步：

1. 在方法上加一个注解；
2. 让 Spring Boot 启动。

启动时，Spring 会扫描这些注解方法，把它们注册成 MCP 工具，并暴露一个 HTTP 端点。客户端连上来，发一次 `tools/list`，就能看到你所有的工具；用户提问时，客户端发 `tools/call`，你的 Java 方法原地被执行。

这篇文章要干的事很具体：用一个 Spring Boot 服务，把 Java 业务方法包成 MCP 工具，让 Claude 这类客户端开箱即用。

## 二、底层原理到底怎么回事

MCP 本质是一套基于 JSON-RPC 2.0 的客户端-服务器协议：Server 暴露能力，Client 发现能力并调用。

### 一次调用完整发生了什么

整个过程像打电话，来回五步：

1. **握手（initialize）**：客户端连上来，双方互报家底——支持哪个协议版本、各自有什么能力。
2. **发现（tools/list）**：客户端问"你有哪些工具"，服务器返回清单，每条包含名字、描述、参数的 JSON Schema。
3. **决策**：用户提问，模型看着这份清单挑工具，决定调哪个、参数填什么。
4. **调用（tools/call）**：客户端把工具名和参数发过来，服务器执行真实的 Java 方法，把结果按协议返回。
5. **收尾**：模型拿到结果，继续组织给用户的回答。

第二步是关键。模型选工具，全靠两样东西：工具的 **description** 和参数的 **schema**。所以描述写得清不清楚，直接决定 AI 挑得对不对。

### 三种传输方式，选错会很难受

| 传输方式 | 怎么通信 | 适用场景 |
| --- | --- | --- |
| STDIO | 走标准输入输出，进程内通信 | 本地命令行工具、单机 |
| Streamable HTTP | 走普通 HTTP POST/GET，可多客户端 | 线上服务、团队共享 |
| SSE | 旧版 HTTP 长连接，2.0 起已废弃 | 别用了 |

Streamable HTTP 是现在推荐的方式，它取代了 SSE。SSE 有个老毛病：一条长连接只能服务一个会话，做负载均衡和水平扩容都别扭。Streamable HTTP 用普通的 POST 请求承载 JSON-RPC 消息，只在服务器需要主动推送消息时，才临时开一条 SSE 流。

### Spring AI 在中间做了什么

Spring AI 帮你把三层东西黏起来了：

- **注解层**：`@McpTool` 标记的方法，启动时被扫描，参数自动生成 JSON Schema。
- **协议层**：把 Spring AI 的 `ToolCallback` 转换成 MCP 的 `ToolSpecification`，网络通信交给 MCP 官方 Java SDK。
- **传输层**：WebMVC Starter 自动注册 HTTP 端点，默认是 `POST /mcp`。

所以你的业务代码里看不到任何 JSON-RPC 细节，它就是个普通 Spring Bean。

### 和 Spring AI 自带的 @Tool 有什么区别

这是最容易搞混的地方，两套注解长得像，用途完全不同：

- `@Tool`（`org.springframework.ai.tool.annotation.Tool`）：给自己家的应用用。你的 Java 程序自己调模型，工具就在同一个进程里，属于内部函数调用。
- `@McpTool`：给外部客户端用。Claude、Cursor 这些通过协议远程调用你的服务，属于跨进程暴露。

一个是内部函数，一个是对外开接口。别混。

## 三、实战：手把手写代码

一个 Spring Boot 服务，两个示例，再加一段 curl 验证，就能跑通全流程。

### 1. pom.xml

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
    <artifactId>mcp-order-server</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.1</spring-ai.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>${spring-ai.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-mcp-server-webmvc</artifactId>
            <version>2.0.1</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

一个 starter 就够了。它会连带引入 Web MVC、MCP 的 Java SDK 和自动配置，不用你再手动加 web 依赖。

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  ai:
    mcp:
      server:
        name: order-mcp-server
        version: 1.0.0
        protocol: STREAMABLE
        type: SYNC
        capabilities:
          tool: true
          resource: false
          prompt: false
```

几个配置逐条说：

- `protocol: STREAMABLE`：用 Streamable HTTP，也就是上面推荐的线上方案。
- `type: SYNC`：同步阻塞模型，一个请求一个线程，逻辑好写。
- `capabilities`：只开工具能力，关掉资源和提示模板。暴露得越少，攻击面越小。

### 3. 第一个示例：注解式工具

先写一个假的订单服务，别接真数据库，方便你直接跑。

```java
package com.example.mcpserver.order;

import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class OrderService {

    private final Map<String, OrderInfo> fakeDb = new ConcurrentHashMap<>();

    public OrderService() {
        fakeDb.put("ORD20261014001",
                new OrderInfo("ORD20261014001", "已发货", 12900L, "2026-10-13T10:20:00"));
        fakeDb.put("ORD20261014002",
                new OrderInfo("ORD20261014002", "待付款", 5900L, "2026-10-14T09:05:00"));
    }

    public OrderInfo findByNo(String orderNo) {
        OrderInfo order = fakeDb.get(orderNo);
        if (order == null) {
            throw new IllegalArgumentException("订单不存在: " + orderNo);
        }
        return order;
    }
}
```

返回值用 record，字段名会被自动写成输出 schema，模型一眼就知道返回结果长什么样。

```java
package com.example.mcpserver.order;

public record OrderInfo(String orderNo, String status, long amountFen, String createdAt) {
}
```

真正暴露给 AI 的工具类，就长这样：

```java
package com.example.mcpserver.order;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

@Component
public class OrderTools {

    private final OrderService orderService;

    public OrderTools(OrderService orderService) {
        this.orderService = orderService;
    }

    @McpTool(
            name = "query_order",
            description = "根据订单号查询订单的当前状态、金额和下单时间。用户提到具体订单号时调用这个工具。",
            generateOutputSchema = true)
    public OrderInfo queryOrder(
            @McpToolParam(description = "订单号，形如 ORD20261014001", required = true) String orderNo) {
        return orderService.findByNo(orderNo);
    }

    @McpTool(
            name = "cancel_order",
            description = "取消一个尚未发货的订单。这是破坏性操作，执行前必须得到用户明确确认。",
            annotations = @McpTool.McpAnnotations(destructiveHint = true, idempotentHint = true))
    public String cancelOrder(
            @McpToolParam(description = "订单号", required = true) String orderNo) {
        return "订单 " + orderNo + " 已进入取消流程";
    }
}
```

这里有三处细节值得说明：

- `description` 是写给模型看的，重点在"什么时候用"，不是"这个方法是干嘛的"。模型挑工具全靠它。
- `generateOutputSchema = true`：给非基本类型的返回值自动生成输出 schema，模型能更准地理解结果结构。
- `annotations` 里的 `destructiveHint`：标记这是破坏性操作，客户端可以据此弹出二次确认。改数据的接口都该标上。

### 4. 第二个示例：编程式注册

注解不是唯一的路。有些老服务你不想改代码，那就用编程式注册——只要把 `ToolCallbackProvider` 注册成 Bean，启动时会被自动收集。

先看一个普通的 Spring AI 工具（注意这里用的是 `@Tool`，因为它只是普通方法，注册动作由下面的配置类完成）：

```java
package com.example.mcpserver.inventory;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Service;

@Service
public class InventoryService {

    @Tool(name = "query_stock", description = "查询某个商品在仓库中的可用库存数量。")
    public int queryStock(@ToolParam(description = "商品 SKU 编码") String sku) {
        return switch (sku) {
            case "SKU-1001" -> 128;
            case "SKU-1002" -> 0;
            default -> throw new IllegalArgumentException("未知 SKU: " + sku);
        };
    }
}
```

然后写一个配置类，把它转成 MCP 工具：

```java
package com.example.mcpserver.inventory;

import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.ai.tool.method.MethodToolCallbackProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class McpToolConfig {

    @Bean
    public ToolCallbackProvider inventoryToolProvider(InventoryService inventoryService) {
        return MethodToolCallbackProvider.builder()
                .toolObjects(inventoryService)
                .build();
    }
}
```

自动配置会自动识别三种 Bean：单个 `ToolCallback`、`ToolCallback` 列表、`ToolCallbackProvider`。工具按名字去重，同名的话先出现的那个生效。

### 5. 启动类

```java
package com.example.mcpserver;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class McpOrderServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(McpOrderServerApplication.class, args);
    }
}
```

### 6. 不接客户端，先用 curl 验一遍

服务起来后，MCP 端口就在 `POST /mcp`。第一步握手：

```bash
curl -i -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

响应头里会带一个 `mcp-session-id`，后面每次请求都要带上它。接着告诉服务器"我初始化完了"，然后列工具：

```bash
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: 上一步返回的ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: 上一步返回的ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

你应该能看到 `query_order`、`cancel_order`、`query_stock` 三个工具。最后真正调一次：

```bash
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: 上一步返回的ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"query_order","arguments":{"orderNo":"ORD20261014001"}}}'
```

返回的就是你那个 `OrderInfo` 序列化后的内容。注意响应体可能是 SSE 格式（`event: message` 加一行 `data:`），这是 Streamable HTTP 的正常表现，不是出错。

### 7. 接进 AI 客户端

在客户端的配置文件里加一段就行：

```json
{
  "mcpServers": {
    "order-mcp-server": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

重启客户端，问它"帮我查一下订单 ORD20261014001 的状态"，它就会自己调 `query_order`。整条链路你一行胶水代码都没写。

## 四、踩坑经验和最佳实践

MCP 的坑集中在三个地方：传输选择、安全、日志。

- **SSE 别再用了。** 它已经被标记废弃，新项目统一上 `STREAMABLE`。你会在老教程里看到 `/sse` 加 `/mcp/message` 双端点的写法，那是历史包袱，别抄。
- **默认是没有鉴权的。** 官方文档说得很直白：默认配置下，任何能访问到端点的客户端，都可以枚举并调用你注册的每一个工具。上线前必须在前面加一层鉴权（Spring Security 或网关），别裸奔在公网。
- **STDIO 模式下千万别往标准输出打日志。** STDIO 传输时，JSON-RPC 消息就走 stdout，你一个 `System.out.println` 就能把协议流冲垮，客户端只会报解析失败，排查起来一头雾水。日志请走 stderr 或文件。
- **description 写"什么时候用"。** "根据订单号查询订单状态"远不如"用户提到具体订单号时调用这个工具"好使。
- **异常分两种，行为完全不同。** 抛 `RuntimeException`，会被转成一个 error 结果交给模型，模型可以自己纠错重试；把它声明成 checked 异常再抛出去，这次调用直接失败，模型什么都收不到。想让模型自己恢复，就抛运行时异常。
- **破坏性操作要打标。** `destructiveHint`、`idempotentHint` 这些提示客户端会读，用来决定要不要二次确认。
- **返回值别太大。** 工具结果会进入模型上下文，一次返回几万字的 JSON，只是白烧 token。
- **工具不是越多越好。** 同名工具先注册的生效；工具一多，模型也会挑错，跟你面对一屏菜单时的感觉一样。

## 五、性能对比和技术选型

MCP Server 适合"一次开发、多客户端复用"；只服务自家应用，直接用 `@Tool` 更省事。

| 方案 | 开发成本 | 复用范围 | 适合场景 |
| --- | --- | --- | --- |
| MCP Server | 中，要起一个协议端点 | 所有 MCP 客户端 | 对外、跨团队共享能力 |
| 各家自带 Function Calling | 高，每家写一份 | 单客户端 | 只服务一个客户端 |
| Spring AI `@Tool` | 低，加个注解 | 仅自家应用 | 应用内部自己调模型 |

传输方式怎么选：

- **STDIO**：本地、单用户、命令行工具，没法扩容。
- **Streamable HTTP**：线上服务、多客户端、能水平扩容，推荐。
- **Stateless**：不保存会话，微服务集群里最省心，代价是丢掉服务端主动推消息的能力。

一句话：本地玩具用 STDIO，线上服务用 Streamable HTTP，集群里横向扩容优先 Stateless。

## 六、总结

MCP 把"给 AI 用的工具"从各家私有的胶水代码，变成了一个标准协议。对 Java 团队来说，Spring AI 的 MCP Server Starter 让这件事成本低到离谱：一个注解，一个启动类，业务方法原地变成 AI 可调用的工具。

整件事就三步：

1. 加依赖，把 `spring.ai.mcp.server.protocol` 配成 `STREAMABLE`。
2. 业务方法打 `@McpTool`，或者用 `ToolCallbackProvider` 编程式注册。
3. 上线前把鉴权补上。

别把 `@Tool` 和 `@McpTool` 搞混，也别在默认无鉴权的端口上裸奔。剩下就是挑几个真正高频的业务能力暴露出去——工具和菜单一样，选择太多，模型也会挑花眼。

## 参考资料

- [MCP Server Boot Starter（Spring AI 官方文档）](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-server-boot-starter-docs.html)
- [MCP Server Annotations（Spring AI 官方文档）](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-annotations-server.html)
- [Streamable-HTTP MCP Server（Spring AI 官方文档）](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-streamable-http-server-boot-starter-docs.html)
- [MCP Server Concepts（Model Context Protocol 官方文档）](https://modelcontextprotocol.io/docs/learn/server-concepts)
- [Transports（MCP 规范）](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

文 / 会编程的吕洞宾

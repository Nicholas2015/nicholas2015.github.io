---
title: "Java 写 MCP Server：让 Claude 直接调你的接口"
date: 2026-10-27T20:00:00+08:00
category: "AI"
tags: ["AI", "mcp"]
---

> 运维同事想在 Claude 里查一笔订单，只能把订单号复制进对话框，等模型回一句"我看不到你的数据库"，再手动贴日志。公司内部系统几十个，每接一个 AI 客户端就得重写一遍适配。这篇讲怎么用 Spring AI 写一个 MCP Server，把 Java 接口变成 Claude、Cursor 能直接调用的工具，客户端零改造。代码是完整工程，跑通它连大模型 API Key 都不需要。

## 一、这个问题到底是什么：AI 客户端和内部系统之间的那条胶水代码

**MCP 解决的不是"模型不够聪明"，而是"模型够不着你的系统"。**

先把场景摆出来。你有一个订单服务、一个库存服务、一个日志平台。现在有三拨人要用 AI：产品经理在用 Claude Desktop 查数据，后端在用 Cursor 写代码想顺便查线上订单，你们自研的客服 Agent 也要查订单。

三拨人，三个客户端，三种接法。

Claude Desktop 要的是它的 MCP 配置，Cursor 要的是 `.cursor/mcp.json`，自研 Agent 要的是 Function Calling 的 JSON Schema。你写了三套描述、三套参数校验、三套错误处理。下个月接入第四个客户端，再来一遍。

**MCP 就是把这件事从 M×N 变成 M+N。** M 个客户端都实现同一套协议，N 个系统都暴露同一套协议，中间不需要两两配对。

打个比方：以前的手机充电口有圆孔、有扁口、有排线，每个充电器配一个手机。USB-C 出来之后，充电器只管输出电，手机只管接收电，中间的形状定死了。MCP 就是 AI 工具调用领域的 USB-C。

把协议里的角色说清楚，后面写代码才不会糊涂：

| 角色 | 是什么 | 例子 |
| --- | --- | --- |
| Host | 用户直接操作的 AI 应用 | Claude Desktop、Cursor、你们自研的客服后台 |
| Client | Host 内部的一个连接器，一个 Client 连一个 Server | Host 启动时按配置建出来的 |
| Server | 你写的那个程序，暴露工具和数据 | 本文要写的订单管理 Server |

一个 Host 可以开多个 Client，连多个 Server。你在 Claude Desktop 里配了三个 MCP Server，它就是三个 Client 在跑。

接着是 Server 能提供的三类东西，很多人一上来就混：

| 能力 | 谁决定用 | 典型场景 | 类比 |
| --- | --- | --- | --- |
| Tools | 模型决定 | 查订单、发工单、算运费 | 给模型一双手 |
| Resources | 客户端或用户决定 | 配置文件、排障手册、日志片段 | 给模型一本书，它自己翻 |
| Prompts | 用户主动选 | 预置的提示词模板 | 给用户的快捷指令 |

区别在于控制权。Tools 是模型自己判断"我该调这个"，Resources 是客户端把内容塞进上下文，Prompts 是人在界面上点一下。

这里有两个常见误解，先拆掉。

第一个误解：MCP 是模型的能力。不是。MCP 是传输协议，跟 HTTP 是一层的东西。模型根本不知道 MCP 的存在，它只看到"有这么几个工具，参数长这样"。是 Host 把 MCP 的工具列表翻译成模型能懂的 Function Calling 格式。

第二个误解：写好 MCP Server，模型就会用。也不会。工具叫什么名字、描述怎么写、参数说明清不清楚，直接决定模型选不选得对。同一个查询接口，描述写"查询订单"，模型经常拿它去查用户；写成"按订单号查询订单详情，订单号格式 SO 开头"，命中率立刻不一样。

所以这篇文章的重点不止是"怎么把接口挂上去"，还有"怎么让模型用得对"。

## 二、底层原理：一次工具调用在协议层到底发生了什么

**MCP 的报文就是 JSON-RPC 2.0，没有魔法。** 你把这三步看明白，调试时看到任何报错都知道该往哪查。

### 2.1 三步走：握手、列清单、调用

第一步，握手。Client 连上来先发 `initialize`，告诉 Server 自己支持哪些能力、协议版本是多少。Server 回一份自己的能力清单。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cursor","version":"1.0"}}}
```

Server 的响应里有个关键东西：`Mcp-Session-Id` 响应头。后续所有请求都要带上它，服务端靠这个认出"还是刚才那个客户端"。

第二步，列清单。Client 发 `tools/list`，Server 返回工具数组，每个工具带名字、描述、`inputSchema`（一个标准 JSON Schema）。

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

模型看到的"工具"，本质就是这个数组被 Host 转换后的样子。所以描述写得烂，模型就是瞎猜。

第三步，调用。模型决定用某个工具，Host 发 `tools/call`，带上工具名和参数对象。

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"get_order","arguments":{"orderNo":"SO20261027001"}}}
```

Server 执行完，返回 `content` 数组。里面可以是文本、图片、资源引用。模型读这段 content 继续推理。

三步之外还有 `notifications/initialized`，握手完 Client 要发一条通知，表示准备就绪。这条没有 `id`，也不会有响应 —— JSON-RPC 里没有 `id` 的就是通知，别傻等返回。

### 2.2 传输层：stdio 和 Streamable HTTP

同样的报文，可以走两种管道。

| | stdio | Streamable HTTP |
| --- | --- | --- |
| 怎么连 | Host 启动子进程，通过标准输入输出收发 | HTTP POST，服务端用 SSE 流式返回 |
| 适合 | 本机工具、单用户、Claude Desktop | 团队共享、部署在服务器、多客户端 |
| 鉴权 | 靠操作系统用户权限 | 自己做，协议不管 |
| 部署 | 跟着客户端走 | 独立服务，能扩能监控 |

stdio 模式下，一个 JSON 一行，写进子进程的 stdin，从 stdout 读结果。简单粗暴，但有个致命细节：**stdout 只能有协议数据，一个字符都不能多。** 你在代码里随手一个 `System.out.println`，或者日志框架往控制台打一行 INFO，客户端的 JSON 解析器立刻崩。这个坑后面单独讲。

Streamable HTTP 是现在的主流。2025-03-26 版规范用它取代了早期的 HTTP+SSE 双端点方案 —— 老方案要维持一条长连接收消息，另开一个端点发消息，过网关、过负载均衡都容易断。新方案把收发合成一个 `/mcp` 端点，响应可以是普通 JSON，也可以升级成 SSE 流，断线了客户端还能重连续上。

服务端返回 SSE 时，你在 curl 里看到的是这样：

```
event: message
data: {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
```

不是 JSON 坏了，是流式帧格式。客户端库会帮你拆。

### 2.3 框架替你做的事

手写这套协议大概要几百行：解析 JSON-RPC、维护会话、把 Java 方法反射成 JSON Schema、把返回值序列化成 content。

Spring AI 把这些包了。你写一个普通 Spring Bean，方法上打 `@McpTool`，它做四件事：

1. 扫描容器里所有带 `@McpTool` 的方法
2. 读方法签名和 `@McpToolParam`，生成 JSON Schema
3. 把工具注册进 MCP Server 的能力清单
4. 收到 `tools/call` 时反射调用，把返回值序列化成 content

有个细节值得单独说：**参数名是从字节码里读的，不是从注解里读的。** `@McpToolParam` 只有 `description` 和 `required` 两个属性，没有 `name`。所以 Java 编译时必须带 `-parameters`，否则反射拿到的是 `arg0`、`arg1`，生成的 schema 里参数名就是 `arg0`。模型看到 `arg0` 只能靠位置猜，参数一多必错。

Spring Boot 的 parent POM 默认开了 `-parameters`，你只要别自己瞎改 compiler 配置就没事。但如果你是老项目迁移过来，或者公司有统一的编译插件配置，这条一定要查。

### 2.4 同步、异步、有状态、无状态

四个词，两两组合，别被绕晕。

同步（sync）和异步（async）说的是你工具方法的写法。同步方法直接返回结果，Spring 在 MVC 的线程池里执行；异步方法返回 `Mono` 或 `Flux`，适合调用下游本来就是响应式的场景。本文全用同步，简单。

有状态（streamable/sse）和无状态（stateless）说的是会话。有状态时，服务端记住每个客户端，支持"服务端反向问客户端"这种双向操作 —— 比如 sampling（让客户端那边的模型帮你生成内容）、elicitation（让用户补充信息）。无状态就是一次请求一次响应，服务端不存任何东西，随便扩副本，但双向能力全没了。

默认是 `streamable`，也就是有状态。大部分场景够用。真要做成无状态，配一行 `protocol: stateless`，代价是你不能再用 `McpSyncRequestContext` 那些双向方法 —— 用了会被静默忽略，不报错，这个坑很阴。

## 三、实战：从零写一个订单管理 MCP Server

**目标：一个跑在 8080 端口的服务，暴露三个订单工具、一个排障手册资源、一个退款审核提示词，Cursor 配上就能用。**

不需要 API Key，不需要模型。MCP Server 只负责把能力摆出来，谁来调是客户端的事。

### 3.1 依赖和配置

`pom.xml`：

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
    <artifactId>mcp-order-server</artifactId>
    <version>1.0.0</version>
    <name>mcp-order-server</name>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.2</spring-ai.version>
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

只加一个 starter，它会把 Web MVC、MCP 协议实现、注解扫描器全带进来。

`src/main/resources/application.yml`：

```yaml
server:
  port: 8080

spring:
  application:
    name: mcp-order-server
  ai:
    mcp:
      server:
        name: order-admin
        version: 1.0.0
        protocol: streamable
        type: sync
        instructions: "订单与售后工具集。订单号格式为 SO 开头，查订单前先确认格式。写操作会真实修改数据，调用前必须先向用户确认。"
        tool-response-mime-type:
          get_order: application/json
        streamable-http:
          mcp-endpoint: /mcp
```

`instructions` 会被塞进客户端看到的服务说明里，相当于给模型的总体提示。写清楚"这是订单域、写操作要确认"，比在每个工具描述里重复一遍省事。

`tool-response-mime-type` 是给返回内容指定 MIME 类型的，客户端有些会按类型渲染。不配也能跑。

启动类：

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

### 3.2 工具类：三个方法，覆盖查、搜、写

这是全篇最核心的一段。注意每个方法上的注解怎么写，以及为什么这么写。

```java
package com.example.mcpserver.tools;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

@Component
public class OrderTools {

    public record Order(String orderNo, String customer, String status,
                        BigDecimal amount, LocalDateTime createdAt) {
    }

    public record OrderPage(List<Order> items, int page, int size, long total) {
    }

    private final Map<String, Order> orders = new ConcurrentHashMap<>();

    public OrderTools() {
        seed("SO20261027001", "张伟", "PAID", "399.00", 2);
        seed("SO20261027002", "张伟", "SHIPPED", "1299.00", 5);
        seed("SO20261027003", "李娜", "REFUNDING", "89.90", 1);
        seed("SO20261027004", "王强", "PAID", "2480.00", 9);
        seed("SO20261027005", "李娜", "CLOSED", "59.00", 20);
    }

    private void seed(String orderNo, String customer, String status, String amount, int daysAgo) {
        orders.put(orderNo, new Order(orderNo, customer, status, new BigDecimal(amount),
                LocalDateTime.now().minusDays(daysAgo)));
    }

    @McpTool(
            name = "get_order",
            description = "按订单号查询订单详情，返回状态、金额、下单时间。订单号格式为 SO 加日期加序号。这是只读操作。",
            annotations = @McpTool.McpAnnotations(readOnlyHint = true, openWorldHint = false))
    public Order getOrder(
            @McpToolParam(description = "订单号，例如 SO20261027001", required = true) String orderNo) {
        Order order = orders.get(orderNo.trim().toUpperCase(Locale.ROOT));
        if (order == null) {
            throw new IllegalArgumentException("订单不存在: " + orderNo);
        }
        return order;
    }

    @McpTool(
            name = "search_orders",
            description = "按客户姓名模糊查询订单，可以再按状态过滤。用于排查某个用户的订单情况，返回分页结果。这是只读操作。",
            annotations = @McpTool.McpAnnotations(readOnlyHint = true, openWorldHint = false))
    public OrderPage searchOrders(
            @McpToolParam(description = "客户姓名，支持部分匹配", required = true) String customer,
            @McpToolParam(description = "订单状态，可选值 PAID、SHIPPED、REFUNDING、CLOSED，不传表示全部", required = false) String status,
            @McpToolParam(description = "页码，从 1 开始，默认 1", required = false) Integer page) {
        int current = (page == null || page < 1) ? 1 : page;
        int size = 10;
        List<Order> matched = orders.values().stream()
                .filter(order -> order.customer().contains(customer))
                .filter(order -> status == null || status.isBlank()
                        || order.status().equalsIgnoreCase(status))
                .sorted(Comparator.comparing(Order::createdAt).reversed())
                .toList();
        int from = Math.min((current - 1) * size, matched.size());
        int to = Math.min(from + size, matched.size());
        return new OrderPage(matched.subList(from, to), current, size, matched.size());
    }

    @McpTool(
            name = "create_refund_ticket",
            description = "为指定订单创建退款工单。这是写操作，会真实修改订单状态为 REFUNDING，调用前必须先向用户确认订单号和原因。",
            annotations = @McpTool.McpAnnotations(readOnlyHint = false, destructiveHint = true, idempotentHint = false))
    public String createRefundTicket(
            @McpToolParam(description = "订单号", required = true) String orderNo,
            @McpToolParam(description = "退款原因，写清楚用户诉求", required = true) String reason) {
        Order updated = orders.computeIfPresent(orderNo.trim().toUpperCase(Locale.ROOT), (no, old) -> {
            if ("CLOSED".equals(old.status())) {
                throw new IllegalStateException("订单已关闭，不能退款: " + no);
            }
            return new Order(old.orderNo(), old.customer(), "REFUNDING", old.amount(), old.createdAt());
        });
        if (updated == null) {
            throw new IllegalArgumentException("订单不存在: " + orderNo);
        }
        return "已创建退款工单，订单 " + updated.orderNo() + " 状态变为 REFUNDING，原因：" + reason;
    }
}
```

几个设计决定，值得说透。

**为什么返回 record 而不是 Map。** 返回对象时，框架会用 Jackson 序列化成 JSON。record 的字段名就是 schema 的字段名，模型看到的结构稳定。用 `Map<String, Object>` 也能跑，但字段名靠你手写字符串，改一次忘一处，模型就开始瞎猜。

**为什么查询方法用 `IllegalArgumentException` 而不是返回 null。** 抛 `RuntimeException` 时，框架会把它转成一个"工具执行失败"的结果返回给模型，模型能看到错误信息，可以换个订单号重试。返回 null 的话，模型看到的是 `null`，它不知道是"没查到"还是"系统坏了"，经常自作聪明编一个订单出来。

**为什么写操作要标 `destructiveHint`。** 这不是装饰。客户端读这个字段决定要不要弹确认框。标了 `readOnlyHint = false` 加 `destructiveHint = true`，Cursor 和 Claude Desktop 调这个工具前会让人点一下。不标，模型可能在你没看清的时候就把订单改成退款了。

**为什么分页。** 见踩坑那节，返回大列表是最容易把 token 打爆的操作。

### 3.3 资源与提示词：把排障手册和审核模板也挂上去

工具之外，再挂一个资源和一个提示词。资源是"客户端可以主动读的内容"，提示词是"用户可以在界面上选的模板"。

```java
package com.example.mcpserver.resources;

import java.util.Map;

import org.springframework.ai.mcp.annotation.McpResource;
import org.springframework.stereotype.Component;

@Component
public class OpsResourceProvider {

    private static final Map<String, String> RUNBOOKS = Map.of(
            "order", """
                    # 订单服务排障手册

                    1. 先确认订单号格式是 SO 加 8 位日期加 3 位序号。
                    2. 用 get_order 查看当前状态，PAID 表示已付款未发货。
                    3. 状态卡在 REFUNDING 超过 24 小时，查退款任务表 refund_task。
                    4. 金额对不上，先看订单表的 amount 和支付流水表的 pay_amount 是否一致。
                    """,
            "payment", """
                    # 支付服务排障手册

                    1. 支付回调丢失时，先查网关日志里的 notify 记录。
                    2. 重复扣款优先看幂等键 out_trade_no 是否重复。
                    3. 退款失败看渠道返回码，不要直接重试，先确认渠道侧状态。
                    """);

    @McpResource(
            uri = "ops://runbook/{service}",
            name = "runbook",
            title = "服务排障手册",
            description = "按服务名读取线上排障步骤，例如 ops://runbook/order",
            mimeType = "text/markdown")
    public String runbook(String service) {
        String content = RUNBOOKS.get(service);
        if (content == null) {
            throw new IllegalArgumentException("没有该服务的排障手册: " + service);
        }
        return content;
    }
}
```

`uri` 里的 `{service}` 是模板变量，方法参数按顺序接。客户端读 `ops://runbook/order`，框架把 `order` 传进 `runbook(String service)`。

注意资源方法的参数没有 `@McpToolParam`，也不需要 —— 客户端不是"填参数"，是"请求这个 URI"。

提示词这块，配一个退款审核模板，再配一个参数自动补全：

```java
package com.example.mcpserver.prompts;

import java.util.List;

import io.modelcontextprotocol.spec.McpSchema.GetPromptResult;
import io.modelcontextprotocol.spec.McpSchema.PromptMessage;
import io.modelcontextprotocol.spec.McpSchema.Role;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import org.springframework.ai.mcp.annotation.McpArg;
import org.springframework.ai.mcp.annotation.McpComplete;
import org.springframework.ai.mcp.annotation.McpPrompt;
import org.springframework.stereotype.Component;

@Component
public class RefundPromptProvider {

    private static final List<String> SAMPLE_ORDER_NOS = List.of(
            "SO20261027001", "SO20261027002", "SO20261027003");

    @McpPrompt(
            name = "refund-review",
            description = "生成一份退款审核清单，把订单事实和用户诉求一起交给模型判断")
    public GetPromptResult refundReview(
            @McpArg(name = "orderNo", description = "订单号", required = true) String orderNo,
            @McpArg(name = "reason", description = "用户退款原因", required = false) String reason) {
        String text = """
                你是电商售后审核员。根据下面的信息判断是否同意退款，并给出处理建议。

                订单号：%s
                用户诉求：%s

                要求：
                1. 先调用 get_order 查订单真实状态，不要凭用户描述下结论。
                2. 订单已发货的，说明需要先确认物流签收情况。
                3. 订单已关闭的，直接说明不能退款并给出替代方案。
                """.formatted(orderNo, reason == null ? "未提供" : reason);

        PromptMessage message = new PromptMessage(Role.USER, TextContent.builder(text).build());
        return GetPromptResult.builder(List.of(message))
                .description("退款审核")
                .build();
    }

    @McpComplete(prompt = "refund-review")
    public List<String> completeOrderNo(String prefix) {
        return SAMPLE_ORDER_NOS.stream()
                .filter(orderNo -> orderNo.startsWith(prefix))
                .toList();
    }
}
```

`@McpComplete` 是输入补全。用户在客户端里输入 `SO2026`，候选框里自动跳出匹配的订单号。方法参数只有一个 `String prefix`，返回匹配列表。这个功能用户感知很强，实现成本极低，建议每个需要输 ID 的提示词都配上。

### 3.4 跑起来，先用 curl 验一遍

```bash
mvn spring-boot:run
```

启动日志里能看到 Tomcat 起在 8080。别急着接客户端，先用 curl 把协议走一遍 —— 出问题时你能分清是服务端的问题还是客户端配置的问题。

```bash
# 1. 初始化，同时把会话 ID 抓出来
SESSION_ID=$(curl -s -D - -o /tmp/mcp-init.json \
  -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')

echo "session: $SESSION_ID"
cat /tmp/mcp-init.json

# 2. 发就绪通知，这条没有响应体
curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. 列工具，应该看到三个名字
curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 4. 真调一次
curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_order","arguments":{"orderNo":"SO20261027001"}}}'
```

第 3 步的返回里，`inputSchema.properties` 应该是 `orderNo`、`customer`、`status`、`page` 这些你写的名字。**如果看到 `arg0`、`arg1`，立刻停下**，说明编译没带 `-parameters`，先把这个问题解决再接客户端。

第 4 步的返回大概长这样（SSE 帧格式，`data:` 后面才是 JSON）：

```
event: message
data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"orderNo\":\"SO20261027001\",\"customer\":\"张伟\",\"status\":\"PAID\",\"amount\":399.00,\"createdAt\":\"2026-10-25T10:12:33\"}"}]}}
```

注意 content 里是**字符串**，不是对象。MCP 的内容块只有 text、image 这几种，结构化数据只能序列化成文本塞进去。客户端那边再反序列化。

### 3.5 接到 Cursor 上

在项目根目录建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "order-admin": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

重启 Cursor，打开设置里的 MCP 面板，`order-admin` 应该是绿的，点开能看到 `get_order`、`search_orders`、`create_refund_ticket` 三个工具，还有 `runbook` 资源和 `refund-review` 提示词。

然后在对话框里说一句"帮我查一下 SO20261027001 这单什么情况"。模型会先调 `get_order`，再根据返回整理成人话。调写操作时，Cursor 会弹确认框 —— 那是 `destructiveHint` 生效了。

Claude Desktop 也能配 HTTP 类型的 MCP Server，但它对本地 HTTP 的支持各版本差异较大，稳妥的做法是用 stdio 版。

### 3.6 stdio 版：让 Claude Desktop 直接拉起来

stdio 版的代码和上面**完全一样**，只换 starter 和打包方式。

依赖换成：

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-mcp-server</artifactId>
    <version>2.0.2</version>
</dependency>
```

这个 starter 只带 `spring-boot-starter`，没有 Web 容器，进程不会去占端口，纯靠标准输入输出通信。

配置加一行：

```yaml
spring:
  ai:
    mcp:
      server:
        name: order-admin
        version: 1.0.0
        stdio: true
        type: sync
```

只想本机试一下的话，`stdio: true` 写在配置里就够了，`mvn spring-boot:run` 之后终端会直接等标准输入。

然后是那个致命细节。Spring Boot 默认的日志输出走 **stdout**，而 stdio 协议规定 stdout 只能有 JSON-RPC 报文。只要启动时打一行 `Started McpOrderServerApplication in 1.2 seconds`，客户端的解析器就炸了。

解决办法是把日志赶到 stderr。加一个 `src/main/resources/logback-spring.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <appender name="STDERR" class="ch.qos.logback.core.ConsoleAppender">
        <target>System.err</target>
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} %-5level %logger{36} - %msg%n</pattern>
        </encoder>
    </appender>

    <root level="INFO">
        <appender-ref ref="STDERR"/>
    </root>
</configuration>
```

`<target>System.err</target>` 这一行是关键。没有它，日志就混进协议流。

打包后配到 Claude Desktop 的 `claude_desktop_config.json`（macOS 在 `~/Library/Application Support/Claude/`，Windows 在 `%APPDATA%\Claude\`）：

```json
{
  "mcpServers": {
    "order-admin": {
      "command": "/usr/bin/java",
      "args": ["-jar", "/opt/mcp/mcp-order-server-1.0.0.jar"]
    }
  }
}
```

`command` 必须写绝对路径。Claude Desktop 启动子进程时的 PATH 和你终端里的不一样，写 `java` 大概率找不到。

重启 Claude Desktop，对话框右下角的工具图标里能看到这三个工具。第一次调用会慢一点，JVM 冷启动。

## 四、踩坑经验和最佳实践

**这一节的每一条都是线上真会崩的地方，不是理论风险。**

### 4.1 stdout 里多一个字符都不行

stdio 模式下，`System.out.println("debug")`、某个第三方库的 banner、日志框架的默认输出，全都会把协议流搅烂。表现是客户端报"Unexpected token"或者干脆连不上，服务端日志看起来一切正常。

排查方法：手动跑一次 `java -jar xxx.jar`，看终端输出。如果第一行不是 JSON，就是被污染了。

除了 logback 改 stderr，还要注意别在工具方法里用 `System.out`。用日志框架，级别调好。

### 4.2 参数名变成 arg0

前面说过，`@McpToolParam` 没有 `name` 属性，参数名靠 `-parameters` 编译标志。Spring Boot parent 默认开，但以下情况会丢：

- 用了公司自建的 parent POM，覆盖了 `maven-compiler-plugin` 配置
- 用 Gradle 且没写 `options.compilerArgs << '-parameters'`
- 用 IDE 直接跑，IDE 的编译设置和 Maven 不一致

验证方式就是看 `tools/list` 返回的 schema。看到 `arg0` 就回头查编译配置。

### 4.3 RuntimeException 和受检异常的语义完全不同

这条最容易踩，因为两种写法在代码里都"能编译、能跑"。

- 抛 `RuntimeException`：框架捕获，转成工具执行失败的结果，**模型能看到错误信息**，可以调整参数重试。
- 抛受检异常（`throws IOException` 且在方法签名里声明）：直接往上抛，**工具调用失败，模型看不到内容**。

所以选择标准很清楚：

| 情况 | 抛什么 | 为什么 |
| --- | --- | --- |
| 参数不合法、订单不存在 | RuntimeException | 模型能看懂，换个参数再试 |
| 下游超时、临时故障 | RuntimeException | 模型可以稍后重试或换工具 |
| 权限不足、内部实现细节 | 受检异常 | 不想让模型看到堆栈和内部信息 |
| 绝对不该重试的错误 | 受检异常 | 直接让调用失败，不浪费 token |

我自己的习惯是：业务层能自解释的错误一律 RuntimeException，涉及内部实现的一律包成受检异常往上扔。

### 4.4 返回值别贪大

工具返回的内容会原样进模型上下文，占的是 token 预算。

一个 `search_orders` 返回 500 条订单，每条 200 字，就是 10 万 token。模型上下文直接爆，客户端报错或者悄悄截断，用户看到的是"模型胡说八道"。

三条规矩：

1. 列表必须分页，默认 10 到 20 条
2. 只返回模型决策需要的字段，别把 `createdBy`、`updatedBy`、`version` 这些内部字段带出去
3. 长文本字段截断，比如商品描述只给前 100 字

需要完整数据时，另给一个"导出"工具，返回文件路径或者下载链接，而不是把内容塞进上下文。

### 4.5 MCP Server 默认没有鉴权

`spring-ai-starter-mcp-server-webmvc` 起的是一个裸的 Spring MVC 应用，**没有任何认证**。谁都能 POST 到 `/mcp`，谁都能调你的 `create_refund_ticket`。

绑 `0.0.0.0` 又没做防护，等于把内部接口公开到公网。

最低限度的做法：

- 开发阶段 `server.address: 127.0.0.1`，只监听本机
- 部署时挂在网关后面，用 API Key 或 OAuth2 拦一层
- 在应用里加 Spring Security，对 `/mcp` 路径做认证
- 写操作全部标 `destructiveHint = true`，让客户端弹确认

工具描述里也要写清楚"这是写操作，调用前必须向用户确认"。模型会读描述，大部分情况下会先问一句。

### 4.6 一个 Server 别塞太多工具

工具超过 15 个，模型选错的概率明显上升。名字相近的工具更是灾难，`get_order` 和 `query_order` 同时存在，模型每次都随机挑一个。

按业务域拆 Server。订单一个、库存一个、日志一个，各自独立部署。客户端那边配多个 Server，模型看到的是分组后的工具列表，选择范围小了，准确率就上来了。

### 4.7 超时和长任务

默认请求超时 20 秒（`spring.ai.mcp.server.request-timeout`）。跑批量任务肯定不够。

两条路：调大超时，或者在工具里用 `McpSyncRequestContext` 发进度通知。后者更好 —— 客户端能看到进度条，用户不会以为卡死了。但进度通知要求客户端带了 progress token，且服务端是有状态模式，无状态模式下这些方法会被静默忽略。

## 五、性能对比和技术选型

**Java 生态里写 MCP Server 有三条路，选错会浪费很多时间。**

| 方案 | 上手成本 | 灵活度 | 适合谁 |
| --- | --- | --- | --- |
| Spring AI Starter | 低，注解即工具 | 中，特殊需求要绕 | 已有 Spring Boot 项目的团队 |
| 官方 MCP Java SDK 裸写 | 中，要自己管会话和注册 | 高，协议层全部可控 | 非 Spring 项目、要精细控制 |
| LangChain4j | 低（客户端侧） | 服务端支持弱 | 主要用 LangChain4j 做 Agent 的项目 |

Spring AI 的优势是把注解扫描、schema 生成、序列化全包了。缺点也在这 —— 想改 schema 生成规则、想自己控制 content 结构，就得下沉到 SDK 层。绝大多数业务场景用不到。

官方 SDK 适合两种情况：你的服务不是 Spring 的（比如纯 Netty 或者 Vert.x），或者你要实现自定义的传输层。

LangChain4j 这边，MCP 的主力是客户端 —— `langchain4j-mcp` 能把远端 Server 的工具接进 `AiServices`，写 Agent 很顺手。但服务端没有对应的 starter，要暴露 Java 接口给别的客户端，还是用 Spring AI 或官方 SDK。

**什么时候不该用 MCP。** 如果你的场景只有一个应用、一个模型、几个内部函数，直接上 Function Calling 更简单，少一层进程间通信，少一套部署。MCP 的价值在"跨客户端复用" —— 当你有三个以上客户端要接同一批能力时，它才开始回本。

## 六、总结

MCP 不神秘。JSON-RPC 报文，三步握手，两种传输。Spring AI 把反射和序列化包了，你剩下要写的就是一个带注解的 Spring Bean。

真正决定成败的是三件小事：

工具描述写得像给新同事的交接文档，别写"查询订单"这种只有你自己懂的短语。参数名和 schema 必须干净，`arg0` 这种东西一出现，模型就开始瞎猜。返回值控制好大小，token 是钱。

安全别偷懒。MCP Server 默认裸奔，写操作默认没有二次确认。上线前把认证加上，把 `destructiveHint` 标对。

最后一句实在话：先写两个只读工具跑通，接到 Cursor 上让自己用一周。你会很快发现哪些描述写得烂、哪些返回值太大 —— 这些体感比看十篇文档都管用。

文 / 会编程的吕洞宾

## 参考资料

- [MCP 规范（2025-06-18 修订版）](https://modelcontextprotocol.io/specification/2025-06-18)
- [Spring AI - MCP Server Boot Starter](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-server-boot-starter-docs.html)
- [Spring AI - MCP Server Annotations](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-annotations-server.html)
- [Spring AI - MCP Overview](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html)

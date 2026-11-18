---
title: "MCP Server 用 Java 写：让 AI 直接调你的接口"
date: 2026-11-17T20:00:00+08:00
category: "AI"
tags: ["AI", "mcp"]
---

> 你花两个月做的订单系统，接口文档写了四十页。同事想让 Claude 帮忙查一个订单，还是得先打开 Postman，复制订单号，粘进聊天框，再把返回的 JSON 贴回去让模型解释。模型很聪明，问题是它看不见你的系统。
>
> MCP 就是补这块的：把你已有的 Java 方法包装成 AI 客户端能自动发现、自动调用的工具。写一次，Claude Desktop、Cursor、自己写的 Agent 都能直接用。下面从协议原理讲到能跑的代码，最后说几个上了线才会暴露的坑。

## 一、MCP 到底解决什么问题：AI 看不见你的 Java 接口

MCP 解决的是「工具供给」问题，不是「模型能力」问题。模型会不会调工具早就不是瓶颈了，瓶颈是：它凭什么知道你有哪些工具。

先看没有 MCP 的世界。Function Calling 的函数声明是写在应用里的，声明和调用方绑死。你给客服机器人写了 `queryOrderStatus` 的函数声明，这份声明只活在那个机器人里。换成 Cursor 想查同一张订单表，得再写一遍；换成团队另一个 Go 项目里的 Agent，还得再写一遍，换个 JSON 结构。五个入口，五份重复声明，五个地方各自维护参数格式。

更烦的是格式不统一。每家大模型的 function 声明长得都差不多但又都不一样，字段名、必填语义、参数描述的位置都有细微差别。你的业务逻辑明明只有一份，适配层却要写 N 份。

MCP 把这一层单独抽了出来。它是一份协议，规定了「工具怎么描述」「工具怎么被调用」「结果怎么返回」。你的 Java 服务实现一次协议，任何支持 MCP 的客户端都能连上来。客户端去问服务端「你有哪些工具」，服务端回一份带 JSON Schema 的清单，客户端把这份清单翻译成自己家模型能懂的格式。声明只写一次，适配由客户端负责。

打个比方。Function Calling 像你给每家打印机厂商单独写一份驱动；MCP 像 USB 标准，打印机按 USB 做，电脑按 USB 做，中间不用互相认识。你在 Java 里实现的是「打印机」那一侧。

需要说清的一点：MCP **不替代** Function Calling。模型这一层调用的仍然是 tool call，MCP 只是让工具清单和调用入口从应用内部挪到了独立进程。你写 MCP Server 的时候，业务代码不用改一行 model 相关的逻辑。

MCP 定义了三种原语：

- **tools（工具）**：能执行动作、改变状态的，比如「下单」「退款」「查库存」。Java 后端用得最多的就是它。
- **resources（资源）**：只读数据，按 URI 取，比如 `order://202611170000123456`。适合给模型当上下文，不适合触发业务动作。
- **prompts（提示模板）**：服务端预置的提示词模板，客户端可以带参数取。

大部分场景只需要 tools。这篇文章的代码也只做 tools，resources 和 prompts 是同一个注解体系下的兄弟，用法一致。

谁在用 MCP：Claude Desktop、Cursor、VS Code、JetBrains 系 IDE，还有一堆自研 Agent 框架。这就是它的价值——你不是为某一个产品接一次，是为所有支持这个协议的东西接一次。

## 二、底层原理：MCP Server 是怎么被 AI 调起来的

MCP 的通信格式是 JSON-RPC 2.0，一次工具调用就是两条 JSON 消息的往返。理解这一点，后面所有配置项都不再是玄学。

### 2.1 两种传输方式，选错会很痛

**stdio**：客户端把你的服务当成子进程拉起来，通过标准输入输出收发 JSON-RPC 帧。本地 IDE、桌面客户端用这个。特点是零网络配置、天然隔离，缺点是只能本机用，而且你的程序**绝对不能往 stdout 打日志**——日志会和协议帧混在一起，客户端直接解析失败。

**Streamable HTTP**：服务端是个正常的 HTTP 服务，客户端 POST 到 `/mcp`，服务端可以用普通 JSON 回，也可以升级成 SSE 流式回。团队共享、多用户接入、放到内网给一堆 Agent 用，都是这个。旧版本有过「SSE + 独立 message 端点」的双端点方案，现在基本退场了。

Spring AI 的服务端配置里 `protocol` 有两个值：`STREAMABLE` 和 `STATELESS`，默认 `STREAMABLE`。区别在于要不要维持会话状态——STREAMABLE 会发 `mcp-session-id` 头，服务端记住这个会话；STATELESS 每条请求自带全部上下文，不记会话。单机随便选，**多副本部署必须 STATELESS**，不然请求被负载均衡打到另一台机器，会话就找不到了。

### 2.2 一次调用的完整链路

客户端连上来，按顺序干这几件事：

1. `initialize`：握手。客户端报协议版本和自己支持的能力，服务端回自己的名字、版本、能力清单。
2. `notifications/initialized`：客户端确认，握手结束。
3. `tools/list`：客户端问「你有哪些工具」。服务端返回工具名、描述、参数的 JSON Schema。
4. `tools/call`：模型决定用某个工具后，客户端带着参数发过来，服务端执行，返回结果内容。

关键点在第四步：**模型不直连你的服务器**。链路是 `模型 → 客户端程序 → 你的 MCP Server`。客户端程序负责把工具清单塞进模型的上下文、解析模型吐出来的 tool call、转成 `tools/call` 发给你、再把结果回灌给模型。所以鉴权、限流、审计这些该做的事，一件都少不了。

### 2.3 Spring AI 帮你翻译了什么

手写 MCP Server 意味着自己拼 JSON Schema、自己分发方法名、自己序列化返回值。Spring AI 的做法是注解 + 自动配置，把这三件事包了：

| 你写的 Java | MCP 协议里的东西 |
| --- | --- |
| `@McpTool(name = "query_order_status")` | 工具名 `query_order_status` |
| `@McpTool(description = "...")` | 工具的 description，模型靠它判断该不该用 |
| 方法参数类型 + `@McpToolParam` | `inputSchema` 的 JSON Schema |
| 方法返回值 | `content` 数组里的文本/结构化内容 |
| 方法抛异常 | `isError: true` + 错误文本 |

注解扫描器在 Bean 初始化阶段扫一遍容器里所有 Bean 的方法，凡是带 `@McpTool` 的都注册成工具。也就是说，你的工具类就是个普通的 `@Component`，能注入 Repository、能加 `@Transactional`、能读配置，跟你写 Service 没区别。

客户端那一侧反过来：`spring-ai-starter-mcp-client` 连上服务端，拉 `tools/list`，把每个工具包装成 Spring AI 的 `ToolCallback`，再通过 `ToolCallbackProvider` 交给 `ChatClient`。模型看到的还是普通的函数声明，它根本不知道背后是个 HTTP 服务。

## 三、实战：两个工程，一个提供工具一个用工具

服务端负责把订单查询暴露成 MCP 工具，客户端负责让模型调用它。分开写是因为真实项目里这两件事通常不在一个进程。

### 3.1 服务端依赖

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
    <version>1.0.0</version>

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

`spring-ai-starter-mcp-server-webmvc` 是跑在 Spring MVC 上的 MCP 服务端。项目用 WebFlux 就换成 `spring-ai-starter-mcp-server-webflux`，代码不用动。

### 3.2 服务端配置

```yaml
server:
  port: 8080

spring:
  ai:
    mcp:
      server:
        name: order-mcp-server
        version: 1.0.0
        instructions: >-
          内部订单查询工具。查单个订单用 query_order_status，
          查某个用户最近的订单用 list_recent_orders。
          所有时间返回 ISO-8601 格式字符串。
        capabilities:
          tool: true
        streamable-http:
          mcp-endpoint: /mcp
```

`instructions` 会随 `initialize` 一起下发给客户端，客户端通常会把它拼进系统提示词。这里写清楚「什么场景用哪个工具」，比在代码注释里写十行都有用。

### 3.3 工具类

```java
package com.example.orders.mcp;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class OrderTools {

    private final OrderRepository repository;

    public OrderTools(OrderRepository repository) {
        this.repository = repository;
    }

    @McpTool(
            name = "query_order_status",
            description = """
                    按订单号查询订单当前状态、承运商和运单号。
                    用户问"我的订单到哪了""发货了吗""快递单号是多少"时调用。
                    订单号必须是 18 位纯数字，如果用户给的不够 18 位，先反问补全再调用。"""
    )
    public OrderStatus queryOrderStatus(
            @McpToolParam(description = "18 位订单号，例如 202611170000123456", required = true)
            String orderNo) {

        return repository.findByOrderNo(orderNo)
                .orElseThrow(() -> new IllegalArgumentException("订单不存在：" + orderNo));
    }

    @McpTool(
            name = "list_recent_orders",
            description = """
                    按用户手机号后四位查询该用户最近的订单列表，按下单时间倒序。
                    用户说"我最近买了什么""帮我看看这个月的单子"时调用。
                    结果最多 10 条，只要摘要字段，不含商品明细。"""
    )
    public List<OrderBrief> listRecentOrders(
            @McpToolParam(description = "用户手机号的后四位数字", required = true)
            String phoneSuffix,
            @McpToolParam(description = "返回条数，1 到 10，默认 5", required = false)
            Integer limit) {

        int size = (limit == null) ? 5 : Math.max(1, Math.min(limit, 10));
        return repository.findByPhoneSuffix(phoneSuffix, size);
    }
}
```

三个细节值得说。

`description` 写的是**什么时候用**，不是「这个工具能干什么」。模型选工具靠的就是这段文本，写成「查询订单状态」这种功能描述，它不知道该在用户问「快递到哪了」时调用。把用户的原话写进去，命中率高得多。

参数描述里带格式约束。「18 位纯数字」这种话写在 description 里，模型会自己先校验再调用，少一次失败的往返。

返回值用 record。服务端会把 record 序列化成 JSON 塞进 `content`，同时生成 `outputSchema`，客户端能拿到结构化的结果，不用再解析文本。

配套的数据层，为了代码能直接跑，用内存实现：

```java
package com.example.orders.mcp;

import org.springframework.stereotype.Repository;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

@Repository
public class OrderRepository {

    private final Map<String, OrderStatus> orders = new ConcurrentHashMap<>();

    public OrderRepository() {
        orders.put("202611170000123456", new OrderStatus(
                "202611170000123456", "SHIPPED", "SF", "SF1234567890123",
                "2026-11-15T09:20:00Z", "13800001234"));
        orders.put("202611160000654321", new OrderStatus(
                "202611160000654321", "DELIVERED", "JD", "JD9876543210987",
                "2026-11-14T18:05:00Z", "13800001234"));
        orders.put("202611120000777888", new OrderStatus(
                "202611120000777888", "PAID", null, null,
                "2026-11-12T11:42:00Z", "13800001234"));
    }

    public Optional<OrderStatus> findByOrderNo(String orderNo) {
        return Optional.ofNullable(orders.get(orderNo));
    }

    public List<OrderBrief> findByPhoneSuffix(String phoneSuffix, int limit) {
        return orders.values().stream()
                .filter(o -> o.buyerPhone().endsWith(phoneSuffix))
                .sorted(Comparator.comparing(OrderStatus::createdAt).reversed())
                .limit(limit)
                .map(o -> new OrderBrief(o.orderNo(), o.status(), o.carrier(), o.createdAt()))
                .toList();
    }
}
```

```java
package com.example.orders.mcp;

public record OrderStatus(
        String orderNo,
        String status,
        String carrier,
        String trackingNo,
        String createdAt,
        String buyerPhone) {
}
```

```java
package com.example.orders.mcp;

public record OrderBrief(
        String orderNo,
        String status,
        String carrier,
        String createdAt) {
}
```

注意两个 record 的分工：`OrderStatus` 带手机号，`OrderBrief` 不带。工具返回值是要进模型上下文的，能少给一个字段就少给一个。

### 3.4 启动类

```java
package com.example.orders;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderMcpServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderMcpServerApplication.class, args);
    }
}
```

启动之后，`POST http://localhost:8080/mcp` 就是 MCP 端点。用官方 Inspector 最省事：

```bash
npx @modelcontextprotocol/inspector
```

在界面里选 Streamable HTTP，地址填 `http://localhost:8080/mcp`，点 Connect 就能看到 `tools/list` 返回的两个工具，也能直接填参数调一次。这一步跑通，说明服务端没问题，剩下的都是客户端的事。

### 3.5 客户端：让模型用上这些工具

客户端工程的依赖：

```xml
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
            <artifactId>spring-ai-starter-mcp-client</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
    </dependencies>
```

父 POM 同样是 `spring-boot-starter-parent` 4.1.2，`java.version` 21。

配置：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4.1-mini
    mcp:
      client:
        name: order-agent
        version: 1.0.0
        streamable-http:
          connections:
            order-server:
              endpoint: http://localhost:8080/mcp
```

连接参数叫 `endpoint`，不叫 `url`。写错了不会报错，只会静默连不上，然后模型告诉你「我没有查询订单的工具」——排查半天。

配置就位后，MCP 客户端会把远端工具包装成 `ToolCallbackProvider`，把它塞给 `ChatClient` 即可：

```java
package com.example.agent;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AgentConfig {

    @Bean
    ChatClient chatClient(ChatClient.Builder builder, ToolCallbackProvider mcpTools) {
        return builder
                .defaultSystem("你是电商客服助手，查订单必须调用工具，不要凭空猜。")
                .defaultToolCallbacks(mcpTools)
                .build();
    }

    @Bean
    CommandLineRunner demo(ChatClient chatClient) {
        return args -> {
            String answer = chatClient.prompt()
                    .user("我手机尾号 1234，最近买了什么东西？帮我看看发货了没")
                    .call()
                    .content();
            System.out.println(answer);
        };
    }
}
```

启动客户端，模型会先调 `list_recent_orders`，拿到三条订单，其中一条状态是 `SHIPPED`，然后组织成一段人话回给你。整个过程中，客户端程序做的是转发，业务逻辑一行都没重写。

## 四、踩坑经验：上线后才暴露的六个问题

工具描述写得好不好，直接决定模型会不会用；剩下的坑基本都在「边界」上。

**坑一：description 写成功能说明书。** 「查询订单」这种写法模型不会主动选。要写触发场景，把用户可能说的话覆盖进去。我一般按「做什么 + 用户会怎么问 + 参数约束」三段写，参考上面 `query_order_status` 的写法。

**坑二：返回值不设上限。** 见过有人把「查询商品列表」直接返回 200 条记录的完整 JSON，一次工具调用吃掉一万多 token，模型后面的推理直接崩。工具返回是进上下文的，不是进数据库的。规则很简单：默认返回摘要字段，条数封顶 10 条，要明细就再开一个按 ID 查的工具。

**坑三：默认超时 20 秒，长任务必挂。** 服务端 `spring.ai.mcp.server.request-timeout` 默认 20 秒。导出报表、批量对账这种工具，20 秒根本不够，客户端拿到超时后模型会重试，重试再超时，最后给你一句「系统繁忙」。正确做法是拆成两段：一个工具提交任务返回 `jobId`，另一个工具按 `jobId` 查进度。模型自己有耐心轮询。

**坑四：把 `/mcp` 当内网接口挂到公网。** MCP 端点本质是个「什么都能调的入口」。你的 `refund_order`、`update_address` 一旦包装成工具，任何拿到这个 URL 的客户端都能调。至少加一层 API Key 校验（Spring Security 的过滤器就行），管理类接口干脆别包装成工具。工具的权限边界要按「最坏情况」设计：这个工具被滥用一次，损失多大。

**坑五：stdio 模式下往 stdout 打日志。** 用 stdio 传输时，stdout 是协议通道。`System.out.println` 打个调试信息，客户端立刻解析失败，报错还告诉你「invalid JSON」。日志一律走 stderr，或者干脆用文件 appender。

**坑六：多副本部署用了会话态。** 默认 `STREAMABLE` 会维持会话，`initialize` 落在 A 机器，`tools/call` 被路由到 B 机器，B 不认识这个 session，直接 400。要么做会话粘滞，要么把 `spring.ai.mcp.server.protocol` 设成 `stateless`。后者更省心，代价是每条请求都要重新带能力协商信息，流量略大。

还有两类不值得单独开一节的：工具数量控制在 20 个以内（超过之后模型选错的概率明显上升，跟之前聊过的工具检索是同一个问题）；工具名用下划线小写，别用驼峰，某些客户端会把名字当 URI 片段处理。

## 五、性能对比和技术选型

MCP 的固定开销很小，成本大头在你的业务接口本身。

| 方案 | 复用范围 | 接入成本 | 适合场景 |
| --- | --- | --- | --- |
| 各应用各写 Function Calling | 单应用 | 每接一个客户端写一遍 | 只有一个入口的临时脚本 |
| OpenAPI 文档转 MCP | 所有 MCP 客户端 | 需要转换工具 + 手调 schema | 已有完整 OpenAPI、接口稳定 |
| Spring AI 注解式 MCP Server | 所有 MCP 客户端 | 加注解即可，业务代码不动 | Java 后端，长期维护 |

工具描述的体积是要算进每次对话的，这笔开销固定发生。12 个工具、每个描述 100 字出头，`tools/list` 的响应体大概 4KB，换算成 token 一千上下，比一次 RAG 检索塞进去的内容还少——具体数字在 Inspector 里点开 `tools/list` 就能看到。所以工具不是越少越好，但每加一个都要问一句「模型真的会用到吗」。

选型上我的建议很直接：Java 后端已经有 Service 层，就用 Spring AI 的注解式方案，别去手写 JSON-RPC 分发。接口只有 OpenAPI 没有 Java 代码（比如老系统），用 OpenAPI 转 MCP 的工具生成一层壳。只有一个应用、只服务一个模型、短期不打算复用，那就老老实实写 Function Calling，别为了架构好看多搭一个进程。

真正需要提前想清楚的是权限和审计，不是协议选型。MCP 让「调用」变便宜了，也就让「误调用」变便宜了。

## 六、总结

MCP 的本质是把工具声明从应用里抽出来，变成一份所有 AI 客户端都能读的协议。它不改变模型怎么调工具，只改变工具清单从哪来。

落到 Java 上，你要做的只有三件事：写一个普通 `@Component`，方法上加 `@McpTool` 和写清楚触发场景的描述，配好 `spring-ai-starter-mcp-server-webmvc` 和端点。剩下的 JSON-RPC、schema 生成、会话管理，Spring AI 都替你做了。

几个判断可以直接拿走：

- 团队内部多个 AI 入口要查同一批数据 → 上 MCP，收益立刻体现。
- 只有一个机器人、只接一家模型 → 先别上，Function Calling 够了。
- 工具会改数据（退款、改地址、发消息）→ 先设计权限，再写工具。
- 多副本部署 → `stateless`，别犹豫。

工具描述是这个技术栈里最容易被低估的部分。代码写对只完成了一半，模型选不选你的工具，全看那几十个字。

文 / 会编程的吕洞宾

## 参考资料

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification)
- [Spring AI - MCP Server Boot Starter](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-server-boot-starter-docs.html)
- [Spring AI - MCP Client Boot Starter](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-client-boot-starter-docs.html)
- [Spring AI - Tool Calling](https://docs.spring.io/spring-ai/reference/api/tools.html)

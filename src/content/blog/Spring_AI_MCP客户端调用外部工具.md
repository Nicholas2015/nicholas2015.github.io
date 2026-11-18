---
title: "Spring AI MCP 客户端调用外部工具"
date: 2026-10-03T20:00:00+08:00
category: "AI"
tags: ["spring-ai", "mcp"]
---

> 想让 AI 顺手查一下 GitHub issue、读本地某个目录的文件、翻一遍数据库表结构，老办法是自己写一堆 `@Tool` 方法：一个能力一个类，鉴权、超时、分页、错误处理全得自己兜。MCP 协议把这活标准化了——GitHub、文件系统、Postgres 这些能力，已经有人写成了现成的 MCP Server，你接上就能用。Spring AI 的 MCP 客户端，就是 Java 这边的那根插头。这篇文章讲清它怎么工作，再给三个能直接跑的例子。

## 一、不接 MCP，你得亲手造每一个工具

结论先行：MCP 客户端的价值，是把「给模型加一个工具」从写代码降级成写配置——前提是那个工具已经有人做成了 MCP Server。

先看大家最熟悉的写法。Java 里给模型加工具，就是写个方法挂上 `@Tool`：

```java
@Component
public class GitHubTools {

    @Tool(description = "根据关键词搜索 GitHub 仓库")
    public String searchRepos(String keyword) {
        // 自己拼 URL、自己带 token、自己解析 JSON
        return restClient.get()
                .uri("https://api.github.com/search/repositories?q={q}", keyword)
                .header("Authorization", "Bearer " + token)
                .retrieve()
                .body(String.class);
    }
}
```

模型看到的是方法的描述和参数，它决定要不要调用；真正发 HTTP 请求的还是你这段代码。这写法本身没问题，问题是它会不断繁殖。

你想让 AI 读文件，写一个；想查数据库表结构，写一个；想查 Jira，再写一个。每个工具的鉴权方式不一样、错误码不一样、返回结构不一样，这些脏活一件都躲不掉。更麻烦的是生态割裂：Claude Desktop、Cursor、各种 IDE 里已经跑着一大堆成熟的 MCP Server，你的 Java 应用一个都用不上，只能重写一遍。

MCP（Model Context Protocol）要解决的就是这个。它定义了一套标准协议，规定「工具怎么描述自己」「怎么被调用」「结果怎么返回」。写 Server 的人按协议实现一次，任何支持 MCP 的客户端都能连上。跟 USB-C 一个道理：以前的充电口各厂商各一套，现在统一成一个口，谁都能插。

在这个模型里，有三个角色：

- **Host**：发起对话的那一端，比如你的 Java 应用、Claude Desktop。
- **Client**：负责跟 Server 建立连接、说协议话的连接器。在 Spring AI 里，这个角色框架帮你干了。
- **Server**：真正提供能力的那一端，可能是个本地进程，也可能是个远程服务。

一个 MCP Server 能提供三类东西：**tools**（可以被调用的动作，比如读文件、建 issue）、**resources**（可以被读取的数据，比如一张表）、**prompts**（预置的提示词模板）。日常 90% 的场景只用到 tools，下面也只讲 tools。

## 二、MCP 客户端到底在底层干了什么

结论先行：MCP 客户端本质就是一个 JSON-RPC 2.0 客户端。它连上 Server、拉回工具清单、把清单翻译成本地的 `ToolCallback`，再交给 ChatClient 用。

### 三个层次

| 层 | 负责什么 | 具体形态 |
| --- | --- | --- |
| 传输层 | 消息怎么在你和 Server 之间传 | stdio、SSE、Streamable HTTP |
| 协议层 | 消息长什么样 | JSON-RPC 2.0，方法名如 `tools/list`、`tools/call` |
| 能力层 | 能干什么 | tools、resources、prompts、sampling、roots |

搞懂这张表，后面所有配置就有落点了。

### 一次完整的握手

客户端启动时，会走这么一个流程：

1. **建连接**：按配置把传输搭起来。stdio 就是起一个子进程，SSE / Streamable HTTP 就是发 HTTP 请求。
2. **initialize**：双方交换协议版本和各自支持的 capability。
3. **initialized 通知**：客户端告诉 Server「我准备好了」。
4. **tools/list**：客户端把 Server 的工具清单拉回来，每个工具带名称、描述、输入参数的 JSON Schema。
5. **翻译**：Spring AI 把这份清单包装成一个 `ToolCallbackProvider`。每个远端工具在你本地都有一个对应的回调，模型看到的工具名就是远端的工具名。
6. **实际调用**：模型决定调用某个工具 → MCP 客户端发 `tools/call` → Server 执行 → 结果原路返回 → 模型拿到结果继续生成。

这里有个关键认知：**模型从头到尾都不知道 MCP 的存在**。它只看到本地多了一批工具，跟平时写 `@Tool` 出来的工具没有任何区别。MCP 客户端就是一层的翻译官，一头说协议话，一头说 Spring AI 的内部话。

### 同步还是异步

MCP Java SDK 有两个客户端：`McpSyncClient` 是会阻塞的版本，调用就等结果；`McpAsyncClient` 返回 `Mono`，适合配 WebFlux 做高并发。绝大多数业务用同步的就够了，配置里 `type: SYNC` 就是选它。注意同步客户端不能在高并发场景下一把梭——每次工具调用都是阻塞的，真扛不住就换异步。

### 三种传输怎么选

| 传输方式 | 连接方式 | 适合场景 | 局限 |
| --- | --- | --- | --- |
| stdio | 本地起子进程，用标准输入输出传 JSON-RPC | 跑在本机的工具：文件、Git、SQLite | 只能本机，进程生命周期得自己管 |
| SSE | HTTP 长连接，Server 单向推事件 | 老的远程 Server | 需要两个端点，规范里已被 Streamable HTTP 取代 |
| Streamable HTTP | 单个 HTTP 端点，POST 和 GET 都走它 | 新的远程 Server | 有状态模式要处理会话粘性 |

一句话：本机能力用 stdio，跨机器共享用 Streamable HTTP，SSE 只有在对接遗留 Server 时才碰。

另外记一笔：工具清单是在启动时拉的，Server 后来动态加了工具，客户端不会自动知道，得重新初始化。

## 三、实战：三个能跑的例子

### 例一：配置里接一个文件系统 Server

依赖部分，`pom.xml` 完整贴出来，照抄能跑：

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
    <artifactId>mcp-client-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.1</spring-ai.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-bom</artifactId>
            <version>${spring-ai.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-mcp-client</artifactId>
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

`spring-ai-starter-mcp-client` 就是客户端那一坨：它会把 MCP Java SDK、自动配置、传输实现全带进来，不用你手动引。

接着是 `application.yml`：

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
    mcp:
      client:
        enabled: true
        name: java-mcp-client
        version: 1.0.0
        type: SYNC
        request-timeout: 60s
        # 本地进程型 Server：Spring AI 用这个命令把子进程拉起来
        stdio:
          connections:
            filesystem:
              command: npx
              args:
                - "-y"
                - "@modelcontextprotocol/server-filesystem"
                - "/tmp/mcp-demo"
        # 远程 Server 按需打开，注意本机没起服务时别开，会启动失败
        # sse:
        #   connections:
        #     demo-remote:
        #       url: http://localhost:8090
```

这段配置读完会自动做三件事：拉起 `npx` 子进程当 Server、完成 initialize 握手、把文件系统工具注册成 `ToolCallbackProvider` 的 bean。你一行 Java 代码都不用写，工具就已经在容器里了。

启动类照常写：

```java
package com.example.mcpclient;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class McpClientApplication {

    public static void main(String[] args) {
        SpringApplication.run(McpClientApplication.class, args);
    }
}
```

关键的一步是把它挂到 ChatClient 上。直接把容器里所有 `ToolCallbackProvider` 注进来：

```java
package com.example.mcpclient.service;

import java.util.List;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.stereotype.Service;

@Service
public class FileAssistantService {

    private final ChatClient chatClient;

    public FileAssistantService(ChatClient.Builder builder,
                                List<ToolCallbackProvider> toolCallbackProviders) {
        this.chatClient = builder
                .defaultSystem("你是文件助手。需要查看目录或文件内容时必须调用工具，禁止凭空编造文件内容。")
                .defaultToolCallbacks(toolCallbackProviders.toArray(ToolCallbackProvider[]::new))
                .build();
    }

    public String ask(String question) {
        return chatClient.prompt()
                .user(question)
                .call()
                .content();
    }
}
```

`defaultToolCallbacks` 的作用是「这批工具每次请求都带上」，省得每次调用都重新注册。上面 `defaultSystem` 那句别省，它会明显降低模型不去调工具、直接瞎编的概率。

再套一个 HTTP 接口就能测：

```java
package com.example.mcpclient.web;

import com.example.mcpclient.service.FileAssistantService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/ai")
public class AssistantController {

    private final FileAssistantService assistantService;

    public AssistantController(FileAssistantService assistantService) {
        this.assistantService = assistantService;
    }

    @GetMapping("/ask")
    public String ask(@RequestParam("q") String question) {
        return assistantService.ask(question);
    }
}
```

启动后请求 `/api/ai/ask?q=列出 /tmp/mcp-demo 下的文件，读出 README.md 的内容`，模型会自己决定调 `list_directory` 和 `read_file`，你只看到最终答案。

### 例二：手动建客户端，接多个同类 Server

自动配置适合「一个固定的 Server」。如果你要按租户、按仓库动态连不同的 Server，就得自己建客户端。`McpSyncClient` 就是这时候用的：

```java
package com.example.mcpclient.config;

import java.time.Duration;
import java.util.List;

import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.spec.McpSchema;
import org.springframework.ai.mcp.SyncMcpToolCallbackProvider;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GitMcpClientConfig {

    @Value("${demo.git.repository:/tmp/demo-repo}")
    private String repository;

    @Bean(destroyMethod = "close")
    public McpSyncClient gitMcpClient() {
        McpSchema.ServerParameters parameters = McpSchema.ServerParameters.builder("uvx")
                .args(List.of("mcp-server-git", "--repository", repository))
                .build();

        McpSyncClient client = McpClient.sync(new StdioClientTransport(parameters))
                .requestTimeout(Duration.ofSeconds(60))
                .clientInfo(new McpSchema.Implementation("java-git-client", "1.0.0"))
                .build();

        // 必须显式初始化，否则后续调用会直接失败
        client.initialize();
        return client;
    }

    @Bean
    public ToolCallbackProvider gitToolCallbackProvider(McpSyncClient gitMcpClient) {
        return new SyncMcpToolCallbackProvider(List.of(gitMcpClient));
    }
}
```

三个点值得留意。`ServerParameters` 描述怎么把 Server 进程拉起来，`StdioClientTransport` 负责按 stdio 传输跟它说话。`client.initialize()` 必须手动调，自动配置之所以不用你操心，是因为它在框架内部替你调了。`destroyMethod = "close"` 保证应用关掉时子进程跟着退出，不写这句等着攒僵尸进程。

`SyncMcpToolCallbackProvider` 的作用是把客户端列表包装成 Spring AI 认的 `ToolCallbackProvider`，这一句就是从「协议世界」跨回「Spring AI 世界」的那道桥。

### 例三：排错用的工具清单接口

工具没生效、模型选错了工具，第一步永远是先看清楚远端到底给了哪些工具。加个接口：

```java
package com.example.mcpclient.web;

import java.util.List;
import java.util.Map;

import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.spec.McpSchema;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/mcp")
public class McpDebugController {

    private final List<McpSyncClient> mcpSyncClients;

    public McpDebugController(List<McpSyncClient> mcpSyncClients) {
        this.mcpSyncClients = mcpSyncClients;
    }

    @GetMapping("/tools")
    public List<String> listTools() {
        return mcpSyncClients.stream()
                .flatMap(client -> client.listTools().tools().stream())
                .map(tool -> tool.name() + " -> " + tool.description())
                .toList();
    }

    @GetMapping("/call")
    public String callTool(@RequestParam("name") String name,
                           @RequestParam("path") String path) {
        McpSchema.CallToolResult result = mcpSyncClients.get(0)
                .callTool(new McpSchema.CallToolRequest(name, Map.of("path", path)));

        StringBuilder text = new StringBuilder();
        result.content().forEach(content -> {
            if (content instanceof McpSchema.TextContent textContent) {
                text.append(textContent.text());
            }
        });
        return text.toString();
    }
}
```

`/api/mcp/tools` 直接问 Server 要清单，看到的名字就是模型看到的名字。`/api/mcp/call` 绕过模型、手动调一次工具，用来验证「是协议不通还是模型不听话」——这一步 90% 能定位问题所在。

## 四、踩坑经验和最佳实践

**stdio 命令找不到，最常见**。`command: npx` 在 IDE 里跑得好，打包部署到服务器就报「Cannot run program npx」。原因是进程的 PATH 不一样。把命令改成绝对路径，或者显式设置 `env` 补上 PATH，别赌运行环境。

**首次启动特别慢**。`npx -y @modelcontextprotocol/server-filesystem` 第一次会去下载包，网络不好能卡半分钟。生产环境建议先全局装好，命令直接指到已安装的可执行文件。

**超时别用默认值**。工具里如果是查数据库、调三方接口这类慢操作，默认超时很容易触发。配置里的 `request-timeout` 按最慢的工具来设，别统一拍脑袋。

**子进程一定要收尾**。手动建的客户端记得 `destroyMethod = "close"`；临时建的长生命周期客户端用完自己 `close()`。stdio 每连一次就是一个子进程，泄漏起来很直观——`ps` 里一排 `npx`。

**别重复注册工具**。自动配置会扫描容器里所有 `McpSyncClient` 汇总成一个 `ToolCallbackProvider`。你自己又手写了一个 provider，同一个工具就会进去两次，工具名撞车，模型直接蒙。要么只走自动配置，要么把手写 provider 之外的自动注册关掉（`spring.ai.mcp.client.toolcallback.enabled=false`）。

**工具一多，模型就选错**。工具描述会塞进上下文，十来个还稳，几十个就开始乱选，token 也涨。给每个工具写清楚 description、参数含义，必要时按业务场景拆成不同的 ChatClient，各挂各的工具子集。

**安全是硬伤**。MCP Server 是跑在你机器上的程序，文件系统 Server 能读文件，shell 类 Server 能执行命令。挂目录只挂必要的，别把 `/` 挂进去；能执行命令的 Server 别接进无人值守的流程。这是把「AI 能干什么」的边界直接交给了配置，配错等于开大门。

**Streamable HTTP 有状态模式要考虑会话粘性**。多实例部署时，同一个会话的请求要落到同一个实例，否则服务端找不到会话。不想折腾就用无状态模式，把状态放外部存储。

## 五、性能对比和技术选型

自写 `@Tool` 和接 MCP Server 怎么选，判断标准很直白：

- **私有逻辑、一锤子买卖** → 自己写 `@Tool`。你不可能为了一个只在自家系统里用的接口去写个 Server。
- **通用能力、已经有现成 Server** → 接 MCP。文件、Git、数据库、各类 SaaS，社区基本都有人做过了。
- **同一个能力要被多个语言、多个客户端复用** → 必须 MCP。写一次，Java、Python、IDE 都能接。

传输方式的延迟，stdio 最低，因为就是本地进程间通信，没有网络往返；Streamable HTTP 多一次网络;SSE 在长连接下延迟也不高，但规范已经把它让位给 Streamable HTTP，新项目别选。

真正影响体验的不是传输，是**工具数量**。工具清单按描述进上下文，每个工具的描述加参数 Schema 几十到几百 token，30 个工具就能吃掉好几千 token 的预算，还顺带拉高选错概率。工具上规模之后，重点是做工具筛选（按当前任务只暴露相关的那几个），而不是继续堆。

## 六、总结

MCP 客户端的本质，是一个会说 JSON-RPC 的翻译官：连上 Server、拉回工具清单、翻译成本地 `ToolCallback`，模型对此毫无感知，它只是发现本地工具变多了。

落地路径也很清楚。固定的本地工具，写配置就完事，`spring-ai-starter-mcp-client` 自动拉起进程、注册工具。要动态连、要连多个，手动 `McpClient.sync(...)` 加 `SyncMcpToolCallbackProvider` 两步搞定。剩下的事，全是细节：超时、进程回收、工具描述、安全边界——这些细节不处理，工具接得再多也是埋雷。

值得说一句的是，接现成工具省下来的时间，应该花在怎么让模型选对工具上。工具接得下不是本事，选得准才是。

## 参考资料

- [Model Context Protocol 官方文档](https://modelcontextprotocol.io/)
- [MCP 规范](https://modelcontextprotocol.io/specification/2025-06-18)
- [Spring AI 参考文档：MCP 概览](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html)
- [Spring AI 参考文档：MCP Client Boot Starter](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-client-boot-starter-docs.html)
- [官方 MCP Server 列表](https://github.com/modelcontextprotocol/servers)

文 / 会编程的吕洞宾

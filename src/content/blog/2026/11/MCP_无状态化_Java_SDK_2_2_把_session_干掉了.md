---
title: "MCP 无状态化：Java SDK 2.2 把 session 干掉了，你的 server 要不要动"
date: 2026-11-23 09:06:15
tags: ["AI", "MCP", "Java", "Agent"]
categories: ai
---

# MCP 无状态化：Java SDK 2.2 把 session 干掉了，你的 server 要不要动

MCP server 写起来最烦的地方，是它天生有状态。客户端要先 `initialize` 握手，服务端记住这个连接是谁、支持什么能力，然后才允许调工具。听起来合理，但落到部署上就是一堆麻烦：负载均衡得开粘性会话，一个实例挂了上面挂的连接全废，扩缩容的时候老连接不知道该往哪儿去。

2026-07-28 那版 MCP 规范把这个前提推翻了。**协议不再有 session，也没有 initialize 握手。** Java SDK 2.2.0 跟进了，新实现在 `io.modelcontextprotocol.modern` 包里，跟老的实现并排放着。

这篇讲清楚三件事：变的是什么、新 API 长什么样、你手上的 server 到底该不该动。

## 协议层发生了什么

老协议的生命周期是这样：

```text
客户端 --initialize--> 服务器
       <--能力协商--
       <--session-id--
客户端 --tools/call + session-id--> 服务器
```

新协议把这套砍了：

```text
客户端 --tools/call（自带 protocolVersion + capabilities 在 _meta 里）--> 服务器
服务器 --结果--> 客户端
```

每个请求自带它需要的一切上下文，服务器处理完就忘。这带来几个直接后果：

**没有粘性路由的需求。** 任何实例都能处理任何请求，你不需要在 Nginx 上配 `ip_hash`，也不需要 Redis 存 session。

**没有服务端往客户端发请求。** 老协议里服务器可以反向调客户端的 sampling、elicitation、roots。新协议里这个方向被禁了——服务器需要用户补信息时，返回一个 `InputRequiredResult`，由客户端带着答案重试。

**能力协商变成每个请求都带。** 版本、客户端能力全在 `_meta` 里，服务器每次自己判断。

## Java SDK 2.2 的结构

两个包并存，不共享任何类型：

| | modern | legacy |
|---|---|---|
| 包名 | `io.modelcontextprotocol.modern` | `io.modelcontextprotocol` |
| 规范版本 | 2026-07-28 | 2025-11-25 及更早 |
| session | 无 | 有（除无状态 transport） |
| 原语来源 | 你自己实现的 repository | 注册进去的 specification |
| 服务端反向请求 | `InputRequiredResult` | sampling / elicitation / roots / ping |

两个都在 `mcp-core` 里，**不用多引依赖**。入口类是 `io.modelcontextprotocol.modern.server.McpServer` 和 `io.modelcontextprotocol.modern.client.McpClient`。

官方在文档第一段就打了预防针：**modern API 在 3.0 之前的小版本里还可能变。** 打算基于它写生产代码的，自己权衡。

## 服务端：一套 McpServer，同步异步自己选

老的 Java SDK 有个别扭的地方：同步和异步是两套 server 类（`McpSyncServer` / `McpAsyncServer`），你的 Repository 实现得跟着选。

modern 这边只有一个 `McpServer`。同步异步是**按 repository 选**的——同步的 repository 里永远看不到 Reactor 类型。

几个设计点值得单独说：

**工具、资源、prompt 来自你实现的 repository，SDK 里没有注册表。** 这句听着像内部实现细节，实际影响很大：多租户、按权限过滤、动态目录、分页，这些以前得在 SDK 外面包一层，现在直接写在 repository 里就行。你要给 A 租户看 3 个工具、B 租户看 20 个，就是 `find` 里判断一下返回什么。

**同步或异步由 transport 决定要不要 offload 阻塞代码。** 你写同步 handler，框架知道怎么处理，不用自己包 `Mono.fromCallable` 再扔 `boundedElastic`。

**流式只在划算的时候开。** handler 返回单个结果就用 `application/json`，返回一个能先发进度再发结果的对象才走 SSE。老协议里 Streamable HTTP 总是流式的，这点是实打实的改动。

**没有 server 主动请求了。** 要用户补输入，返回 `InputRequiredResult`，客户端补完重试。一次请求可能要来回几轮。

## 客户端：没有握手了

老的客户端要先 `initialize` 走一遍握手才能用。新客户端：

```java
McpClient client = McpClient.sync(transport);
// 拿到就能用，构建过程零 I/O
var result = client.tool("create_issue").arguments(args).call();
```

三个特点：

- **构建时不发 I/O**，client 代表一个用户，不会自己跑去连
- **transport 可以跟别的 client 共享**
- **每个操作有自己的请求 spec**，`client.tool("x").arguments(a).call()`，链式的

它自己处理了 `_meta` 块、版本重协商、多轮 `input_required`（表单和 URL 两种形式）、`Mcp-*` 和 `Mcp-Param-*` 头、`subscriptions/listen`、`server/discover`，还有基于 `ttlMs` 的工具列表缓存。

支持的 transport：Streamable HTTP（JDK `HttpClient`）和 STDIO。

**没支持的**：sampling、roots、logging、扩展。

## 顺带一个信号：sampling、roots、logging 被废弃了

这条比 API 变更更值得琢磨。跟着 SEP-2577，这些**发起**相关功能的 API 全标废弃了：`addRoot`、`setLoggingLevel`、`createMessage`、`listRoots`、`loggingNotification`，还有对应的能力 builder 方法。

处理这些请求的**注册方法没废弃**——因为对方可能还在用，你得能接。

行为和线格式都没变。但方向很清楚：MCP 觉得服务端往客户端发请求这个模式问题太多，慢慢往回收。

## 破坏性变更清单

升级前照着核：

**所有人都会碰到的：**

`McpTransportContext` 不再有基于内容的 `equals`/`hashCode`。以前拿它当 map key 或者比较的代码会出错，改成 `get(String)` 读条目。

**从 2.2.0-M1/M2 的 modern 预览版升上来的（大部分人不会踩）：**

- repository 的 `find` 现在返回 handler 而不是 specification
- `CompletionsFeature` 和 `McpSync/AsyncCompletionRepository` 删了，改成 prompt 和 resource template 自己定义 completion
- `McpParamHeaders` 换成 `McpHeaders`，多带一个 `Mcp-Name`
- `InputResponses.get` 和 `RequestStateCodec.open` 返回 `null`，不再是空 `Optional`

## 你到底该不该动

分三种情况：

**① 你写的是 MCP server，客户端都是老版本**

先别动。modern server 只讲 2026-07-28，老客户端连上来会被拒绝——而且拒绝得挺体面，返回 `UnsupportedProtocolVersion` 并列出支持的版本。想同时服务两代人，就得跑两套 server（modern + legacy），共用业务逻辑。这个成本先算清楚。

**② 你的 server 要水平扩容，或者一直在跟 session 死磕**

就是为你准备的。不用粘性路由、不用 Redis 存会话、实例随便扩。如果你的 session 里只存了"这个连接是谁"这种能从请求推出来的东西，直接换 modern，代码会更短。

**③ 你的 server 重度依赖 sampling 或者 elicitation**

缓缓。modern server 里 sampling 没有等价物，elicitation 换成了 `InputRequiredResult` 的多轮往返——语义接近但不是同一套心智模型。而且客户端侧 sampling 也还没实现。

## 几个容易忽略的点

**legacy 一行没改。** 不在 modern 包里的东西行为完全不变，所以升级 SDK 本身是安全的。真正的迁移成本在你决定切 modern 的那一刻。

**modern server 也支持订阅限制。** `McpServer.Builder#restrictSubscriptions` 能按调用方限制哪些资源可订阅。多租户场景这个很实用，别自己再包一层。

**它已经不叫 streamable 了。** 老的 Streamable HTTP 被"彻底重做"，现在叫不叫这个名字看你怎么理解——反正一个请求可以是纯 JSON，也可以是 SSE 流，由 handler 返回值决定。

**兼容性测试别省。** 官方说 modern server 通过了 2026-07-28 所有必需的 server 一致性场景，client 通过了非认证部分。但你自己的场景还是得跑——一致性测试只证明协议对，不证明你的业务对。

## 一句话

MCP 从一个"有连接的会话协议"变成了"带版本的自描述请求协议"。这个转变让 MCP server 终于能像普通 Web 服务一样部署，代价是丢掉服务端主动交互的能力。取舍值不值，看你的 server 需要做什么。

## 参考资料

- [MCP Java SDK 2.2.0 发布说明](https://github.com/modelcontextprotocol/java-sdk/releases/tag/v2.2.0)
- [Modern Server 文档](https://java.sdk.modelcontextprotocol.io/latest/server-modern/)
- [Modern Client 文档](https://java.sdk.modelcontextprotocol.io/latest/client-modern/)
- [MCP 规范与 SEP 仓库](https://github.com/modelcontextprotocol/modelcontextprotocol)
- [MCP Java SDK 产物](https://repo1.maven.org/maven2/io/modelcontextprotocol/sdk/mcp/)

---
title: "Java多智能体：AgentScope分工实战"
date: 2026-10-21T20:00:00+08:00
category: "AI"
tags: ["agent"]
---

**摘要：** 一个 Agent 又查数据又做评审，上下文越塞越脏，结论越来越水。本文用 AgentScope Java 的子 Agent 把任务拆开：讲清 spawn 的调用链、上下文与工具隔离、同步/后台/并行三种跑法，附两个完整可运行示例和踩坑清单。

> 周五下午做发布评审：一个 Agent 又看安全、又看性能、又写结论。SQL、日志、规范文档全堆在同一段上下文里，它越评越飘，最后给你一句「整体风险可控」。你盯着屏幕想不通——明明每个检查项都写进提示词了。问题不在模型不认真，在你让一个脑袋同时干三份活，还指望它每份都专业。这篇讲怎么用 AgentScope 的子 Agent 把它拆开。

## 一、一个 Agent 全包，到底哪里出了问题

结论：一个 Agent 全包复杂任务，先崩的不是模型能力，是上下文。

先把 Agent 这个词落地。它就是一个循环：模型看当前对话，决定下一步是调工具还是给答案；调了工具，结果塞回对话，再问一遍。循环本身不复杂，复杂的是每转一圈，上下文就厚一层。

发布评审这种活，上下文膨胀得尤其快。查一次订单表结构，回来几十行 DDL；跑一次慢查询分析，回来一段执行计划；再加安全规范、性能基线、历史事故记录。三轮之后，模型的注意力被摊薄在几万字里，前面说过什么、哪条是重点，它自己都抓不住。

具体会看到三种症状。

**上下文污染。** 安全评审需要盯鉴权和注入，性能评审需要盯索引和锁。两类证据混在一起，模型容易拿安全的标准去评价索引，或者反过来。它不是不懂，是被无关信息带偏了。

**串行拖时间。** 一个循环一次只能推进一件事。安全看完再看性能，性能看完再写结论，全程串行。明明两块互不依赖，却只能排队。

**角色冲突。** 你在 system prompt 里塞三套标准，模型会折中。安全要求「宁可错杀」，性能要求「别加多余校验」，两句话打架，最后它给你一个四平八稳、什么也没说的结论。

所以拆分的动机很朴素：让每份工作有自己的工作台，只放它需要的材料。

但别把「拆」当万能药。判断标准就三条：子任务之间是否独立、是否各自吃大量上下文、是否能并行。三条占两条，才值得拆。一个查天气的工具也开个子 Agent，纯属给账单加戏。

## 二、AgentScope 的子 Agent 是怎么跑起来的

结论：子 Agent 不是另一套框架，它就是一个被包装成工具的 Agent。

### 一次 spawn，实际发生了什么

父 Agent 在推理时，模型看到的工具列表里多了一个 `agent_spawn`。它决定调用，参数是子 Agent 的 id 和一段任务描述。接下来的事由框架接手：

| 步骤 | 谁在做 | 发生了什么 |
| --- | --- | --- |
| 1 | 父 Agent 的模型 | 输出 `agent_spawn(agent_id="security-reviewer", task="评审这段 SQL")` |
| 2 | 框架 | 按 id 找到声明，新建一个瞬态 `HarnessAgent` |
| 3 | 框架 | 给子 Agent 独立的会话和 workspace，注入它的系统提示 |
| 4 | 子 Agent | 自己跑 ReAct 循环，需要时调工具 |
| 5 | 框架 | 把子 Agent 最后一条消息包成 tool result |
| 6 | 父 Agent | 拿到结果，继续下一轮推理 |

关键在第五步。父 Agent 的上下文里只多了两样东西：派活时写的那段任务描述，和子 Agent 返回的结论。子 Agent 中间查了什么、试错了几轮、工具返回了多少字，全部留在它自己的会话里。

这就是「上下文隔离」的全部秘密，没有什么神奇的压缩算法，就是不给父 Agent 看。

### 隔离的边界在哪

**对话不带过去。** 子 Agent 是独立 session，父 Agent 之前聊过什么，它一概不知道。所以你派活时必须把背景写全。「按上面说的方案改一下」这种话，对它等于空指针。

**工具可以继承，也可以收窄。** 子 Agent 默认拿到父 Agent 的工具箱。声明里的 `tools` 是个白名单：写了，就只保留列出的那些；不写，全给。父 Agent 有退款工具，子 Agent 又不需要，就别让它看见。少一个工具，少一类误操作。

**workspace 默认隔离。** 子 Agent 有自己的工作目录，跟父 Agent 的文件互不干扰。好处是脏文件不会互相污染，代价是子 Agent 看不到父 Agent 刚写的文件。需要共享时把模式改成 `SHARED`，或者干脆在任务里给绝对路径。

**权限默认向下传。** 父 Agent 明确拒绝的权限，子 Agent 也拿不到。这个默认值是对的：不能因为多套了一层，就把父级的禁区绕过去。

### 同步、后台、并行，三种跑法

子 Agent 的行为由一个参数控制：`timeout_seconds`。

| 取值 | 行为 | 适合什么 |
| --- | --- | --- |
| 大于 0（默认 30，上限 600） | 同步等待，结果作为本次工具调用的返回值 | 父 Agent 下一步就要用这份结果 |
| 等于 0 | 立刻返回 `task_id`，子 Agent 后台跑 | 耗时长、不阻塞主线 |
| 同步等待超时 | 任务被提升为后台任务，继续跑，父 Agent 先往下走 | 不想干等，但也不想浪费已完成的工作 |

后台任务完成后，父 Agent 不需要轮询。框架会在它下一次推理前，把结果以 `<system-reminder>` 的形式插到对话末尾。模型看到就会接着处理。

这一点值得单独说：很多从旧框架迁过来的人，习惯在提示词里写「记得调用 task_output 查结果」。这是多余的。自动回推是默认路径，`task_output`、`wait_async_results` 这些工具是逃生口——想提前看进度、想等一批任务全部到齐、想取消跑偏的任务，才需要它们。

并行是另一层。同一轮推理里，模型可以连续发起多个 `agent_spawn`。工具执行默认就是并行的，所以这些子 Agent 会同时开跑，等这一批全部返回，父 Agent 才进入下一轮。这就是标准的 fan-out / fan-in：先扇形派活，再收口合并。

还有两个边界。本地声明的子 Agent 是叶子节点，默认不能再往下派；框架在 spawn 链路上另有 3 层深度保护，但正常业务用不到——真套那么深，先反思任务是不是该拆成独立工作流。另一个是生命周期：子 Agent 是瞬态实例，任务结束就关掉；想让它跨多次调用保留状态，得在声明里打开会话持久化。

## 三、实战：给发布评审搭一个三人小队

结论：一个主 Agent 加两个专家子 Agent，代码量比手写线程池编排少一个数量级。

场景固定下来：主 Agent 收到变更说明，把安全评审派给 `security-reviewer`，性能评审派给 `perf-reviewer`，两份都回来后合并成放行结论。两个子 Agent 各配一个只读工具，谁也不多拿。

### 3.1 依赖

`pom.xml` 只引两个坐标：`agentscope-harness` 提供 Agent 和子 Agent 能力，`agentscope-extensions-model-dashscope` 提供模型接入。JDK 要求 17 以上，这里按 21 编译。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>agentscope-subagent-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>io.agentscope</groupId>
            <artifactId>agentscope-harness</artifactId>
            <version>2.0.4</version>
        </dependency>
        <dependency>
            <groupId>io.agentscope</groupId>
            <artifactId>agentscope-extensions-model-dashscope</artifactId>
            <version>2.0.4</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.16.0</version>
            </plugin>
            <plugin>
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.6.4</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 3.2 两个只读工具

工具类不用继承什么基类。方法上打 `@Tool`，参数上打 `@ToolParam`，注册时框架反射生成 JSON Schema。`readOnly = true` 告诉框架这个调用没有副作用，`concurrencySafe = true` 表示可以并发执行。这里放两个工具：一个查 SLO，一个查安全规范，后面分别发给两个子 Agent。

```java
package com.example.review;

import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;

public class OpsTools {

    @Tool(
            name = "get_service_slo",
            description = "查询某个服务的 SLO 指标，返回可用性、P99 延迟和错误预算剩余。只读操作。",
            readOnly = true,
            concurrencySafe = true)
    public String getServiceSlo(
            @ToolParam(name = "service", description = "服务名，例如 order-service")
            String service) {
        return switch (service) {
            case "order-service" -> "order-service: 可用性 99.95%, P99 320ms, 错误预算剩余 41%";
            case "pay-service" -> "pay-service: 可用性 99.99%, P99 180ms, 错误预算剩余 78%";
            default -> service + ": 未接入 SLO 监控";
        };
    }

    @Tool(
            name = "read_security_policy",
            description = "按主题读取安全规范条款，返回必须遵守的硬性要求。只读操作。",
            readOnly = true,
            concurrencySafe = true)
    public String readSecurityPolicy(
            @ToolParam(name = "topic", description = "规范主题，例如 sql-injection、authz")
            String topic) {
        return switch (topic) {
            case "sql-injection" -> "所有外部输入必须参数化；禁止字符串拼接 SQL；动态排序字段必须走白名单。";
            case "authz" -> "按用户查询的接口必须校验当前登录用户与目标 userId 一致，或具备管理端权限。";
            default -> "未找到主题：" + topic;
        };
    }
}
```

真实项目里这里换成监控 API 或数据库查询就行，方法签名和注解不用动。

### 3.3 主 Agent 和两个子 Agent

`HarnessAgent.builder()` 是共享配置，启动时建一次；每个请求 `build()` 一个新实例，用完关掉。实例是新的，会话是不是新的，由 `userId` 和 `sessionId` 决定。

```java
package com.example.review;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.UserMessage;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.subagent.SubagentDeclaration;

import java.nio.file.Path;
import java.util.List;

public class ReviewTeamApp {

    private static final HarnessAgent.Builder BUILDER = HarnessAgent.builder()
            .name("release-review-lead")
            .sysPrompt("""
                    你是发布评审的主持人。
                    收到变更说明后，必须把安全评审交给 security-reviewer，把性能评审交给 perf-reviewer。
                    两个子 Agent 都返回后，你负责合并：先列阻塞项，再列建议项，最后给一句是否放行的结论。
                    不要自己代替子 Agent 做评审。
                    """)
            .model("dashscope:qwen-plus")
            .workspace(Path.of(".agentscope/review-workspace"))
            .toolkit(buildToolkit())
            .subagent(SubagentDeclaration.builder()
                    .name("security-reviewer")
                    .description("安全评审专家。检查鉴权、SQL 注入、越权、敏感信息泄露时使用。")
                    .model("dashscope:qwen-plus")
                    .steps(6)
                    .tools(List.of("read_security_policy"))
                    .build())
            .subagent(SubagentDeclaration.builder()
                    .name("perf-reviewer")
                    .description("性能评审专家。评估慢 SQL、锁竞争、线程池和超时设置时使用。")
                    .model("dashscope:qwen-plus")
                    .steps(6)
                    .tools(List.of("get_service_slo"))
                    .build());

    public static void main(String[] args) {
        String change = """
                变更：order-service 新增“按用户查订单”接口
                SQL：SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC;
                接口没有分页参数，直接返回 List<Order>。
                上线时间：今晚 22:00，预计峰值 QPS 1200。
                """;

        RuntimeContext ctx = RuntimeContext.builder()
                .userId("alice")
                .sessionId("release-night-42")
                .build();

        try (HarnessAgent agent = BUILDER.build()) {
            Msg reply = agent.call(new UserMessage("请评审这次发布：\n" + change), ctx).block();
            System.out.println(reply.getTextContent());
        }
    }

    private static Toolkit buildToolkit() {
        Toolkit toolkit = new Toolkit();
        toolkit.registerTool(new OpsTools());
        return toolkit;
    }
}
```

几处关键设计，逐个说。

`sysPrompt` 里写死了「必须派给两个子 Agent」。这不是啰嗦，是给模型一个明确的编排策略。你不写，它可能自己把活干了，子 Agent 白声明。

两个子 Agent 都没配 workspace，框架会自动给它们各建一个隔离目录。它们只做纯文本分析，不需要碰文件，这样最省事。

`security-reviewer` 的白名单只有 `read_security_policy`，`perf-reviewer` 只有 `get_service_slo`。父工具箱里两个工具都在，但每个子 Agent 只看得见自己那一个。

`perf-reviewer` 的 `tools(List.of("get_service_slo"))` 是白名单，`security-reviewer` 同样只留了 `read_security_policy`。以后父 Agent 加了删库工具，两个子 Agent 都不会跟着拿到。

`steps(6)` 限制子 Agent 的推理轮数。默认是 10，评审这种活 6 轮够用。给太小，它可能没看完就交卷；给太大，跑偏了也能烧很久。

### 3.4 跑起来

```bash
export DASHSCOPE_API_KEY=你的密钥
mvn -q compile exec:java -Dexec.mainClass=com.example.review.ReviewTeamApp
```

输出不是固定字符串，模型每次措辞会变，但结构会稳定在「阻塞项 / 建议项 / 结论」三块。如果它没按格式来，别急着改代码，先在 `sysPrompt` 里把格式再写死一点，或者给子 Agent 也加一句输出约定。

### 3.5 零代码加一个子 Agent

声明也可以不写 Java。在 workspace 下建 `subagents/reviewer.md`，文件名就是 `agent_id`，front matter 里的 `description` 决定模型什么时候会想到它。

`review-workspace/subagents/reviewer.md`：

```markdown
---
description: 代码评审专家。需要检查命名、异常处理、边界条件时使用。
model: dashscope:qwen-plus
steps: 6
---

你是代码评审专家。严格按下面的格式输出，不要写额外内容：

## 阻塞项
## 建议项
## 结论
```

主类只需要指向这个 workspace，不用任何 `subagent(...)` 调用：

```java
package com.example.review;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.UserMessage;
import io.agentscope.harness.agent.HarnessAgent;

import java.nio.file.Path;

public class WorkspaceSubagentApp {

    public static void main(String[] args) {
        HarnessAgent.Builder builder = HarnessAgent.builder()
                .name("release-review-lead")
                .sysPrompt("你是发布评审主持人。代码评审交给 reviewer 子 Agent，你只负责汇总。")
                .model("dashscope:qwen-plus")
                .workspace(Path.of("review-workspace"));

        RuntimeContext ctx = RuntimeContext.builder()
                .userId("alice")
                .sessionId("release-md-demo")
                .build();

        try (HarnessAgent agent = builder.build()) {
            Msg reply = agent.call(new UserMessage("""
                    请让 reviewer 评审这段代码：
                    public Order get(Long id) {
                        return orderMapper.selectById(id);
                    }
                    """), ctx).block();
            System.out.println(reply.getTextContent());
        }
    }
}
```

这种写法适合把 Agent 定义交给团队维护：改提示词、改模型、改工具白名单，都是改 Markdown，不用重新发版。注意 front matter 里不要再写 `name`，文件名已经是 id，重复写会冲突。

## 四、子 Agent 踩坑经验和最佳实践

结论：子 Agent 用错，通常不是框架问题，是任务边界没画清。

**任务描述必须自包含。** 子 Agent 看不到父对话，它只有你给的那段 task。把背景、输入、期望格式、不要做什么，一次写全。「参考刚才那份方案」是典型反例，子 Agent 只会瞎猜。

**别让子 Agent 继承全部工具。** 默认全继承很省事，也很危险。父 Agent 有下单、退款、发消息的工具，子 Agent 做只读分析时全都能调。声明里加白名单，一个一个列。

**别在提示词里写「记得轮询」。** 后台任务完成会自动回推，写轮询只会让模型多调一次 `task_output`，白花钱。只有需要「等一批任务全部到齐再继续」时，才用 `wait_async_results` 做屏障。

**把超时当成失败，是误判。** 同步等待超时后，任务不会死，会被提升为后台任务继续跑，返回里带 `task_id` 和 `timeout_promoted` 状态。这时候父 Agent 如果重新派一遍活，同一份工作就干了两遍。看到这个状态，要么等回推，要么用 `task_output` 接上。

**子 Agent 的输出要约定格式。** 不约定，两个子 Agent 一个写散文一个写表格，父 Agent 合并时只能和稀泥。在子 Agent 的提示里固定小节标题，合并逻辑才稳定。

**workspace 隔离会咬人。** 默认 `ISOLATED`，子 Agent 看不到父 Agent 刚生成的文件。要么改成 `SHARED`，要么在任务里给绝对路径。别一边让它读相对路径，一边奇怪为什么找不到。

**别指望无限套娃。** 本地子 Agent 默认是叶子，不能再派下一层；只有自定义 factory、远程链路才可能继续往下，而且整条链路有 3 层深度保护。更现实的问题是成本：每层每个子 Agent 都是一次完整的模型循环，扇出几层就能把一次请求放大成几十次调用。真需要那么深，先想想任务是不是该拆成独立工作流。

**算清成本再拆。** 拆分的收益是上下文更干净、墙钟时间更短；代价是 token 总量上升，因为每个子 Agent 都要重新读一遍系统提示和任务背景。两个子 Agent 并行，时间大约取决于最慢的那个，但账单是两个一起算。

## 五、多智能体选型：什么时候该拆，什么时候别拆

结论：先用单 Agent 跑通，出现明确的上下文或并行信号，再拆。

| 方案 | 适合的场景 | 代价 |
| --- | --- | --- |
| 单 Agent | 任务步骤少、上下文可控、串行也能接受 | 复杂任务容易注意力涣散 |
| 主 Agent + 子 Agent | 子任务独立、各自吃大量材料、需要并行 | token 上升，编排依赖模型判断 |
| 固定工作流 | 步骤稳定、顺序不能变、要强审计 | 灵活性差，异常分支要手写 |
| 手写多线程编排 | 完全不信任模型做调度 | 代码量大，状态和重试都得自己管 |

一个简单的判断顺序：

- 任务能不能用一段提示词稳定完成？能，别拆。
- 子任务之间有没有数据依赖？有，先后顺序明确，用固定工作流更稳。
- 子任务是不是各自要读大量文档、日志、代码？是，子 Agent 的上下文隔离正好对症。
- 能不能同时做？能，让模型在同一轮发多个 `agent_spawn`，吃满并行。

AgentScope 的子 Agent 胜在省事：声明、隔离、工具白名单、后台回推、并行执行，框架都包了。代价是调度权交给模型，它可能派错人、派重、或者干脆不派。所以系统提示里的编排规则要写清楚，关键场景再加同步屏障或人工审批。

## 六、总结

子 Agent 的本质，是把「一个大脑硬扛」换成「几个专家分头干，主持人汇总」。上下文隔离不是玄学，就是不让父 Agent 看到中间过程。

落地时记住三件事：

- 任务描述写全，子 Agent 没有父对话的记忆。
- 工具用白名单收窄，别把整个工具箱递过去。
- 同步用于必须拿结果再往下走，后台用于长任务，并行用于互不依赖的分支。

还有一层容易被忽略：子 Agent 不是微服务。它没有独立部署、没有自己的 SLA，也不会因为你多开几个就自动变快。它只是把一个上下文切成几个，让每个上下文里的模型少分心。切分本身有成本，任务描述要重写，结果要合并，失败要兜底。

所以别为了架构好看而拆。先让单 Agent 跑，跑到它开始漏约束、串行拖垮体验、或者两套标准互相打架，再动手。

至于什么时候拆——当你发现提示词越写越长、模型开始漏看前面的约束、两个检查项互相打架，那就是信号。别等到一次请求烧掉几十万 token 才想起来分工。

## 参考资料

- [Subagent - AgentScope Java](https://java.agentscope.io/v2/en/docs/harness/subagent)
- [Quickstart - AgentScope Java](https://java.agentscope.io/v2/en/docs/quickstart)
- [Harness Architecture - AgentScope Java](https://java.agentscope.io/v2/en/docs/harness/architecture)
- [agentscope-java on GitHub](https://github.com/agentscope-ai/agentscope-java)

文 / 会编程的吕洞宾

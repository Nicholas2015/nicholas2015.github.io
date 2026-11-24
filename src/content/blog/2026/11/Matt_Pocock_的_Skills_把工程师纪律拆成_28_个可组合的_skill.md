---
title: "Matt Pocock 的 Skills：把工程师纪律拆成 28 个可组合的 skill"
date: 2026-11-23 19:15:14
tags: ["AI", "Agent", "Skill", "工程实践"]
categories: ai
---

# Matt Pocock 的 Skills：把工程师纪律拆成 28 个可组合的 skill

三十三万颗星。看起来像又一个"AI 编程神器"——作者 Matt Pocock，TypeScript 圈里做 Total TypeScript 课程的，前 Vercel。但这个仓库跟市面上那堆恰恰相反：它不帮你少思考，它专门设计来逼你多思考。

仓库副标题就一句话：**Skills for Real Engineers**，后面跟着"straight from my .agents directory"——直接从他的个人目录里倒出来的，不是精心包装过的产品。

## 他先骂了对手

README 里对 GSD、BMAD、Spec-Kit 这帮框架的评价很直接：

> 开发真实应用很难。这些方法想通过**接管流程**来帮忙。但在这么做的时候，它们拿走了你的控制权，让流程里的 bug 变得难以排查。

这句话说的是什么？那些框架给你一条固定的流水线：先 PRD、再任务拆解、再代码生成。你按着走就行。出问题了呢？你手里只有一个黑盒，不知道是哪一步错了，也改不动。

Matt 的选择完全相反：**小、好改、可组合，跟任何模型都能配**。他的原话是"hack around with them，make them your own"。

这个定位决定了整个仓库的形态——它不是框架，是零件箱。

## 为什么这些 skill 存在

README 用四个"失败模式"来组织，每个都是他实际踩过的，配一句经典书的引用。我觉得这才是整篇最有价值的部分，比 skill 列表值钱。

### 失败模式 #1：agent 压根没做你要的东西

> 没人真正清楚自己想要什么。
> ——《程序员修炼之道》

你脑子里有个想法，跟 agent 一说，它开始干。回头一看，完全不是那么回事。

这是软件开发里最古老的失败模式——需求错位。换成 AI，它没消失，反而因为 agent 执行得快而放大了：错得也快。

**他的解法是"拷问"（grilling）。**

不是让 agent 干活，是让 agent 反过来问你。一条一条，问到你把脑子里的模糊地带全部分辨清楚为止。

### 失败模式 #2：废话太多

> 有了通用语言，开发者和代码的对话都来自同一个领域模型。
> ——Eric Evans，《领域驱动设计》

agent 一进项目就开始猜术语。它不知道"课程视频"里"materialize"是什么意思，于是用二十个词去描述一个词能说清的事。

**他的解法是共享语言**：一份 `GLOSSARY.md`，把项目黑话翻译成模型能直接用的词。

他给了个特别有说服力的对照：

> **改之前**：课程里某个 section 下面的一节 lesson 被"变成真的"（就是给了它在文件系统里一个位置）的时候有个问题
>
> **改之后**：materialization cascade 有个问题

一句话变五个字。而且这个精简**每次会话都在省**。

他在 README 里说：这可能是整个仓库最酷的技巧。

### 失败模式 #3：代码跑不起来

> 永远走小的、有意识的步子。反馈速度就是你的速度上限。
> ——《程序员修炼之道》

对齐了也没用，如果 agent 写出来的东西运行起来是错的。

**他的解法是反馈回路**：静态类型、浏览器访问、自动化测试。测试这块的核心是红-绿-重构——先写个失败的测试，再让它过。

这里有个反常识的点：**agent 写测试不是为了验证，是为了拿到一致的反馈信号**。没有这个信号，它就是在黑暗里飞行。

### 失败模式 #4：我们造了坨泥巴

> 每天都要在系统设计上投入。
> ——Kent Beck

> 最好的模块是深的。它们用一个简单的接口撬动大量功能。
> ——John Ousterhout，《软件设计哲学》

agent 写代码快，所以软件熵增也快。几周下来，代码库的复杂度到了一个手工开发根本达不到的高度。

**他的解法是"每天关心设计"**。不是重构大扫除，是持续地识别"可以变深"的模块——把一堆行为收进一个小接口后面。

## 最巧妙的一个设计：谁能调用它

这是我看完整个仓库后觉得最该抄的一点。

所有 skill 按**谁能调用**分成两类：

**用户调用（user-invoked）**：只有你敲 `/grill-me` 才会触发。它的工作是**调度**——编排一条流程。

**模型调用（model-invoked）**：你可以敲，agent 也可以自己判断该用。它装的是**可复用的纪律**。

规则很硬：**用户调用的 skill 可以调用模型调用的，但永远不能调用另一个用户调用的。**

为什么要这么分层？我理解是这样：用户调用的那些是"入口"，每个都对应一次明确的意图（我要开始设计了、我要发 PR 了）。如果它们能互相调用，agent 就能在你没让它开始干活的时候自己开工。禁止这层嵌套，等于保证"动手"这件事永远需要你的明确指令。

这个设计在 `ask-matt` 那个路由 skill 里体现得最清楚——它自己就是用户调用的，干的活只是告诉你"你该用哪个"。

## 主流程：从想法到上线

`ask-matt` 里画的主干，我认为是整个仓库的骨架：

```text
/grill-with-docs  →  把想法问清楚
        ↓
   需要原型验证？ →  /prototype  →  /handoff 回来
        ↓
   多会话的活？ →  /to-spec → /to-tickets → /implement（或者 /implement-spec）
        ↓
      单会话的活？ →  /implement 直接干
```

拆开说几个关键的：

**`/grill-with-docs`** —— 起点。跟 `/grill-me` 是同一套拷问，但它多干两件事：边问边更新 `GLOSSARY.md`，把难解释的决策写成 ADR。所以它在有仓库的时候永远比 `/grill-me` 好，因为**它留下痕迹**。

**`/to-spec` vs `/grill-with-docs` 的分工很讲究**：`to-spec` 不提问，它只是把你们已经聊出来的东西整理成 spec。问清楚和写下来是两个动作，他拆成了两个 skill。

**`/to-tickets`** —— 把 spec 拆成"曳光弹式"的工单（tracer-bullet ticket），每个工单**声明它的阻塞边**。在有真实 issue tracker 的地方，这些边变成原生的 blocking link，所以阻塞解除的工单谁都能拿。

**`/implement` vs `/implement-spec`** —— 前者一个工单一次，之间 `/clear` 清空上下文；后者把工单当任务图，在"就绪前沿"上并行跑多个实现子 agent，全部落到一个集成分支。**前者靠你自己驱动，后者你退到编排位。**

**`/wayfinder`** —— 当活大到单个会话装不下时用。把工作拆成决策工单挂在 tracker 上，一个一个解决，直到路清楚为止。

## 拷问到底怎么工作

`grilling` 是所有拷问类 skill 底下的那个原语——`grill-me`、`grill-with-docs`、`triage`、`wayfinder`、`improve-codebase-architecture` 全用它。所以它的写法最值得看。

它把设计当成一棵**决策树**：每个决策分叉出依赖它的决策。

**按轮（round）推进。** 所谓"前沿"（frontier）是——前置条件已经确定、现在就能问、不用猜答案的那些问题。一轮把整个前沿问完，每个问题编号，并给出它推荐的答案。等用户答完再下一轮。

问题格式定死了：

```text
❓ **Q1** - **<问题标题>**：<问题正文，可能多段，可能带选项>

➡️ <我推荐的答案>
```

还有一条硬规矩：**每个问题的措辞要让"是"等于接受推荐答案**。

这条看着是格式细节，实际是效率设计——用户大部分时候只需要回"是"或者"不，改成那个"。不用每次重新构造回答。

然后还有一条我觉得最能说明作者水平的：

> **查事实是你的活，永远不是用户的。**

前沿上一个问题需要环境里的事实（文件系统、工具），就派一个子 agent 用全新的上下文去找，别问用户你自己能查的东西。而且不能等：跑着的探查算"未定的前置"，只有依赖它的下游问题要等，前沿上其余的问题现在就问。

最后的收尾条件很干净：**前沿空了**——设计树的每个分支都走过了，没有一个假设是悄悄留下的。而且，**在用户确认之前不许动手**。

## 另外几个值得单独说的

**`/tdd`** —— 红-绿-重构的循环，一次一个垂直切片。配套两个参考文档讲什么算好测试、什么算坏测试。这个 skill 的价值不在教 TDD，在**让 agent 有稳定的反馈节拍**。

**`/diagnosing-bugs`** —— 一个分阶段门控的诊断循环：先建一个能在这个 bug 上变红的反馈回路，然后最小化、提假设、插桩、修、补回归测试。每一阶段过了才进下一阶段。这个"门控"设计我一直想要——防止 agent 跳到结论。

**`/code-review`** —— **两个轴，跑两个并行子 agent**：一个查"标准"（符不符合仓库规范、有没有 Fowler 那套坏味道），另一个查"规格"（忠实地实现了原始 issue 吗）。并行是为了**互相不污染**——同一个上下文里查规范和查需求，结论会串味。

**`/pr`** —— PR 正文该长什么样：摘要用最小的可视化把改动说清、前后证据证明它能用、还要给个合并风险判断（单向门还是双向门，影响半径多大）。"单向门/双向门"是 Jeff Bezos 那套决策框架。

**`/improve-codebase-architecture`** —— 扫代码库找"可以变深"的机会，出一份可视化 HTML 报告交给你，然后你挑一个，它跟你拷问。他自己说每几天该跑一次。而且他标注得很诚实：**这是勘测，不是救援**——在老代码库上它能找到真候选，但不会替你理清泥巴。

**`/retro`** —— 一次会话之后，给 agent 的运行环境提改进建议（导航、自动检查、编码规范、steering 文件、工具），按严重程度排序。

**`/wizard`** —— 生成一个交互式 bash 向导，把只有人能做的步骤带人走一遍：配基础设施、设凭据或 CI secret、走一个不熟的三方后台、跑一次性的迁移或切换。这个思路挺少见的——**承认有些活 AI 干不了，那就让它造工具给人用**。

## 生产效率那一组

**`/handoff`** —— 把当前对话压缩成一份交接文档，让另一个 agent 接着干。README 里专门说了它的典型用法：原型活在它自己的目录里，用 `/handoff` 带出去、开新会话做原型、`/handoff` 带回来。**这是解决"换个上下文就失忆"的正解**。

**`/teach`** —— 跨多次会话教你一个概念，把当前目录当成有状态的教具。

**`/wait-what`** —— 这个名字起得好。任何时候一句话没听懂，敲它，agent 用你 `GLOSSARY.md` 里的词、补上你缺的上下文，用人话说一遍。**不用重开对话**。

**`/to-questionnaire`** —— 有些决策你一个人定不了，得问别人。它把决策转成一份 Markdown 问卷，给那个能拍板的人，异步填或者开会一起填。有意思的是它**拷问的是"发送"这件事**（给谁、要什么回来），不是问卷主题。

**`writing-for-agents`** —— 这个我认为是**唯一一个跟 AI 工程化直接相关的硬通货**。它讲怎么写给 agent 读的文档，包括 skill、`AGENTS.md`、任何通过指针到达的文档。

里面两个概念很有用：

- **上下文指针（context pointer）**：agent 上下文里的一条引用，它命名某个不在上下文里的材料，并编码了"什么条件下该去够到它"。skill 的 description 就是一个；`AGENTS.md` 里指向某个文档的一行也是同一个东西。**决定 agent 什么时候去够的，是指针的措辞，不是它的目标。**
- **两种负载**：**上下文负载**（常驻材料在窗口上的成本，每轮都花 token 和注意力）、**认知负载**（人的成本：有哪些文档、什么时候该用哪个）。他说认知负载不是要最小化的东西——"它是人的主体性的代价"。

还有个判断标准值得抄走：一个必须有、但指针措辞很弱的材料，**这叫变异性 bug**——先修措辞，修不好才内联。

## 安装

30 秒的事，选一个装（**两个都装会让你每个 skill 出现两次**）：

Claude Code：

```bash
claude plugin install mattpocock-skills@claude-plugins-official
```

Codex：

```bash
codex plugin marketplace add mattpocock/skills
codex plugin add mattpocock-skills@mattpocock
```

其他任意 agent（cursor / opencode / devin / windsurf / amp / pi）：

```bash
npx skills@latest add mattpocock/skills -a <agent>
```

装的时候**记得勾上 `setup-matt-pocock-skills`**，然后每个仓库跑一次：

```text
/setup-matt-pocock-skills
```

它会问你三件事：用哪个 issue tracker（GitHub / GitLab / 本地文件 / 你描述的任何东西）、triage 工单时打什么 label、创建的文档放哪儿。

没有这一步的话，`/triage`、`/to-tickets` 这些依赖 tracker 的 skill 跑不起来。

## 一些实际判断

**它不解耦于模型。** README 明说"work with any model"。不过注意 `agents/openai.yaml` 这个文件——每个 skill 目录下都有一份，说明确实给不同 agent 做了适配。

**它真的小。** 主体 skill 的 SKILL.md 大多在两三千字，辅助材料拆成独立文件按需读。对比那些动辄上万字的框架文档，这套更像是"提示词工程做好了的样子"。

**它承认边界。** `/improve-codebase-architecture` 说自己"是勘测不是救援"；`/wizard` 承认有些活 AI 干不了就造工具给人；`writing-for-agents` 直接把认知负载定义成"不该最小化"。这种诚实度在 AI 工具圈里不多见。

**学它最好别整套搬。** 这套 skill 是围绕"一个人用 Claude Code 做 TypeScript 项目"调出来的。你的项目结构、issue tracker、团队规范都不一样。真正该抄的是那四个失败模式的诊断思路，和"用户调用/模型调用"这条分层规则——这两个是跟技术栈无关的。

## 参考资料

- [mattpocock/skills 仓库](https://github.com/mattpocock/skills)
- [skills.sh 上的 skill 目录](https://skills.sh/mattpocock/skills)
- [作者站点](https://aihero.dev/skills)
- [ask-matt：skill 路由与主流程](https://github.com/mattpocock/skills/blob/main/skills/engineering/ask-matt/SKILL.md)
- [grilling：拷问原语](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)
- [writing-for-agents：怎么写给 agent 的文档](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md)

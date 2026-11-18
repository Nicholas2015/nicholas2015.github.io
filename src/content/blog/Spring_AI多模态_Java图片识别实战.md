---
title: "Spring AI 多模态：Java 图片识别实战"
date: 2026-10-16T20:00:00+08:00
category: "AI"
tags: ["spring-ai"]
---

**摘要：** 发票、合同扫描件、用户截图里的信息，Java 后端过去要接 OCR 再写正则去抠，模板一变就崩。本文讲清多模态模型怎么「看图」，再用 Spring AI 的 `Media` 把图片塞进请求：两个云端示例（图片问答、发票结构化抽取）加一个本地模型示例，代码完整可直接跑。

> 财务系统要录发票。旧方案是 Tesseract 识别文字，再用正则抠金额、开票日期、购方名称。上线第一周还行，第二周供应商换了发票模板，正则对不上，字段整片错位。新方案是把发票图片直接发给多模态模型，问一句「卖方、买方、价税合计是多少」，一次调用拿到结构化结果，模板变不变都不影响。在 Java 里落地这套东西，Spring AI 留的入口只有一个字段：`UserMessage` 的 `media`。这篇把原理和代码一次讲完。

## 一、这个问题到底是什么

结论：多模态就是让模型除了文字，还能直接看图片、听音频。它把「图片里有什么」从一个需要 OCR + 模板匹配 + 人工规则的工程问题，变成一次模型调用。

先分清两件事，很多人把它们混在一起：

- **OCR**：把像素里的字符转成文本。它不知道这是一张发票，也不知道金额在哪一行。
- **多模态理解**：模型看到整张图，知道这是发票，能回答「价税合计多少」「有没有盖章」「这两版设计稿差在哪」。

真正费人的是 OCR 之后那半段。文字出来了，还得靠模板和正则去找字段；模板一换、扫描件一歪，规则全废。多模态模型不需要模板，它按语义回答问题——图变了，问题不变，答案照样能出。

在 Spring AI 里，图片不是特殊类型，它就是消息的一部分：

| 概念 | 说明 |
| --- | --- |
| `Media` | 一份多模态数据，等于「格式 + 内容」 |
| `MimeType` | 格式声明，比如 `image/png`、`image/jpeg` |
| `UserMessage.media` | 把 `Media` 挂在用户消息上，跟文字一起发出去 |

有一条限制要记牢：`media` 只对**用户消息**有意义。挂在系统消息上没用；模型返回的助手消息永远是纯文本。想让模型生成图片或语音，那是另一套专用模型，不走这条链路。

适合用的场景：

- 用户上传截图、照片，要判断内容或提取信息
- 发票、合同、证件、报表扫描件的字段录入
- 图片对比，比如维修前后、设计稿两版差异
- 报错截图定位问题、图表截图转成数据

判断标准一句话：**如果这件事换个不懂模板的人，看一眼图也能答出来，那它就该交给多模态模型。**

## 二、底层原理到底怎么回事

结论：多模态模型不是「两个模型绑在一起」，而是把图片也变成了 token，和文字 token 放在同一条序列里，交给同一个 Transformer 处理。

图片怎么变成 token，拆成三步：

1. 图片先切成固定大小的小块（patch），常见 14×14 或 16×16 像素一块。
2. 每块过一遍视觉编码器（通常是一个 ViT），变成一个向量。
3. 这个向量再经过一层投影，映射到和文字 token 相同的语义空间。

于是「一串图片 token + 一串文字 token」拼起来，就是模型看到的一条普通序列。图片和文字不是两路输入，它们在这一次请求里被拼成「一段话里夹着几块图」。

模型凭什么能「看懂」？关键在第 3 步的对齐。训练时，成对的「图 + 描述」在向量空间里被拉近，不匹配的被推远。训练完，一张猫的图和「猫」这个词的向量挨得很近；一张发票的照片，和「发票」「金额」这些词的向量也挨得很近。

对写 Java 的人来说，这件事最直接的后果是**钱**：

- 图片按被切成多少块来折算 token，图越大、块越多、越贵。
- 一张高分辨率截图，可能比几百字的提示词还贵。
- 所以「上传前先压缩」不是优化技巧，是省钱习惯。

再看 Spring AI 在这一层做了什么。它没有为图片造新接口，只是让 `UserMessage` 多带一个 `media` 字段。这个 `Media` 的内容有两种给法：

- 传 `Resource`：Spring AI 把字节读出来，转成 base64 嵌在请求体里。
- 传 `URI`：只把地址交给模型，让模型自己去下载。

这两个选择有真实差别。模型在公网、你的图片在内网，你给它一个内网地址它够不着，只能用 base64。反过来，一张已经在公网对象存储上的图，给 URL 更省流量。选错了不会报「格式错误」，只会拿到一个 4xx 或者一个莫名其妙的答案。

一次多模态调用的消息结构大概长这样：

```text
SystemMessage   : 你是一个严谨的票据识别助手
UserMessage     : 「提取发票字段」 + [Media(image/png)]
AssistantMessage: 纯文本
```

## 三、实战：手把手写代码

### 3.1 依赖和配置

pom.xml，完整可直接抄：

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
    <artifactId>spring-ai-vision-demo</artifactId>
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
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-ollama</artifactId>
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
            </plugin>
        </plugins>
    </build>
</project>
```

application.yml：

```yaml
spring:
  ai:
    model:
      chat: openai
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o
```

`spring.ai.model.chat` 这行是个开关。classpath 上同时放了 openai 和 ollama 两个 starter 时，用它指定激活哪一个，否则容器里会出现两个 `ChatModel` bean，注入直接失败。后面的本地模型示例靠切换这行来换后端。

启动类，没什么可讲的：

```java
package com.example.multimodal;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class MultimodalApplication {

    public static void main(String[] args) {
        SpringApplication.run(MultimodalApplication.class, args);
    }
}
```

### 3.2 第一个例子：把图片发给模型，让它描述

这个例子故意用最「素」的写法：直接注入 `ChatModel`，手动拼 `UserMessage` 和 `Prompt`。不经过 `ChatClient`，出了问题排查链路最短。

```java
package com.example.multimodal.web;

import java.io.IOException;

import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.content.Media;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.util.MimeTypeUtils;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/vision")
public class ImageDescribeController {

    private final ChatModel chatModel;

    public ImageDescribeController(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    @PostMapping(value = "/describe", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public String describe(@RequestParam("file") MultipartFile file) throws IOException {
        Media media = new Media(MimeTypeUtils.parseMimeType(contentTypeOf(file)), toResource(file));

        UserMessage userMessage = UserMessage.builder()
                .text("用中文描述这张图片里有什么。如果图上有文字，把文字原样抄出来，不要改写。")
                .media(media)
                .build();

        return this.chatModel.call(new Prompt(userMessage))
                .getResult()
                .getOutput()
                .getText();
    }

    private static String contentTypeOf(MultipartFile file) {
        String contentType = file.getContentType();
        return (contentType == null || contentType.isBlank()) ? "image/jpeg" : contentType;
    }

    private static Resource toResource(MultipartFile file) throws IOException {
        return new ByteArrayResource(file.getBytes()) {
            @Override
            public String getFilename() {
                return file.getOriginalFilename();
            }
        };
    }
}
```

几处关键点，挨个说：

- 上传上来的 `MultipartFile` 不能直接当 `Media` 用，先转成 `Resource`。这里转成 `ByteArrayResource`，因为它的字节已经在内存里了。
- 重写 `getFilename()` 不是洁癖。`ByteArrayResource` 默认没有文件名，某些模型服务端会靠文件名后缀判断格式，缺失时会拒绝或者按错误的格式解析。
- `MimeTypeUtils.parseMimeType(...)` 把字符串格式转成 `MimeType`。浏览器没传 `Content-Type` 时给个兜底值，别让空值把请求打死。
- 取结果的链是 `getResult()` → `getOutput()` → `getText()`，拿到的就是模型回复的纯文本。

跑起来测一下：

```bash
curl -X POST http://localhost:8080/api/vision/describe \
     -F "file=@/tmp/invoice.png"
```

### 3.3 第二个例子：图片直接变成 Java 对象

`ChatClient` 的 `entity()` 会替你干两件事：自动给模型加上「按这个结构输出 JSON」的指令，再把返回的 JSON 转成对象。图片照样挂在 `UserMessage` 上。

先定义要拿的数据。注意日期用了 `String`，原因在踩坑那节讲：

```java
package com.example.multimodal.invoice;

import java.math.BigDecimal;
import java.util.List;

public record Invoice(
        String sellerName,
        String buyerName,
        BigDecimal totalAmount,
        String invoiceDate,
        List<Item> items) {

    public record Item(String name, BigDecimal amount) {
    }
}
```

控制器：

```java
package com.example.multimodal.web;

import java.io.IOException;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.content.Media;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.util.MimeTypeUtils;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import com.example.multimodal.invoice.Invoice;

@RestController
@RequestMapping("/api/invoice")
public class InvoiceExtractController {

    private final ChatClient chatClient;

    public InvoiceExtractController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @PostMapping(value = "/extract", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Invoice extract(@RequestParam("file") MultipartFile file) throws IOException {
        Media media = new Media(MimeTypeUtils.parseMimeType(contentTypeOf(file)), toResource(file));

        UserMessage userMessage = UserMessage.builder()
                .text("提取这张发票的卖方名称、买方名称、价税合计金额、开票日期和商品明细。"
                        + "图中看不清的字段留空，禁止猜测或补全。")
                .media(media)
                .build();

        return this.chatClient.prompt()
                .system("你是财务票据识别助手，只输出图片中真实存在的信息。")
                .messages(userMessage)
                .call()
                .entity(Invoice.class);
    }

    private static String contentTypeOf(MultipartFile file) {
        String contentType = file.getContentType();
        return (contentType == null || contentType.isBlank()) ? "image/jpeg" : contentType;
    }

    private static Resource toResource(MultipartFile file) throws IOException {
        return new ByteArrayResource(file.getBytes()) {
            @Override
            public String getFilename() {
                return file.getOriginalFilename();
            }
        };
    }
}
```

`.entity(Invoice.class)` 一行顶掉过去几十行：不用手写 JSON 解析，也不用在提示词里手贴 schema。它内部把 `Invoice` 的结构转成格式说明塞给模型，拿到文本后再反序列化。业务代码里你直接拿到一个 `Invoice` 对象，`invoice.totalAmount()` 就能用。

### 3.4 第三个例子：换成本地模型，内网也能跑

发票这种东西，很多公司不允许传出去。本地跑一个视觉模型，数据不出机房。

新增一份 profile 配置 `application-local.yml`：

```yaml
spring:
  ai:
    model:
      chat: ollama
    ollama:
      base-url: http://localhost:11434
      chat:
        model: qwen2.5vl:7b
        options:
          temperature: 0.2
      init:
        pull-model-strategy: when_missing
```

`pull-model-strategy` 设成 `when_missing`，启动时发现模型没拉过就自动 `ollama pull`，省掉一次手工操作。本地模型优先选带 vl（vision-language）后缀的：`qwen2.5vl:7b` 认中文票据比较稳，`gemma3:4b` 更省显存。

要注意的是，本地这份配置和线上那份共用同一套 Java 代码。切后端只改配置，不改代码——这也是 Spring AI 抽象的价值所在。

再写一个只在 local profile 下生效的启动任务，做多图对比。图片放在 `src/main/resources/images/` 下。

```java
package com.example.multimodal.local;

import java.util.List;

import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.content.Media;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.springframework.util.MimeTypeUtils;

@Component
@Profile("local")
public class LocalVisionRunner implements CommandLineRunner {

    private final ChatModel chatModel;

    public LocalVisionRunner(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    @Override
    public void run(String... args) {
        Media before = new Media(MimeTypeUtils.IMAGE_PNG,
                new ClassPathResource("images/board-before.png"));
        Media after = new Media(MimeTypeUtils.IMAGE_PNG,
                new ClassPathResource("images/board-after.png"));

        UserMessage userMessage = UserMessage.builder()
                .text("这是同一块电路板维修前后的两张图。用中文指出哪些元件发生了变化，"
                        + "按「位置 - 变化」的列表输出，看不清就写不确定。")
                .media(List.of(before, after))
                .build();

        String answer = this.chatModel.call(new Prompt(userMessage))
                .getResult()
                .getOutput()
                .getText();

        System.out.println("【本地模型回答】");
        System.out.println(answer);
    }
}
```

启动：

```bash
ollama pull qwen2.5vl:7b
./mvnw spring-boot:run -Dspring-boot.run.profiles=local
```

多图对比就是在同一次请求里挂多个 `Media`，顺序就是模型看到的顺序。图一多，token 涨得很快，下一节讲怎么控制。

## 四、踩坑经验和最佳实践

**日期字段别用 `LocalDate`。** 模型返回的 JSON 里日期是字符串，如果反序列化用的 ObjectMapper 没注册 JavaTimeModule，`LocalDate` 会直接抛异常。上面 `Invoice` 用 `String` 接就是因为这个：先收字符串，在业务层自己 `LocalDate.parse(...)`，出错也看得见。金额用 `BigDecimal` 没问题，它是 Jackson 的原生类型。

**格式不对，模型不会好好告诉你。** `png`、`jpeg`、`webp` 都稳；HEIC、TIFF 很多模型不吃，报错信息通常含糊。上传入口先把格式转一遍，别指望模型兜底。

**内网图片只能走 base64。** 给云模型传一个 `http://10.0.0.5/xxx.png`，它拿不到，也不会明确说「地址不可达」。要么 base64，要么把图放到模型能访问的对象存储。

**分辨率不是越高越好。** 长边缩到 1024～1568 之间，多数识别任务已经够用。再往上加，准确率提升很有限，token 成本却是线性涨。

**不会看图的模型不会说「我看不到」。** 换模型前先拿一张明确的图试一次，确认它是真在看图，而不是顺着提示词编。这个坑最贵。

**提示词里必须写「看不清就留空」。** 不写，模型大概率会把没看清的字段替你补全，而且补得像真的。

**一次别挂太多张图。** 图片 token 会挤占上下文，把对话历史和输出空间都压掉。批量场景老老实实分批，配合并发控制。

**图片里可能有隐私。** 发票上有税号、银行账号，证件照有身份证号。上传前想清楚要不要先打码，这不只是合规问题——模型服务商的日志里可能留着。

## 五、性能对比和技术选型

按三个维度看：准不准、贵不贵、数据能不能出去。

| 方案 | 识别准确率 | 成本 | 数据隐私 | 落地难度 |
| --- | --- | --- | --- | --- |
| OpenAI `gpt-4o` 等云端视觉模型 | 高，中文票据也稳 | 按图片 token 计费，量大会疼 | 数据出内网 | 最低，填个 key 就能跑 |
| Anthropic Claude 系列 | 高，长文档截图表现好 | 同上 | 数据出内网 | 低 |
| 阿里云通义千问 VL / 百炼 | 高，中文票据模板友好 | 按量付费，国内结算方便 | 出境合规压力小 | 低 |
| 本地 Ollama（`qwen2.5vl:7b`、`gemma3:4b`） | 中，复杂票据会漏字段 | 一次性显卡投入，调用零成本 | 数据不出机房 | 需要机器和运维 |

怎么选，给几条直接的：

- 数据能出内网、量不大：直接上云端视觉模型，别折腾本地。
- 数据绝对不能出内网：本地模型起步，`qwen2.5vl:7b` 在 16G 显存的机器上能跑；准确率不够再考虑私有化部署更大的模型。
- 国内业务、要发票、要合规：优先国内云厂商的视觉模型。
- 图片量大且模板固定：先想想是不是真的需要多模态——结构固定的场景，OCR 加一次校验可能更便宜。

还有一条容易被忽略：**云端模型和本地模型可以并存**。低敏感度的活走本地，疑难件走云端，用 `spring.ai.model.chat` 配合你自己的路由逻辑就能做。另外，语音转文字不属于多模态聊天链路，那是 `TranscriptionModel` 的活，别硬塞进 `UserMessage`。

## 六、总结

把图片喂给模型，在 Spring AI 里只有一个动作：把 `Media` 挂到 `UserMessage` 上。

- 图片会被切成块、编码成向量，映射进和文字同一个语义空间——所以才要按分辨率对钱负责。
- `Media` 的内容给 `Resource`（base64 内联）还是 `URI`（让模型自己取），取决于你的图片能不能被模型访问到。
- 最省的写法是 `ChatModel` 加 `Prompt`；要结构化结果就用 `ChatClient` 的 `entity()`，省掉手写解析。
- 换云端还是本地，改配置不改代码。

多模态最大的价值不是「技术新」，而是它替掉了那堆最不稳定的模板和正则。过去一个模板变更就能让字段整片错位，现在图变了、问题没变，答案照样出得来。真要说风险，就一条：模型不会告诉你它没看清。所以「看不清就留空」这句话，记得写进提示词。

## 参考资料

- 【Spring AI 官方文档 · Multimodality】https://docs.spring.io/spring-ai/reference/api/multimodality.html
- 【Spring AI 官方文档 · ChatClient】https://docs.spring.io/spring-ai/reference/api/chatclient.html
- 【Spring AI 官方文档 · Ollama Chat】https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html
- 【Spring AI 官方文档 · Transcription API（音频转文字）】https://docs.spring.io/spring-ai/reference/api/audio/transcriptions.html
- 【Anthropic 官方文档 · Vision】https://docs.anthropic.com/en/docs/build-with-claude/vision
- 【Ollama 模型库 · qwen2.5vl】https://ollama.com/library/qwen2.5vl

文 / 会编程的吕洞宾

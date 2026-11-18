---
title: "Embedding 选错 RAG 全废 Java 选型实战"
date: 2026-11-06T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

**摘要：** RAG 召回一堆无关文档，第一反应往往是换切分策略、加重排序，其实八成问题出在 Embedding 模型上。本文讲清 Embedding 到底在干什么、怎么选、怎么在 Spring AI 和 LangChain4j 里用起来，附完整可运行代码和三个常见坑。

> 知识库问答上线第一天，用户问「怎么退款」，系统召回了「退款政策」「退款流程」「退款时效」三条——听起来挺准。再问「退款要多久」，召回的却是「退款政策」「退货政策」「换货流程」。你以为是切分没切好，换了五种 chunk size，结果还是老样子。问题不在切分，在于 Embedding 模型根本没把「退款要多久」和「退款时效」映射到相近的向量空间。Embedding 是 RAG 的地基，地基歪了，上面怎么装修都白搭。

## 一、这个问题到底是什么

结论：Embedding 模型决定了你的文档和查询能不能「对上暗号」。选错了，后面所有优化都是徒劳。

Embedding 做的事很简单：把一段文字（一个 chunk、一个问题）变成一组数字，比如 1536 个浮点数。这组数字就是这段文字的「语义坐标」。两句话意思越接近，坐标在空间里就靠得越近。

举个具体例子。「如何申请退款」和「退款流程是什么」，在好的 Embedding 模型里，这两个向量几乎重合。「如何申请退款」和「今天天气怎么样」，向量就离得很远。RAG 召回的本质，就是在向量空间里找最近的几个点。

问题出在哪？不同模型对「语义接近」的理解不一样。

- 有的模型对中文理解差，「退款」和「退货」在它眼里可能比「退款」和「退款流程」还近。
- 有的模型训练数据偏英文，中文场景下向量分布很散。
- 有的模型维度太高（比如 3072），存起来费内存、算起来慢，但精度提升有限。
- 有的模型维度太低（比如 384），区分度不够，「退款政策」和「退款流程」在它眼里是一回事。

选 Embedding 不是选「最先进的」，是选「最适合你的场景和数据」的。

## 二、底层原理到底怎么回事

### Embedding 模型到底在学什么

训练一个 Embedding 模型，本质上是教模型学会「什么算相似」。

训练数据长这样：「退款申请」和「如何退款」是一对正例（应该靠近），「退款申请」和「天气预报」是一对负例（应该远离）。模型通过大量这样的样本，学会把语义相近的句子映射到相近的向量。

问题来了：训练数据决定了模型擅长什么。

- 用英文维基百科训练的模型，英文语义理解强，中文可能一塌糊涂。
- 用代码仓库训练的模型，代码语义理解强，自然语言可能一般。
- 用通用语料训练的模型，日常对话理解强，专业领域（法律、医疗、金融）可能不够精准。

所以选模型的第一步，是看它的训练数据和你的场景是否匹配。

### 维度、归一化、相似度计算

三个技术细节会直接影响你的 RAG 效果。

**维度**：向量有多少个数字。维度越高，理论上能表达的语义越精细，但存储和计算成本也越高。常见选择：768、1024、1536、3072。对大多数中文 RAG 场景，1024 或 1536 足够，没必要上 3072。

**归一化**：向量长度是否被缩放到 1。归一化后的向量，余弦相似度等于点积，计算更快。大多数现代 Embedding 模型默认归一化，但有些老模型不归一，用的时候要确认。

**相似度计算**：两个向量怎么比「有多像」。常用三种：

- **余弦相似度**：看方向，不看长度。最常用，推荐默认用这个。
- **点积**：方向 + 长度。归一化后和余弦等价。
- **欧氏距离**：看绝对距离。用得少，某些场景下效果不如余弦。

向量数据库通常支持多种，选余弦就对了，除非你有明确理由换。

### 中文场景的模型选择

中文 RAG 场景，主流选择：

| 模型 | 维度 | 特点 | 适合场景 |
|------|------|------|----------|
| `bge-m3` | 1024 | 多语言、多粒度，支持稠密+稀疏+ColBERT | 通用中文 RAG，推荐首选 |
| `bge-large-zh-v1.5` | 1024 | 中文优化，性能好 | 纯中文场景 |
| `text-embedding-3-small` | 1536 | OpenAI 官方，英文强中文一般 | 英文为主或混合场景 |
| `text-embedding-3-large` | 3072 | OpenAI 高精度，成本高 | 对精度要求极高的场景 |
| `gte-Qwen2-7B-instruct` | 3584 | 阿里开源，中文理解强 | 私有化部署、中文专业领域 |

我的建议：通用场景直接上 `bge-m3`，中文纯度高的场景用 `bge-large-zh-v1.5`，英文多就用 OpenAI 的。私有化部署、对中文精度要求高，考虑 `gte-Qwen2`。

别一上来就用 `text-embedding-ada-002`，那是 2022 年的模型，现在看已经落后了。

## 三、实战：手把手写代码

### Spring AI 接入 Embedding 模型

Spring AI 把 Embedding 模型抽象成 `EmbeddingModel` 接口，换模型只改配置，代码不动。

pom.xml：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>embedding-demo</artifactId>
    <version>1.0.0</version>

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
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
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

application.yml：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        options:
          model: text-embedding-3-small
```

这段配置告诉 Spring AI：用 OpenAI 的 `text-embedding-3-small` 模型做 Embedding。API Key 从环境变量读，别硬编码。

EmbeddingService.java：

```java
package com.example.embedding;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.embedding.EmbeddingResponse;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class EmbeddingService {

    private final EmbeddingModel embeddingModel;

    public EmbeddingService(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    public float[] embed(String text) {
        EmbeddingResponse response = embeddingModel.embedForResponse(List.of(text));
        return response.getResult().getOutput();
    }

    public List<float[]> embedBatch(List<String> texts) {
        EmbeddingResponse response = embeddingModel.embedForResponse(texts);
        return response.getResults().stream()
                .map(result -> result.getOutput())
                .toList();
    }
}
```

`EmbeddingModel` 是 Spring AI 的核心接口，注入进来就能用。`embedForResponse` 方法接受文本列表，返回向量列表。批量调用比逐条调用快得多，因为底层会合并成一次 HTTP 请求。

### LangChain4j 接入 Embedding 模型

LangChain4j 也封装了 Embedding 接口，换模型同样只改配置。

pom.xml：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>langchain4j-embedding-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.23.0</version>
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

`langchain4j-open-ai` 包含 OpenAI Embedding 模型的封装。如果想用其他模型（比如 Azure OpenAI、本地 Ollama），换对应的依赖即可。

LangChain4jEmbeddingService.java：

```java
package com.example.embedding;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.model.output.Response;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class LangChain4jEmbeddingService {

    private final EmbeddingModel embeddingModel;

    public LangChain4jEmbeddingService() {
        this.embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("text-embedding-3-small")
                .build();
    }

    public float[] embed(String text) {
        Response<Embedding> response = embeddingModel.embed(text);
        return response.content().vector();
    }

    public List<float[]> embedBatch(List<String> texts) {
        List<TextSegment> segments = texts.stream()
                .map(TextSegment::from)
                .toList();
        Response<List<Embedding>> response = embeddingModel.embedAll(segments);
        return response.content().stream()
                .map(Embedding::vector)
                .toList();
    }
}
```

这里有个容易栽的细节：LangChain4j 的 `embedAll` 只收 `List<TextSegment>`，不收 `List<String>`。`TextSegment` 是 LangChain4j 的「文本片段」对象，除了文本本身还能挂元数据。传裸字符串编译不过，先 `TextSegment.from(text)` 包一层。

LangChain4j 的接口设计和 Spring AI 类似，都是「传入文本、返回向量」。区别在于 LangChain4j 不依赖 Spring，可以在任何 Java 项目里用。如果你已经在用 Spring Boot，推荐用 Spring AI；如果是普通 Java 项目或者需要更灵活的配置，LangChain4j 更合适。

### 向量相似度计算实战

拿到向量后，怎么算相似度？Spring AI 和 LangChain4j 都提供了工具类。

SimilarityDemo.java：

```java
package com.example.embedding;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.embedding.EmbeddingResponse;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class SimilarityDemo {

    private final EmbeddingModel embeddingModel;

    public SimilarityDemo(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    public void demo() {
        String query = "退款要多久";
        List<String> documents = List.of(
                "退款政策：所有商品支持 7 天无理由退款",
                "退款流程：申请后 1-3 个工作日到账",
                "退货政策：退货需保持商品完好",
                "换货流程：申请后 3-5 个工作日处理"
        );

        // 计算查询向量
        float[] queryVector = embeddingModel.embedForResponse(List.of(query))
                .getResult().getOutput();

        // 计算文档向量
        List<float[]> docVectors = embeddingModel.embedForResponse(documents)
                .getResults().stream()
                .map(result -> result.getOutput())
                .toList();

        // 计算余弦相似度
        for (int i = 0; i < documents.size(); i++) {
            double similarity = cosineSimilarity(queryVector, docVectors.get(i));
            System.out.printf("查询: %s%n文档: %s%n相似度: %.4f%n%n",
                    query, documents.get(i), similarity);
        }
    }

    private double cosineSimilarity(float[] a, float[] b) {
        double dotProduct = 0.0;
        double normA = 0.0;
        double normB = 0.0;

        for (int i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
```

这段代码演示了 RAG 召回的核心逻辑：把查询和文档都转成向量，算余弦相似度，取最高的几个。实际项目里，这一步由向量数据库完成，你不需要手写循环，但理解原理能帮你调试问题。

跑一下这段代码，你会看到「退款流程：申请后 1-3 个工作日到账」的相似度最高，「退款政策」次之，「退货政策」和「换货流程」较低。如果结果不是这样，说明模型选错了。

## 四、踩坑经验和最佳实践

### 坑一：查询和文档用不同模型

有人觉得「文档用大模型 Embedding 精度高，查询用小模型速度快」。这是错的。

Embedding 模型训练时，查询和文档是在同一个空间里对齐的。你用两个不同模型，相当于把查询放在北京坐标系，文档放在上海坐标系，永远对不上。

**正确做法**：查询和文档必须用同一个模型。如果模型支持「查询专用」和「文档专用」两种模式（比如 `bge-m3` 的 `query` 和 `passage` 前缀），那是模型内部的处理，不算换模型。

### 坑二：忽略文本预处理

Embedding 模型对输入很敏感。「退款流程」和「退 款 流 程」（多了空格），向量可能差很远。

**正确做法**：

- 统一全半角字符
- 去掉多余空格和换行
- 统一大小写（英文场景）
- 去掉特殊符号（除非符号有语义，比如 `C++` 的 `+`）

这些预处理看起来琐碎，但能显著提升召回质量。

### 坑三：向量维度不匹配

你把文档用 1536 维模型 Embedding，存进向量数据库，后来换成 1024 维模型重新 Embedding 查询。维度对不上，要么报错，要么召回全乱。

**正确做法**：

- 换模型时，所有文档重新 Embedding
- 向量数据库的索引维度要和模型匹配
- 别在同一张表里混用不同维度的向量

### 最佳实践：先小范围评测

别一上来就把全量文档都 Embedding 了。先挑 100 个典型问题和对应文档，用候选模型跑一遍，看召回率。

评测脚本很简单：

```java
package com.example.embedding;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

@Component
public class EmbeddingEvaluator {

    private final EmbeddingModel embeddingModel;

    public EmbeddingEvaluator(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    public double evaluate(List<Map.Entry<String, List<String>>> testCases) {
        int correct = 0;

        for (var testCase : testCases) {
            String query = testCase.getKey();
            List<String> expectedDocs = testCase.getValue();

            float[] queryVector = embeddingModel.embedForResponse(List.of(query))
                    .getResult().getOutput();

            List<float[]> docVectors = embeddingModel.embedForResponse(expectedDocs)
                    .getResults().stream()
                    .map(result -> result.getOutput())
                    .toList();

            // 找最相似的文档
            double maxSimilarity = -1;
            int bestIndex = -1;
            for (int i = 0; i < docVectors.size(); i++) {
                double similarity = cosineSimilarity(queryVector, docVectors.get(i));
                if (similarity > maxSimilarity) {
                    maxSimilarity = similarity;
                    bestIndex = i;
                }
            }

            // 简化判断：第一个期望文档是最相似的
            if (bestIndex == 0) {
                correct++;
            }
        }

        return (double) correct / testCases.size();
    }

    private double cosineSimilarity(float[] a, float[] b) {
        double dotProduct = 0.0;
        double normA = 0.0;
        double normB = 0.0;

        for (int i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
```

准备 100 个测试用例，每个用例是一个问题和一组候选文档（第一个是正确答案）。跑一遍，召回率低于 80% 就该换模型了。

## 五、性能对比和技术选型

### 速度和成本对比

| 模型 | 维度 | 部署方式 | 单条耗时（量级） | 成本 |
|------|------|----------|------------------|------|
| `bge-small-zh` | 512 | 本地 CPU | 几毫秒 | 无 API 费用 |
| `bge-large-zh-v1.5` | 1024 | 本地 GPU | 十几毫秒 | 无 API 费用 |
| `bge-m3` | 1024 | 本地 GPU / 自建服务 | 十几到几十毫秒 | 无 API 费用，算力自担 |
| `text-embedding-3-small` | 1536 | OpenAI API | 百毫秒级 | $0.02 / 百万 token |
| `text-embedding-3-large` | 3072 | OpenAI API | 二百毫秒级 | $0.13 / 百万 token |
| `gte-Qwen2-7B-instruct` | 3584 | 本地 GPU | 数百毫秒 | 无 API 费用，GPU 成本高 |

表里的耗时是量级参考，具体取决于你的硬件、batch 大小和网络。别拿它当 benchmark，自己压一遍才算数。

成本结构差别很大：本地模型没有 API 账单，但 GPU 和运维要自己扛，并发上来还得做批处理；云端 API 省事，按 token 付费，延迟受网络影响。

### 选型决策树

1. **数据敏感、必须私有化** → 本地模型（`bge-small-zh` 起步，精度不够换 `gte-Qwen2`）
2. **通用中文 RAG、不敏感** → `bge-m3` API
3. **英文为主或混合语言** → `text-embedding-3-small`
4. **对精度要求极高、预算充足** → `text-embedding-3-large`

别纠结太久，先跑起来，效果不好再换。Embedding 模型切换成本不高（重新 Embedding 文档而已），别在选型上花超过一天。

## 六、总结

Embedding 模型是 RAG 的地基，决定了文档和查询能不能在向量空间里对上。选错了，后面切分、检索、重排序全白搭。

选型核心看三点：训练数据是否匹配你的场景、维度是否合适、成本是否可接受。中文通用场景推荐 `bge-m3`，纯中文推荐 `bge-large-zh`，英文推荐 OpenAI 的系列。

接入很简单，Spring AI 和 LangChain4j 都封装好了接口，换模型只改配置。但要注意三个坑：查询和文档必须用同一个模型、文本预处理不能省、向量维度要匹配。

最后，别在选型上纠结太久。先小范围评测，效果不好就换，切换成本不高。RAG 的优化是系统工程，Embedding 只是第一步，后面还有切分、检索、重排序、Prompt 优化要做。

## 参考资料

- [Spring AI - Embeddings API](https://docs.spring.io/spring-ai/reference/api/embeddings.html)
- [LangChain4j - RAG (Retrieval-Augmented Generation)](https://docs.langchain4j.dev/tutorials/rag)
- [LangChain4j - OpenAI Embedding Model](https://docs.langchain4j.dev/integrations/embedding-models/open-ai)

文 / 会编程的吕洞宾

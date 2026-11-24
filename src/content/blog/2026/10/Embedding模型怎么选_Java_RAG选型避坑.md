---
title: "Embedding模型怎么选？Java RAG选型避坑"
date: 2026-10-08T20:00:00+08:00
category: "AI"
tags: ["rag"]
---

> RAG 搭完了，检索却总差点意思，于是有人丢来一句：换个 Embedding 模型试试。可真动手时问题全冒出来了——维度选 1536 还是 3072？中文该用哪家？本地跑得动吗？贵不贵？最要命的一条是：Embedding 模型一换，整个向量库得推倒重算，线上几百万条向量重跑一遍，是实打实的钱和时间。这篇把 Embedding 选型讲透：维度、语言、成本、部署方式怎么权衡，再用 Spring AI 写三个能直接跑的例子，最后给你一套上线前的自测方法。

## 一、这个问题到底是什么

结论先行：Embedding 选型要同时权衡六件事——语义质量、维度、语言支持、价格、最大输入长度、能不能本地部署；而最容易被忽略、代价最大的一条是「换模型必须重建整个向量库」。

先把 Embedding 是什么说清楚。它是把一段文字映射成一串浮点数，也就是向量。语义越接近的文本，向量之间的距离越小。RAG 的检索能不能准，一半靠切分，一半就靠这个向量把「用户的问题」和「知识库里的段落」对上号。

所以选错了模型，后面再怎么调 topK、加 rerank、换向量库，都是在错误的地基上装修。

复制粘贴之前，先问自己六个问题：

- **语义质量够不够？** 同样一句话，好模型能把「怎么退单」和「如何申请退款」判成高度相关，差模型判成两回事。这是检索命中的根本。
- **维度多少？** 维度是向量的长度，比如 1536 个数。维度越高，通常能塞进的语义细节越多，但存储和检索成本也线性上涨。
- **支不支持中文/多语言？** 很多英文模型对中文是「能跑但一般」，词表里中文占比低，语义会打折。
- **价格多少？** API 模型按 token 计费，知识库全量重算一次就是一笔账。
- **单次最多能喂多长？** 模型有最大输入长度，切片超过它会被截断或报错，直接影响你的分块策略。
- **能不能本地部署？** 数据敏感、断网环境、或者单纯想省钱，就得考虑本地模型。

最常见的翻车方式，是直接抄了教程里的默认模型：OpenAI 默认还是老的 `text-embedding-ada-002`，或者随手从 Ollama 拉个对话模型当 Embedding 用。前者对中文和多语言一般、维度固定，后者根本就不是 Embedding 模型，输出的向量没意义。

还有一条隐形的坑，几乎所有人都踩过：**Embedding 模型是「成对」使用的**。写入向量库时用的模型，和查询时用的模型，必须是同一个。中途换了模型，新旧向量混在同一个库里，距离比较完全失去意义——检索会变成随机抽奖。这就是为什么换模型等于重建全库，而不是改一行配置的事。

## 二、底层原理到底怎么回事

结论先行：Embedding 模型把文本压成一个固定长度的向量，检索靠比较向量夹角（余弦相似度）；维度、语言、成本这些取舍，本质都来自「用多少信息量去编码一段语义」这个单一问题。

**文本是怎么变成向量的。** 模型内部先把文字切成 token，再经过一层层神经网络，最后把整句话的语义「汇总」成一个固定长度的向量。它有点像图书馆的坐标系统：每本书本来没坐标，管理员按内容给它贴一个坐标，内容相近的书坐标就挨得近。区别是，这个坐标有上千个维度，不是三维。

**检索靠什么比较。** 最常用的是余弦相似度——看两个向量的夹角。夹角越小，方向越接近，语义越像。值为 1 表示方向一致，0 表示毫无关系。也可以用点积或欧氏距离，但如果向量都做了归一化（长度变成 1），这三种算法算出来的排序是一样的，所以别太纠结选哪个。Spring AI 的向量库默认用余弦距离，够用。

**维度和成本的关系。** 向量库占的内存，大致是「条数 × 维度 × 每个浮点数占的字节数」。1536 维、用 4 字节浮点存，一条就是 6KB 左右；换成 3072 维，直接翻倍。一百万条文档，这就是 6GB 和 12GB 的差别，检索时的计算量也同步上涨。所以维度不是越高越好，是「够用就行」。

好消息是尺寸可以砍。OpenAI 的 `text-embedding-3` 系列支持用 `dimensions` 参数把输出向量截短，比如 1536 降到 512。原理叫 Matryoshka（套娃）表示学习——训练时就让前面的维度承载最重要的信息，后面的是锦上添花，砍掉尾部损失有限。实测里 512 维对中文短文本检索往往够用，能省掉三分之二的存储。

**为什么中文要挑模型。** 模型的词表决定了它认识的「字」。英文模型的词表里中文 token 很少，一个汉字可能被切成好几个碎块，语义编码自然吃亏。所以中文场景优先选词表覆盖好、明确支持中文的模型，比如多语言的 E5、BGE 系列。

**还有一个容易忽略的非对称问题。** 检索里「查询」和「文档」角色不同：查询是短问题，文档是长段落。有些模型（比如 E5、BGE 系列）要求给查询加 `query:` 前缀、给文档加 `passage:` 前缀，因为它俩训练时就是这么喂的。漏了前缀，效果会明显下降。OpenAI 的模型不需要前缀，加了反而添乱。用哪个模型，就照哪个模型的说明来，别自己发明。

**本地还是 API。** API 模型省心、质量上限高，但按量付费、依赖网络、数据要出境。本地模型（比如通过 Ollama 跑 BGE-M3）一次性投入机器，之后零调用成本，数据不出门，代价是质量通常略低、要靠自己维护。分界线很简单：数据敏感或量特别大，上本地；追求效果、量不大，用 API。

**最后是分块尺寸。** 模型有最大输入长度（常见 512 或 8192 token）。你的分块如果超出，模型要么截断要么报错。所以分块大小要和模型的最大长度一起定，不能各定各的。

## 三、实战：手把手写代码

结论先行：下面三个例子，从「算两句话的相似度」到「上线前自测模型质量」，全部基于 Spring AI 的 `EmbeddingModel` 抽象——换模型只改配置，Java 代码一行不动。

先把依赖写全，这是完整的 `pom.xml`：

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
    <artifactId>embedding-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.1</spring-ai.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
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
                <version>4.1.1</version>
            </plugin>
        </plugins>
    </build>
</project>
```

配置文件 `application.yml`，先用 OpenAI：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        model: text-embedding-3-small
        dimensions: 512
```

`dimensions` 这一行就是刚才说的「砍尺寸」——把 1536 维降到 512，存储直接省三分之二。

主启动类和一个工具类，先摆出来：

```java
package com.example.embeddingdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class EmbeddingDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(EmbeddingDemoApplication.class, args);
    }
}
```

```java
package com.example.embeddingdemo;

/**
 * 向量计算工具类。余弦相似度的实现，只用 JDK，不引任何数学库。
 */
public final class Vectors {

    private Vectors() {
    }

    public static double cosine(float[] a, float[] b) {
        if (a.length != b.length) {
            throw new IllegalArgumentException("维度不一致：" + a.length + " vs " + b.length);
        }
        double dot = 0;
        double normA = 0;
        double normB = 0;
        for (int i = 0; i < a.length; i++) {
            dot += (double) a[i] * b[i];
            normA += (double) a[i] * a[i];
            normB += (double) b[i] * b[i];
        }
        double denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom == 0 ? 0 : dot / denom;
    }
}
```

### 例一：算两句话的相似度

这是最小可用单元。注入 `EmbeddingModel`，把两段文字转成向量，算余弦值。

```java
package com.example.embeddingdemo;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/embedding")
public class SimilarityController {

    private final EmbeddingModel embeddingModel;

    public SimilarityController(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    @GetMapping("/similarity")
    public Map<String, Object> similarity(@RequestParam String a, @RequestParam String b) {
        float[] vectorA = embeddingModel.embed(a);
        float[] vectorB = embeddingModel.embed(b);
        return Map.of(
                "dimensions", vectorA.length,
                "cosine", Vectors.cosine(vectorA, vectorB)
        );
    }
}
```

关键点：`embeddingModel.embed(String)` 直接返回 `float[]`，省掉了手工拆响应的麻烦；`dimensions` 返回的是真实维度，可以用它验证 `dimensions: 512` 有没有生效。启动后访问 `/embedding/similarity?a=怎么退单&b=如何申请退款`，你会看到维度是 512、余弦值很高，比如 0.7 以上；把 `b` 换成「今天天气不错」，分值会明显掉下来。

### 例二：上线前自测——用一对一对的样本给模型打分

光看一两组不够。上线前你应该准备一组「应该相近」和「应该无关」的样本对，让模型跑一遍，看分数有没有拉开差距。这是个 `CommandLineRunner`，启动就跑：

```java
package com.example.embeddingdemo;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class EmbeddingEvalRunner implements CommandLineRunner {

    private final EmbeddingModel embeddingModel;

    public EmbeddingEvalRunner(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    @Override
    public void run(String... args) {
        record SamplePair(String tag, String query, String document) {
        }

        List<SamplePair> pairs = List.of(
                new SamplePair("应当相近", "怎么重置密码", "忘记密码后如何找回账号"),
                new SamplePair("应当相近", "发票在哪里开", "如何申请开具电子发票"),
                new SamplePair("应当无关", "怎么重置密码", "公司年会抽奖活动规则"),
                new SamplePair("应当无关", "发票在哪里开", "服务器 CPU 占用过高排查")
        );

        for (SamplePair pair : pairs) {
            float[] queryVector = embeddingModel.embed(pair.query());
            float[] docVector = embeddingModel.embed(pair.document());
            System.out.printf("%-6s | %-14s | %.4f%n",
                    pair.tag(), pair.query(), Vectors.cosine(queryVector, docVector));
        }
    }
}
```

怎么读结果：同一模型下，「应当相近」那两行的分值应该明显高于「应当无关」两行。如果两类分数挤在一起，说明这个模型分不开你业务里的语义，换模型之前先怀疑它。这套自测只需要几十条样本，却能在花钱重建全库之前把模型筛一遍，非常划算。

### 例三：批量转换知识库

真实场景是整个知识库批量向量化。`embed(List<String>)` 一次传一批，比循环单条快得多——API 模型省往返次数，本地模型能吃到批处理的吞吐红利。

```java
package com.example.embeddingdemo;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
public class BatchEmbeddingService {

    private final EmbeddingModel embeddingModel;

    public BatchEmbeddingService(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    /**
     * 把知识库切片批量转成向量。分批是为了避免单次请求过大被 provider 拒绝。
     */
    public List<float[]> embedAll(List<String> chunks, int batchSize) {
        List<float[]> vectors = new ArrayList<>(chunks.size());
        for (int i = 0; i < chunks.size(); i += batchSize) {
            int end = Math.min(i + batchSize, chunks.size());
            List<String> batch = chunks.subList(i, end);
            vectors.addAll(embeddingModel.embed(batch));
        }
        return vectors;
    }
}
```

`batchSize` 别贪大。很多 provider 对单次请求的条数和总 token 有上限，一次塞几百条容易被拒。我一般取 16 到 64 之间，先小批量跑通再加。

如果你想在运行时临时换模型或改维度，用 `EmbeddingRequest` 传请求级选项即可，不用重启：

```java
EmbeddingResponse response = embeddingModel.call(
        new EmbeddingRequest(List.of("第一段", "第二段"),
                OpenAiEmbeddingOptions.builder()
                        .model("text-embedding-3-large")
                        .dimensions(1024)
                        .build()));
```

切到本地模型（Ollama）时，Java 代码一行不用改，只改配置。用顶层属性指定用哪家的 Embedding：

```yaml
spring:
  ai:
    model:
      embedding: ollama
    ollama:
      embedding:
        model: bge-m3
```

`bge-m3` 是中文与多语言都还不错的本地选择，配合 Ollama 一行 `ollama pull bge-m3` 就能跑。`EmbeddingModel` 这个抽象的价值就在这——业务代码只认接口，底层是 OpenAI 还是 Ollama，由配置决定。

## 四、踩坑经验和最佳实践

结论先行：Embedding 相关的坑，九成出在「模型换了但库没重建」「前缀漏加」「多模型 bean 冲突」这三件事上。

**坑一：换模型不重建向量库。** 最常见也最致命。新旧向量混库后，检索会退化到几乎随机，而且不报错，你只会觉得「效果变差了」，很难定位。规则刻进团队规范：Embedding 模型版本进配置、进监控，写库和查询必须同源；要换就整库重算，别混用。重建期间可以用双库切换——新模型写新库，验证通过再切流量。

**坑二：该加前缀的模型没加前缀。** 用 E5、BGE 这类模型时，查询和文档的前缀（`query:` / `passage:`）必须成对加上，而且查询用查询前缀、文档用文档前缀，不能对调。这一条漏了，分数会悄悄下降，你还以为是模型的锅。用 OpenAI 模型时则不要加前缀。

**坑三：多个 Embedding starter 同时存在导致 bean 冲突。** 上面例子里同时引了 openai 和 ollama 两个 starter，Spring AI 会按 `spring.ai.model.embedding` 这个顶层属性决定装配哪个 `EmbeddingModel`。不指定的话容易拿到不是你预期的那个。启用哪个就写哪个：`spring.ai.model.embedding=openai` 或 `ollama`。

**坑四：忽略了最大输入长度。** 分块长度超过模型上限，Ollama 默认会静默截断尾部（`spring.ai.ollama.embedding.truncate` 默认 true），OpenAI 则可能直接报错。静默截断最坑，因为丢的是段落后半段的关键信息。上线前测一条「超长文本」看看行为。

**坑五：维度改小后忘了改向量库 schema。** 把维度从 1536 改到 512，如果向量库的索引还按 1536 建，写入就会失败或维度对不上。维度是索引的一部分，改了要重建索引。

几条我固定执行的实践：

- 把「Embedding 模型名 + 维度」当成库表的元数据存下来，查询时校验一致，不一致直接报错，避免混库。
- 上线前用例二那套样本对做 A/B，两个候选模型跑同一批样本，选分差更明显的那个。
- 中文场景优先多语言模型；预算有限就先上 512 维，效果不够再加。
- 批量写入用分批，别一次性怼。

## 五、性能对比和技术选型

结论先行：没有「最好的」Embedding 模型，只有和你的语言、预算、部署条件匹配的模型；中文场景别直接用英文默认模型，数据敏感优先本地。

| 维度 | OpenAI text-embedding-3-small | OpenAI text-embedding-3-large | 本地 BGE-M3（Ollama） |
| --- | --- | --- | --- |
| 语义质量 | 好 | 更好 | 中文/多语言良好 |
| 默认维度 | 1536（可截短） | 3072（可截短） | 1024 |
| 中文支持 | 尚可 | 尚可 | 好 |
| 计费 | 按 token | 按 token（更贵） | 仅机器成本 |
| 部署 | 云端 API | 云端 API | 本地 |
| 数据出境 | 是 | 是 | 否 |

选型思路，按优先级排：

- **数据不能出境 / 断网环境** → 直接本地（Ollama + BGE-M3 之类），别犹豫。
- **中文为主、预算一般** → 本地或国内多语言模型；API 的话避开只做英文的模型。
- **追求效果、量不大** → 上 API 的 large 版本，维度用默认或 1024。
- **量特别大、成本敏感** → API small 版本 + 截短到 512 维，先把存储压下来。

真实数量级参考：同样是百万条文档，3072 维比 1536 维多占一倍索引内存，检索时的距离计算也大致翻倍。所以在效果能接受的前提下，维度是性价比最高的一个旋钮。

## 六、总结

Embedding 选型这件事，说到底就三句话。

第一，先想清楚约束，再挑模型。数据敏不敏感、中文还是英文、量有多大，这三条一确定，候选范围就剩两三个了，不用在几十个模型里纠结。

第二，维度是成本旋钮，语言是质量旋钮。维度能砍就砍，中文场景别偷懒用英文默认模型。这两个方向调对了，大部分烦恼就没了。

第三，模型换了，库必须重建。这一条不是建议，是纪律。混库不报错，但检索会烂掉，排查成本远高于一开始就管好。

落地顺序我推荐这样走：拿业务里真实的问题和文档，凑二三十对样本；用例二的自测程序把候选模型跑一遍；选出分差最明显的那个；确认维度和存储预算；最后才批量重建向量库、切流量。整套下来一下午能搞定，能省掉上线后反复调参的痛苦。

别把 Embedding 当成一个随手填的配置项。它是 RAG 的地基，值得花半天选对。

## 参考资料

- [Spring AI Reference — OpenAI Embeddings](https://docs.spring.io/spring-ai/reference/api/embeddings/openai-embeddings.html)
- [Spring AI Reference — Ollama Embeddings](https://docs.spring.io/spring-ai/reference/api/embeddings/ollama-embeddings.html)
- [OpenAI — New embedding models and API updates](https://openai.com/index/new-embedding-models-and-api-updates/)
- [BGE M3-Embedding（论文）](https://arxiv.org/abs/2402.03216)
- [Hugging Face — MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard)

文 / 会编程的吕洞宾

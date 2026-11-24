---
title: "ES分页超过1万条就报错，Java后端3种解法"
date: 2026-11-10T09:00:00+08:00
category: "中间件"
tags: ["elasticsearch"]
---

> 后台列表翻到第 500 页就 500 了，日志里躺着 `Result window is too large, from + size must be less than or equal to: [10000] but was [10020]`。很多人的第一反应是把 `index.max_result_window` 调大，不报错了，可查询慢到超时。Elasticsearch 深分页不是配置问题，是查询模型问题。这篇把 from+size、scroll、search_after+PIT 三条路拆开讲，配一套能直接跑的 Spring Boot 代码。

## 一、报错到底是什么：from + size 为什么卡在一万条

Elasticsearch 的默认分页上限是 `from + size ≤ 10000`，超了就直接拒绝请求，不是降级、不是截断，是抛异常。

这个限制来自索引设置 `index.max_result_window`，默认值一万。它约束的是**一次请求里 from 和 size 的和**，不是结果集大小，也不是文档总数。你的索引里可以有一亿条数据，翻第 1 页完全没问题；翻到第 501 页（from=10000）就撞墙。

为什么默认是一万？因为 from+size 这种分页方式，成本随页码线性上涨。翻得越深，集群要搬运和排序的数据越多，多到一定程度会把协调节点的内存和 CPU 拖垮。官方给一万这个数，是个经验上的安全值。

实际项目里常见的三种误判：

**误判一：调大 `max_result_window` 就好了。** 这只是把护栏挪走，车还在往悬崖开。调到一百万，一次查询可能要协调节点合并几个 GB 的候选文档，慢查询和 OOM 都会来。

**误判二：以为加机器能解决。** 深分页的瓶颈在协调节点的归并，加数据节点反而让分片变多，每个分片都要吐 `from+size` 条候选，总代价更高。

**误判三：把 MySQL 的分页思维直接搬过来。** MySQL 的 `LIMIT 10000, 20` 有 B+ 树索引可以定位偏移，代价可控；ES 没有"偏移量"这种便宜的东西，它是分布式倒排索引，每个分片都得从头数。

三种方案的对比，先有个整体印象：

| 方案 | 能否跳页 | 单页代价 | 数据一致性 | 典型场景 |
| --- | --- | --- | --- | --- |
| from + size | 能 | 随页码线性增长 | 弱 | 前 100 页以内的普通列表 |
| scroll | 不能 | 恒定 | 强（快照） | 离线全量导出 |
| search_after + PIT | 不能 | 恒定 | 强（快照） | 信息流、深翻页 |

记住一句话：**ES 天生不擅长"跳到第 N 页"，它擅长"接着上一页往下翻"。**

## 二、底层原理到底怎么回事：两阶段查询与游标模型

### from + size 的两阶段查询

一次带 from/size 的查询，在集群内部走两个阶段。

**Query 阶段**：协调节点把请求发给索引的每一个分片。每个分片在自己本地做查询和排序，然后返回 `from + size` 条结果的轻量信息（文档 ID、排序值），不含 `_source`。

**Fetch 阶段**：协调节点把 N 个分片送来的候选合并、全局排序，取真正的第 from 到 from+size 条，再按文档 ID 去对应分片取回完整内容。

假设索引 3 个主分片，要第 501 页、每页 20 条：

- 每个分片返回 10020 条候选
- 协调节点一共收到 30060 条
- 排序后扔掉前 10000 条，只留 20 条

丢弃率 99.93%。而且这活儿每翻一页都要重算一遍，第 502 页再来一次。页码越深，白干的活越多，这就是"线性增长"的真正含义。

### search_after 为什么便宜

`search_after` 换了个思路：不用偏移量，用**游标**。

你告诉 ES "从排序值等于这一组的那条记录之后开始，给我 20 条"。每个分片只需要在本地找到"排在这组值之后"的前 20 条，返回给协调节点归并。代价恒定为 `分片数 × size`，跟翻到第几页毫无关系。

代价是不能跳页。你只能"下一页"，因为没有第 500 页的游标，只有上一页末尾那条记录的坐标。

这里有个硬性要求：**排序字段的组合必须唯一确定一条记录**。假设只按 `create_time` 倒序，同一毫秒有 200 条数据，游标记住的是"时间戳 = 1730000000000"，下一页 ES 不知道这 200 条里哪些已经返回过，结果就是重复或漏数据。所以排序必须带一个唯一字段做兜底，通常用文档 ID 或业务主键：

```
create_time DESC, article_id ASC
```

`article_id` 是 keyword 类型，有 doc values，排序开销很小。别用 `_id` 排序，那是倒排索引里的特殊字段，排序性能差，官方也不推荐。

### PIT 解决的是翻页过程中的数据漂移

只用 search_after 还有个隐患：ES 是近实时的，默认每秒 refresh 一次。你翻第 1 页时读到 20 条，此时新写入 5 条并 refresh 了，翻第 2 页时这 5 条会挤进排序结果，导致原来第 1 页末尾的几条被"推"到第 2 页，用户看到重复内容。

PIT（Point In Time）给这次翻页会话开一个数据快照。开了 PIT 之后，后续所有查询都基于同一份索引视图，期间的新增、更新、删除都看不见。`keep_alive` 是滑动过期时间，每次用 PIT 查询都会续期。

PIT + search_after 是现在做深翻页的标准组合，也是官方推荐的替代 scroll 的方案。

### scroll 是另一种快照

`scroll` 同样基于快照，但它的语义是"一次性把这批数据全部拉完"。第一次查询返回 `scroll_id`，之后每次带着它去取下一批，直到结果为空。

它的资源开销比 PIT 大：服务端要维持每个 scroll 上下文对应的段引用，段就无法被合并和删除。几百个 scroll 同时挂着不清理，节点会明显变慢，甚至触发 `Too many open scrolls`。

scroll 适合离线导出、批量重建索引这类"跑完就扔"的任务。用在用户翻页上，是选错了工具。

## 三、实战：手把手写三种分页代码

先起一个 ES 实例，本地跑就行：

```bash
docker run -d --name es9 -p 9200:9200 \
  -e discovery.type=single-node \
  -e xpack.security.enabled=false \
  -e ES_JAVA_OPTS="-Xms1g -Xmx1g" \
  docker.elastic.co/elasticsearch/elasticsearch:9.5.6
```

等十几秒，`curl http://localhost:9200` 能看到集群信息就可以往下走。

### 3.1 依赖

`pom.xml`，整套依赖齐了，直接复制能编译：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.9</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>es-deep-page</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
        </dependency>

        <dependency>
            <groupId>co.elastic.clients</groupId>
            <artifactId>elasticsearch-java</artifactId>
            <version>9.5.6</version>
        </dependency>

        <!-- ES 客户端内部用 Jackson 2 做 JSON 映射，单独引一份，避免和应用侧 Jackson 混淆 -->
        <dependency>
            <groupId>com.fasterxml.jackson.core</groupId>
            <artifactId>jackson-databind</artifactId>
            <version>2.22.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
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

### 3.2 配置文件

`application.yml`：

```yaml
server:
  port: 8080

elasticsearch:
  url: http://localhost:9200
  index: article

logging:
  level:
    com.example.espage: info
```

### 3.3 客户端配置

`EsClientConfig` 建两个 Bean：底层 HTTP 客户端和上层的 `ElasticsearchClient`。`Rest5Client` 实现了 `Closeable`，Spring 容器关闭时会自动调用 `close()`，不用手写。

```java
package com.example.espage.config;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.json.jackson.JacksonJsonpMapper;
import co.elastic.clients.transport.ElasticsearchTransport;
import co.elastic.clients.transport.rest5_client.Rest5ClientTransport;
import co.elastic.clients.transport.rest5_client.low_level.Rest5Client;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.net.URI;

@Configuration
public class EsClientConfig {

    @Bean
    public Rest5Client rest5Client(@Value("${elasticsearch.url}") String url) {
        return Rest5Client.builder(URI.create(url)).build();
    }

    @Bean
    public ElasticsearchTransport elasticsearchTransport(Rest5Client rest5Client) {
        return new Rest5ClientTransport(rest5Client, new JacksonJsonpMapper());
    }

    @Bean
    public ElasticsearchClient elasticsearchClient(ElasticsearchTransport transport) {
        return new ElasticsearchClient(transport);
    }
}
```

### 3.4 文档实体

字段名故意和 ES 里的字段名保持一致，这样不用写一堆映射注解，也方便对照 `_source` 排查问题。

```java
package com.example.espage.document;

public class ArticleDoc {

    private String article_id;
    private String title;
    private String author;
    private long create_time;
    private long view_count;
    private String content;

    public String getArticle_id() {
        return article_id;
    }

    public void setArticle_id(String article_id) {
        this.article_id = article_id;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getAuthor() {
        return author;
    }

    public void setAuthor(String author) {
        this.author = author;
    }

    public long getCreate_time() {
        return create_time;
    }

    public void setCreate_time(long create_time) {
        this.create_time = create_time;
    }

    public long getView_count() {
        return view_count;
    }

    public void setView_count(long view_count) {
        this.view_count = view_count;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }
}
```

### 3.5 返回结构

`Cursor` 是游标，`PageResult` 是统一的分页返回体。`total` 为 -1 表示这次没统计总数。

```java
package com.example.espage.dto;

public record Cursor(long createTime, String articleId) {
}
```

```java
package com.example.espage.dto;

import java.util.List;

public record PageResult<T>(
        List<T> records,
        long total,
        boolean totalExact,
        String pitId,
        Cursor nextCursor) {
}
```

### 3.6 造五万条测试数据

`DataInitRunner` 在应用启动后跑一次：建索引、写映射、批量灌数据。索引已存在或者已有数据就跳过，重复启动不会重复灌。

注意 `create_time` 用的是 `long`，存的是毫秒时间戳。用整数存时间，排序不会有时区和精度问题，游标传参也简单。

```java
package com.example.espage.init;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.BulkRequest;
import co.elastic.clients.elasticsearch.core.BulkResponse;
import co.elastic.clients.elasticsearch.core.bulk.BulkResponseItem;
import com.example.espage.document.ArticleDoc;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.io.IOException;

@Component
public class DataInitRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DataInitRunner.class);
    private static final int TOTAL = 50_000;
    private static final int BATCH = 1_000;

    private final ElasticsearchClient client;
    private final String index;

    public DataInitRunner(ElasticsearchClient client, @Value("${elasticsearch.index}") String index) {
        this.client = client;
        this.index = index;
    }

    @Override
    public void run(ApplicationArguments args) throws IOException {
        createIndexIfAbsent();

        long existing = client.count(c -> c.index(index)).count();
        if (existing > 0) {
            log.info("索引 {} 已有 {} 条数据，跳过初始化", index, existing);
            return;
        }

        long baseTime = System.currentTimeMillis();
        for (int start = 0; start < TOTAL; start += BATCH) {
            BulkRequest.Builder bulk = new BulkRequest.Builder();
            int end = Math.min(start + BATCH, TOTAL);
            for (int i = start; i < end; i++) {
                ArticleDoc doc = buildDoc(i, baseTime - i * 1000L);
                bulk.operations(op -> op.index(idx -> idx
                        .index(index)
                        .id(doc.getArticle_id())
                        .document(doc)));
            }
            BulkResponse response = client.bulk(bulk.build());
            if (response.errors()) {
                for (BulkResponseItem item : response.items()) {
                    if (item.error() != null) {
                        log.warn("写入失败 id={} reason={}", item.id(), item.error().reason());
                    }
                }
            }
        }
        log.info("初始化完成，共写入 {} 条", TOTAL);
    }

    private void createIndexIfAbsent() throws IOException {
        boolean exists = client.indices().exists(e -> e.index(index)).value();
        if (exists) {
            return;
        }
        client.indices().create(c -> c
                .index(index)
                .mappings(m -> m
                        .properties("article_id", p -> p.keyword(k -> k))
                        .properties("title", p -> p.text(t -> t))
                        .properties("author", p -> p.keyword(k -> k))
                        .properties("create_time", p -> p.long_(l -> l))
                        .properties("view_count", p -> p.long_(l -> l))
                        .properties("content", p -> p.text(t -> t))));
        log.info("索引 {} 创建完成", index);
    }

    private ArticleDoc buildDoc(int i, long createTime) {
        ArticleDoc doc = new ArticleDoc();
        doc.setArticle_id("A" + String.format("%08d", i));
        doc.setTitle("第 " + i + " 篇：Elasticsearch 深分页实践");
        doc.setAuthor("author-" + (i % 20));
        doc.setCreate_time(createTime);
        doc.setView_count(i % 5000);
        doc.setContent("这是一条用于测试深分页的正文内容，序号 " + i);
        return doc;
    }
}
```

### 3.7 浅分页：from + size

适合前几十页。超过一万直接抛异常，把错误暴露在开发阶段，别让它跑到线上。

```java
package com.example.espage.service;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.SortOrder;
import co.elastic.clients.elasticsearch.core.SearchRequest;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import co.elastic.clients.elasticsearch.core.search.Hit;
import com.example.espage.document.ArticleDoc;
import com.example.espage.dto.PageResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

@Service
public class ShallowPageService {

    private final ElasticsearchClient client;
    private final String index;

    public ShallowPageService(ElasticsearchClient client, @Value("${elasticsearch.index}") String index) {
        this.client = client;
        this.index = index;
    }

    public PageResult<ArticleDoc> page(String keyword, int page, int size) throws IOException {
        int from = (page - 1) * size;
        if (from + size > 10_000) {
            throw new IllegalArgumentException("from + size 超过 10000，请改用 /api/articles/deep 游标分页");
        }

        SearchRequest.Builder builder = new SearchRequest.Builder();
        builder.index(index)
                .from(from)
                .size(size)
                .trackTotalHits(t -> t.enabled(true))
                .sort(s -> s.field(f -> f.field("create_time").order(SortOrder.Desc)))
                .sort(s -> s.field(f -> f.field("article_id").order(SortOrder.Asc)));

        if (keyword != null && !keyword.isBlank()) {
            builder.query(q -> q.match(m -> m.field("title").query(keyword)));
        }

        SearchResponse<ArticleDoc> response = client.search(builder.build(), ArticleDoc.class);
        List<ArticleDoc> records = new ArrayList<>();
        for (Hit<ArticleDoc> hit : response.hits().hits()) {
            if (hit.source() != null) {
                records.add(hit.source());
            }
        }

        long total = response.hits().total() == null ? -1 : response.hits().total().value();
        return new PageResult<>(records, total, true, null, null);
    }
}
```

### 3.8 深分页：PIT + search_after

这是文章的重点。第一次请求不传 `pitId`，服务端开一个 PIT 并返回；后续请求带上 `pitId`、`afterTime`、`afterId` 往下翻。

`trackTotalHits` 关掉了，深翻页场景里精确总数意义不大，统计一次全量代价不小，前端显示"约 5 万条"就够。

```java
package com.example.espage.service;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.FieldValue;
import co.elastic.clients.elasticsearch._types.SortOrder;
import co.elastic.clients.elasticsearch.core.SearchRequest;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import co.elastic.clients.elasticsearch.core.search.Hit;
import com.example.espage.document.ArticleDoc;
import com.example.espage.dto.Cursor;
import com.example.espage.dto.PageResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

@Service
public class DeepPageService {

    private static final String KEEP_ALIVE = "2m";

    private final ElasticsearchClient client;
    private final String index;

    public DeepPageService(ElasticsearchClient client, @Value("${elasticsearch.index}") String index) {
        this.client = client;
        this.index = index;
    }

    public PageResult<ArticleDoc> page(String keyword, int size, String pitId,
                                       Long afterTime, String afterId) throws IOException {
        String effectivePit = (pitId == null || pitId.isBlank())
                ? client.openPointInTime(o -> o.index(index).keepAlive(t -> t.time(KEEP_ALIVE))).id()
                : pitId;

        SearchRequest.Builder builder = new SearchRequest.Builder();
        builder.pit(p -> p.id(effectivePit).keepAlive(t -> t.time(KEEP_ALIVE)))
                .size(size)
                .trackTotalHits(t -> t.enabled(false))
                .sort(s -> s.field(f -> f.field("create_time").order(SortOrder.Desc)))
                .sort(s -> s.field(f -> f.field("article_id").order(SortOrder.Asc)));

        if (keyword != null && !keyword.isBlank()) {
            builder.query(q -> q.match(m -> m.field("title").query(keyword)));
        }
        if (afterTime != null && afterId != null) {
            builder.searchAfter(List.of(FieldValue.of(afterTime), FieldValue.of(afterId)));
        }

        SearchResponse<ArticleDoc> response = client.search(builder.build(), ArticleDoc.class);
        List<Hit<ArticleDoc>> hits = response.hits().hits();
        List<ArticleDoc> records = new ArrayList<>(hits.size());
        for (Hit<ArticleDoc> hit : hits) {
            if (hit.source() != null) {
                records.add(hit.source());
            }
        }

        Cursor nextCursor = null;
        if (!hits.isEmpty()) {
            List<FieldValue> sortValues = hits.get(hits.size() - 1).sort();
            nextCursor = new Cursor(sortValues.get(0).longValue(), sortValues.get(1).stringValue());
        }
        return new PageResult<>(records, -1, false, effectivePit, nextCursor);
    }

    public void close(String pitId) throws IOException {
        client.closePointInTime(c -> c.id(pitId));
    }
}
```

注意 `searchAfter` 的值顺序，必须和 `sort` 的顺序完全一致。排序是 `create_time` 再 `article_id`，游标就得是 `[时间戳, 文档ID]`。顺序写反了，ES 不报错，但结果莫名其妙。

### 3.9 全量导出：scroll

导出走 scroll，一次拉一批，最后务必清理上下文。`finally` 里那句 `clearScroll` 不是可选项，是必需项。

```java
package com.example.espage.service;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.ScrollResponse;
import co.elastic.clients.elasticsearch.core.SearchRequest;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import co.elastic.clients.elasticsearch.core.search.Hit;
import com.example.espage.document.ArticleDoc;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;

@Service
public class ScrollExportService {

    private static final Logger log = LoggerFactory.getLogger(ScrollExportService.class);
    private static final String KEEP_ALIVE = "3m";

    private final ElasticsearchClient client;
    private final String index;

    public ScrollExportService(ElasticsearchClient client, @Value("${elasticsearch.index}") String index) {
        this.client = client;
        this.index = index;
    }

    public long exportAll(String keyword, int batchSize) throws IOException {
        SearchRequest.Builder builder = new SearchRequest.Builder();
        builder.index(index)
                .size(batchSize)
                .scroll(t -> t.time(KEEP_ALIVE));
        if (keyword != null && !keyword.isBlank()) {
            builder.query(q -> q.match(m -> m.field("title").query(keyword)));
        }

        SearchResponse<ArticleDoc> first = client.search(builder.build(), ArticleDoc.class);
        String scrollId = first.scrollId();
        long exported = 0;
        try {
            List<Hit<ArticleDoc>> hits = first.hits().hits();
            while (!hits.isEmpty()) {
                for (Hit<ArticleDoc> hit : hits) {
                    ArticleDoc doc = hit.source();
                    if (doc != null) {
                        exported++;
                    }
                }
                ScrollResponse<ArticleDoc> next = client.scroll(
                        s -> s.scrollId(scrollId).scroll(t -> t.time(KEEP_ALIVE)),
                        ArticleDoc.class);
                scrollId = next.scrollId();
                hits = next.hits().hits();
                log.info("已导出 {} 条", exported);
            }
        } finally {
            client.clearScroll(c -> c.scrollId(scrollId));
        }
        return exported;
    }
}
```

### 3.10 接口层和启动类

三个接口，对应三种方案，方便对比压测。

```java
package com.example.espage.web;

import com.example.espage.document.ArticleDoc;
import com.example.espage.dto.PageResult;
import com.example.espage.service.DeepPageService;
import com.example.espage.service.ScrollExportService;
import com.example.espage.service.ShallowPageService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.Map;

@RestController
@RequestMapping("/api/articles")
public class ArticleController {

    private final ShallowPageService shallowPageService;
    private final DeepPageService deepPageService;
    private final ScrollExportService scrollExportService;

    public ArticleController(ShallowPageService shallowPageService,
                             DeepPageService deepPageService,
                             ScrollExportService scrollExportService) {
        this.shallowPageService = shallowPageService;
        this.deepPageService = deepPageService;
        this.scrollExportService = scrollExportService;
    }

    @GetMapping("/shallow")
    public PageResult<ArticleDoc> shallow(@RequestParam(defaultValue = "1") int page,
                                          @RequestParam(defaultValue = "20") int size,
                                          @RequestParam(required = false) String keyword) throws IOException {
        return shallowPageService.page(keyword, page, size);
    }

    @GetMapping("/deep")
    public PageResult<ArticleDoc> deep(@RequestParam(defaultValue = "20") int size,
                                       @RequestParam(required = false) String pitId,
                                       @RequestParam(required = false) Long afterTime,
                                       @RequestParam(required = false) String afterId,
                                       @RequestParam(required = false) String keyword) throws IOException {
        return deepPageService.page(keyword, size, pitId, afterTime, afterId);
    }

    @GetMapping("/export")
    public Map<String, Object> export(@RequestParam(required = false) String keyword) throws IOException {
        long exported = scrollExportService.exportAll(keyword, 1000);
        return Map.of("exported", exported);
    }
}
```

```java
package com.example.espage;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class EsPageApplication {

    public static void main(String[] args) {
        SpringApplication.run(EsPageApplication.class, args);
    }
}
```

启动后先验证浅分页：

```bash
curl "http://localhost:8080/api/articles/shallow?page=1&size=5"
```

深分页第一次请求，注意返回体里的 `pitId` 和 `nextCursor`：

```bash
curl "http://localhost:8080/api/articles/deep?size=5"
```

拿返回的 `pitId`、`nextCursor.createTime`、`nextCursor.articleId` 翻下一页：

```bash
curl "http://localhost:8080/api/articles/deep?size=5&pitId=xxx&afterTime=1730000000000&afterId=A00009999"
```

`pitId` 建议放请求头或者服务端 session，放 URL 里既长又容易被日志带出去。

## 四、踩坑经验和最佳实践

**排序字段不唯一，数据重复或丢失。** 这是最高频的坑。只按时间排序，同一毫秒多条数据，翻页必出错。加 keyword 类型的主键字段做第二排序键，成本几乎为零。

**PIT 忘了关，集群报 `Too many open PITs`。** PIT 有 `keep_alive`，到期会自动释放，但用户开着一堆标签页、每个都开 PIT，照样能把资源吃满。前端关闭页面时调一次关闭接口，服务端也加上最大会话数限制。

**`keep_alive` 设太短，翻页中途失效。** 设 30 秒，用户看一页想两分钟，回来再翻就报 `search_context_missing_exception`。给 2 到 5 分钟比较稳，每次查询都会续期。

**`total` 显示 10000 是假的。** `track_total_hits` 默认上限一万，超过时返回的是 `value=10000, relation=gte`，意思是"至少一万"。前端把这个数字当精确值展示，产品经理会来找你。要么显式 `trackTotalHits(true)`，要么老老实实显示"约"。

**调大 `max_result_window` 后 OOM。** 从一万调到一百万，单次查询协调节点要合并几百万条候选，堆内存直接顶不住。这个参数是护栏，不是开关，动了就得承担后果。

**scroll 上下文没清理，节点越跑越慢。** 每个 scroll 上下文都会固定住索引段，段无法合并、无法删除，磁盘和内存都涨。写完数据立刻 `clearScroll`，并且给导出任务加上超时。

**游标顺序和排序顺序不一致。** 传 `[article_id, create_time]` 给按 `create_time DESC, article_id ASC` 排序的查询，ES 不校验，直接按位置对应，结果全乱。把排序字段组合定义成常量，两边共用同一份，别手写两遍。

**分片数不是越多越好。** 深分页的协调代价是 `分片数 × size`，二十个分片意味着每次翻页要归并二十份结果。中小索引把分片控制在 3 到 5 个，比盲目扩容有效。

## 五、性能对比和技术选型

具体毫秒数没什么参考价值，机器配置、分片数量、文档大小都会让数字变样，看趋势更靠谱：

| 方案 | 首屏耗时 | 翻到第 400 页 | 协调节点内存 | 备注 |
| --- | --- | --- | --- | --- |
| from + size | 低 | 随页码近似线性上涨 | 随页码上涨 | 深页 GC 压力明显 |
| search_after + PIT | 低 | 与首屏基本持平 | 平稳 | 首屏多一次开 PIT 的开销 |
| scroll | 中 | 每批恒定，但总量固定 | 服务端持有段引用 | 只适合导出 |

选型上我的建议很直接：

- **普通列表，页码不超过 100 页**：用 from + size，简单，够用，别过度设计。
- **信息流、下拉加载、无限滚动**：search_after + PIT，这是唯一正确的选择。
- **运营后台要跳页，数据量又大**：别硬扛。限制最大页数，强制加筛选条件（时间范围、分类），把"翻到第 5000 页"这个需求从产品层面砍掉。真实用户不会翻到那里，是爬虫或者导出需求在翻。
- **全量导出、重建索引**：scroll 或者 PIT 循环拉取，跑完立刻清理。

还有一种情况值得提一句：如果需求本质是"统计 + 多维筛选 + 排序"，而且数据量在千万级以内，用 ES 的聚合或者 ES|QL 往往比硬翻页更合适。翻页只是展示手段，不是目的。

## 六、总结

ES 深分页报错，本质是 from + size 的代价模型撑不住了——每个分片都要吐 `from+size` 条候选，协调节点合并后扔掉 99% 以上。调大 `max_result_window` 只是把问题往后推。

正确的解法是换成游标模型：search_after 用"上一页最后一条的排序值"代替"偏移量"，代价和页码无关；再用 PIT 固定一份快照，避免翻页过程中数据漂移。排序字段必须唯一，通常用业务主键兜底。

scroll 留给出全量导出，用完必须清理上下文。真要跳页又数据量大，就在产品层面限制页数，别在存储层硬扛。

记住那条分界线：ES 不擅长跳页，擅长往下翻。

文 / 会编程的吕洞宾

## 参考资料

- [Paginate search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)
- [Open point in time API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-open-point-in-time)
- [Scroll API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-scroll)
- [Elasticsearch Java client](https://www.elastic.co/docs/reference/elasticsearch/clients/java)

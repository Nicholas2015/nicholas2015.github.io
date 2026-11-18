---
title: "ES深分页1万条上限，Java后端3步改造"
date: 2026-10-29T09:00:00+08:00
category: "中间件"
tags: ["elasticsearch"]
---

> 后台列表翻到第 500 页，接口直接 500，日志里一行红字：`Result window is too large, from + size must be less than or equal to: [10000]`。很多人第一反应是把 `max_result_window` 调大，调完确实不报错了，然后集群开始抖，堆内存告警。这篇文章把 ES 深分页讲透：1 万条这道墙是怎么来的，search_after 和 PIT 各自解决什么问题，以及一套能直接跑通的完整代码。

## 一、报错的到底是什么

ES 深分页报错，根因在取数方式，不在参数写错了。

`from + size` 是 ES 最自然的翻页写法：跳过前 `from` 条，取 `size` 条。听起来像 MySQL 的 `LIMIT offset, size`，但两者的实现完全是两回事。MySQL 有 B+ 树可以顺着叶子节点往后走，ES 没有。ES 的索引是不可变的倒排结构，它"跳"不了，只能"捞完再丢"。

具体点说，假设你的索引有 5 个分片，请求 `from=10000, size=20`：

1. 协调节点把请求发给 5 个分片；
2. 每个分片都要取出自己本地排在前 10020 名的文档，连同排序值一起返回；
3. 协调节点收到 5 × 10020 = 50100 条候选，在内存里做一次归并排序；
4. 丢掉前 10000 条，返回第 10001 到 10020 条。

也就是说，为了给用户看 20 条数据，集群实际搬运了 5 万条。`from` 越大，搬运量线性上涨，而且每个分片都要在堆里维护一个大小为 `from + size` 的优先队列。

`index.max_result_window` 这个默认 10000 的设置，就是给这个队列加的一道闸门。它不是"功能限制"，是"内存保护"。官方把它设成 10000，意思很明确：超过这个量级的深翻，你的用法大概率是错的。

我见过最典型的一次事故：一个商品索引 5 个分片，运营要导出全部数据，前端每页 50 条一直点下一页。翻到第 300 页左右开始变慢，负责的兄弟直接把 `max_result_window` 改成了 1000000。报错消失了，两天后集群开始频繁 Full GC。原因不复杂——每次请求，5 个分片各维护一个百万级的优先队列，协调节点还要收 500 万条候选。堆就这么被吃掉了。

所以这道墙不能拆，只能绕。绕过它的工具有三个：`search_after`、`scroll`、`PIT`。前两个解决"怎么往后取"，第三个解决"取的过程中数据变了怎么办"。

## 二、from + size 为什么贵，search_after 为什么省

`search_after` 把"跳过前 N 条"换成了"从锚点往后取"，单次代价从 `O(from + size)` 降到 `O(size)`。

理解它要先理解 ES 的查询两阶段。

**Query 阶段**：协调节点把查询发给每个分片，分片在本地执行查询、打分、排序，然后只返回 `from + size` 条文档的 ID 和排序值。注意，这里返回的是 ID，不是文档内容。

**Fetch 阶段**：协调节点归并出全局前 `from + size` 名，挑出真正要返回的那 `size` 个 ID，再发起第二轮请求去各分片取 `_source`。

贵的地方在 Query 阶段。`from=100000` 时，每个分片要吐出 100020 条候选，协调节点要收 100020 × 分片数 条。这些数据全在 JVM 堆里，而且排序比较是纯 CPU 活。分片数越多，这个数字越夸张——这是很多人忽略的一点：同样的 `from`，5 分片和 20 分片的代价差 4 倍。

`search_after` 换了个思路：我不告诉你"跳过多少条"，我告诉你"从哪个位置之后开始"。

```json
{
  "size": 20,
  "sort": [
    { "createdAt": "desc" },
    { "id": "desc" }
  ],
  "search_after": ["2026-01-20T10:00:00Z", 28800]
}
```

这段 DSL 的意思是：找排序值排在 `("2026-01-20T10:00:00Z", 28800)` 这组值之后的 20 条。每个分片只需要在本地定位到这个锚点，往后取 20 条交上去。协调节点收到 5 × 20 = 100 条，归并取前 20。`from` 再大也不影响这个开销。

代价是：**它是有状态的**。你必须知道上一页最后一条的排序值，才能取下一页。所以 `search_after` 不支持跳页，只支持"下一页"。这对移动端无限滚动、后台导出、数据同步这类场景完全够用；对"用户直接点第 87 页"这种需求就不合适——那种需求本身就该换设计。

还有两个硬性要求，踩过坑的人都懂：

**排序必须唯一。** 如果只按 `createdAt` 排序，而 20 条数据的时间戳完全一样，ES 无法确定这 20 条的先后顺序，翻页时就会出现重复或漏数据。解决办法是加一个唯一字段做 tie-breaker，通常是主键 `id`。排序字段的顺序也必须固定，第一页和第二页用的 `sort` 不一样，结果必然错乱。

**PIT 保证翻页期间的一致性。** `search_after` 有一个隐蔽问题：翻页过程中如果索引发生了 refresh 或者合并，排序结果会漂移。第一页看到的数据，第二页可能又出现一次。`point-in-time` 就是解决这个的——它开一个索引的时间点快照，后续所有翻页都基于这个快照，数据不会变。

PIT 还有额外好处：它把请求绑定到固定的分片集合上，减少了每次请求重新解析索引元数据的开销。用法是先 `POST /my-index/_pit?keep_alive=2m` 拿到一个 `pit_id`，之后查询时不再指定 `index`，而是带上 `pit.id`，并且每次请求都可以刷新 `keep_alive`。用完必须显式关闭，否则上下文会一直挂着占资源。

**scroll 呢？** 它也能深翻，但它是为"一次性遍历全量数据"设计的，会占用大量上下文和资源，而且不能反映实时变更。官方在文档里明确不推荐用它做用户翻页。导出任务可以用，用户列表别用。

四种方案放一起对比：

| 方案 | 能跳页 | 深翻成本 | 一致性 | 适用场景 |
| --- | --- | --- | --- | --- |
| from + size | 能 | 随 from 线性增长 | 弱 | 前几页、总数不大的列表 |
| search_after | 不能 | 恒定，与 from 无关 | 弱（可能漂移） | 无限滚动、导出、同步 |
| search_after + PIT | 不能 | 恒定 | 强（快照） | 推荐默认方案 |
| scroll | 不能 | 低但占资源 | 强（快照） | 一次性全量导出、离线任务 |

## 三、实战：3 万条商品数据，把深分页跑通

这一节给一套完整可运行的项目。三步改造：先用 `from + size` 复现报错，再换成 `search_after`，收尾时把 PIT 加上。

### 3.1 起一个单节点 ES

本地验证用 Docker 最省事，`docker-compose.yml` 如下：

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:9.5.5
    container_name: es-deep-paging
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ports:
      - "9200:9200"
    volumes:
      - es-data:/usr/share/elasticsearch/data

volumes:
  es-data:
```

`xpack.security.enabled=false` 是为了本地免密，生产环境别这么干。启动后访问 `http://localhost:9200` 能看到集群信息就说明好了。

### 3.2 项目依赖

`pom.xml` 完整内容：

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
    <artifactId>es-deep-paging</artifactId>
    <version>1.0.0</version>
    <name>es-deep-paging</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>co.elastic.clients</groupId>
            <artifactId>elasticsearch-java</artifactId>
            <version>9.5.5</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.2</version>
            <scope>test</scope>
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

这里没引 Spring Data Elasticsearch，直接用官方 Java Client。原因很简单：翻页逻辑要精确控制 `sort` 数组、`search_after`、`pit`，走原生客户端比在 Repository 抽象层里绕更清楚，也少一层版本耦合。

### 3.3 配置文件

`src/main/resources/application.yml`：

```yaml
server:
  port: 8080

demo:
  elasticsearch:
    uri: http://localhost:9200
  seed-count: 30000

logging:
  level:
    co.elastic.clients: INFO
```

### 3.4 启动类

```java
package com.example.esdeep;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class EsDeepPagingApplication {

    public static void main(String[] args) {
        SpringApplication.run(EsDeepPagingApplication.class, args);
    }
}
```

### 3.5 客户端配置

官方 Java Client 用 HttpClient 5 做底层传输，客户端对象是线程安全的，全局建一个就够，别每次请求 new 一个。

```java
package com.example.esdeep.config;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.json.jackson.Jackson3JsonpMapper;
import co.elastic.clients.transport.ElasticsearchTransport;
import co.elastic.clients.transport.rest5_client.Rest5ClientTransport;
import co.elastic.clients.transport.rest5_client.low_level.Rest5Client;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.net.URI;

@Configuration
public class ElasticsearchConfig {

    @Value("${demo.elasticsearch.uri:http://localhost:9200}")
    private String uri;

    private Rest5Client rest5Client;
    private ElasticsearchTransport transport;

    @Bean
    public ElasticsearchClient elasticsearchClient() {
        this.rest5Client = Rest5Client.builder(URI.create(uri)).build();
        this.transport = new Rest5ClientTransport(rest5Client, new Jackson3JsonpMapper());
        return new ElasticsearchClient(transport);
    }

    @PreDestroy
    public void shutdown() throws Exception {
        if (transport != null) {
            transport.close();
        }
        if (rest5Client != null) {
            rest5Client.close();
        }
    }
}
```

`Jackson3JsonpMapper` 是配 Jackson 3 的序列化器，和 Spring Boot 4 默认的 Jackson 版本对得上。如果你的项目还在用 Jackson 2，换成 `JacksonJsonpMapper` 即可，别的都不用动。

`@PreDestroy` 里关连接是必须的。HttpClient 5 的异步客户端会持有 IO 线程和连接池，不关的话应用重启时端口释放会慢一拍。

### 3.6 实体和返回结构

商品对象用 record，字段名和索引 mapping 对齐：

```java
package com.example.esdeep.model;

public record Product(
        long id,
        String title,
        String category,
        double price,
        String createdAt
) {
}
```

`createdAt` 用 `String` 而不是 `Instant`，是为了避免序列化格式在 ES 那边解析失败。ES 的 `date` 字段接受 ISO-8601 字符串，`Instant.toString()` 出来的 `2026-01-01T00:00:00Z` 正好是合法格式，省掉自定义序列化器的麻烦。

统一分页返回：

```java
package com.example.esdeep.model;

import java.util.List;

public record PageResult<T>(
        List<T> items,
        String nextCursor,
        long total,
        boolean hasMore
) {
}
```

`nextCursor` 就是我们自己的游标，把 ES 返回的排序值编码成一个字符串，前端原样带回来就行。

### 3.7 建索引 + 灌 3 万条数据

启动时自动建索引、灌数据，方便复现。`seed-count` 设为 0 就跳过灌数据。

```java
package com.example.esdeep.initializer;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.BulkResponse;
import co.elastic.clients.elasticsearch.core.bulk.BulkOperation;
import com.example.esdeep.model.Product;
import com.example.esdeep.service.ProductSearchService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Component
public class ProductDataInitializer implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(ProductDataInitializer.class);

    private final ElasticsearchClient client;
    private final int seedCount;

    public ProductDataInitializer(ElasticsearchClient client,
                                  @Value("${demo.seed-count:30000}") int seedCount) {
        this.client = client;
        this.seedCount = seedCount;
    }

    @Override
    public void run(ApplicationArguments args) throws IOException {
        boolean exists = client.indices().exists(e -> e.index(ProductSearchService.INDEX)).value();
        if (exists) {
            log.info("索引 {} 已存在，跳过初始化", ProductSearchService.INDEX);
            return;
        }
        createIndex();
        if (seedCount > 0) {
            seed(seedCount);
        }
    }

    private void createIndex() throws IOException {
        client.indices().create(c -> c
                .index(ProductSearchService.INDEX)
                .mappings(m -> m
                        .properties("id", p -> p.long_(l -> l))
                        .properties("title", p -> p.text(t -> t)
                                .fields("keyword", f -> f.keyword(k -> k.ignoreAbove(256))))
                        .properties("category", p -> p.keyword(k -> k))
                        .properties("price", p -> p.double_(d -> d))
                        .properties("createdAt", p -> p.date(d -> d
                                .format("strict_date_optional_time||epoch_millis")))));
        log.info("索引 {} 创建完成", ProductSearchService.INDEX);
    }

    private void seed(int count) throws IOException {
        String[] categories = {"phone", "laptop", "book", "home", "toy"};
        long base = Instant.parse("2026-01-01T00:00:00Z").toEpochMilli();
        int batchSize = 1000;

        for (int start = 0; start < count; start += batchSize) {
            int end = Math.min(start + batchSize, count);
            List<BulkOperation> operations = new ArrayList<>(end - start);

            for (int i = start; i < end; i++) {
                long id = i + 1L;
                Product product = new Product(
                        id,
                        "商品-" + id,
                        categories[(int) (id % categories.length)],
                        9.9 + (id % 500),
                        Instant.ofEpochMilli(base + id * 60_000L).toString()
                );
                operations.add(BulkOperation.of(o -> o.index(idx -> idx
                        .index(ProductSearchService.INDEX)
                        .id(String.valueOf(id))
                        .document(product))));
            }

            BulkResponse response = client.bulk(b -> b.operations(operations));
            if (response.errors()) {
                log.warn("第 {} 批写入存在失败项", start / batchSize);
            }
        }
        log.info("已写入 {} 条商品数据", count);
    }
}
```

几处关键点：

`title` 字段同时建了 `text` 和 `keyword` 两个类型。`text` 用来做全文检索，`keyword` 用来精确匹配和排序。ES 里对 `text` 字段做排序会直接报 `Fielddata is disabled` 的错——这是新手最容易撞的墙之一。

`createdAt` 显式写了 `format`，兼容 ISO 字符串和毫秒时间戳两种写法。不写也能用默认值，但显式声明后，写入格式稍微不规范时会报错而不是静默存成 null，排查起来更省事。

灌数据用 Bulk API，每批 1000 条。别一条一条 `index`，3 万条会跑很久，网络往返时间占大头。

### 3.8 核心服务：三种翻页方式

这是全文的核心类，三个方法对应三种方案。

```java
package com.example.esdeep.service;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.FieldValue;
import co.elastic.clients.elasticsearch._types.SortOrder;
import co.elastic.clients.elasticsearch._types.Time;
import co.elastic.clients.elasticsearch.core.OpenPointInTimeResponse;
import co.elastic.clients.elasticsearch.core.SearchRequest;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import co.elastic.clients.elasticsearch.core.search.Hit;
import com.example.esdeep.model.PageResult;
import com.example.esdeep.model.Product;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

@Service
public class ProductSearchService {

    public static final String INDEX = "products";

    private static final String KEEP_ALIVE = "2m";

    private final ElasticsearchClient client;

    public ProductSearchService(ElasticsearchClient client) {
        this.client = client;
    }

    /**
     * 方式一：from + size。page * size 超过 10000 就会抛异常。
     */
    public PageResult<Product> pageByFromSize(int page, int size) throws IOException {
        int from = page * size;

        SearchResponse<Product> response = client.search(s -> s
                        .index(INDEX)
                        .from(from)
                        .size(size)
                        .trackTotalHits(t -> t.enabled(true))
                        .query(q -> q.matchAll(m -> m))
                        .sort(so -> so.field(f -> f.field("createdAt").order(SortOrder.Desc)))
                        .sort(so -> so.field(f -> f.field("id").order(SortOrder.Desc))),
                Product.class);

        List<Product> items = response.hits().hits().stream()
                .map(Hit::source)
                .toList();

        long total = response.hits().total() == null ? 0L : response.hits().total().value();
        boolean hasMore = (long) from + items.size() < total;

        return new PageResult<>(items, null, total, hasMore);
    }

    /**
     * 方式二：search_after。cursor 为空表示取第一页。
     */
    public PageResult<Product> pageBySearchAfter(String cursor, int size) throws IOException {
        SearchRequest.Builder builder = new SearchRequest.Builder()
                .index(INDEX)
                .size(size)
                .trackTotalHits(t -> t.enabled(true))
                .query(q -> q.matchAll(m -> m))
                .sort(so -> so.field(f -> f.field("createdAt").order(SortOrder.Desc)))
                .sort(so -> so.field(f -> f.field("id").order(SortOrder.Desc)));

        if (cursor != null && !cursor.isBlank()) {
            builder.searchAfter(decodeCursor(cursor));
        }

        SearchResponse<Product> response = client.search(builder.build(), Product.class);
        return toPageResult(response, size);
    }

    /**
     * 打开一个 PIT，返回 pitId。前端拿到后每次翻页都带上。
     */
    public String openPit() throws IOException {
        OpenPointInTimeResponse response = client.openPointInTime(o -> o
                .index(INDEX)
                .keepAlive(Time.of(t -> t.time(KEEP_ALIVE))));
        return response.id();
    }

    /**
     * 方式三：PIT + search_after。带上 PIT 后不能再指定 index。
     */
    public PageResult<Product> pageWithPit(String pitId, String cursor, int size) throws IOException {
        SearchRequest.Builder builder = new SearchRequest.Builder()
                .size(size)
                .trackTotalHits(t -> t.enabled(true))
                .query(q -> q.matchAll(m -> m))
                .sort(so -> so.field(f -> f.field("createdAt").order(SortOrder.Desc)))
                .sort(so -> so.field(f -> f.field("id").order(SortOrder.Desc)))
                .pit(p -> p.id(pitId).keepAlive(Time.of(t -> t.time(KEEP_ALIVE))));

        if (cursor != null && !cursor.isBlank()) {
            builder.searchAfter(decodeCursor(cursor));
        }

        SearchResponse<Product> response = client.search(builder.build(), Product.class);
        return toPageResult(response, size);
    }

    public void closePit(String pitId) throws IOException {
        client.closePointInTime(c -> c.id(pitId));
    }

    private PageResult<Product> toPageResult(SearchResponse<Product> response, int size) {
        List<Hit<Product>> hits = response.hits().hits();
        List<Product> items = hits.stream().map(Hit::source).toList();
        long total = response.hits().total() == null ? 0L : response.hits().total().value();

        String nextCursor = null;
        if (hits.size() == size) {
            nextCursor = encodeCursor(hits.get(hits.size() - 1).sort());
        }

        return new PageResult<>(items, nextCursor, total, hits.size() == size);
    }

    /**
     * 把 ES 返回的排序值数组编码成不透明游标，前端不需要理解内部结构。
     */
    private String encodeCursor(List<FieldValue> sortValues) {
        String raw = rawValue(sortValues.get(0)) + "|" + rawValue(sortValues.get(1));
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    private List<FieldValue> decodeCursor(String cursor) {
        String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        String[] parts = raw.split("\\|");
        return List.of(FieldValue.of(parts[0]), FieldValue.of(Long.parseLong(parts[1])));
    }

    private String rawValue(FieldValue value) {
        if (value.isString()) {
            return value.stringValue();
        }
        if (value.isLong()) {
            return Long.toString(value.longValue());
        }
        throw new IllegalStateException("不支持的排序值类型: " + value._kind());
    }
}
```

逐个说清楚。

`pageByFromSize` 里 `page * size` 直接算 `from`，`page=0` 表示第一页。这个方法的用途就是复现报错，`page=500, size=20` 时 `from=10000`，`from + size = 10020`，超过默认窗口，直接抛 `ElasticsearchException`。

`trackTotalHits(t -> t.enabled(true))` 是为了拿到精确总数。ES 默认只统计到 10000，超过就返回 `"relation": "gte"`，`total.value()` 停在 10000。做后台列表通常需要精确总数，所以打开它；代价是要遍历全部匹配文档。如果对总数不敏感，别开。

`pageBySearchAfter` 里，`cursor` 为空的第一次查询不带 `search_after`，从第一页开始。之后的每次查询把上一页最后一条的排序值数组传回去。

`encodeCursor` 把两个排序值用 `|` 拼起来再做 URL-safe Base64。为什么要编码？因为排序值里可能有 `:`、空格、时区符号，直接塞进 URL 容易出问题。编码成 Base64 后，前端和网关都不需要关心里面是什么。

`decodeCursor` 必须和 `encodeCursor` 严格对应。这里写死了"第一个值是字符串、第二个值是 long"，因为排序字段固定为 `createdAt` + `id`。如果以后加了第三个排序字段，这两个方法要一起改——这是这套方案唯一的耦合点，建议在类注释里写清楚。

`openPit` 和 `pageWithPit` 是第三种方式。注意 `PIT` 查询里**不能出现 `.index(...)`**，指定了会报错。`keepAlive` 每次请求都带一遍，相当于续期，前端翻页慢也不会中途过期。

`toPageResult` 里判断"还有下一页"用的是 `hits.size() == size`。取满一页就认为可能还有，多请求一次拿空数据比漏数据强。生产上如果想更准，可以在最后一条之后做一次探测查询。

### 3.9 接口层

```java
package com.example.esdeep.controller;

import com.example.esdeep.model.PageResult;
import com.example.esdeep.model.Product;
import com.example.esdeep.service.ProductSearchService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.Map;

@RestController
@RequestMapping("/api/products")
public class ProductController {

    private final ProductSearchService searchService;

    public ProductController(ProductSearchService searchService) {
        this.searchService = searchService;
    }

    @GetMapping("/from-size")
    public PageResult<Product> fromSize(@RequestParam(defaultValue = "0") int page,
                                        @RequestParam(defaultValue = "20") int size) throws IOException {
        return searchService.pageByFromSize(page, size);
    }

    @GetMapping("/search-after")
    public PageResult<Product> searchAfter(@RequestParam(required = false) String cursor,
                                           @RequestParam(defaultValue = "20") int size) throws IOException {
        return searchService.pageBySearchAfter(cursor, size);
    }

    @PostMapping("/pit")
    public Map<String, String> openPit() throws IOException {
        return Map.of("pitId", searchService.openPit());
    }

    @GetMapping("/pit")
    public PageResult<Product> withPit(@RequestParam String pitId,
                                       @RequestParam(required = false) String cursor,
                                       @RequestParam(defaultValue = "20") int size) throws IOException {
        return searchService.pageWithPit(pitId, cursor, size);
    }

    @DeleteMapping("/pit")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void closePit(@RequestParam String pitId) throws IOException {
        searchService.closePit(pitId);
    }
}
```

`pitId` 放在 query 参数里而不是路径里，是因为 PIT ID 是长 Base64 字符串，可能包含 `+`、`/`、`=`，塞进 path 会被网关或容器处理掉。

异常处理把 ES 的报错原样透出来，方便你看到那句 `Result window is too large`：

```java
package com.example.esdeep.controller;

import co.elastic.clients.elasticsearch._types.ElasticsearchException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ElasticsearchException.class)
    public ResponseEntity<Map<String, Object>> handleElasticsearch(ElasticsearchException e) {
        log.warn("ES 请求失败: {}", e.getMessage());
        return ResponseEntity.badRequest()
                .body(Map.of("error", String.valueOf(e.getMessage())));
    }
}
```

### 3.10 跑起来看效果

启动应用后，第一次请求会触发建索引和灌数据，3 万条大概几秒钟。

复现报错：

```bash
curl -s "http://localhost:8080/api/products/from-size?page=500&size=20" | jq
```

返回里会看到 `Result window is too large, from + size must be less than or equal to: [10000]`。

改成 search_after，第一页：

```bash
curl -s "http://localhost:8080/api/products/search-after?size=20" | jq
```

把返回的 `nextCursor` 拿去取第二页，注意 `cursor` 里有 Base64 字符，用 `--data-urlencode` 让 curl 帮你编码：

```bash
curl -s -G "http://localhost:8080/api/products/search-after" \
  --data-urlencode "cursor=你的nextCursor" \
  --data-urlencode "size=20" | jq
```

一直翻下去都不会报错，也不会变慢。

PIT 版本先开游标：

```bash
curl -s -X POST "http://localhost:8080/api/products/pit" | jq
```

拿到 `pitId` 后翻页：

```bash
curl -s -G "http://localhost:8080/api/products/pit" \
  --data-urlencode "pitId=你的pitId" \
  --data-urlencode "size=20" | jq
```

用完记得关：

```bash
curl -s -X DELETE -G "http://localhost:8080/api/products/pit" \
  --data-urlencode "pitId=你的pitId" -o /dev/null -w "%{http_code}\n"
```

## 四、踩坑经验和最佳实践

**坑一：排序字段不唯一，翻页重复或漏数据。** 只按 `createdAt` 排序时，时间戳相同的数据顺序不确定，第二页可能把第一页末尾的数据再返回一遍。加 `id` 做 tie-breaker 就解决了。判断标准很简单：你的 `sort` 数组拼起来能不能唯一确定一条文档，不能就加主键。

**坑二：拿 `text` 字段排序。** 报错 `Fielddata is disabled on text fields by default`。`text` 是分词后的倒排索引，没有原始值顺序，ES 不让你排序。要么在 mapping 里加 `.keyword` 子字段，要么把字段直接定义成 `keyword`。

**坑三：PIT 忘了关，上下文堆积。** 每个 PIT 都会在集群里占一个 search context。用 `GET /_nodes/stats/indices/search` 能看到 `open_contexts` 的数量，涨上去下不来就是这个原因。前端关闭页面、用户超时，后端都没有触发关闭，上下文只能等 `keep_alive` 到期自动清理。实践做法是给 PIT 加一个应用层的兜底：记录打开时间，超过 `keepAlive` 的 PIT 由定时任务扫一遍主动关掉。

**坑四：`keep_alive` 设太短。** 设成 `30s`，用户翻页中间去接了杯水，回来请求直接 `search_context_missing_exception`。前端得处理这个错误并重新开 PIT。我的建议是 `1m` 到 `5m`，够用又不至于占太多资源。

**坑五：把 `max_result_window` 调大当解决方案。** 这是最危险的一个。调大只是把闸门抬高，代价一点没变，只是从"报错"变成"慢慢把集群拖死"。真要做深翻，换 `search_after`；真要做全量导出，用 PIT 分批拉，或者直接走快照。

还有几个细节值得留意：

- **分片数别贪多。** `from + size` 的成本是 `分片数 × (from + size)`，20 个分片的小索引做深翻，比 5 个分片的慢好几倍。小索引没必要分那么多片。
- **`_source` 能过滤就过滤。** 列表页通常只要几个字段，用 `fetchSource` 或 `sourceIncludes` 只取需要的，减少网络和反序列化开销。
- **游标要能失效。** 排序字段或查询条件变了，旧游标就作废了。生产上给游标加个版本号或者签名，避免用户拿着过期游标翻出奇怪的结果。

## 五、性能对比和技术选型

选型的判断标准只有一条：**用户能不能跳页**。

能跳页、但只需要前几十页的场景，直接用 `from + size`，简单、代码少、够用。后台管理里 90% 的列表都属于这类，别为了"可能有一天要深翻"把架构搞复杂。

需要无限滚动、导出、数据同步，用 `search_after`。它对 `from` 完全不敏感，第 1 页和第 5000 页的耗时基本一致。代价是不能跳页，以及必须维护游标。

对数据一致性有要求（比如导出对账、报表快照），加 PIT。用户体验上没区别，但结果稳定，不会因为翻页期间有新数据写入而错乱。

`scroll` 只在一种情况下用：一次性把全量数据拉完然后丢弃。它占资源、不支持并发翻页、不能反映实时变更，用在用户列表上属于用错工具。

成本对比的直观结论：`from + size` 的开销随页码线性增长，`search_after` 和 PIT 的开销与页码无关，只和 `size`、分片数有关。所以页码越深，差距越大；浅翻页时三者差别可以忽略。

## 六、总结

`max_result_window` 的那道 1 万条闸门，是 ES 在替你踩刹车，不是它能力不够。

真正要改的是取数方式：`search_after` 用锚点替代偏移，把深翻的成本压成常数；PIT 补上一致性，让翻页期间的数据变动不影响结果。两个加起来，就是一套能扛住任意深度的分页方案。

落地的时候记住三个硬约束：排序必须唯一（加主键 tie-breaker）、游标和排序字段必须严格对应、PIT 用完必须关。这三条漏任何一条，线上都会以"数据重复""翻页错乱""上下文泄漏"的形式找上门。

代码里那套 `encodeCursor` / `decodeCursor` 建议直接抄走，把耦合点收敛在一个类里，改排序字段时只需要动两个方法。

文 / 会编程的吕洞宾

## 参考资料

- [Paginate search results](https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html)
- [Point in time API](https://www.elastic.co/guide/en/elasticsearch/reference/current/point-in-time-api.html)
- [Index modules settings（index.max_result_window）](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules.html#index-max-result-window)
- [Scroll API](https://www.elastic.co/guide/en/elasticsearch/reference/current/scroll-api.html)
- [Elasticsearch Java API Client](https://www.elastic.co/guide/en/elasticsearch/client/java-api-client/current/index.html)

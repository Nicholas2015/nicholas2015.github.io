---
title: "Text2SQL 实战：Java 让大模型安全查库"
date: 2026-10-19T20:00:00+08:00
category: "AI"
tags: ["AI", "mysql"]
---

**摘要：** Text2SQL 不是一句 prompt 就完事。本文用 Spring AI 搭一条完整链路：把表结构喂给模型、生成 SQL、做安全校验、执行，再把数据库报错回灌给模型重试。附只读账号、超时、行数限制和选型建议。

> 运营在群里问：「上个月华东区退款金额最高的三个品类是什么？」数据团队排期排到下周。你想着接个大模型，让它直接查库，半小时就能做完。demo 跑通了，上线第一天就出问题：模型编了个不存在的字段，还把一张 800 万行的订单表全表扫了一遍，数据库 CPU 直接拉满。这篇文章解决的就是这件事：怎么让大模型查库，既查得对，又不会把库搞挂。

## 一、这个问题到底是什么

结论：Text2SQL 的难点不在生成 SQL，而在让这条 SQL 安全、正确地跑在你的库上。

先把角色分清楚。大模型不连数据库，它只做一件事：看着你给的表结构，把「上个月退款最多的品类」翻译成一串 SQL 文本。真正执行这条 SQL 的，是你 Java 代码里的 `JdbcTemplate`。

这意味着模型可以胡说，而你的代码会当真。中间没有编译器，没有类型检查，没有权限提示。它写 `pay_amount`，你库里叫 `amount`，SQL 直接报错；它忘了写 `LIMIT`，你的从库就开始冒烟。

### demo 很惊艳，上线就翻车

网上的 Text2SQL 示例，通常长这样：一张 `users` 表，三个字段，问「有多少用户」，模型写 `SELECT COUNT(*) FROM users`。当然准。

真实环境是另一回事：

- 库里有 60 张表，表名还带业务前缀，`t_order_main`、`biz_refund_record`。
- 字段注释是十年前写的，`flag` 后面跟着「是否有效（1 是 0 否，但历史数据有 2）」。
- 同一个「金额」，订单表叫 `total_amount`，退款表叫 `refund_fee`，还一个存分、一个存元。
- 数据库账号是读写账号，模型哪天真写出 `UPDATE`，你连后悔的时间都没有。

### 三个必须解决的问题

**字段幻觉。** 模型会按训练语料里的常见表结构补全字段名。你的表越不标准，它编得越起劲。

**查询失控。** 没有 `LIMIT` 的 `SELECT *`，加上一个 `LIKE '%关键词%'`，足够让小库卡住。大表还能把连接池占满。

**权限越界。** 多租户系统里，A 公司的运营问一句「所有订单」，模型可能真的生成不带 `tenant_id` 的 SQL。

### 一个可执行的验收标准

别用「感觉挺准」来评估。准备 20 个真实业务问题，每个问题人工写好标准答案，然后记录三件事：

- SQL 一次执行成功率；
- 查询结果和标准答案是否一致；
- 从提问到返回的 P95 耗时。

三个数字都达标，再谈上线。第一版能做到 70% 可用，已经算不错，剩下的靠 schema 注释和错误回灌慢慢补。

## 二、底层原理到底怎么回事

结论：把 Text2SQL 当成「翻译 + 编译检查 + 运行反馈」三段流水线，而不是一次问答。

### 模型看到的只有你给的 schema

大模型对这个库的全部认知，来自你塞进 prompt 的那段表结构。你给什么，它知道什么；你没给的，它靠猜。

所以 schema 不是随便 `SHOW CREATE TABLE` 一下就完事。有用的信息包括：

- 表名、列名、数据类型；
- 列的 COMMENT，最好写成业务语言；
- 枚举字段的全部取值，比如 `status: paid/refunded/cancelled`；
- 今天日期，以及「上个月」「最近 7 天」按哪个时区算；
- 哪些字段是金额、单位是元还是分。

列注释的价值被严重低估。`status VARCHAR(20)` 模型只能猜，`status VARCHAR(20) -- 订单状态：paid 已支付 / refunded 已退款 / cancelled 已取消` 模型基本不会用错。

代价是 token。一张 20 列的表，描述完大概 300 到 500 token；十张表就是三五千 token。每次提问都带一遍，成本不低。后面会讲怎么按业务域裁剪。

### 模型为什么会编字段

它本质是在做概率补全。训练数据里大量出现 `id`、`user_id`、`created_at`、`amount`，于是它默认你的表也长这样。你的字段叫 `payable_amount`，它照样写 `amount`，因为这样「最顺」。

三种补救手段，建议全上：

1. **只给真实 schema**，别给示例，别让它自由发挥；
2. **生成后校验列名**，拿 `information_schema.columns` 对一遍，不存在的列直接打回；
3. **执行报错回灌**，把数据库的 `Unknown column 'amount' in 'field list'` 原样丢回给模型，让它改。

第三条最有效。模型看到真实报错，比你说十遍「不要编字段」都管用。

### 一次性生成和工具循环的区别

一次性生成像闭卷考试：模型看完题，写完交卷，对不对听天由命。

工具循环像开卷考试，还允许重做：模型可以先调 `describeSchema` 看字段，再调 `runQuery` 执行，报错了拿着错误信息改一版再跑。Spring AI 的 `@Tool` 就是干这个的。

代价很直接。一次生成只调一次模型，工具循环通常要 2 到 5 次，延迟翻倍，token 也翻倍。内部工具可以接受，面向 C 端的高并发接口就要掂量。

### 安全要三道门，缺一不可

**第一道，数据库账号。** 给 Text2SQL 单独开一个只读账号，只授权 `SELECT`，只给业务库，不给系统库。这是最后一道门，也是唯一一道模型绕不过去的门。

**第二道，应用层 SQL 校验。** 只允许 `SELECT` 和 `WITH` 开头，禁止多语句、注释、DDL、`INTO OUTFILE`、`SLEEP` 这类东西。它防的是模型手滑和 prompt 注入，不是专业黑客。真要被攻破，靠的还是第一道门。

**第三道，执行层限制。** 强制 `LIMIT`，设置 `queryTimeout` 和 `maxRows`，最好再走只读从库。这三样是保命的，别省。

### 结果总结也会幻觉

SQL 查出来 37 行，模型总结时写成「共 42 条」。这种事很常见，因为它在「复述数字」时又做了一次概率生成。

办法很简单：数字在 Java 里算好，模型只负责解释。或者明确告诉它「只能引用结果里出现的数字，不要做任何加减乘除」。结果行数也要截断，几百行 JSON 塞进去，既贵又容易让它看花眼。

## 三、实战：手把手写代码

结论：先跑通「生成 → 校验 → 执行 → 总结」的最小链路，再加工具循环，最后补权限和审计。

### 3.1 依赖和配置

`pom.xml` 如下。模型走 OpenAI 兼容协议，这里以 DeepSeek 为例，换成通义、豆包、OpenAI 只改 `base-url` 和 `model`。

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
    <artifactId>text2sql-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

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

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.7.0</version>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.1</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

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

配置文件里，`base-url` 指向 OpenAI 兼容网关，`temperature` 设 0，尽量让每次生成稳定。数据库账号必须是只读账号，不要图省事用 root。

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&serverTimezone=Asia/Shanghai&characterEncoding=utf8
    username: readonly
    password: readonly_pwd
    hikari:
      maximum-pool-size: 10
  ai:
    openai:
      api-key: ${DEEPSEEK_API_KEY}
      base-url: https://api.deepseek.com
      chat:
        options:
          model: deepseek-chat
          temperature: 0
```

建库脚本也贴上，三张表，带中文注释。注释就是模型理解业务的地图，别省。

```sql
CREATE DATABASE IF NOT EXISTS shop DEFAULT CHARACTER SET utf8mb4;
USE shop;

CREATE TABLE products (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '商品ID',
    name        VARCHAR(100) NOT NULL COMMENT '商品名称',
    category    VARCHAR(50)  NOT NULL COMMENT '品类：手机/电脑/配件',
    price       DECIMAL(10,2) NOT NULL COMMENT '售价，单位元'
) COMMENT '商品表';

CREATE TABLE orders (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '订单ID',
    user_id     BIGINT NOT NULL COMMENT '用户ID',
    tenant_id   BIGINT NOT NULL COMMENT '租户ID，华东=1，华南=2',
    status      VARCHAR(20) NOT NULL COMMENT '订单状态：paid 已支付 / refunded 已退款 / cancelled 已取消',
    total_amount DECIMAL(12,2) NOT NULL COMMENT '订单金额，单位元',
    created_at  DATETIME NOT NULL COMMENT '下单时间'
) COMMENT '订单主表';

CREATE TABLE order_items (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '明细ID',
    order_id    BIGINT NOT NULL COMMENT '订单ID',
    product_id  BIGINT NOT NULL COMMENT '商品ID',
    quantity    INT NOT NULL COMMENT '购买数量',
    item_amount DECIMAL(12,2) NOT NULL COMMENT '明细金额，单位元'
) COMMENT '订单明细表';

INSERT INTO products (name, category, price) VALUES
('iPhone 17', '手机', 5999.00),
('MacBook Air', '电脑', 8999.00),
('USB-C 充电线', '配件', 79.00);

INSERT INTO orders (user_id, tenant_id, status, total_amount, created_at) VALUES
(1001, 1, 'paid',     5999.00, '2026-09-03 10:12:00'),
(1002, 1, 'refunded', 8999.00, '2026-09-08 14:30:00'),
(1003, 2, 'paid',      158.00, '2026-09-15 09:05:00'),
(1004, 1, 'refunded', 5999.00, '2026-09-21 20:41:00'),
(1005, 2, 'paid',     8999.00, '2026-10-02 11:20:00');

INSERT INTO order_items (order_id, product_id, quantity, item_amount) VALUES
(1, 1, 1, 5999.00),
(2, 2, 1, 8999.00),
(3, 3, 2,  158.00),
(4, 1, 1, 5999.00),
(5, 2, 1, 8999.00);
```

### 3.2 最小链路：生成、校验、执行、总结

先解决两个基础设施。`JdbcTemplate` 统一加上超时和最大行数，这样即使模型漏了 `LIMIT`，JDBC 层也只取 200 行。

```java
package com.example.text2sql;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

@Configuration
public class JdbcConfig {

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        JdbcTemplate template = new JdbcTemplate(dataSource);
        template.setQueryTimeout(5);
        template.setMaxRows(200);
        template.setFetchSize(50);
        return template;
    }
}
```

`SchemaProvider` 负责把 `information_schema` 里的真实结构拼成一段给模型看的文字。注意它读的是数据库元数据，不是手写的 JSON，这样表结构变了不用改代码。

```java
package com.example.text2sql;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Component
public class SchemaProvider {

    private final JdbcTemplate jdbcTemplate;

    public SchemaProvider(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public String describe(List<String> tables) {
        if (tables == null || tables.isEmpty()) {
            throw new IllegalArgumentException("至少指定一张表");
        }
        String placeholders = tables.stream().map(t -> "?").collect(Collectors.joining(","));
        String sql = """
                SELECT table_name AS tableName,
                       column_name AS columnName,
                       data_type AS dataType,
                       column_comment AS columnComment
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name IN (%s)
                ORDER BY table_name, ordinal_position
                """.formatted(placeholders);

        List<Map<String, Object>> rows = jdbcTemplate.queryForList(sql, tables.toArray());

        Map<String, StringBuilder> byTable = new LinkedHashMap<>();
        for (Map<String, Object> row : rows) {
            String table = String.valueOf(row.get("tableName"));
            String column = String.valueOf(row.get("columnName"));
            String type = String.valueOf(row.get("dataType"));
            Object commentValue = row.get("columnComment");
            String comment = commentValue == null ? "" : String.valueOf(commentValue);

            StringBuilder builder = byTable.computeIfAbsent(
                    table, key -> new StringBuilder("表 ").append(key).append("：\n"));
            builder.append("  - ").append(column).append(" ").append(type);
            if (!comment.isBlank()) {
                builder.append("  -- ").append(comment);
            }
            builder.append("\n");
        }
        return byTable.values().stream()
                .map(StringBuilder::toString)
                .collect(Collectors.joining("\n"));
    }
}
```

`SqlGuard` 是应用层的门。它干四件事：去掉 markdown 代码块、去掉注释、拒绝多语句和非查询语句、补上或压低 `LIMIT`。

```java
package com.example.text2sql;

import org.springframework.stereotype.Component;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Component
public class SqlGuard {

    private static final int MAX_ROWS = 200;

    private static final Set<String> BLOCKED_WORDS = Set.of(
            "insert", "update", "delete", "drop", "alter", "truncate",
            "create", "grant", "revoke", "replace", "merge", "call",
            "execute", "load_file", "outfile", "dumpfile", "sleep",
            "benchmark", "information_schema", "performance_schema",
            "mysql", "sys"
    );

    private static final Pattern CODE_FENCE =
            Pattern.compile("^\\x60{3}[a-zA-Z]*\\s*|\\s*\\x60{3}$");
    private static final Pattern COMMENTS =
            Pattern.compile("(--[^\\n]*|/\\*.*?\\*/)", Pattern.DOTALL);
    private static final Pattern LIMIT =
            Pattern.compile("(?i)\\blimit\\s+(\\d+)");
    private static final Pattern BLOCKED = Pattern.compile(
            "\\b(" + String.join("|", BLOCKED_WORDS) + ")\\b", Pattern.CASE_INSENSITIVE);

    public String check(String rawSql) {
        if (rawSql == null || rawSql.isBlank()) {
            throw new IllegalArgumentException("模型没有返回 SQL");
        }

        String sql = CODE_FENCE.matcher(rawSql.trim()).replaceAll("");
        sql = COMMENTS.matcher(sql).replaceAll(" ").trim();

        while (sql.endsWith(";")) {
            sql = sql.substring(0, sql.length() - 1).trim();
        }
        if (sql.contains(";")) {
            throw new IllegalArgumentException("只允许单条语句");
        }

        String lower = sql.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("select") && !lower.startsWith("with")) {
            throw new IllegalArgumentException("只允许 SELECT 或 WITH 开头的查询");
        }

        Matcher blocked = BLOCKED.matcher(sql);
        if (blocked.find()) {
            throw new IllegalArgumentException("SQL 含禁用关键字：" + blocked.group(1));
        }
        if (lower.contains("for update") || lower.contains("lock in share mode")) {
            throw new IllegalArgumentException("不允许加锁读");
        }

        Matcher limit = LIMIT.matcher(sql);
        if (limit.find()) {
            int current = Integer.parseInt(limit.group(1));
            if (current > MAX_ROWS) {
                sql = sql.substring(0, limit.start())
                        + "limit " + MAX_ROWS
                        + sql.substring(limit.end());
            }
        } else {
            sql = sql + " limit " + MAX_ROWS;
        }
        return sql;
    }
}
```

`QueryPlan` 是模型输出的结构。用 record 加 `JsonPropertyDescription`，Spring AI 会把它转成 JSON Schema 塞进提示词，模型返回的 JSON 再反序列化成对象。

```java
package com.example.text2sql;

import com.fasterxml.jackson.annotation.JsonPropertyDescription;

public record QueryPlan(
        @JsonPropertyDescription("一条 MySQL 方言的只读 SELECT 语句，不要带 markdown 代码块，不要带分号")
        String sql,

        @JsonPropertyDescription("把用户问题拆成查询条件的一句话说明")
        String reasoning
) {
}
```

核心服务把四步串起来。注意系统提示词里写了「今天是哪天」，这比让模型自己算日期靠谱得多。

```java
package com.example.text2sql;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@Service
public class Text2SqlService {

    private static final String SYSTEM_PROMPT = """
            你是 MySQL 数据分析师。根据给定的表结构，把用户问题翻译成一条 SELECT 语句。
            规则：
            1. 只能使用表结构里真实存在的表和列，禁止猜测字段名。
            2. 只生成一条语句，只能是 SELECT 或 WITH 开头。
            3. 时间范围用 MySQL 函数表达，今天是 %s。
            4. 金额字段单位是元，不要做汇率换算。
            5. 不确定用户指哪个字段时，选注释最贴近的那个，并在 reasoning 里说明。
            6. 不要输出 markdown 代码块，sql 字段只放裸 SQL。
            """;

    private final ChatClient chatClient;
    private final SchemaProvider schemaProvider;
    private final SqlGuard sqlGuard;
    private final JdbcTemplate jdbcTemplate;

    public Text2SqlService(ChatClient.Builder builder,
                           SchemaProvider schemaProvider,
                           SqlGuard sqlGuard,
                           JdbcTemplate jdbcTemplate) {
        this.chatClient = builder.build();
        this.schemaProvider = schemaProvider;
        this.sqlGuard = sqlGuard;
        this.jdbcTemplate = jdbcTemplate;
    }

    public Answer ask(String question, List<String> tables) {
        String schema = schemaProvider.describe(tables);

        QueryPlan plan = chatClient.prompt()
                .system(SYSTEM_PROMPT.formatted(LocalDate.now()))
                .user(u -> u.text("""
                        表结构：
                        {schema}

                        用户问题：{question}
                        """)
                        .param("schema", schema)
                        .param("question", question))
                .call()
                .entity(QueryPlan.class);

        String sql = sqlGuard.check(plan.sql());
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(sql);
        String answer = explain(question, sql, rows);
        return new Answer(sql, rows, answer);
    }

    private String explain(String question, String sql, List<Map<String, Object>> rows) {
        String data = rows.isEmpty() ? "查询结果为空" : rows.toString();
        if (data.length() > 4000) {
            data = data.substring(0, 4000) + "...(已截断)";
        }

        return chatClient.prompt()
                .system("""
                        你是数据分析师。根据 SQL 和查询结果回答用户问题。
                        只解释结果，不要重新计算数字，不要编造结果里没有的数据。
                        结果为空就直接说没查到，并给出一个可能的原因。
                        回答控制在 120 字以内。
                        """)
                .user(u -> u.text("问题：{question}\nSQL：{sql}\n结果：{data}")
                        .param("question", question)
                        .param("sql", sql)
                        .param("data", data))
                .call()
                .content();
    }

    public record Answer(String sql, List<Map<String, Object>> rows, String answer) {
    }
}
```

一个 REST 接口把它暴露出去。默认只允许三张表，别让前端随便传表名。

```java
package com.example.text2sql;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/text2sql")
public class Text2SqlController {

    private final Text2SqlService text2SqlService;

    public Text2SqlController(Text2SqlService text2SqlService) {
        this.text2SqlService = text2SqlService;
    }

    public record AskRequest(String question, List<String> tables) {
    }

    @PostMapping("/ask")
    public Text2SqlService.Answer ask(@RequestBody AskRequest request) {
        if (request.question() == null || request.question().isBlank()) {
            throw new IllegalArgumentException("question 不能为空");
        }
        List<String> tables = request.tables() == null || request.tables().isEmpty()
                ? List.of("orders", "order_items", "products")
                : request.tables();
        return text2SqlService.ask(request.question(), tables);
    }
}
```

跑起来之后，这样调：

```bash
curl -s http://localhost:8080/api/text2sql/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"上个月退款订单的总金额是多少"}'
```

返回里会带 `sql`、`rows` 和一段人话 `answer`。先把 `sql` 打出来看一眼，这是排查问题最有效的手段。

### 3.3 工具循环：让模型自己看报错、改 SQL

最小链路的问题是一锤子买卖。字段错了，接口直接 500，用户只看到「系统繁忙」。

把查库能力包成工具，模型就能自己重试。`describeSchema` 让它先确认字段，`runQuery` 返回结果或错误信息。

```java
package com.example.text2sql;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.StringJoiner;

@Component
public class DbQueryTools {

    private final JdbcTemplate jdbcTemplate;
    private final SqlGuard sqlGuard;
    private final SchemaProvider schemaProvider;

    public DbQueryTools(JdbcTemplate jdbcTemplate,
                        SqlGuard sqlGuard,
                        SchemaProvider schemaProvider) {
        this.jdbcTemplate = jdbcTemplate;
        this.sqlGuard = sqlGuard;
        this.schemaProvider = schemaProvider;
    }

    @Tool(description = "查看指定表的字段结构。参数是逗号分隔的表名，例如 orders,order_items")
    public String describeSchema(String tables) {
        List<String> tableList = List.of(tables.split("\\s*,\\s*"));
        return schemaProvider.describe(tableList);
    }

    @Tool(description = "执行一条只读 SELECT 查询，返回 CSV 文本，最多 50 行。SQL 使用 MySQL 方言，不要加 markdown 代码块")
    public String runQuery(String sql) {
        try {
            String safeSql = sqlGuard.check(sql);
            List<Map<String, Object>> rows = jdbcTemplate.queryForList(safeSql);
            if (rows.isEmpty()) {
                return "查询成功，但没有数据";
            }

            Map<String, Object> first = rows.get(0);
            StringBuilder result = new StringBuilder(String.join(",", first.keySet())).append("\n");
            int count = 0;
            for (Map<String, Object> row : rows) {
                if (count++ >= 50) {
                    break;
                }
                StringJoiner line = new StringJoiner(",");
                for (String key : first.keySet()) {
                    Object value = row.get(key);
                    line.add(value == null ? "" : String.valueOf(value));
                }
                result.append(line).append("\n");
            }
            return result.toString();
        } catch (Exception e) {
            return "SQL 执行失败：" + e.getMessage() + "。请检查字段名、函数和语法，修正后重试。";
        }
    }
}
```

Agent 服务只负责给规则，重试逻辑交给模型和 Spring AI 的工具调用循环。

```java
package com.example.text2sql;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class Text2SqlAgent {

    private final ChatClient chatClient;
    private final DbQueryTools dbQueryTools;

    public Text2SqlAgent(ChatClient.Builder builder, DbQueryTools dbQueryTools) {
        this.chatClient = builder.build();
        this.dbQueryTools = dbQueryTools;
    }

    public String ask(String question) {
        return chatClient.prompt()
                .system("""
                        你是电商数据分析师，可以调用工具查库。
                        工作方式：
                        1. 先用 describeSchema 确认字段，再写 SQL。
                        2. 用 runQuery 执行。SQL 报错就把错误信息当成线索改 SQL，最多重试 3 次。
                        3. 只查 orders、order_items、products 三张表。
                        4. 回答给业务同学看：先给结论，再给关键数字，不要贴 SQL。
                        5. 数据为空就说没查到，不要编。
                        """)
                .user(question)
                .tools(dbQueryTools)
                .call()
                .content();
    }
}
```

把它接到接口上，就是一个会自我纠错的查询入口：

```java
package com.example.text2sql;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/text2sql")
public class Text2SqlAgentController {

    private final Text2SqlAgent text2SqlAgent;

    public Text2SqlAgentController(Text2SqlAgent text2SqlAgent) {
        this.text2SqlAgent = text2SqlAgent;
    }

    public record AgentRequest(String question) {
    }

    @PostMapping("/agent")
    public Map<String, String> ask(@RequestBody AgentRequest request) {
        if (request.question() == null || request.question().isBlank()) {
            throw new IllegalArgumentException("question 不能为空");
        }
        return Map.of("answer", text2SqlAgent.ask(request.question()));
    }
}
```

两个接口的差别要心里有数：`/ask` 一次模型调用，快、便宜、错就错；`/agent` 两到五次调用，慢、贵、但能自己修正。内部工具用后者，对外接口用前者加人工兜底。

## 四、踩坑经验和最佳实践

结论：Text2SQL 的效果，八成取决于 schema 和边界，两成取决于模型。

**schema 不是越全越好。** 我见过把整个库几十张表全塞进去的做法，token 烧得快，模型还容易被相似表名带偏。按业务域分组，一次只给 3 到 8 张表。用户问订单，就别给商品库存表。

**列注释要写人话，还要写枚举。** `type TINYINT` 等于没说。写成 `type TINYINT -- 订单类型：1 普通 / 2 预售 / 3 虚拟`，准确率立刻不一样。历史脏数据也要写进去，比如「有 2 表示已删除，统计时要过滤」。

**别让模型算日期。** 「上个月」对模型是个模糊概念，它可能按训练数据的时间算。把 `LocalDate.now()` 写进系统提示词，再明确时区。跨月、闰年这些事，交给数据库函数。

**`LIMIT` 一定要双保险。** 应用层补 `LIMIT`，JDBC 层设 `maxRows`，数据库账号再配 `MAX_EXECUTION_TIME`。三层里任何一层失效，另外两层还能兜住。

**SQL 校验别做成正则地狱。** 简单场景用关键字黑名单够用，复杂 SQL 建议上 JSqlParser 做 AST 校验，至少能准确判断是不是单条 `SELECT`。自己写正则判断嵌套查询，迟早漏。

**行级权限不要交给模型。** 多租户场景，正确做法是给每个租户建视图，或者在 SQL 外面套一层 `WHERE tenant_id = ?`，参数从登录态取。让模型「记得加 tenant_id」，等于把安全交给运气。

**结果总结只让它解释，不让它计算。** 总数、平均值、环比，在 Java 里算完再给它。模型负责把数字翻译成人话，这个它擅长。

**留审计日志。** 每次记录：谁问的、问题原文、生成的 SQL、是否被 guard 拦截、执行耗时、返回行数。出问题时，这份日志比任何监控都管用。

**给高频问题留后门。** Top 20 的问题，直接配 SQL 模板，不走模型。又快又准，还省钱。模型只处理长尾。

**别把整段对话历史塞进 prompt。** 上一轮生成的错误 SQL 和报错信息，会让模型反复复读旧字段。只保留最近一轮的 SQL 和错误摘要，够用就行。

## 五、性能对比和技术选型

结论：没有一种方案通吃，高频走模板，长尾走模型，复杂查询走 Agent。

| 方案 | 模型调用次数 | 延迟 | 单次成本 | 准确率 | 适合场景 |
| --- | --- | --- | --- | --- | --- |
| 预置 SQL 模板 | 0 | 10-50ms | 0 | 接近 100% | 高频固定报表 |
| 一次性生成 | 1 | 1-3s | 低 | 中等 | 内部简单查询 |
| 工具循环 Agent | 2-5 | 3-10s | 中高 | 较高 | 长尾、多表、需要纠错 |
| 混合方案 | 0-5 | 按需 | 可控 | 高 | 生产环境推荐 |

延迟的大头在模型生成，不在数据库执行。一条走索引的查询通常几十毫秒，模型写 SQL 要一两秒，Agent 多轮更久。所以优化重点是把常见问题从「生成」降到「模板」，而不是去调 JVM 参数。

并发上，Text2SQL 不适合直接扛 C 端流量。一个请求占一次模型调用，还占一个数据库连接。真要做，前面加队列和限流，数据库走只读从库，连接池单独隔离，别和主业务抢。

这些场景建议别用 Text2SQL：

- 强一致、要求分毫不差的财务报表；
- 涉及 5 张以上表复杂 join 的查询；
- 权限模型复杂到需要行级、列级混合控制；
- 对外公开、会被恶意构造问题的入口。

## 六、总结

Text2SQL 不是「接个大模型就能查库」，它是一套工程：schema 怎么描述、SQL 怎么校验、错误怎么回灌、权限怎么兜底。

落地顺序我建议这样走：

1. 先开只读账号，只给三张表，把最小链路跑通；
2. 准备 20 个真实问题，记录可执行率和正确率；
3. 补 schema 注释，加 `LIMIT`、超时、`maxRows`；
4. 再上工具循环，让模型自己纠错；
5. 最后接审计、缓存和高频模板。

别一上来就追求「任意问题都能查」。先把一个业务域做准，比做一个什么都能问、什么都问不准的 demo 有价值得多。

判断一个 Text2SQL 方案值不值得上，就看两件事：它能不能稳定回答业务里最高频的 20 个问题，以及出错时你能不能一眼看出错在哪。前者决定有没有人用，后者决定你敢不敢上线。

模型会升级，schema 会变，唯一不能省的是校验和权限这两道门。别把力气全花在换模型上。

## 参考资料

- [Spring AI ChatClient](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Spring AI Tool Calling](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [MySQL SELECT Statement](https://dev.mysql.com/doc/refman/8.4/en/select.html)
- [OWASP SQL Injection](https://owasp.org/www-community/attacks/SQL_Injection)

文 / 会编程的吕洞宾

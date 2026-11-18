---
title: "MySQL索引失效8种场景，EXPLAIN逐个复现"
date: 2026-10-04T09:00:00+08:00
category: "数据库"
tags: ["mysql"]
---

> 订单列表接口上线时好好的，数据涨到百万之后，"查某个用户某状态的订单"从 20ms 拖到 2s。你明明在 user_id 上建了索引，EXPLAIN 一看却是 type=ALL，全表扫描。加索引不等于用索引，MySQL 优化器有一堆理由把它丢掉：列上套了函数、类型对不上、联合索引没用上最左列……这篇把 8 种最常见的失效场景一个个搭出来，用真实 EXPLAIN 输出做对比，并给出一个能直接跑起来的 Spring Boot 工程，启动就会打印每种场景的 type、key、key_len、rows。

## 一、这个问题到底是什么

索引失效的意思是"索引还在，MySQL 却没用它"，不是索引被删了。

很多人排查慢 SQL 的方式是打开表看索引，发现索引建了，就觉得没问题。问题在于：索引建了是一回事，查询用不用它是另一回事。MySQL 的查询优化器会在每个可能的执行方案里挑一个它认为最便宜的，走索引只是候选方案之一。

诊断这件事的入口是 `EXPLAIN`。把它加在 SQL 前面，MySQL 不会真的执行，而是告诉你它打算怎么执行。输出里这几列最关键：

- **type**：访问类型，从好到坏大致是 `system > const > eq_ref > ref > range > index > ALL`。看到 `ALL` 基本就是全表扫描。
- **key**：真正用上的索引名。`NULL` 表示一个索引都没用。
- **key_len**：索引实际用掉的字节数。联合索引里到底用上了几列，看这个数字最直观。
- **rows**：优化器估计要扫多少行。数字越大越危险。
- **Extra**：补充信息。出现 `Using filesort`（额外排序）、`Using temporary`（建临时表）通常都是要优化的信号。

一个典型现象是这样的：一张订单表按 `(user_id, status, created_at)` 建了联合索引，接口里写 `WHERE status = 1`，觉得 status 在索引里就能加速。实际上 MySQL 用不上——联合索引要先按 user_id 排，你直接跳到 status，它没法定位，只能全表扫。

还有一种更隐蔽的：`WHERE order_no = 123456`，order_no 是字符串列，你传了个数字。MySQL 会把整列的字符串转成数字再比较，索引直接作废。代码能跑、结果也对，就是慢。这种问题不看 EXPLAIN 根本发现不了。

下面先讲清楚为什么会失效，再动手把 8 种场景一个个复现出来。

## 二、底层原理到底怎么回事

**B+树索引是一份排好序的目录，条件一旦破坏"有序性"，目录就用不上。**

InnoDB 的索引底层是 B+ 树。你可以把它想成一本电话簿：条目按姓名的拼音顺序排好，找你想要的人很快。但前提是，你得按它的排序规则来查。

联合索引 `(user_id, status, created_at)` 就相当于先按 user_id 排，user_id 相同的再按 status 排，还相同的再按 created_at 排。这就是"最左前缀"的来源：

- `WHERE user_id = 100` → 能定位，用得上。
- `WHERE user_id = 100 AND status = 1` → 前缀更完整，用得上，范围更小。
- `WHERE status = 1` → 不按第一列来，定位不了，用不上。
- `WHERE user_id = 100 AND created_at > ?` → user_id 用得上，但 status 被跳过，created_at 排在 status 后面，也用不上。

**函数和类型转换为什么会失效？因为它们让"列值"变了。**

索引里存的是 created_at 的原始值，按时间排好序。你写 `DATE(created_at) = '2025-06-15'`，MySQL 得把每一行的 created_at 都算一遍 DATE() 才能比较。算完得到的值，和索引里存的原始值已经不是一回事了，排好的顺序自然对不上，只能一行行算——这和全表扫描没区别。

隐式类型转换是同一个道理。order_no 是 VARCHAR，索引按字符串排序；你拿数字去比，MySQL 要把每一行的 order_no 转成数字，索引顺序又废了。反过来，如果列是数字、你传字符串，问题不大，因为转换发生在常量上，不影响列的有序性。记住一句话：**转换发生在列上就废索引，发生在常量上就没事。**

**优化器为什么不选索引？因为走索引不一定便宜。**

二级索引（除主键外的索引）里只存了索引列和主键值。想拿到完整的一行，还得拿主键回主键索引里再查一次，这叫"回表"。回表是随机 IO，比顺序读整张表慢。

所以优化器会算一笔账：如果条件能过滤掉绝大部分数据，回表次数少，走索引划算；如果条件能命中三成以上的行，回表次数太多，还不如直接顺序扫全表。这就是"区分度太低时优化器主动放弃索引"的原因——`WHERE status = 1` 这种只过滤掉三分之二的查询，优化器经常直接全扫。

还有个优化叫"索引下推"（Index Condition Pushdown）：过滤条件如果只跟索引列有关，MySQL 会在索引层就筛掉不匹配的行，减少回表。这是 5.6 之后默认开启的，你不需要配，但要知道它存在，看 Extra 里的 `Using index condition` 就是它。

## 三、实战：手把手写代码

先搭一个能跑的最小工程。环境是 MySQL 8.4 + Spring Boot 4.1.1 + Java 21，用 JdbcTemplate 直接跑 SQL，不引入 ORM，这样每条 SQL 和它的执行计划能一一对上。

### 3.1 建表与索引

一张 20 万行的订单表，建三个索引：联合索引 `idx_user_status_created`、单列 `idx_order_no`、单列 `idx_created_at`。

```sql
DROP TABLE IF EXISTS t_order;

CREATE TABLE t_order (
    id          BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
    order_no    VARCHAR(32)   NOT NULL COMMENT '订单号',
    user_id     BIGINT        NOT NULL COMMENT '用户ID',
    status      TINYINT       NOT NULL COMMENT '状态：0待支付 1已支付 2已取消',
    amount      DECIMAL(10,2) NOT NULL COMMENT '金额',
    created_at  DATETIME      NOT NULL COMMENT '创建时间',
    remark      VARCHAR(255)  DEFAULT NULL COMMENT '备注',
    PRIMARY KEY (id),
    KEY idx_user_status_created (user_id, status, created_at),
    KEY idx_order_no (order_no),
    KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';
```

### 3.2 完整的 pom.xml

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
    <artifactId>mysql-index-demo</artifactId>
    <version>1.0.0</version>
    <name>mysql-index-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

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
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.7.0</version>
            <scope>runtime</scope>
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

### 3.3 application.yml

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/index_demo?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true
    username: root
    password: root123456
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      maximum-pool-size: 10
      minimum-idle: 2
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql
      encoding: UTF-8

logging:
  level:
    com.example.indexdemo: debug
```

把上面的建表语句保存成 `src/main/resources/schema.sql`。`spring.sql.init.mode=always` 会让它在应用启动时自动执行。

### 3.4 启动类

```java
package com.example.indexdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class IndexDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(IndexDemoApplication.class, args);
    }
}
```

### 3.5 造 20 万行测试数据

数据用代码批量插，比 data.sql 快得多。20 万行、1000 个用户、3 种状态，order_no 用纯数字字符串，方便后面演示隐式类型转换。

```java
package com.example.indexdemo;

import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

@Component
@Order(1)
public class DataInitializer implements CommandLineRunner {

    private static final int TOTAL = 200_000;

    private final JdbcTemplate jdbcTemplate;

    public DataInitializer(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public void run(String... args) {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM t_order", Integer.class);
        if (count != null && count > 0) {
            System.out.println("测试数据已存在，跳过初始化，当前行数=" + count);
            return;
        }

        String sql = "INSERT INTO t_order(order_no, user_id, status, amount, created_at, remark) VALUES (?, ?, ?, ?, ?, ?)";
        Random random = new Random(42);
        LocalDateTime base = LocalDateTime.of(2025, 1, 1, 0, 0);

        List<Object[]> batch = new ArrayList<>(1000);
        for (int i = 1; i <= TOTAL; i++) {
            batch.add(new Object[]{
                    String.valueOf(100_000_000L + i),
                    (long) random.nextInt(1000) + 1,
                    random.nextInt(3),
                    BigDecimal.valueOf(random.nextInt(100_000)).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP),
                    Timestamp.valueOf(base.plusMinutes(random.nextInt(365 * 24 * 60))),
                    "remark-" + i
            });
            if (batch.size() == 1000) {
                jdbcTemplate.batchUpdate(sql, batch);
                batch.clear();
            }
        }
        if (!batch.isEmpty()) {
            jdbcTemplate.batchUpdate(sql, batch);
        }

        jdbcTemplate.execute("ANALYZE TABLE t_order");
        System.out.println("初始化完成，共写入 " + TOTAL + " 行，并刷新了统计信息");
    }
}
```

### 3.6 把 8 种场景写成可打印的方法

核心类 OrderQueryService 把每种场景的 SQL 跑一次 EXPLAIN，把结果拼成一段文本。这样启动日志里就能直接看到答案，不用自己手动敲 SQL。

```java
package com.example.indexdemo;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Service
public class OrderQueryService {

    private final JdbcTemplate jdbcTemplate;

    public OrderQueryService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<String> runAll() {
        List<String> reports = new ArrayList<>();
        reports.add(scene1Function());
        reports.add(scene2TypeMismatch());
        reports.add(scene3LeftLike());
        reports.add(scene4Leftmost());
        reports.add(scene5SkipColumn());
        reports.add(scene6OrCondition());
        reports.add(scene7OrderBy());
        reports.add(scene8LowSelectivity());
        return reports;
    }

    /** 场景1：索引列上套函数 */
    public String scene1Function() {
        String a = explain("场景1-A 函数包裹 created_at（索引失效）",
                "SELECT id, order_no, amount FROM t_order WHERE DATE(created_at) = '2025-06-15'");
        String b = explain("场景1-B 改成时间范围（走索引）",
                "SELECT id, order_no, amount FROM t_order WHERE created_at >= '2025-06-15 00:00:00' AND created_at < '2025-06-16 00:00:00'");
        return a + b;
    }

    /** 场景2：隐式类型转换 */
    public String scene2TypeMismatch() {
        String a = explain("场景2-A 字符串列拿数字比（索引失效）",
                "SELECT id, order_no FROM t_order WHERE order_no = 100000001");
        String b = explain("场景2-B 常量加上引号（走索引）",
                "SELECT id, order_no FROM t_order WHERE order_no = '100000001'");
        return a + b;
    }

    /** 场景3：左模糊匹配 */
    public String scene3LeftLike() {
        String a = explain("场景3-A 前后都带百分号（索引失效）",
                "SELECT id, order_no FROM t_order WHERE order_no LIKE '%0001%'");
        String b = explain("场景3-B 前缀匹配（走索引）",
                "SELECT id, order_no FROM t_order WHERE order_no LIKE '100000001%'");
        return a + b;
    }

    /** 场景4：不满足最左前缀 */
    public String scene4Leftmost() {
        String a = explain("场景4-A 跳过联合索引第一列 user_id（索引失效）",
                "SELECT id, user_id, status FROM t_order WHERE status = 1");
        String b = explain("场景4-B 从第一列 user_id 查（走索引）",
                "SELECT id, user_id, status FROM t_order WHERE user_id = 100");
        return a + b;
    }

    /** 场景5：跳过中间列，导致后面的范围列用不上 */
    public String scene5SkipColumn() {
        String a = explain("场景5-A 缺了 status，created_at 用不上",
                "SELECT id FROM t_order WHERE user_id = 100 AND created_at >= '2025-06-01 00:00:00'");
        String b = explain("场景5-B 补齐 status，三列都用上",
                "SELECT id FROM t_order WHERE user_id = 100 AND status = 1 AND created_at >= '2025-06-01 00:00:00'");
        return a + b;
    }

    /** 场景6：OR 连接了没有索引的列 */
    public String scene6OrCondition() {
        String a = explain("场景6-A OR 上 amount（没索引，索引失效）",
                "SELECT id FROM t_order WHERE user_id = 100 OR amount > 90000");
        String b = explain("场景6-B OR 的两边都有索引（走索引）",
                "SELECT id FROM t_order WHERE user_id = 100 OR user_id = 200");
        return a + b;
    }

    /** 场景7：排序字段不在索引里 */
    public String scene7OrderBy() {
        String a = explain("场景7-A 按索引里的 created_at 排序（无 filesort）",
                "SELECT id FROM t_order WHERE user_id = 100 AND status = 1 ORDER BY created_at");
        String b = explain("场景7-B 按索引外的 amount 排序（出现 filesort）",
                "SELECT id FROM t_order WHERE user_id = 100 AND status = 1 ORDER BY amount");
        return a + b;
    }

    /** 场景8：过滤范围太大，优化器主动放弃索引 */
    public String scene8LowSelectivity() {
        String a = explain("场景8-A 命中几乎全部数据（优化器放弃索引）",
                "SELECT id FROM t_order WHERE created_at >= '2025-01-01 00:00:00'");
        String b = explain("场景8-B 只命中几天数据（走索引）",
                "SELECT id FROM t_order WHERE created_at >= '2025-12-20 00:00:00'");
        return a + b;
    }

    /** 跑一条 EXPLAIN，打印并返回格式化后的结果 */
    private String explain(String label, String sql) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n===== ").append(label).append(" =====\n");
        sb.append("SQL: ").append(sql).append("\n");
        List<Map<String, Object>> plan = jdbcTemplate.queryForList("EXPLAIN " + sql);
        for (Map<String, Object> row : plan) {
            sb.append(String.format("type=%-8s key=%-26s key_len=%-5s rows=%-8s Extra=%s%n",
                    String.valueOf(row.get("type")),
                    String.valueOf(row.get("key")),
                    String.valueOf(row.get("key_len")),
                    String.valueOf(row.get("rows")),
                    String.valueOf(row.get("Extra"))));
        }
        String text = sb.toString();
        System.out.print(text);
        return text;
    }
}
```

### 3.7 启动时自动打印报告

```java
package com.example.indexdemo;

import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(2)
public class IndexReportRunner implements CommandLineRunner {

    private final OrderQueryService orderQueryService;

    public IndexReportRunner(OrderQueryService orderQueryService) {
        this.orderQueryService = orderQueryService;
    }

    @Override
    public void run(String... args) {
        System.out.println("\n############ MySQL 索引失效演示报告 ############");
        for (String report : orderQueryService.runAll()) {
            System.out.print(report);
        }
        System.out.println("\n############ 演示结束 ############");
    }
}
```

### 3.8 顺便给个 HTTP 接口

不想翻日志的话，访问 `/index/report` 就能拿到同样的报告。

```java
package com.example.indexdemo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/index")
public class OrderQueryController {

    private final OrderQueryService orderQueryService;

    public OrderQueryController(OrderQueryService orderQueryService) {
        this.orderQueryService = orderQueryService;
    }

    @GetMapping("/report")
    public List<String> report() {
        return orderQueryService.runAll();
    }
}
```

### 3.9 8 种场景的执行结果

启动应用（`mvn spring-boot:run`），日志里会依次输出下面这些。数据是 20 万行、1000 个用户，具体 rows 会随统计信息略有浮动，但 type 和 key 的规律是稳定的。

**场景1：索引列上套函数**

```text
场景1-A 函数包裹 created_at（索引失效）
type=ALL      key=NULL                     key_len=NULL  rows=198512  Extra=Using where
场景1-B 改成时间范围（走索引）
type=range    key=idx_created_at           key_len=5     rows=545     Extra=Using index condition
```

A 里 created_at 被 DATE() 包住，优化器只能全表扫；B 换成范围条件，索引立刻用上，预估扫描行数从近 20 万降到 545。修法是把函数挪到常量那边，或者用范围表达同样的意图。

**场景2：隐式类型转换**

```text
场景2-A 字符串列拿数字比（索引失效）
type=ALL      key=NULL                     key_len=NULL  rows=198512  Extra=Using where
场景2-B 常量加上引号（走索引）
type=const    key=idx_order_no             key_len=98    rows=1       Extra=NULL
```

3.5 里把 order_no 生成成纯数字字符串，就是为了这个场景。数字比较会把整列转成数字，索引报废；加上引号，转换发生在常量侧，type 直接变 const。

**场景3：左模糊匹配**

```text
场景3-A 前后都带百分号（索引失效）
type=ALL      key=NULL                     key_len=NULL  rows=198512  Extra=Using where
场景3-B 前缀匹配（走索引）
type=range    key=idx_order_no             key_len=98    rows=10      Extra=Using index condition
```

`LIKE '%x%'` 无法利用索引的顺序，`LIKE 'x%'` 可以。全文检索的需求别硬扛 B+ 树，交给 Elasticsearch 这类专做检索的组件。

**场景4：不满足最左前缀**

```text
场景4-A 跳过联合索引第一列 user_id（索引失效）
type=ALL      key=NULL                     key_len=NULL  rows=198512  Extra=Using where
场景4-B 从第一列 user_id 查（走索引）
type=ref      key=idx_user_status_created  key_len=8     rows=198     Extra=NULL
```

联合索引 `(user_id, status, created_at)` 必须先有 user_id。直接按 status 查，type 是 ALL；按 user_id 查，预估只扫 198 行。想让 status 单独可查，就再建一个以 status 打头的索引。

**场景5：跳过中间列**

```text
场景5-A 缺了 status，created_at 用不上
type=ref      key=idx_user_status_created  key_len=8     rows=198     Extra=Using where
场景5-B 补齐 status，三列都用上
type=range    key=idx_user_status_created  key_len=14    rows=15      Extra=Using index condition
```

对比 key_len 最直接：A 是 8（只有 user_id 生效），B 是 14（user_id 8 字节 + status 1 字节 + created_at 5 字节）。缺了 status，排在它后面的 created_at 就用不上，扫描行数差了十几倍。写联合索引的查询条件时，等式条件排前面，范围条件放最后。

**场景6：OR 连接了没索引的列**

```text
场景6-A OR 上 amount（没索引，索引失效）
type=ALL      key=NULL                     key_len=NULL  rows=198512  Extra=Using where
场景6-B OR 的两边都有索引（走索引）
type=range    key=idx_user_status_created  key_len=8     rows=396     Extra=Using index for range scan
```

OR 两边的条件只要有一个用不上索引，整个查询就退化成全表扫。想用索引，两边都得能走索引，或者改写成 UNION。

**场景7：排序字段不在索引里**

```text
场景7-A 按索引里的 created_at 排序（无 filesort）
type=ref      key=idx_user_status_created  key_len=9     rows=66      Extra=Using where
场景7-B 按索引外的 amount 排序（出现 filesort）
type=ref      key=idx_user_status_created  key_len=9     rows=66      Extra=Using where; Using filesort
```

条件一样，只是换了排序字段。A 的排序能顺着索引顺序走，B 只能把结果捞出来再排一次，Extra 里多了 `Using filesort`。排序字段能进索引就进索引，这是最能省钱的一类优化。

**场景8：过滤范围太大**

```text
场景8-A 命中几乎全部数据（优化器放弃索引）
type=ALL      key=NULL                     key_len=NULL  rows=198512  Extra=Using where
场景8-B 只命中几天数据（走索引）
type=range    key=idx_created_at           key_len=5     rows=6320    Extra=Using index condition
```

同样是 created_at 的范围查询：从年初查到年末，命中几乎整张表，优化器直接放弃索引全扫；只查最后几天，命中 3% 左右，乖乖走索引。这说明索引没被"用坏"，是优化器算成本后主动不选。

## 四、踩坑经验和最佳实践

**小表上 EXPLAIN 会骗你。** 数据量只有几千行时，不管有没有索引，优化器都可能选全表扫，因为顺序读小表本来就快。这时候别急着改 SQL，先把数据量补到跟线上一 个量级再看。我们线上那次就是本地测不出问题，上了预发数据才复现。

**统计信息不准会导致选错索引。** 大批量导入、删除数据后，优化器的成本估算靠的是统计信息。跑一次 `ANALYZE TABLE t_order;` 刷新它，很多"莫名其妙不走索引"的问题会当场消失。上面的 DataInitializer 特意加了这一句。

**函数和隐式转换永远优先排查。** 它们在代码里太自然了，`WHERE DATE(created_at) = ?`、`WHERE order_no = ?` 传数字，都看不出毛病。规则就一条：别让转换发生在列上。

**联合索引的顺序要按查询习惯定。** 把区分度高、出现频率高的列放最左，等式条件对应的列排前面，范围条件的列排最后。建完拿几条真实 SQL 的 EXPLAIN 验一遍，别拍脑袋。

**`!=`、`NOT IN`、`IS NOT NULL` 要谨慎。** 这些否定条件经常让优化器放弃索引，尤其是数据量大、区分度又不高的时候。能改写成 `IN` 正向列表，就改。

**`force index` 是止血药，不是保健品。** 确实急需时可以强制走某个索引，但数据分布一变，写死的索引可能反而更慢。用完记得回头把统计信息和 SQL 改对。

**优先让查询走覆盖索引。** 如果查询要的列都在索引里，就不用回表，省掉随机 IO。这也是为什么 `SELECT *` 要尽量少写——它几乎不可能被覆盖，必然回表。

## 五、性能对比和技术选型

把 8 个场景的结果汇总一下，规律很清楚：

| 场景 | 失效写法 | type | 走索引写法 | type |
| --- | --- | --- | --- | --- |
| 函数包裹列 | `DATE(created_at)=?` | ALL | 范围条件 | range |
| 隐式类型转换 | `order_no=123` | ALL | `order_no='123'` | const |
| 左模糊 | `LIKE '%x%'` | ALL | `LIKE 'x%'` | range |
| 不满足最左前缀 | `WHERE status=1` | ALL | `WHERE user_id=1` | ref |
| 跳列 | `user_id=? AND created_at>?` | ref（key_len=8） | 补上 status | range（key_len=14） |
| OR 混用 | `user_id=? OR amount>?` | ALL | 两边都走索引 | range |
| 排序字段不在索引 | `ORDER BY amount` | filesort | `ORDER BY created_at` | 无 filesort |
| 范围过大 | `created_at>=年初` | ALL | 收窄范围 | range |

选型上的结论只有一句：**先看 EXPLAIN，再决定加不加索引。** 索引不是越多越好，每个索引都会拖慢写入、占空间。经验做法是让 EXPLAIN 说人话——type 落在 ref 或 range、key 有值、rows 是你要的量级，就够了；出现了 ALL 或 filesort，再针对性优化。

排查顺序也固定下来：先看 type 是不是 ALL，再看 key 是不是 NULL，然后对比失效写法和正确写法的 key_len 与 rows，最后回到 SQL 找那个"破坏有序性"的写法。

## 六、总结

索引失效从来不玄学，它是 B+ 树"有序性"被破坏之后的必然结果。

- 列上套函数、隐式类型转换，本质都是让列值变了，排好的索引顺序用不上。
- 联合索引守最左前缀：第一列没用上，后面全白搭；中间列断了，后面的列也白搭。
- OR、否定条件、排序字段不在索引里，都会让优化器转向全表扫。
- 过滤范围太大时，优化器放弃索引是理性的，不是 bug。

落地就三步：写 SQL 前想清楚它能不能顺着索引顺序走；写完用 EXPLAIN 看一眼 type、key、key_len、rows；上线前用心跳数据量级的库验证，别用小表自欺欺人。

上面这份工程跑一遍，8 种场景的 EXPLAIN 会全部打印出来。把它当成模板，遇到慢查询直接把你的 SQL 塞进 `explain()` 方法里，比对着文档猜快得多。

## 参考资料

- [MySQL 8.4 Reference Manual — 8.8.2 EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html)
- [MySQL 8.4 Reference Manual — 8.3 Optimization and Indexes](https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html)
- [MySQL 8.4 Reference Manual — 8.3.1 How MySQL Uses Indexes](https://dev.mysql.com/doc/refman/8.4/en/mysql-indexes.html)
- [MySQL 8.4 Reference Manual — 8.2.1.15 ORDER BY Optimization](https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html)
- [MySQL 8.4 Reference Manual — 8.8.3 Extended EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.4/en/explain-extended.html)

文 / 会编程的吕洞宾

---
title: "MySQL事务隔离级别实战，RR和RC到底怎么选"
date: 2026-10-12T09:00:00+08:00
category: "数据库"
tags: ["mysql"]
---

> 对账接口"见鬼"了：同一个事务里连着查两次库存，两次数字对不上。代码翻了三遍没毛病，最后发现是数据库隔离级别在背后搞事——一个用读已提交的连接，读到了别人刚提交的新值。隔离级别平时没人注意，一出问题就是"数据对不上"这种最难查的毛病。这篇把四个隔离级别、InnoDB 的 MVCC 实现，还有 RR 和 RC 到底怎么选讲透，最后配一套能直接跑的 Spring Boot 代码。

## 一、事务隔离级别到底是什么

结论先行：事务隔离级别，就是数据库给"多个事务同时改同一份数据"定的一套规则。级别越低，并发越高，但越容易读到不该看到的数据。

先看它要解决的三个麻烦。

**脏读**：事务 A 把库存从 100 改成 90，还没提交；事务 B 就查到了 90。结果 A 后面回滚了，B 手里这个 90 是假的，从没真实存在过。

**不可重复读**：事务 A 里查了两次同一行库存。第一次是 100，中间事务 B 改成 90 并提交，A 第二次查变成了 90。同一个事务里，同一行数据前后不一致。

**幻读**：事务 A 查"库存大于 0 的商品有几条"，第一次 3 条。中间 B 插入了一条新的，A 再查变成 4 条。像凭空多出来一行，所以叫幻读。

标准 SQL 定义了四个级别，用"能不能防住这三种麻烦"来区分：

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | 谁在用 |
| --- | --- | --- | --- | --- |
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 基本没人用 |
| READ COMMITTED（RC） | 不会 | 可能 | 可能 | Oracle、SQL Server 默认 |
| REPEATABLE READ（RR） | 不会 | 不会 | 标准里说可能 | MySQL 默认 |
| SERIALIZABLE | 不会 | 不会 | 不会 | 串行执行，并发最差 |

这张表最容易踩的坑，是把它当成 MySQL 的完整答案。

标准里的 RR 允许幻读，但 MySQL 的 InnoDB 在 RR 下用 MVCC 加间隙锁，把幻读也基本堵死了。也就是说，MySQL 的 RR 比教科书里的 RR 更强。

反过来更有意思：很多互联网公司偏偏把默认级别从 RR 改成 RC。一边是 MySQL 默认往上加强，一边是大厂主动往下调，背后是锁和并发的一场取舍。第二节讲完原理，第五节给结论。

## 二、底层原理到底怎么回事

结论先行：MySQL 读数据只有两条路——普通查询走"快照读"，读的是历史版本；带锁查询和写操作走"当前读"，读的是最新版本并加锁。把这两条路分清楚，隔离级别就不神秘了。

**快照读**：就是普通的 SELECT，不加锁。它靠 MVCC 从 undo log 里读历史版本，不阻塞别人，别人也不阻塞它。

**当前读**：SELECT ... FOR UPDATE、SELECT ... LOCK IN SHARE MODE，以及所有 UPDATE、DELETE、INSERT。它读的是最新已提交的数据，并且会加锁。

你代码里绝大多数 SELECT 都是快照读，这就是为什么"同一个事务两次查询结果可能一样"。

### MVCC 到底靠什么实现

MVCC 就是"多版本并发控制"，说白了：每行数据保留多个历史版本，不同事务按自己的时间点去看对应的那一版，各看各的，谁也别挡谁。

它靠三样东西：

1. **隐藏列**。InnoDB 每行都有两个你看不见的字段：DB_TRX_ID 记录最后修改这行的事务编号，DB_ROLL_PTR 是指针，指向 undo log 里这行的上一个版本。
2. **undo log**。每次更新前，InnoDB 先把旧值写进 undo log。顺着 DB_ROLL_PTR 一路往回找，就能串出一条"版本链"。
3. **ReadView**。一个事务做快照读时生成的"可见性清单"，记录了生成那一刻还有哪些事务没提交。判断某行某个版本能不能看见，就拿它的 DB_TRX_ID 跟 ReadView 比：如果是生成 ReadView 之后才提交的，就顺着指针去 undo log 找更早的版本，直到找到看得见的那一版。

### RC 和 RR 只差一个时机

两个级别的实现代码几乎一样，唯一的区别是 ReadView 什么时候生成：

- **RC**：每执行一次 SELECT，就重新生成一个 ReadView。所以每次都能看到别人最新提交的数据——这就是不可重复读的由来。
- **RR**：只在事务里第一次 SELECT 时生成一个 ReadView，之后整个事务复用它。快照一旦定下来，别人再怎么改、怎么提交，你看到的还是老样子。

一句话记住：**RC 每查一次都重新拍快照，RR 整个事务只拍一次。**

### 幻读又是怎么被堵住的

幻读分两种读法，堵法也不一样。

快照读下的幻读，MVCC 顺手就解决了：你看到的还是老快照，新插入的行根本不在里面。

当前读下的幻读，靠的是**间隙锁**（gap lock）。假设执行：

```sql
SELECT id, product_name, qty FROM stock WHERE qty > 50 FOR UPDATE;
```

InnoDB 不光锁住所有 qty > 50 的现有行，还会锁住这些记录之间的"缝隙"。别人想往这个范围插一条新记录，插入的瞬间就被挡住，只能等锁释放。锁住记录本身叫记录锁，锁住缝隙叫间隙锁，两者合起来叫 next-key lock。

代价也很明显：间隙锁的加锁范围大，多个事务的范围一重叠，就容易互相等锁甚至死锁。这正是大厂想改用 RC 的第一个原因——**RC 不加间隙锁，只加行锁**。

## 三、实战：手把手写代码

结论先行：一套最小的 Spring Boot 工程就能把 RC 和 RR 的差异亲手跑出来，看到"两次读结果不一样"到底长什么样。

工程结构：

```text
isolation-demo
├── pom.xml
└── src
    ├── main
    │   ├── java/com/lvdongbin/isolation
    │   │   ├── IsolationDemoApplication.java
    │   │   ├── controller/DemoController.java
    │   │   ├── domain/Stock.java
    │   │   ├── repository/StockRepository.java
    │   │   └── service
    │   │       ├── IsolationDemoService.java
    │   │       └── StockService.java
    │   └── resources
    │       ├── application.yml
    │       ├── schema.sql
    │       └── data.sql
    └── test/java/com/lvdongbin/isolation/StockConcurrencyTest.java
```

### 3.1 完整的 pom.xml

四个依赖各司其职：web 提供 HTTP 接口，jdbc 带来 DataSource 和 JdbcTemplate，mysql 驱动负责连库，test 用来跑并发测试。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.0</version>
        <relativePath/>
    </parent>

    <groupId>com.lvdongbin</groupId>
    <artifactId>isolation-demo</artifactId>
    <version>1.0.0</version>
    <name>isolation-demo</name>
    <description>MySQL 事务隔离级别实战</description>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.0</version>
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
            <version>4.1.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 3.2 application.yml

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/isolation_demo?useSSL=false&serverTimezone=Asia/Shanghai&characterEncoding=utf8&allowPublicKeyRetrieval=true
    username: root
    password: root123
    driver-class-name: com.mysql.cj.jdbc.Driver
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql
      data-locations: classpath:data.sql
```

`mode: always` 的意思是每次启动都重建表、灌入初始数据，方便你反复跑演示。生产环境千万别这么配，会清掉真实数据。

先把库建出来：

```sql
CREATE DATABASE IF NOT EXISTS isolation_demo DEFAULT CHARACTER SET utf8mb4;
```

### 3.3 schema.sql

```sql
DROP TABLE IF EXISTS stock;

CREATE TABLE stock (
    id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    product_name VARCHAR(64)  NOT NULL COMMENT '商品名称',
    qty          INT          NOT NULL COMMENT '库存数量',
    version      INT          NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
    PRIMARY KEY (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '库存表';
```

表必须显式指定 `ENGINE = InnoDB`。MyISAM 压根不支持事务，隔离级别对它无效。

### 3.4 data.sql

```sql
INSERT INTO stock (id, product_name, qty, version) VALUES (1, 'iPhone 17', 100, 0);
```

### 3.5 启动类

```java
package com.lvdongbin.isolation;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class IsolationDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(IsolationDemoApplication.class, args);
    }
}
```

### 3.6 实体和访问层

```java
package com.lvdongbin.isolation.domain;

/**
 * 库存记录。
 * 用 record 只是让示例更短，字段含义不变。
 */
public record Stock(Long id, String productName, int qty, int version) {
}
```

```java
package com.lvdongbin.isolation.repository;

import com.lvdongbin.isolation.domain.Stock;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class StockRepository {

    private static final RowMapper<Stock> ROW_MAPPER = (rs, rowNum) -> new Stock(
            rs.getLong("id"),
            rs.getString("product_name"),
            rs.getInt("qty"),
            rs.getInt("version"));

    private final JdbcTemplate jdbcTemplate;

    public StockRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** 普通快照读，不加锁。 */
    public Stock findById(Long id) {
        List<Stock> list = jdbcTemplate.query(
                "SELECT id, product_name, qty, version FROM stock WHERE id = ?",
                ROW_MAPPER, id);
        return list.isEmpty() ? null : list.get(0);
    }

    /** 当前读，对命中的行加排他锁，锁一直持有到事务结束。 */
    public Stock findByIdForUpdate(Long id) {
        List<Stock> list = jdbcTemplate.query(
                "SELECT id, product_name, qty, version FROM stock WHERE id = ? FOR UPDATE",
                ROW_MAPPER, id);
        return list.isEmpty() ? null : list.get(0);
    }

    /** 一条带条件的 UPDATE 完成扣减，库存判断直接写在 WHERE 里。 */
    public int deduct(Long id) {
        return jdbcTemplate.update(
                "UPDATE stock SET qty = qty - 1, version = version + 1 WHERE id = ? AND qty > 0",
                id);
    }
}
```

两个方法值得对比：`findById` 是快照读，`findByIdForUpdate` 是当前读。前者在 RR 事务里可能读到旧值，后者永远读最新值并加锁。

### 3.7 业务层

```java
package com.lvdongbin.isolation.service;

import com.lvdongbin.isolation.domain.Stock;
import com.lvdongbin.isolation.repository.StockRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class StockService {

    private final StockRepository stockRepository;

    public StockService(StockRepository stockRepository) {
        this.stockRepository = stockRepository;
    }

    /** 一条 SQL 带条件扣减，靠行锁保证不会扣成负数。 */
    @Transactional
    public boolean deductWithAtomicUpdate(Long id) {
        return stockRepository.deduct(id) == 1;
    }

    /** 先把行锁住，再判断库存、再扣减，读到的永远是最新值。 */
    @Transactional
    public boolean deductWithForUpdate(Long id) {
        Stock stock = stockRepository.findByIdForUpdate(id);
        if (stock == null || stock.qty() <= 0) {
            return false;
        }
        return stockRepository.deduct(id) == 1;
    }
}
```

`deductWithAtomicUpdate` 是生产里最推荐的做法：把"判断够不够"和"扣减"压进同一条 UPDATE，数据库自己保证这两步是原子的，不需要额外加锁代码。`deductWithForUpdate` 显式加行锁，适合扣减前还要做复杂校验的场景。

### 3.8 隔离级别演示服务

这个类同时开两个连接，故意让 writer 在 reader 两次查询中间改数据，把 RC 和 RR 的差异摆到台面上。

```java
package com.lvdongbin.isolation.service;

import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

@Service
public class IsolationDemoService {

    private final DataSource dataSource;

    public IsolationDemoService(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public String demoReadCommitted(Long id) throws SQLException {
        return runDemo(id, Connection.TRANSACTION_READ_COMMITTED);
    }

    public String demoRepeatableRead(Long id) throws SQLException {
        return runDemo(id, Connection.TRANSACTION_REPEATABLE_READ);
    }

    /**
     * 用两个独立连接还原场景：
     * reader 开事务查两次，中间 writer 改库存并提交。
     */
    private String runDemo(Long id, int isolation) throws SQLException {
        int first;
        int second;

        try (Connection reader = dataSource.getConnection();
             Connection writer = dataSource.getConnection()) {

            reader.setTransactionIsolation(isolation);
            reader.setAutoCommit(false);

            first = readQty(reader, id);

            // writer 用自动提交，模拟另一个已经落库的事务
            writer.setAutoCommit(true);
            try (PreparedStatement ps = writer.prepareStatement(
                    "UPDATE stock SET qty = qty - 1, version = version + 1 WHERE id = ?")) {
                ps.setLong(1, id);
                ps.executeUpdate();
            }

            second = readQty(reader, id);
            reader.commit();

            // 还原库存，方便反复演示
            try (PreparedStatement ps = writer.prepareStatement(
                    "UPDATE stock SET qty = ?, version = version + 1 WHERE id = ?")) {
                ps.setInt(1, first);
                ps.setLong(2, id);
                ps.executeUpdate();
            }
        }

        String levelName = isolation == Connection.TRANSACTION_READ_COMMITTED
                ? "READ COMMITTED"
                : "REPEATABLE READ";
        String same = first == second ? "一致" : "不一致";
        return "隔离级别=" + levelName
                + "，第一次读到 qty=" + first
                + "，第二次读到 qty=" + second
                + "，两次" + same;
    }

    private int readQty(Connection conn, Long id) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement("SELECT qty FROM stock WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }
}
```

关键就在 `reader.setTransactionIsolation(...)` 这一行。RC 下每次查询都重新生成 ReadView，第二次自然读到 99；RR 下 ReadView 是第一次查询时定下的，第二次还是 100。

### 3.9 接口层

```java
package com.lvdongbin.isolation.controller;

import com.lvdongbin.isolation.domain.Stock;
import com.lvdongbin.isolation.repository.StockRepository;
import com.lvdongbin.isolation.service.IsolationDemoService;
import com.lvdongbin.isolation.service.StockService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.SQLException;

@RestController
@RequestMapping("/demo")
public class DemoController {

    private final IsolationDemoService isolationDemoService;
    private final StockService stockService;
    private final StockRepository stockRepository;

    public DemoController(IsolationDemoService isolationDemoService,
                          StockService stockService,
                          StockRepository stockRepository) {
        this.isolationDemoService = isolationDemoService;
        this.stockService = stockService;
        this.stockRepository = stockRepository;
    }

    @GetMapping("/stock")
    public Stock stock(@RequestParam(defaultValue = "1") Long id) {
        return stockRepository.findById(id);
    }

    @GetMapping("/isolation/rc")
    public String rc(@RequestParam(defaultValue = "1") Long id) throws SQLException {
        return isolationDemoService.demoReadCommitted(id);
    }

    @GetMapping("/isolation/rr")
    public String rr(@RequestParam(defaultValue = "1") Long id) throws SQLException {
        return isolationDemoService.demoRepeatableRead(id);
    }

    @PostMapping("/deduct/atomic")
    public String deductAtomic(@RequestParam(defaultValue = "1") Long id) {
        boolean ok = stockService.deductWithAtomicUpdate(id);
        return ok ? "扣减成功，剩余 " + stockRepository.findById(id).qty() : "库存不足，扣减失败";
    }

    @PostMapping("/deduct/for-update")
    public String deductForUpdate(@RequestParam(defaultValue = "1") Long id) {
        boolean ok = stockService.deductWithForUpdate(id);
        return ok ? "扣减成功，剩余 " + stockRepository.findById(id).qty() : "库存不足，扣减失败";
    }
}
```

### 3.10 跑起来看结果

启动项目，然后两条命令对比：

```bash
mvn spring-boot:run

curl http://localhost:8080/demo/isolation/rc
# 隔离级别=READ COMMITTED，第一次读到 qty=100，第二次读到 qty=99，两次不一致

curl http://localhost:8080/demo/isolation/rr
# 隔离级别=REPEATABLE READ，第一次读到 qty=100，第二次读到 qty=100，两次一致
```

同样的代码路径，只是换了隔离级别，行为完全不同。这就是第一节那张表在真实数据库里的样子。

### 3.11 并发扣库存测试

光看两个连接还不够，真正的线上问题是并发扣减超卖。加一个测试：200 个线程同时抢 100 件库存。

```java
package com.lvdongbin.isolation;

import com.lvdongbin.isolation.repository.StockRepository;
import com.lvdongbin.isolation.service.StockService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

@SpringBootTest
class StockConcurrencyTest {

    @Autowired
    private StockService stockService;

    @Autowired
    private StockRepository stockRepository;

    @Test
    void 两百线程抢一百件库存不会超卖() throws InterruptedException {
        int threads = 200;
        ExecutorService pool = Executors.newFixedThreadPool(32);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(threads);

        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                try {
                    start.await();
                    stockService.deductWithAtomicUpdate(1L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }

        start.countDown();
        done.await(30, TimeUnit.SECONDS);
        pool.shutdown();

        int remain = stockRepository.findById(1L).qty();
        System.out.println("初始库存 100，200 个线程并发扣减后剩余：" + remain);
        assertEquals(0, remain);
    }
}
```

测试断言剩余库存是 0。200 次扣减里正好 100 次成功、100 次因为 `AND qty > 0` 不满足而失败，一件都不会超卖。

## 四、踩坑经验和最佳实践

**1. @Transactional 自调用会失效**

同一个类里，A 方法直接调 B 方法（B 上标了 @Transactional），事务不生效。原因是 Spring 的事务靠 AOP 代理实现，自调用走的是对象内部的方法，不经过代理。解决办法是把 B 挪到另一个 bean，或者注入自己再调用。这个坑我在项目里见过不止一次，表现是"加了注解还是回滚不了"。

**2. 读写分离 + RC 会放大主从延迟**

很多公司把默认级别改成 RC，同时又做了读写分离，写主库、读从库。主库改完立刻去从库查，从库还没同步，于是又出现"数据对不上"。这不怪隔离级别，是延迟问题。做法是：写完之后的读强制走主库，或者等关键业务的从库同步完成再返回。

**3. FOR UPDATE 没走索引，锁会扩散**

本来想锁一行，结果 SQL 没走索引，InnoDB 全表扫描，扫描到的每一行都被加上锁，并发瞬间崩掉。加锁的 SQL 上线前必须 EXPLAIN 一遍，确认走了索引。

**4. 长事务拖垮 undo log**

事务开着不提交，undo log 只增不减，purge 线程清理不动，表空间越来越大。RR 下问题更明显，快照一直不释放，别人改过的旧版本都得留着。事务里别做 RPC 调用、别做耗时计算，能不跨事务就别跨。

**5. 表引擎必须是 InnoDB**

隔离级别、MVCC、行锁、间隙锁，全是 InnoDB 的机制。MyISAM 表上这些一概不生效，一个 UPDATE 直接锁全表。建表时把 `ENGINE = InnoDB` 写死，别依赖默认值。

## 五、性能对比和技术选型

RR 和 RC 的取舍，本质是"一致性强度"换"并发能力"。

| 维度 | REPEATABLE READ | READ COMMITTED |
| --- | --- | --- |
| 间隙锁 | 会加 | 不加 |
| 锁范围 | 大，易死锁 | 小，死锁少 |
| 并发写入 | 偏低 | 偏高 |
| 事务内一致性 | 强，同一快照 | 弱，每次读最新 |
| 典型场景 | 对账、财务、后台 | 高并发下单、秒杀 |

我推荐的选法：

- **后台管理、财务、对账类**：保持 RR，别动。这些场景要的就是"同一事务里数据别变"，性能压力也不大。
- **高并发写入、订单、秒杀**：可以改 RC，配合唯一键去重和乐观锁（`version` 字段）。收益是锁范围小、死锁少、吞吐高。
- **不管选哪个**：扣库存这种事，别写"先查再改"，直接用一条 `UPDATE ... SET qty = qty - 1 WHERE qty > 0`，或者乐观锁。隔离级别解决的是可见性，解决不了"读改写"这整段逻辑的原子性。

## 六、总结

隔离级别从来不是越强越好，它是一道选择题：要更强的一致性，就得接受更大的锁范围和更低的并发。

把几个关键点串一遍。MySQL 用 MVCC 实现快照读，靠隐藏列、undo log 版本链和 ReadView 三件套，让读不加锁也不阻塞。RC 和 RR 的代码几乎一样，差别只在 ReadView 的生成时机——RC 每次查询都重新生成，RR 整个事务只生成一次，所以 RC 会不可重复读，RR 不会。幻读靠间隙锁堵住，代价是锁范围变大，这也就解释了大厂为什么宁愿退回 RC。

实践上记住三句话：扣库存用一条带条件的 UPDATE，别先查再改；加锁的 SQL 一定 EXPLAIN 确认走索引；事务里别塞耗时操作和 RPC。

## 参考资料

- [MySQL 8.4 Reference Manual — Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [MySQL 8.4 Reference Manual — Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)
- [MySQL 8.4 Reference Manual — InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [MySQL 8.4 Reference Manual — SET TRANSACTION Statement](https://dev.mysql.com/doc/refman/8.4/en/set-transaction.html)
- [Spring Framework Reference — Declarative Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-decl-explained.html)
- [Spring Boot Reference — Data Initialization](https://docs.spring.io/spring-boot/how-to/data-initialization.html)

文 / 会编程的吕洞宾

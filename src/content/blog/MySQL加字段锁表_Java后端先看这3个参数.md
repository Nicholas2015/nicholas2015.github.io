---
title: MySQL加字段锁表_Java后端先看这3个参数
date: 2026-11-22 14:16:14
tags: ["Java", "MySQL", "Spring Boot"]
categories: java
---

# MySQL加字段锁表_Java后端先看这3个参数

晚上十点给订单表加个 remark 字段，SQL 敲下去十几分钟没动静。客服群炸了：订单列表全部转圈，接口超时，CPU 却不高。原来一条报表事务跑了四十分钟没提交，ALTER 在等它的元数据锁，所有订单查询又排在 ALTER 后面。加字段锁表不是 MySQL 抽风，是锁的排队规则在起作用。这篇把 MDL、三种 DDL 算法和一套能复现的 Spring Boot 代码讲清楚，告诉你该盯的三个参数。

## 一、加字段为什么会把整张表锁死

加字段锁表，锁的不是数据行，而是表的「元数据锁」。英文叫 Metadata Lock，简称 MDL。它挡的是表结构变更，不是某一行记录。

可以把它想成一张表的使用证。每个连接要读写这张表，先去门口领一张共享证，大家都能领。ALTER TABLE 要改表结构，得领独占证，同一时刻只能有一张，而且必须等所有共享证都还回来。

问题就出在还证的条件上：共享证不是语句执行完就还，而是要等整个事务结束才还。一个事务里执行了 `SELECT * FROM orders WHERE id = 1`，哪怕这条查询一毫秒就返回了，只要事务没提交，这张共享证就一直攥在手里。

于是场景变成这样：

1. 报表服务开了一个事务，读了一次 orders，然后慢慢算数据，四十分钟没提交。
2. DBA 执行 `ALTER TABLE orders ADD COLUMN remark VARCHAR(64)`，申请独占证，排在那张共享证后面。
3. 新的订单查询来领共享证，发现前面有个独占证在排队，不能再插队，只能跟着排。
4. 订单接口全部卡住，连接池被占满，上游开始超时重试，流量越堆越多。

这就是「加个字段把整张表锁死」的完整链条。数据库 CPU 不高，磁盘也不忙，因为大家根本没在干活，都在等锁。

### 默认等锁时间是一年

更坑的是默认值。MySQL 的 `lock_wait_timeout` 控制等元数据锁的时间，默认 31536000 秒，整整一年。也就是说，如果没有人为设置，ALTER 会安安静静地等下去，同时把后面所有查询堵在门口。

所以排查这类问题时，先别盯着 CPU 和慢查询日志。去 `SHOW PROCESSLIST` 里看状态，看到大量 `Waiting for table metadata lock`，基本就对上号了。

### Online DDL 不等于不锁表

有些文章说用 `ALGORITHM=INPLACE` 就是「在线 DDL」，不影响业务。这句话只对了一半。

Online 指的是改表结构的过程中，允许并发读写数据，不用把整张表锁住几小时。但在 DDL 开始和结束的两个瞬间，它仍然要拿独占元数据锁。拿不到，它就一直等；它一等，后面的查询就全排队。

换句话说，Online DDL 解决的是「拷贝数据期间能不能写入」，解决不了「前面有长事务占着表」的问题。这两件事经常被混为一谈，也是线上翻车的重灾区。

## 二、MDL 和三种 DDL 算法的底层逻辑

MDL 在 MySQL 的 Server 层，不在 InnoDB 引擎里。这个位置很关键：哪怕你用的是 Memory 引擎，或者表里一行数据都没有，改表结构照样要过 MDL 这一关。

### 一条 SQL 从进门到拿证

一条语句的执行顺序，简化后是这样：

1. 连接器接收 SQL。
2. 解析器做语法分析。
3. 执行器向 Server 层申请这张表的 MDL。
4. 拿到锁后，再调用 InnoDB 去读或写数据。
5. 事务提交或回滚时，释放 MDL。

第 3 步发生在引擎之前，所以 InnoDB 的行锁、间隙锁跟它是两套东西。行锁冲突看 `innodb_lock_wait_timeout`，MDL 冲突看 `lock_wait_timeout`，别搞混。

MDL 还分类型。普通查询拿 `SHARED_READ`，插入更新拿 `SHARED_WRITE`，ALTER 要 `EXCLUSIVE`。共享锁之间不冲突，共享和独占冲突，独占和独占也冲突。

线上排查时，别只查 `performance_schema`，MySQL 自带的 `sys.schema_table_lock_waits` 更省事。它把「谁在等」和「谁卡着」配好对，一条 SQL 就能找到源头线程：

```sql
SELECT waiting_pid,
       waiting_query,
       blocking_pid,
       blocking_query
FROM sys.schema_table_lock_waits;
```

`blocking_pid` 对应的就是那个攥着表不放的连接。拿到它，再去 `information_schema.innodb_trx` 里看这个连接在跑什么，基本就破案了。

### 三种 DDL 算法，差别在要不要碰数据

MySQL 执行 ALTER 时，底层有三种算法，用 `ALGORITHM` 参数指定。

**COPY**：建一张临时表，把原表数据一行行拷过去，拷完再改名替换。整个过程原表不能写入。这是最老的办法，也最慢，只有在其他算法不支持时才用。

**INPLACE**：在原表上直接改，不建临时表。改的过程中产生的并发写入，先记到一块 online log 里，改完再补回去。所以它可以做到 `LOCK=NONE`，允许并发读写。加索引、改列类型通常走这条路。改列类型会重建表数据，耗时跟行数成正比；加二级索引只建索引，不重建整张表。

**INSTANT**：只改数据字典，不碰任何一行数据。MySQL 8.0.12 开始支持在表尾加列，8.0.29 开始支持在任意位置加列和删列。加一个普通字段是毫秒级操作，跟表里有一万行还是一亿行没关系。

重点来了：三种算法都要拿独占 MDL。INSTANT 省掉的是拷贝表的时间，不是等锁的时间。前面有长事务，INSTANT 照样得排队。

### LOCK 参数管的是并发写入

`LOCK` 参数控制 DDL 执行期间，业务能不能读写：

- `LOCK=NONE`：允许并发读和写，要求最高，不支持就直接报错。
- `LOCK=SHARED`：允许并发读，不允许写。
- `LOCK=EXCLUSIVE`：读写都禁止。

显式写 `LOCK=NONE` 有个好处：如果当前操作做不到无锁并发，MySQL 会立刻报错，而不是悄悄降级成锁表。错误码通常是 1845 或 1846，看到这两个数字，说明你选的算法撑不住这个操作。

### 为什么后来的查询不能插队

MDL 的排队规则优先保证写锁不被饿死。一个独占锁在等的时候，新来的共享锁不能绕过它先拿证。

这条规则本身合理，不然一个大查询接一个大查询，ALTER 永远排不上。但副作用就是：只要 ALTER 在等，整张表的新查询全部停摆。

所以事故现场往往不是「DDL 很慢」，而是「DDL 在等一个根本不知道什么时候结束的事务」。DDL 本身可能只要几毫秒。

## 三、实战：用 Spring Boot 复现一次加字段锁表

这一节搭一个能跑的最小服务，把上面的链条完整复现一遍。你需要 JDK 21、Maven、一个 MySQL 8.0.29 以上版本的实例。

项目一共七个文件：`pom.xml`、`application.yml`、`schema.sql`、启动类、线程池配置、服务类和控制器。全部贴全，复制就能跑。

目录结构长这样，Java 类都放在 `com.example.ddldemo` 包下：

```text
online-ddl-demo
├── pom.xml
└── src
    └── main
        ├── java/com/example/ddldemo
        │   ├── DdlDemoApplication.java
        │   ├── AsyncConfig.java
        │   ├── DdlService.java
        │   └── OrderAdminController.java
        └── resources
            ├── application.yml
            └── schema.sql
```

### 3.1 先建库

```sql
CREATE DATABASE IF NOT EXISTS ddl_demo
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;
```

### 3.2 pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>online-ddl-demo</artifactId>
    <version>1.0.0</version>
    <name>online-ddl-demo</name>
    <description>Reproduce MySQL metadata lock during ALTER TABLE</description>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.10.0</version>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.2.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.2.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 3.3 application.yml

数据库地址、账号密码改成你自己的。`rewriteBatchedStatements=true` 是给批量插入用的，不加的话两万行数据能插到天荒地老。

```yaml
server:
  port: 8080

spring:
  application:
    name: online-ddl-demo
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/ddl_demo?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai&characterEncoding=utf8&rewriteBatchedStatements=true
    username: root
    password: root
    hikari:
      pool-name: ddl-demo-pool
      maximum-pool-size: 10
      minimum-idle: 2
      connection-timeout: 10000
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql

logging:
  level:
    org.springframework.jdbc.core: INFO
```

### 3.4 schema.sql

表里故意不放 `remark` 字段，留给 DDL 接口来加。

```sql
CREATE TABLE IF NOT EXISTS orders (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    order_no    VARCHAR(32)  NOT NULL,
    user_id     BIGINT       NOT NULL,
    amount      DECIMAL(10, 2) NOT NULL,
    status      TINYINT      NOT NULL DEFAULT 0,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_user_created (user_id, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
```

### 3.5 启动类

```java
package com.example.ddldemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DdlDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DdlDemoApplication.class, args);
    }
}
```

### 3.6 线程池配置

长事务要在一个独立线程里挂着，不然接口请求会一直不返回，没法继续做实验。

```java
package com.example.ddldemo;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

@Configuration
public class AsyncConfig {

    @Bean(destroyMethod = "shutdown")
    public ExecutorService ddlDemoExecutor() {
        AtomicInteger counter = new AtomicInteger(1);
        return Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "ddl-demo-" + counter.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        });
    }
}
```

### 3.7 核心服务类

这个类干了四件事：批量造数据、开一个挂住的长事务、执行带超时设置的 ALTER、查询当前的元数据锁。

```java
package com.example.ddldemo;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

@Service
public class DdlService {

    private static final Set<String> SUPPORTED_ALGORITHMS = Set.of("INSTANT", "INPLACE", "COPY");

    private final JdbcTemplate jdbcTemplate;
    private final TransactionTemplate transactionTemplate;
    private final ExecutorService executorService;

    public DdlService(JdbcTemplate jdbcTemplate,
                      TransactionTemplate transactionTemplate,
                      ExecutorService ddlDemoExecutor) {
        this.jdbcTemplate = jdbcTemplate;
        this.transactionTemplate = transactionTemplate;
        this.executorService = ddlDemoExecutor;
    }

    public Map<String, Object> seedOrders(int rows) {
        if (rows < 1 || rows > 1_000_000) {
            throw new IllegalArgumentException("rows 必须在 1 到 1000000 之间");
        }
        long existing = countOrders();
        if (existing > 0) {
            Map<String, Object> skipped = new LinkedHashMap<>();
            skipped.put("inserted", 0);
            skipped.put("totalRows", existing);
            skipped.put("hint", "表里已有数据，跳过初始化");
            return skipped;
        }

        int batchSize = 1000;
        long begin = System.nanoTime();
        for (int offset = 0; offset < rows; offset += batchSize) {
            int current = Math.min(batchSize, rows - offset);
            List<Object[]> batch = new ArrayList<>(current);
            for (int i = 0; i < current; i++) {
                int seq = offset + i + 1;
                batch.add(new Object[]{
                        "ORD" + String.format("%010d", seq),
                        (long) (seq % 50_000),
                        BigDecimal.valueOf(10 + (seq % 990)).setScale(2),
                        seq % 5
                });
            }
            jdbcTemplate.batchUpdate(
                    "INSERT INTO orders (order_no, user_id, amount, status) VALUES (?, ?, ?, ?)",
                    batch);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("inserted", rows);
        result.put("totalRows", countOrders());
        result.put("elapsedMs", (System.nanoTime() - begin) / 1_000_000);
        return result;
    }

    public long countOrders() {
        Long count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM orders", Long.class);
        return count == null ? 0L : count;
    }

    public Map<String, Object> startLongTransaction(int seconds) {
        if (seconds < 1 || seconds > 120) {
            throw new IllegalArgumentException("seconds 必须在 1 到 120 之间");
        }

        CountDownLatch started = new CountDownLatch(1);
        executorService.submit(() -> {
            try {
                transactionTemplate.executeWithoutResult(status -> {
                    jdbcTemplate.queryForObject("SELECT COUNT(*) FROM orders", Long.class);
                    started.countDown();
                    sleepSeconds(seconds);
                });
            } catch (RuntimeException exception) {
                started.countDown();
            }
        });

        try {
            if (!started.await(3, TimeUnit.SECONDS)) {
                throw new IllegalStateException("长事务没能在 3 秒内启动，检查数据库连接");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("等待长事务启动时被中断", exception);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("started", true);
        result.put("holdSeconds", seconds);
        result.put("hint", "现在查 /api/orders/locks，应该能看到 lockType=SHARED_READ");
        return result;
    }

    public Map<String, Object> addRemarkColumn(int lockWaitSeconds, String algorithm) {
        if (lockWaitSeconds < 1 || lockWaitSeconds > 60) {
            throw new IllegalArgumentException("lockWaitSeconds 必须在 1 到 60 之间");
        }
        String normalized = algorithm.toUpperCase(Locale.ROOT);
        if (!SUPPORTED_ALGORITHMS.contains(normalized)) {
            throw new IllegalArgumentException("algorithm 只能是 INSTANT、INPLACE 或 COPY");
        }

        Integer columnCount = jdbcTemplate.queryForObject("""
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'orders'
                  AND column_name = 'remark'
                """, Integer.class);
        if (columnCount != null && columnCount > 0) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("algorithm", normalized);
            result.put("elapsedMs", 0L);
            result.put("message", "remark 字段已经存在，不需要重复添加");
            return result;
        }

        long begin = System.nanoTime();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("algorithm", normalized);
        result.put("lockWaitSeconds", lockWaitSeconds);

        try {
            jdbcTemplate.execute((ConnectionCallback<Void>) connection -> {
                int originalTimeout = readLockWaitTimeout(connection);
                try (Statement statement = connection.createStatement()) {
                    statement.execute("SET SESSION lock_wait_timeout = " + lockWaitSeconds);
                    statement.execute("ALTER TABLE orders ADD COLUMN remark VARCHAR(64) NULL, ALGORITHM=" + normalized);
                } finally {
                    try (Statement restore = connection.createStatement()) {
                        restore.execute("SET SESSION lock_wait_timeout = " + originalTimeout);
                    }
                }
                return null;
            });
            result.put("success", true);
            result.put("elapsedMs", (System.nanoTime() - begin) / 1_000_000);
            result.put("message", "字段添加成功");
        } catch (DataAccessException exception) {
            SQLException sqlException = findSqlException(exception);
            result.put("success", false);
            result.put("elapsedMs", (System.nanoTime() - begin) / 1_000_000);
            result.put("errorCode", sqlException == null ? -1 : sqlException.getErrorCode());
            result.put("message", friendlyMessage(sqlException));
        }
        return result;
    }

    public List<Map<String, Object>> currentMetadataLocks() {
        String sql = """
                SELECT ml.thread_id        AS threadId,
                       ml.lock_type        AS lockType,
                       ml.lock_status      AS lockStatus,
                       ml.lock_duration    AS lockDuration,
                       t.processlist_time  AS secondsInState,
                       t.processlist_state AS state,
                       t.processlist_info  AS sqlText
                FROM performance_schema.metadata_locks ml
                JOIN performance_schema.threads t ON t.thread_id = ml.thread_id
                WHERE ml.object_schema = DATABASE()
                  AND ml.object_name = 'orders'
                ORDER BY ml.thread_id
                """;
        return jdbcTemplate.query(sql, (resultSet, rowNumber) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("threadId", resultSet.getLong("threadId"));
            row.put("lockType", resultSet.getString("lockType"));
            row.put("lockStatus", resultSet.getString("lockStatus"));
            row.put("lockDuration", resultSet.getString("lockDuration"));
            row.put("secondsInState", resultSet.getObject("secondsInState"));
            row.put("state", resultSet.getString("state"));
            row.put("statement", resultSet.getString("sqlText"));
            return row;
        });
    }

    private int readLockWaitTimeout(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet resultSet = statement.executeQuery("SELECT @@SESSION.lock_wait_timeout")) {
            resultSet.next();
            return resultSet.getInt(1);
        }
    }

    private String friendlyMessage(SQLException exception) {
        if (exception == null) {
            return "未知数据库错误，查看应用日志里的堆栈";
        }
        return switch (exception.getErrorCode()) {
            case 1205 -> "等锁超时：orders 表上有长事务占着元数据锁。先提交或杀掉那个事务，再重试 DDL。";
            case 1213 -> "死锁：DDL 和别的事务互相等待，数据库已经回滚了其中一个，稍后重试。";
            case 1060 -> "remark 字段已经存在，不用重复添加。";
            case 1845, 1846 -> "当前表结构不支持这个算法，换 INPLACE 或 COPY 再试。";
            default -> exception.getMessage();
        };
    }

    private SQLException findSqlException(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof SQLException sqlException) {
                return sqlException;
            }
            current = current.getCause();
        }
        return null;
    }

    private void sleepSeconds(int seconds) {
        try {
            Thread.sleep(Duration.ofSeconds(seconds));
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
    }
}
```

### 3.8 控制器

```java
package com.example.ddldemo;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderAdminController {

    private final DdlService ddlService;

    public OrderAdminController(DdlService ddlService) {
        this.ddlService = ddlService;
    }

    @PostMapping("/seed")
    public Map<String, Object> seed(@RequestParam(defaultValue = "200000") int rows) {
        return ddlService.seedOrders(rows);
    }

    @GetMapping("/count")
    public Map<String, Object> count() {
        return Map.of("rows", ddlService.countOrders());
    }

    @PostMapping("/long-transaction")
    public Map<String, Object> longTransaction(@RequestParam(defaultValue = "30") int seconds) {
        return ddlService.startLongTransaction(seconds);
    }

    @PostMapping("/add-remark")
    public Map<String, Object> addRemark(
            @RequestParam(defaultValue = "3") int lockWaitSeconds,
            @RequestParam(defaultValue = "INSTANT") String algorithm) {
        return ddlService.addRemarkColumn(lockWaitSeconds, algorithm);
    }

    @GetMapping("/locks")
    public List<Map<String, Object>> locks() {
        return ddlService.currentMetadataLocks();
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, Object> handleBadRequest(IllegalArgumentException exception) {
        return Map.of("error", exception.getMessage());
    }
}
```

### 3.9 跑一遍，看锁怎么来的

启动应用：

```bash
mvn spring-boot:run
```

第一步，造二十万行数据。二十万行不多，但足够让 INPLACE 和 INSTANT 的耗时差距肉眼可见。

```bash
curl -X POST 'http://localhost:8080/api/orders/seed?rows=200000'
```

第二步，确认行数：

```bash
curl 'http://localhost:8080/api/orders/count'
```

第三步，开一个挂三十秒的长事务。这个接口会等事务真正开始才返回：

```bash
curl -X POST 'http://localhost:8080/api/orders/long-transaction?seconds=30'
```

第四步，查元数据锁。你会看到一条 `SHARED_READ`，`lockDuration` 是 `TRANSACTION`，`state` 是 `Sleep` 或者 `User sleep`：

```bash
curl 'http://localhost:8080/api/orders/locks'
```

第五步，趁长事务还没结束，执行加字段。这里把等锁时间设成 3 秒：

```bash
curl -X POST 'http://localhost:8080/api/orders/add-remark?lockWaitSeconds=3&algorithm=INSTANT'
```

返回结果大概长这样：

```json
{
  "algorithm": "INSTANT",
  "lockWaitSeconds": 3,
  "success": false,
  "elapsedMs": 3002,
  "errorCode": 1205,
  "message": "等锁超时：orders 表上有长事务占着元数据锁。先提交或杀掉那个事务，再重试 DDL。"
}
```

注意，这里用的是 `INSTANT`。它不需要拷贝一行数据，但照样卡了三秒，因为等的是 MDL。这就是前面那句话的实证：INSTANT 省的是拷表时间，不是等锁时间。

第六步，长事务结束后再执行一次：

```bash
curl -X POST 'http://localhost:8080/api/orders/add-remark?lockWaitSeconds=3&algorithm=INSTANT'
```

这次会返回 `"success": true`，耗时通常只有几毫秒。再用 `SHOW CREATE TABLE orders;` 看一眼，`remark` 已经在表里了。

### 3.10 把「后面的查询也堵住」演出来

想看得更直观，开两个终端。终端 A 把长事务设成 60 秒，DDL 的等锁时间也设成 60 秒：

```bash
curl -X POST 'http://localhost:8080/api/orders/long-transaction?seconds=60'
curl -X POST 'http://localhost:8080/api/orders/add-remark?lockWaitSeconds=60&algorithm=INSTANT'
```

终端 B 在 A 的 ALTER 开始等待之后，请求行数接口：

```bash
curl -m 5 'http://localhost:8080/api/orders/count'
```

那条 `count` 会超时，因为它排在 DDL 后面等 MDL。此时去看 `SHOW PROCESSLIST`，会看到 `Waiting for table metadata lock` 一排排挂着。业务侧的体感就是接口全挂，而数据库指标一切正常。

实验做完，记得把长事务等完，或者直接重启应用释放连接。想重来一遍，执行 `DROP TABLE orders;` 再启动即可。

## 四、踩坑经验和最佳实践

### 坑一：挑低峰期就安全

低峰期只能降低「正常请求」的并发，降不了长事务。报表、定时任务、消息消费、后台导出，这些东西偏偏喜欢在凌晨跑，而且经常包在一个大事务里。

执行前先查有没有长事务：

```sql
SELECT trx_id,
       trx_state,
       trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS seconds_alive,
       trx_mysql_thread_id,
       trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started
LIMIT 20;
```

有跑了几分钟的，先找业务方确认，别直接杀。`KILL` 一个正在写数据的事务，回滚可能比执行还久。

### 坑二：写了 LOCK=NONE 就以为不锁表

`LOCK=NONE` 的意思是「DDL 执行期间允许并发读写」，不是「不需要元数据锁」。DDL 开始和结束那两个瞬间，独占 MDL 一分不少。

真正的价值在于：做不到的时候它会报错。你显式写 `LOCK=NONE`，MySQL 不会偷偷降级成锁表模式，问题在预发环境就能暴露。

### 坑三：不设 lock_wait_timeout

默认一年，等于没有超时。DDL 一旦排在有长事务的后面，就会无限期等，同时把整张表的新查询全部堵死。

执行 DDL 前，在当前会话里设一个短超时，比如 5 秒：

```sql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE orders ADD COLUMN remark VARCHAR(64) NULL, ALGORITHM=INSTANT;
```

拿不到锁就快速失败，让重试逻辑过一会儿再来，比一直挂着强一百倍。

### 坑四：以为慢查询日志能查到

MDL 等待不是慢查询。SQL 还没开始执行，卡在拿锁阶段，慢查询日志里可能什么都没有。

要看两个地方：

- `SHOW PROCESSLIST` 里的 `State`，找 `Waiting for table metadata lock`。
- `performance_schema.metadata_locks`，看谁拿着锁、谁在等锁。

### 坑五：大表直接上原生 DDL

百万行以内，原生 Online DDL 够用。上了千万行，尤其是核心交易表，建议用 `pt-online-schema-change` 或 `gh-ost`。

这两个工具的思路都是影子表：建一张新表，慢慢把数据拷过去，同时同步增量变更，收尾用一次短暂的 rename 切换。整个过程业务无感，代价是需要额外磁盘空间，以及更长的总耗时。

工具不是免死金牌。收尾那下 rename 也要拿 MDL，同样会被长事务挡住。所以查长事务这一步，什么时候都省不了。

### 一套能落地的操作顺序

1. 查 `information_schema.innodb_trx`，确认没有超过阈值的长事务。
2. 评估操作能不能用 `ALGORITHM=INSTANT`，能就用，别犹豫。
3. 不能用 INSTANT，再评估 INPLACE + `LOCK=NONE` 是否支持。
4. 千万行以上，直接上 gh-ost 或 pt-osc，别赌。
5. 会话里设 `lock_wait_timeout`，建议 5 到 10 秒。
6. DDL 失败就重试，重试间隔拉长，别在同一个时间点反复撞。
7. 执行完看主从延迟，确认从库也完成了变更。

## 五、INSTANT、INPLACE、COPY 怎么选

三种算法的核心差异，一张表能说清：

| 算法 | 是否重建表 | 并发 DML | 额外磁盘 | 耗时 | 典型场景 |
| --- | --- | --- | --- | --- | --- |
| INSTANT | 否 | 允许 | 几乎为零 | 毫秒级，与行数无关 | 加普通列（8.0.12 起）、任意位置加列或删列（8.0.29 起） |
| INPLACE | 改列类型会，建索引不会 | 允许（LOCK=NONE） | 视操作而定 | 随行数线性增长 | 加索引、改列类型、改字符集 |
| COPY | 是 | 不允许 | 需要 | 最慢 | 不支持 INPLACE 的冷门变更 |

选型顺序很固定：先看能不能 INSTANT，再看能不能 INPLACE + LOCK=NONE，都不行才考虑 COPY 或者外部工具。

INSTANT 也有边界。表用了 `ROW_FORMAT=COMPRESSED`、带 FULLTEXT 索引、或者加完列会超过行长度上限，都会直接报错。遇到这些限制，老老实实退回 INPLACE。

原生 DDL 和外部工具的取舍：

- **原生 Online DDL**：不用装东西，一条 SQL 搞定，适合中小表。缺点是执行期间仍然占着 MDL，长事务一来就卡。
- **pt-online-schema-change**：用触发器同步增量，兼容 MySQL 8.x，生态成熟。触发器有额外开销，高写入表要压测。
- **gh-ost**：读 binlog 同步，不建触发器，支持暂停和限流，对主库压力更小。部署和权限配置比 pt-osc 麻烦。

我的建议很直接：百万行以下用原生，千万行以上用 gh-ost，中间地带看团队熟悉哪个。别自己写脚本拷表，坑比省下的时间多。

## 六、总结

加字段锁表这件事，本质是元数据锁排队，不是数据量太大。

记住三件事就够了：

- **先查长事务**。`information_schema.innodb_trx` 里跑了几分钟还没提交的，才是真正的元凶。
- **能 INSTANT 就 INSTANT**。它不碰数据，但别指望它跳过等锁。
- **一定要设 lock_wait_timeout**。默认一年，等于把整张表交给一个不知道何时结束的事务。

DDL 本身不可怕。可怕的是你敲下 ALTER 的那一刻，不知道还有谁攥着那张表的使用证。

## 参考资料

- [MySQL 8.4 Reference Manual — Online DDL Operations](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)
- [MySQL 8.4 Reference Manual — Metadata Locking](https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html)
- [MySQL 8.4 Reference Manual — Online DDL Performance and Concurrency](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-performance.html)
- [MySQL 8.4 Reference Manual — Server System Variables: lock_wait_timeout](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_lock_wait_timeout)

文 / 会编程的吕洞宾

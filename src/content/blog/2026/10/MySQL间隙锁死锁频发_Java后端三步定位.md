---
title: "MySQL间隙锁死锁频发：Java后端三步定位"
date: 2026-10-23T09:00:00+08:00
category: "数据库"
tags: ["mysql"]
---

> 库存表按仓库批量扣减，线上突然开始零星报 `Deadlock found when trying to get lock; try restarting transaction`。翻业务代码，两个事务改的根本不是同一批数据：一个动仓库 10，一个动仓库 20，八竿子打不着，怎么就互相锁死了？更邪门的是本地压测死活复现不了，只有大促流量上来才冒头。问题不在你的 SQL 写得烂，而在 InnoDB 的间隙锁——它锁的不是某一行，而是行与行之间的"空地"。这篇讲清楚间隙锁怎么来的、死锁日志怎么读、代码怎么改。

## 一、这个问题到底是什么

先给结论：MySQL 间隙锁死锁的本质，是两个事务各自持有了对方想插入位置的间隙锁，形成环形等待，InnoDB 检测到环路后强制回滚其中一个。

要理解这句话，得先接受一个反直觉的事实：**InnoDB 锁的粒度不只有"行"，还有"行与行之间的空隙"**。

把索引想成一排按编号排好的人。记录锁锁的是某个人，间隙锁锁的是两个人之间的站位——这个位置不许再塞人进来。你锁了第 10 号和第 20 号之间的空地，别人想往中间插一个新号，就得等你放手。

为什么要有这么个东西？因为可重复读（RR）隔离级别下，MySQL 要防幻读。幻读的意思是：同一个事务里查两次，第二次凭空多出来几行。多出来的行只能是别人插进去的，所以想杜绝幻读，就得提前把"可能插入的位置"也锁住。间隙锁就是干这个的。

看一张真实的库存表：

```sql
CREATE TABLE `stock` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `sku_code` varchar(64) NOT NULL,
  `warehouse_id` bigint NOT NULL,
  `quantity` int NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sku_warehouse` (`sku_code`,`warehouse_id`),
  KEY `idx_warehouse` (`warehouse_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

表里只有两条数据，仓库 10 一条，仓库 30 一条，**仓库 20 是空的**。这个"空"很关键。

现在两个事务交叉执行：

| 时刻 | 事务 A | 事务 B |
| --- | --- | --- |
| T1 | `SELECT ... WHERE warehouse_id = 10 FOR UPDATE` | |
| T2 | | `SELECT ... WHERE warehouse_id = 20 FOR UPDATE` |
| T3 | `INSERT ... warehouse_id = 20` → 卡住 | |
| T4 | | `INSERT ... warehouse_id = 10` → 卡住 |
| T5 | 死锁，B 被回滚 | |

逐行看。T1 时 A 按 `idx_warehouse` 找 10，命中一条记录。非唯一索引的等值查询，InnoDB 不会只锁这一行，还会向右多扫一格，把 10 到 30 之间的空隙一起锁上——防止你查完的瞬间有人插一条 15 进来。所以 A 手里握着：记录 10 + 空隙 (10, 30)。

T2 时 B 找 20，索引里没有 20，扫到 30 就停了。没命中记录，但空隙照样锁：B 握着空隙 (10, 30)。

注意，**间隙锁和间隙锁之间是不冲突的**。两个人都锁同一块空地，都能成功。这也是为什么代码一路跑到 T3 都没报错。

T3，A 要插一条 warehouse_id = 20 的记录，位置正好落在 (10, 30) 里。插入需要申请"插入意向锁"，而插入意向锁和间隙锁冲突——A 被 B 挡住。

T4，B 要插 warehouse_id = 10，位置也在 (10, 30) 里（新记录排在已有的 10 后面）。被 A 挡住。

A 等 B，B 等 A。InnoDB 一看这环形等待解不开，直接回滚其中一个，把 `1213` 错误扔给应用层。业务代码里看到的现象就是：一个看起来毫无关联的插入，突然失败了。

这就是让人抓狂的地方——报错的 SQL 和阻塞的 SQL 常常不是同一条，甚至不在同一张业务表上，光看代码永远想不通。

## 二、底层原理到底怎么回事

InnoDB 的行锁有四类，理解了这四类，死锁日志基本能自己读。

| 锁类型 | 锁住什么 | 什么时候出现 |
| --- | --- | --- |
| 记录锁 Record Lock | 索引上的一条记录 | 唯一索引等值命中，或主键等值命中 |
| 间隙锁 Gap Lock | 两条索引记录之间的空隙 | 非唯一索引等值/范围查询、唯一索引未命中 |
| 临键锁 Next-Key Lock | 记录锁 + 记录前面的间隙 | RR 下的默认加锁单位 |
| 插入意向锁 Insert Intention | 插入位置的一个意向标记 | INSERT 时申请，与间隙锁冲突 |

临键锁是 RR 的默认形态，它是"左开右闭"的区间。索引里有 10 和 30 两条记录，那么临键锁覆盖的是 `(负无穷, 10]` 和 `(10, 30]`。锁住 10 这条记录的临键锁，顺手就把 10 左边的空隙也带上了。

### 加锁规则，背下来能省很多加班

这部分是硬知识，面试问、线上排查也用得上。前提：走的是索引，不是全表扫。

| SQL 形态 | 实际加的锁 |
| --- | --- |
| 唯一索引等值，记录存在 | 记录锁，一条 |
| 唯一索引等值，记录不存在 | 间隙锁，锁住那个空位 |
| 非唯一索引等值 | 临键锁 + 向右多扫一格的间隙锁 |
| 非唯一索引范围查询 | 范围内所有记录的临键锁，直到第一个不满足条件的记录 |
| 没有索引可用 | 全表所有记录加锁，等价于锁表 |

第一条和第二条的差别，是很多人栽跟头的地方。同一条 `WHERE sku_code = 'X' FOR UPDATE`，这行数据存在时只锁一行，不存在时就变成锁一个区间。业务上"查一下有没有，没有就插"的逻辑，恰恰每次都走第二条路。

第四条解释了我们那个例子的第二个锁来源。非唯一索引的等值查询，扫到 10 之后不会立刻停，要再往右看一眼 30 才确认"没有更多 10 了"。这一眼，就把 (10, 30) 锁进去了。

### 死锁检测是怎么工作的

InnoDB 维护一张等待图（wait-for graph）：谁在等谁，画成有向图。每次有事务要等待锁，就检查加完这条边会不会成环。成环就说明死锁，立刻挑一个"代价最小"的事务回滚——通常选 undo 记录少、修改行数少的那个，因为回滚便宜。

这个检测受 `innodb_deadlock_detect` 控制，默认开着。关掉它，InnoDB 就不查环了，死锁只能靠 `innodb_lock_wait_timeout`（默认 50 秒）超时来解。听起来省了 CPU，实际是把"毫秒级回滚"换成"50 秒卡死"，高并发下连接池会被瞬间抽干。

回滚发生时，应用层收到的错误长这样：

```
ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction
```

`40001` 是 SQLState，表示序列化失败，属于**可以重试**的瞬时错误。这里有个认知差：很多人把它当成业务异常往上抛，用户看到 500；正确做法是整个事务重来一遍。

### 为什么压测复现不了

死锁需要精确的交错时序，还要有"空隙"这个前提。压测脚本通常是单线程循环，或者每个线程操作自己的数据，天然凑不出交叉等待。线上真实流量里，两个用户的请求恰好落在同一个空隙两侧，概率不高但量大了必然发生。

复现的关键不是加大压力，是**手工构造时序**：让两个事务都先拿到锁，再同时往下走。下面的代码就是干这个的。

## 三、实战：手把手写代码

我们做一个能稳定复现间隙锁死锁的 Spring Boot 项目，再顺手把修复版写出来。整套代码可以直接跑。

### 1. 建库

```sql
CREATE DATABASE IF NOT EXISTS lock_demo DEFAULT CHARSET utf8mb4;
```

### 2. pom.xml

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
    <artifactId>innodb-gap-lock-demo</artifactId>
    <version>1.0.0</version>
    <name>innodb-gap-lock-demo</name>

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
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.2</version>
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

### 3. application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: innodb-gap-lock-demo
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/lock_demo?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai
    username: root
    password: root123
    hikari:
      maximum-pool-size: 10
      connection-timeout: 3000
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql
      data-locations: classpath:data.sql
```

`spring.sql.init.mode: always` 让应用每次启动都执行建表和初始化数据。这里会先删表再建，只适合本地演示，别往生产环境抄。

### 4. 建表脚本 src/main/resources/schema.sql

```sql
DROP TABLE IF EXISTS stock;

CREATE TABLE stock (
    id bigint NOT NULL AUTO_INCREMENT,
    sku_code varchar(64) NOT NULL,
    warehouse_id bigint NOT NULL,
    quantity int NOT NULL DEFAULT 0,
    updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_sku_warehouse (sku_code, warehouse_id),
    KEY idx_warehouse (warehouse_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

### 5. 初始数据 src/main/resources/data.sql

```sql
INSERT INTO stock (id, sku_code, warehouse_id, quantity) VALUES (1, 'SKU-001', 10, 500);
INSERT INTO stock (id, sku_code, warehouse_id, quantity) VALUES (2, 'SKU-002', 30, 800);
```

仓库 20 故意留空。这两行数据决定了空隙 (10, 30) 的存在，是整个复现的前提。

### 6. 启动类 src/main/java/com/example/lockdemo/LockDemoApplication.java

```java
package com.example.lockdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LockDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(LockDemoApplication.class, args);
    }
}
```

### 7. 仓储层 src/main/java/com/example/lockdemo/service/StockService.java

这个类负责最底层的 JDBC 操作。为什么不用 `@Transactional` 一把梭？因为要控制两个事务的交错时序，必须手工持有 Connection。

```java
package com.example.lockdemo.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

@Service
public class StockService {

    private final DataSource dataSource;
    private final JdbcTemplate jdbcTemplate;

    public StockService(DataSource dataSource, JdbcTemplate jdbcTemplate) {
        this.dataSource = dataSource;
        this.jdbcTemplate = jdbcTemplate;
    }

    public Connection openTransaction() throws SQLException {
        Connection connection = dataSource.getConnection();
        connection.setAutoCommit(false);
        connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
        return connection;
    }

    public void lockByWarehouse(Connection connection, long warehouseId) throws SQLException {
        String sql = "SELECT id, sku_code, quantity FROM stock WHERE warehouse_id = ? FOR UPDATE";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setLong(1, warehouseId);
            try (ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    resultSet.getLong("id");
                }
            }
        }
    }

    public void insertStock(Connection connection, String skuCode, long warehouseId, int quantity) throws SQLException {
        String sql = "INSERT INTO stock (sku_code, warehouse_id, quantity) VALUES (?, ?, ?)";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, skuCode);
            statement.setLong(2, warehouseId);
            statement.setInt(3, quantity);
            statement.executeUpdate();
        }
    }

    public int countByWarehouse(long warehouseId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM stock WHERE warehouse_id = ?", Integer.class, warehouseId);
        return count == null ? 0 : count;
    }
}
```

`lockByWarehouse` 里的 `while (resultSet.next())` 看着多余，其实是把结果集读完，确保这条语句完整执行、锁全部拿到，不会因为提前关流出现意外。

### 8. 死锁编排 src/main/java/com/example/lockdemo/service/DeadlockDemoService.java

核心就一件事：用 `CountDownLatch` 卡住两个线程，等双方都拿到锁了，再同时发起插入。

```java
package com.example.lockdemo.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

@Service
public class DeadlockDemoService {

    private static final Logger log = LoggerFactory.getLogger(DeadlockDemoService.class);

    private final StockService stockService;

    public DeadlockDemoService(StockService stockService) {
        this.stockService = stockService;
    }

    public Map<String, Object> runOnce() throws Exception {
        CountDownLatch bothLocked = new CountDownLatch(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> transactionA = pool.submit(
                    () -> crossTransaction("A", 10L, 20L, "SKU-FROM-A", bothLocked));
            Future<String> transactionB = pool.submit(
                    () -> crossTransaction("B", 20L, 10L, "SKU-FROM-B", bothLocked));

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("beforeWarehouse10", stockService.countByWarehouse(10L));
            result.put("beforeWarehouse20", stockService.countByWarehouse(20L));
            result.put("transactionA", transactionA.get(20, TimeUnit.SECONDS));
            result.put("transactionB", transactionB.get(20, TimeUnit.SECONDS));
            result.put("afterWarehouse10", stockService.countByWarehouse(10L));
            result.put("afterWarehouse20", stockService.countByWarehouse(20L));
            return result;
        } finally {
            pool.shutdownNow();
        }
    }

    private String crossTransaction(String name, long lockWarehouse, long insertWarehouse,
                                    String skuCode, CountDownLatch bothLocked) {
        try (Connection connection = stockService.openTransaction()) {
            stockService.lockByWarehouse(connection, lockWarehouse);
            bothLocked.countDown();
            bothLocked.await(5, TimeUnit.SECONDS);

            try {
                stockService.insertStock(connection, skuCode, insertWarehouse, 100);
                connection.commit();
                return name + " 提交成功";
            } catch (SQLException ex) {
                connection.rollback();
                log.warn("事务 {} 失败，错误码 {}，SQLState {}", name, ex.getErrorCode(), ex.getSQLState());
                return name + " 被回滚，错误码 " + ex.getErrorCode() + "：" + ex.getMessage();
            }
        } catch (Exception ex) {
            return name + " 异常：" + ex.getMessage();
        }
    }
}
```

`CountDownLatch` 是这套代码的灵魂。没有它，线程 A 可能一溜烟跑完整个事务，线程 B 才开始，永远不会交叉。有它，两个线程在 `await` 处对齐，然后一起冲向 INSERT。

### 9. 锁现场查看 src/main/java/com/example/lockdemo/service/LockInspector.java

出事时别猜，直接看 InnoDB 自己记的账。

```java
package com.example.lockdemo.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class LockInspector {

    private final JdbcTemplate jdbcTemplate;

    public LockInspector(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<Map<String, Object>> currentLocks() {
        String sql = """
                SELECT l.engine_transaction_id AS trx_id,
                       l.object_name           AS table_name,
                       l.index_name,
                       l.lock_type,
                       l.lock_mode,
                       l.lock_status,
                       l.lock_data
                FROM performance_schema.data_locks l
                ORDER BY l.engine_transaction_id, l.index_name
                """;
        return jdbcTemplate.queryForList(sql);
    }

    public List<Map<String, Object>> runningTransactions() {
        String sql = """
                SELECT trx_id,
                       trx_state,
                       trx_started,
                       trx_rows_locked,
                       trx_rows_modified,
                       trx_query
                FROM information_schema.INNODB_TRX
                ORDER BY trx_started
                """;
        return jdbcTemplate.queryForList(sql);
    }
}
```

`data_locks` 表里，`LOCK_MODE` 出现 `X,GAP` 就是间隙锁，出现 `X` 且 `LOCK_TYPE` 是 `RECORD` 多为临键锁，`LOCK_MODE` 带 `INSERT_INTENTION` 就是在等插入。

### 10. 接口层 src/main/java/com/example/lockdemo/controller/LockDemoController.java

```java
package com.example.lockdemo.controller;

import com.example.lockdemo.service.DeadlockDemoService;
import com.example.lockdemo.service.LockInspector;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/demo")
public class LockDemoController {

    private final DeadlockDemoService deadlockDemoService;
    private final LockInspector lockInspector;

    public LockDemoController(DeadlockDemoService deadlockDemoService, LockInspector lockInspector) {
        this.deadlockDemoService = deadlockDemoService;
        this.lockInspector = lockInspector;
    }

    @PostMapping("/deadlock")
    public Map<String, Object> triggerDeadlock() throws Exception {
        return deadlockDemoService.runOnce();
    }

    @GetMapping("/locks")
    public Map<String, Object> locks() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("locks", lockInspector.currentLocks());
        result.put("transactions", lockInspector.runningTransactions());
        return result;
    }
}
```

### 11. 跑起来看结果

```bash
mvn spring-boot:run
curl -X POST http://localhost:8080/demo/deadlock
```

返回大概是这样：

```json
{
  "beforeWarehouse10": 1,
  "beforeWarehouse20": 0,
  "transactionA": "A 提交成功",
  "transactionB": "B 被回滚，错误码 1213：Deadlock found when trying to get lock; try restarting transaction",
  "afterWarehouse10": 1,
  "afterWarehouse20": 1
}
```

B 是谁被回滚不固定，InnoDB 每次挑代价小的那个，多跑几次可能会换。数据最终一致：一个成功插入，一个整体回滚。

### 12. 修复版：重试兜底 + 统一顺序

死锁不可能百分百消灭，但可以做到"发生了也自动恢复"。先写一个重试工具：

```java
package com.example.lockdemo.support;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.SQLException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;

public final class DeadlockRetry {

    private static final Logger log = LoggerFactory.getLogger(DeadlockRetry.class);
    private static final int MAX_ATTEMPTS = 3;

    private DeadlockRetry() {
    }

    public static <T> T execute(String actionName, Supplier<T> action) {
        RuntimeException lastError = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return action.get();
            } catch (RuntimeException ex) {
                if (!isRetryable(ex) || attempt == MAX_ATTEMPTS) {
                    throw ex;
                }
                lastError = ex;
                long sleepMillis = ThreadLocalRandom.current().nextLong(20, 80) * attempt;
                log.warn("{} 命中死锁，第 {} 次重试，等待 {} ms", actionName, attempt, sleepMillis);
                try {
                    Thread.sleep(sleepMillis);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw ex;
                }
            }
        }
        throw lastError == null ? new IllegalStateException("重试流程异常") : lastError;
    }

    private static boolean isRetryable(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof SQLException sqlException) {
                int errorCode = sqlException.getErrorCode();
                if (errorCode == 1213 || errorCode == 1205) {
                    return true;
                }
            }
            current = current.getCause();
        }
        return false;
    }
}
```

重试要包住**整个事务**，不能只重试最后那条 SQL。事务已经被回滚了，前面几条语句的效果全丢了，只重试一条等于写脏数据。

再改业务：加锁顺序统一，并且用单语句 upsert 替代"先查有没有、再插"。

```java
package com.example.lockdemo.service;

import com.example.lockdemo.support.DeadlockRetry;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

@Service
public class SafeStockService {

    private final JdbcTemplate jdbcTemplate;

    public SafeStockService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public void deduct(long warehouseId, Map<String, Integer> items) {
        List<String> skuCodes = new ArrayList<>(items.keySet());
        Collections.sort(skuCodes);
        for (String skuCode : skuCodes) {
            int count = items.get(skuCode);
            int updated = jdbcTemplate.update(
                    "UPDATE stock SET quantity = quantity - ? WHERE warehouse_id = ? AND sku_code = ? AND quantity >= ?",
                    count, warehouseId, skuCode, count);
            if (updated == 0) {
                throw new IllegalStateException("库存不足或商品不存在：" + skuCode);
            }
        }
    }

    public void addStock(String skuCode, long warehouseId, int quantity) {
        DeadlockRetry.execute("addStock", () -> jdbcTemplate.update("""
                INSERT INTO stock (sku_code, warehouse_id, quantity)
                VALUES (?, ?, ?) AS new_row
                ON DUPLICATE KEY UPDATE quantity = stock.quantity + new_row.quantity
                """, skuCode, warehouseId, quantity));
    }
}
```

三处改动各有分工。

`Collections.sort` 让所有事务按同一个顺序拿锁。A 事务要扣 SKU-001 和 SKU-002，B 事务扣 SKU-002 和 SKU-001，不排序就是经典交叉死锁；排序后双方都先拿 001，一个等另一个，不会成环。

`ON DUPLICATE KEY UPDATE` 把"判断 + 插入"压成一条语句，中间不留持锁窗口，也就没有机会在两个事务之间插进空隙锁。注意 `AS new_row` 这个行别名：MySQL 8.0.20 起 `VALUES(quantity)` 的写法已废弃，新写法是给插入值起别名再引用。这个 upsert 依赖 `uk_sku_warehouse` 唯一索引，没有唯一索引它就是个普通 INSERT，重复数据照进不误。

`quantity >= ?` 写在 WHERE 里，是乐观锁的思路：不先查再改，直接让数据库判断够不够。更新的行数返回 0，说明库存不足，业务异常抛出去。整条语句原子执行，不存在"查到 10 件、扣的时候只剩 3 件"的窗口。

## 四、踩坑经验和最佳实践

**踩坑一：以为"没查到数据就没加锁"。** 这是最普遍的误解。`SELECT ... FOR UPDATE` 查到 0 行，锁反而更重——它锁的是整个区间。做存在性校验用普通 `SELECT`，别顺手加 `FOR UPDATE`。

**踩坑二：唯一索引等值查询，记录不存在时照样加间隙锁。** 规则表第二条。`WHERE sku_code = 'NEW-SKU' FOR UPDATE` 在数据不存在时锁住的是插入位置，两个事务同时"占位"就会互相卡住。这个坑在"注册用户名查重"的场景里特别常见。

**踩坑三：间隙锁之间不冲突，所以问题延后爆发。** 两个事务的 `SELECT` 都成功了，日志里一片祥和，直到 INSERT 那一刻才炸。排查时不要只盯着报错的那条 SQL，往前找同一事务里更早的加锁语句。

**踩坑四：事务里调 RPC、发消息、等第三方接口。** 锁的持有时间等于事务时长。本来 5 毫秒的锁，因为中间等了一次 2 秒的 HTTP 调用，变成 2 秒，死锁概率直接放大几百倍。所有外部调用挪到事务外面，先落库再发消息。

**踩坑五：关掉 `innodb_deadlock_detect` 想省 CPU。** 别关。关了之后死锁只能等 `innodb_lock_wait_timeout` 超时，默认 50 秒。50 秒里这条连接一直占着，并发一高连接池直接打满，故障面比死锁本身大得多。真觉得检测有开销，先优化 SQL 和事务长度。

**踩坑六：把 1213 当成不可恢复的错误。** 它是瞬时错误，重试一次大概率就过了。但重试必须包住整个事务，且要有次数上限和退避，别写成无限循环。

**踩坑七：批量 `IN` 更新一次几千行。** 锁的范围跟着行数走，一次锁几千行，跟别人冲突的概率成倍上升。切成 200 行一批，批间留一点间隔。

**踩坑八：调低隔离级别到 RC 却没改 binlog 格式。** RC 下间隙锁基本消失，死锁会少一大截，但 binlog 必须是 ROW 格式，否则主从数据可能不一致。改隔离级别是全局动作，得评估整个集群，不是单个业务能自己决定的。

实践上，我一般按这个顺序处理：先看死锁日志找到两条冲突 SQL，再看它们走的索引，能改成唯一索引等值命中的就改；改不了的，统一加锁顺序；还不行，缩短事务 + 加重试；最后才考虑动隔离级别。

## 五、性能对比和技术选型

不同方案在锁范围、吞吐和实现成本上差别很大，选之前先看清楚。

| 方案 | 锁范围 | 并发表现 | 适用场景 |
| --- | --- | --- | --- |
| RR + `SELECT FOR UPDATE` | 记录 + 间隙 | 冲突概率高，容易死锁 | 强一致、冲突少的场景 |
| RC 隔离级别 | 基本只有记录锁 | 死锁显著减少 | 大多数互联网业务 |
| 乐观锁（`WHERE quantity >= ?`） | 单条记录，语句级 | 无长事务，吞吐最好 | 库存扣减、状态流转 |
| 唯一索引等值锁 | 单条记录 | 范围最小 | 有唯一键能定位的业务 |
| 分布式锁（Redis） | 数据库外 | 取决于锁实现 | 跨库、跨服务的互斥 |

我的推荐很直接：**能用一条带条件的 UPDATE 解决的，就不要用 `SELECT FOR UPDATE` 加应用层判断**。前者是一条语句，锁的窗口以微秒计；后者是两条语句加一个事务，窗口被拉长到整个业务逻辑。

对于确实需要"先读后写"的场景，把隔离级别降到 RC 是最省事的做法，代价是要接受不可重复读。银行账务这类不能接受的同学，老老实实统一加锁顺序加重试。

间隙锁不是 bug，是 RR 隔离级别的必然代价。想清楚业务到底需不需要 RR，比背加锁规则更有价值。

## 六、总结

间隙锁死锁的根源是"锁了看不见的东西"——记录之间的空隙。非唯一索引的等值查询、唯一索引未命中的查询、范围查询，都会把空隙锁上；插入又需要和间隙锁冲突的插入意向锁，两边一交叉，环就成了。

排查按三步走。第一步，从 `SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK` 段或者 `performance_schema.data_locks` 里，找到两个事务各自的持锁和等锁记录，注意 `LOCK_MODE` 里的 `GAP` 和 `INSERT_INTENTION`。第二步，把两条 SQL 的加锁顺序画出来，找那个方向相反的交叉点。第三步，按顺序试修复手段：改走唯一索引等值、统一加锁顺序、单语句原子更新、缩短事务、加重试。

代码层面记住四句话：

- 存在性检查不要用 `FOR UPDATE`
- 多行操作按固定顺序加锁
- "判断 + 修改"尽量压成一条带条件的 UPDATE
- 1213 必须重试，且重试整个事务

死锁日志其实特别好读，它把两个事务的持锁、等锁、最终回滚谁全写清楚了。怕的是不看日志，靠猜改代码——那种改法，通常是把一个死锁改成另一个死锁。

文 / 会编程的吕洞宾

## 参考资料

- [InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
- [Locking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
- [Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [INSERT ... ON DUPLICATE KEY UPDATE Statement](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)
- [The performance_schema.data_locks Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html)
- [Spring Framework JDBC Connections](https://docs.spring.io/spring-framework/reference/data-access/jdbc/connections.html)

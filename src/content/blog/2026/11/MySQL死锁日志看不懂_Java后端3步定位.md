---
title: "MySQL死锁日志看不懂？Java后端3步定位"
date: 2026-11-02T09:00:00+08:00
category: "数据库"
tags: ["mysql"]
---

> 摘要：线上突然报 `Deadlock found when trying to get lock`，多数人只会加重试。这篇从死锁日志的三段结构讲起，说清 InnoDB 的记录锁、间隙锁和临键锁到底锁了什么，再给一套能直接跑的复现工程和修复代码，收尾是排查死锁的三步法。

半夜两点，告警群弹出一条 `Deadlock found when trying to get lock; try restarting transaction`。白天压测一切正常，凌晨批量任务一跑就炸。很多人的第一反应是 MySQL 出 bug 了，接着去搜参数、调超时，问题照旧。死锁不是数据库抽风，是两条事务把加锁顺序走成了交叉，然后各自攥着一把锁等对方放手。这篇讲清楚：日志怎么读、InnoDB 锁了什么、代码怎么改。

## 一、这个问题到底是什么

死锁是两个或多个事务互相等待对方持有的锁，形成闭环，谁也无法继续。

举个最直观的例子。事务 A 先锁库存行，再锁订单行；事务 B 先锁订单行，再锁库存行。两边第一步都成功，第二步都卡住。A 等 B 释放订单行，B 等 A 释放库存行。这个环不打破，两条事务永远等下去。

MySQL 不会让它们干等。InnoDB 有死锁检测，发现环之后会挑一条事务回滚，抛给你这个错：

```text
Deadlock found when trying to get lock; try restarting transaction
```

注意错误码：`1213`，SQLState 是 `40001`。它和锁等待超时不是一回事。锁等待超时报的是：

```text
Lock wait timeout exceeded; try restarting transaction
```

错误码 `1205`，由 `innodb_lock_wait_timeout` 控制，默认 50 秒。这两个错经常被混为一谈，处理方式完全不同：1213 是已经检测到环、立刻回滚；1205 是单方向等待太久、超时放弃。

日常开发里还有个更隐蔽的情况：死锁根本没报错。比如批量任务里每条记录单独提交，冲突时只是变慢，日志里干干净净，你在监控上看到的是「凌晨跑批耗时从 8 分钟涨到 40 分钟」。这种更难查。

死锁的本质不是锁不够用，是访问顺序不一致。只要两条事务以不同顺序碰同一批资源，并发一上来就会撞。

那为什么「加重试」看起来有效？因为死锁检测回滚了一方，另一方拿到锁继续跑完并提交，环就断了。被回滚的那条重试时，对手已经不在了，自然成功。但重试只是止血，顺序不改，第二天同一时间还会再来一次。

## 二、底层原理到底怎么回事

### 2.1 行锁加在索引上，不是加在行上

InnoDB 的锁挂在索引记录上。这句话决定了所有死锁分析的方向：**SQL 走了哪个索引，就锁了哪些索引项**。

同样是更新一行，四种写法锁的范围差得很远：

```sql
-- 主键等值：只锁 id = 1 这一条
update t_order set status = 1 where id = 1;

-- 唯一索引等值：也只锁一条，但二级索引和主键索引都要锁
update t_order set status = 1 where order_no = 'NO20261102001';

-- 普通索引：锁住命中的记录，还要锁记录之间的间隙
update t_order set status = 1 where user_id = 7;

-- 没有索引：扫描到的每一行都锁，效果接近锁表
update t_order set status = 1 where remark = '加急';
```

第四条最容易出事。很多「莫名其妙全表锁」的工单，根因就是 WHERE 条件里的字段没建索引。扫描过程碰到的每一行都会被锁住，并发稍高就互相堵死。所以排查死锁的第一步不是看事务，是看 SQL 的 EXPLAIN。

还要注意二级索引。走 `order_no` 更新时，InnoDB 先在二级索引上加锁，再回表到主键索引加锁。一条 SQL 锁了两个地方，死锁的组合也就多了一倍。

### 2.2 三种锁：记录锁、间隙锁、临键锁

InnoDB 在可重复读隔离级别下有三种行级锁：

| 锁类型 | 锁住什么 | 什么时候出现 |
| --- | --- | --- |
| 记录锁 Record Lock | 某一条索引记录 | 唯一索引等值命中 |
| 间隙锁 Gap Lock | 两条记录之间的空隙，不含记录本身 | 范围查询、非唯一索引等值查询 |
| 临键锁 Next-Key Lock | 间隙 + 右边那条记录 | 可重复读下的默认形态 |

间隙锁是死锁的高发区，因为它锁的是「不存在的东西」。

假设 `t_order.id` 里只有 1、5、10 三条记录。执行：

```sql
update t_order set status = 1 where id = 7;
```

7 不存在，但 InnoDB 不能当没发生。它会锁住 (5, 10) 这个区间，防止别人在这期间插进一条 7，导致当前事务的语义漂移。这时候另一个事务执行 `insert into t_order(id, ...) values (6, ...)`，插入意向锁会和间隙锁冲突，直接卡住。如果两边还各持有别的锁，环就形成了。

插入意向锁本身也是个知识点：它是插入前加的一种特殊间隙锁，多个事务往同一个间隙插入时彼此不冲突，但和已经存在的间隙锁冲突。线上「并发插入同区间卡死」基本都是这个原因。

### 2.3 死锁检测怎么发现环

InnoDB 维护一张等待图：每个事务是节点，谁等谁是边。每次加锁失败就更新这张图，发现闭环就判定死锁。

判定之后要选一个牺牲者。规则是回滚代价小的那个，通常看 undo log 量。所以日志里最后一行会写 `WE ROLL BACK TRANSACTION (2)`，告诉你谁被牺牲了。

检测本身有成本。事务越多、锁越复杂，构图和遍历越慢。高并发场景下这个开销不可忽略，但把它关掉更糟：`innodb_deadlock_detect=OFF` 之后，死锁退化成锁等待，只能等 50 秒超时，接口全挂在那儿。除非你非常确定业务里不会有死锁，否则别关。

### 2.4 死锁日志的三段结构

执行 `SHOW ENGINE INNODB STATUS\G`，找到 `LATEST DETECTED DEADLOCK` 这一段。它记录最近一次死锁，格式固定：

```text
------------------------
LATEST DETECTED DEADLOCK
------------------------
*** (1) TRANSACTION:
TRANSACTION 4218, ACTIVE 0 sec starting index read
LOCK WAIT 2 lock struct(s), heap size 1128, 1 row lock(s)
MySQL thread id 12, query id 88 localhost root updating
update t_order set status = 1 where id = 1
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `deadlock_demo`.`t_stock`
 lock_mode X locks rec but not gap
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table `deadlock_demo`.`t_order`
 lock_mode X locks rec but not gap waiting
*** (2) TRANSACTION:
TRANSACTION 4217, ACTIVE 0 sec starting index read
...
*** WE ROLL BACK TRANSACTION (2)
```

读这段日志只需要盯四个地方：

1. 每个事务最后执行的 SQL。这是它当时在等什么。
2. `HOLDS THE LOCK(S)`。这是它已经攥在手里的锁。
3. `lock_mode` 后面的修饰。`locks rec but not gap` 是纯记录锁，带 `gap` 就是间隙锁或临键锁。
4. 最后一行回滚了谁。

把两个事务的「持有」和「等待」拼起来，环就出来了。上面这段的意思是：事务 1 持有库存行、等订单行；事务 2 持有订单行、等库存行。典型的交叉顺序。

## 三、实战：手把手写代码

这套工程能直接复现死锁，也能直接改成修复版。先建库：

```sql
create database if not exists deadlock_demo default character set utf8mb4;
```

### 3.1 pom.xml

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
    <artifactId>mysql-deadlock-demo</artifactId>
    <version>1.0.0</version>
    <name>mysql-deadlock-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
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

### 3.2 application.yml

```yaml
spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/deadlock_demo?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai&characterEncoding=utf8
    username: root
    password: root
    hikari:
      maximum-pool-size: 10
      connection-timeout: 3000
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql
```

### 3.3 schema.sql

放在 `src/main/resources/schema.sql`。每次启动重建表，保证复现环境干净。

```sql
drop table if exists t_order;
drop table if exists t_stock;

create table t_stock (
    sku_id bigint primary key,
    qty    int not null
) engine = InnoDB;

create table t_order (
    id         bigint primary key,
    order_no   varchar(32) not null,
    status     tinyint     not null default 0,
    updated_at datetime    not null default current_timestamp on update current_timestamp,
    unique key uk_order_no (order_no)
) engine = InnoDB;

insert into t_stock (sku_id, qty) values (1, 100);
insert into t_order (id, order_no, status) values (1, 'NO20261102001', 0);
```

### 3.4 复现死锁的启动类

两个线程，一个先扣库存再改订单，另一个反过来。用 `CountDownLatch` 保证两边都先拿到第一把锁，再走第二步，这样死锁是必现的，不用碰运气。

```java
package com.example.deadlock;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

@SpringBootApplication
public class DeadlockDemoApplication implements CommandLineRunner {

    private final JdbcTemplate jdbcTemplate;
    private final TransactionTemplate transactionTemplate;

    public DeadlockDemoApplication(JdbcTemplate jdbcTemplate, TransactionTemplate transactionTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.transactionTemplate = transactionTemplate;
    }

    public static void main(String[] args) {
        SpringApplication.run(DeadlockDemoApplication.class, args);
    }

    @Override
    public void run(String... args) throws Exception {
        CountDownLatch bothFirstLocked = new CountDownLatch(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);

        Future<?> a = pool.submit(() -> runInTx("A", bothFirstLocked,
                "update t_stock set qty = qty - 1 where sku_id = 1",
                "update t_order set status = 1 where id = 1"));

        Future<?> b = pool.submit(() -> runInTx("B", bothFirstLocked,
                "update t_order set status = 2 where id = 1",
                "update t_stock set qty = qty - 1 where sku_id = 1"));

        a.get(30, TimeUnit.SECONDS);
        b.get(30, TimeUnit.SECONDS);
        pool.shutdown();

        Integer qty = jdbcTemplate.queryForObject("select qty from t_stock where sku_id = 1", Integer.class);
        Integer status = jdbcTemplate.queryForObject("select status from t_order where id = 1", Integer.class);
        System.out.println("最终结果 qty=" + qty + ", status=" + status);
    }

    private void runInTx(String name, CountDownLatch latch, String firstSql, String secondSql) {
        try {
            transactionTemplate.executeWithoutResult(status -> {
                jdbcTemplate.update(firstSql);
                System.out.println("[" + name + "] 第一把锁到手");
                latch.countDown();
                try {
                    latch.await(5, TimeUnit.SECONDS);
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                jdbcTemplate.update(secondSql);
                System.out.println("[" + name + "] 第二把锁到手，事务提交");
            });
        } catch (DataAccessException e) {
            System.out.println("[" + name + "] 被回滚：" + rootMessage(e));
        }
    }

    private String rootMessage(Throwable e) {
        Throwable current = e;
        while (current.getCause() != null) {
            current = current.getCause();
        }
        return current.getMessage();
    }
}
```

跑起来输出大概是这样：

```text
[A] 第一把锁到手
[B] 第一把锁到手
[A] 被回滚：Deadlock found when trying to get lock; try restarting transaction
[B] 第二把锁到手，事务提交
最终结果 qty=99, status=2
```

注意结果：库存扣了一次，订单状态是 B 写的 2，A 的整条事务被回滚。这就是死锁检测的代价——牺牲一方，保住整体可用。

### 3.5 修复版：统一顺序 + 有限重试

修复的核心只有一句话：所有入口按同一顺序访问资源。库存永远在前，订单永远在后。顺序一致，环就构不成。

再用重试兜住那些无法控制顺序的场景，比如跨服务调用、批量任务。

```java
package com.example.deadlock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.SQLException;

@Service
public class OrderPayService {

    private static final Logger log = LoggerFactory.getLogger(OrderPayService.class);
    private static final int MAX_ATTEMPTS = 3;
    private static final int ERROR_DEADLOCK = 1213;

    private final JdbcTemplate jdbcTemplate;
    private final TransactionTemplate transactionTemplate;

    public OrderPayService(JdbcTemplate jdbcTemplate, TransactionTemplate transactionTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.transactionTemplate = transactionTemplate;
    }

    public void pay(long orderId, long skuId) {
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                transactionTemplate.executeWithoutResult(status -> {
                    jdbcTemplate.update("update t_stock set qty = qty - 1 where sku_id = ?", skuId);
                    jdbcTemplate.update("update t_order set status = 1 where id = ?", orderId);
                });
                return;
            } catch (DataAccessException e) {
                if (!isDeadlock(e) || attempt == MAX_ATTEMPTS) {
                    throw e;
                }
                log.warn("第 {} 次撞上死锁，退避后重试", attempt);
                sleep(50L * attempt);
            }
        }
    }

    private boolean isDeadlock(Throwable e) {
        Throwable current = e;
        while (current != null) {
            if (current instanceof SQLException sqlException
                    && sqlException.getErrorCode() == ERROR_DEADLOCK) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

配套的 Controller，方便用 curl 压一把：

```java
package com.example.deadlock;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderPayService orderPayService;

    public OrderController(OrderPayService orderPayService) {
        this.orderPayService = orderPayService;
    }

    @PostMapping("/{orderId}/pay")
    public String pay(@PathVariable long orderId, @RequestParam long skuId) {
        orderPayService.pay(orderId, skuId);
        return "ok";
    }
}
```

重试次数别拍脑袋往上加。三次足够，退避 50、100、150 毫秒。再多就是在放大下游压力，而且说明顺序问题根本没解决。

### 3.6 出事了怎么现场看锁

别等日志，直接查 `performance_schema`。`data_locks` 是当前所有锁，`data_lock_waits` 是谁在等谁。

```sql
-- 谁持有什么锁
select ENGINE_TRANSACTION_ID as trx_id,
       OBJECT_SCHEMA          as db,
       OBJECT_NAME            as table_name,
       INDEX_NAME             as index_name,
       LOCK_TYPE              as lock_type,
       LOCK_MODE              as lock_mode,
       LOCK_STATUS            as lock_status,
       LOCK_DATA              as lock_data
from performance_schema.data_locks
order by trx_id;

-- 等待关系，一眼看出环
select REQUESTING_ENGINE_TRANSACTION_ID as waiting_trx,
       BLOCKING_ENGINE_TRANSACTION_ID  as blocking_trx
from performance_schema.data_lock_waits;
```

想看事务本身在干什么，查 `information_schema.innodb_trx`，里面 `trx_state` 为 `LOCK WAIT` 的那条就是卡住的事务，`trx_query` 是它最后执行的 SQL。

把这些查询包成一个只读接口，线上排查会方便很多：

```java
package com.example.deadlock;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/debug")
public class LockInspectorController {

    private final JdbcTemplate jdbcTemplate;

    public LockInspectorController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/locks")
    public List<Map<String, Object>> locks() {
        return jdbcTemplate.queryForList("""
                select ENGINE_TRANSACTION_ID as trx_id,
                       OBJECT_SCHEMA          as db,
                       OBJECT_NAME            as table_name,
                       INDEX_NAME             as index_name,
                       LOCK_TYPE              as lock_type,
                       LOCK_MODE              as lock_mode,
                       LOCK_STATUS            as lock_status,
                       LOCK_DATA              as lock_data
                from performance_schema.data_locks
                order by trx_id
                """);
    }

    @GetMapping("/waits")
    public List<Map<String, Object>> waits() {
        return jdbcTemplate.queryForList("""
                select REQUESTING_ENGINE_TRANSACTION_ID as waiting_trx,
                       BLOCKING_ENGINE_TRANSACTION_ID  as blocking_trx
                from performance_schema.data_lock_waits
                """);
    }
}
```

这个接口记得加权限控制，别裸奔在公网。

## 四、踩坑经验和最佳实践

**坑一：只加重试，不改顺序。** 重试能扛住偶发冲突，扛不住稳定复现的交叉。压测时 QPS 一上千，重试次数线性上涨，数据库压力反而更大。判断标准很简单：同一个接口每天固定时间报 1213，那就是顺序问题，重试没用。

**坑二：事务里干重活。** 我见过最离谱的一段代码：事务里扣库存、调第三方支付、发 MQ、写日志表，整条事务持锁 1.8 秒。并发 20 就死锁。锁的持有时间等于事务里所有操作的总耗时，任何远程调用都不该出现在事务里。先提交本地事务，再发消息，用本地消息表或事务消息保证一致性。

**坑三：批量更新不排序。** 两条 SQL 分别按不同条件批量更新同一批行，执行计划选的索引还不一样，交叉几乎必然。改成按主键排序后分批提交：

```sql
update t_order set status = 1 where id in (3, 9, 12) order by id;
```

`order by id` 是官方文档里明确提到的降死锁手段：它让同一条语句内部的加锁次序固定下来，两条事务就不会在行与行之间交叉。但它不减少锁范围，大事务还是得拆。

**坑四：唯一键并发插入。** 两个事务同时插入相同唯一键，其中一个会加共享锁等待，另一个再去拿别的锁，就容易成环。`insert ... on duplicate key update` 也会踩到。处理办法是捕获重复键异常后重查，别在事务里先 `select` 再 `insert`，那中间有竞态窗口。

**坑五：以为换了隔离级别就万事大吉。** 改成读已提交能消掉大部分间隙锁，死锁率明显下降，但记录锁的交叉还在。两个事务反序更新同一批行，照样死。

**坑六：生产环境关死锁检测。** 有人为了省 CPU 把 `innodb_deadlock_detect` 关了，结果死锁变成 50 秒的锁等待，线程池瞬间打满，故障从「偶发报错」升级成「整体不可用」。这个参数别动。

实践上还有几条：事务尽量短，能不在事务里查的别查；更新语句一定要走索引，`explain` 看一眼 type 是不是 `ALL`；批处理按主键排序、分批提交，每批 500 到 1000 行；给死锁重试加上限和退避，别写成死循环。

## 五、性能对比和技术选型

不同隔离级别的取舍很直接：

| 隔离级别 | 间隙锁 | 死锁概率 | 适用场景 |
| --- | --- | --- | --- |
| 可重复读 RR | 有 | 高 | 需要事务内多次读一致，比如对账 |
| 读已提交 RC | 基本没有 | 低 | 绝大多数互联网业务 |

RC 下间隙锁只在唯一键冲突检查和外键检查时出现，这是它死锁率低的根本原因。代价是同一事务内两次读可能看到不同结果，也就是不可重复读。对下单、扣库存这类「读一次就写」的业务，这个代价可以接受。我的建议是默认用 RC，明确需要快照一致性的模块单独开 RR。

并发控制手段的对比：

| 方案 | 加锁位置 | 优点 | 代价 |
| --- | --- | --- | --- |
| 数据库悲观锁 `for update` | 数据库 | 实现简单，强一致 | 持锁期间阻塞，吞吐低 |
| 乐观锁版本号 | 应用层 | 不阻塞，吞吐高 | 冲突时失败，要重试 |
| Redis 分布式锁 | 应用层 | 跨服务生效 | 多一次网络往返，要处理锁续期 |

库存扣减我更倾向 `update t_stock set qty = qty - 1 where sku_id = ? and qty > 0` 这种带条件的原子更新，不加 `for update`，让数据库自己做行锁。冲突极少时它比乐观锁少一次重试，比悲观锁少一次查询。

## 六、总结

死锁排查可以固化成三步：

1. 读日志。`SHOW ENGINE INNODB STATUS` 里找 `LATEST DETECTED DEADLOCK`，把两个事务的「持有」和「等待」列出来。
2. 看 SQL 和执行计划。确认每条语句走的是哪个索引，锁的是记录还是间隙。
3. 改顺序、缩事务、加有限重试。顺序是第一位的，重试只是兜底。

记住一句话：死锁不是锁坏了，是访问顺序打架。只要所有入口对同一批资源的加锁次序一致，环就永远闭不上。剩下的工作，是把事务压短，把 SQL 走对索引。

文 / 会编程的吕洞宾

## 参考资料

- [InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
- [InnoDB Standard Monitor and Lock Monitor Output](https://dev.mysql.com/doc/refman/8.4/en/innodb-standard-monitor.html)

---
title: DDD领域事件总丢_Java后端补个发件箱表
date: 2026-11-26 11:21:58
tags: ["Java", "DDD", "Spring Boot", "MySQL"]
categories: java
---

# DDD领域事件总丢_Java后端补个发件箱表

> 支付回调里订单状态改成已支付，接着调库存服务扣减。这次调用超时，异常被 catch 住，打行 warn 就算完事。三天后财务对账，发现 27 笔订单付了钱、库存没扣。你想补发，却不知道补哪几笔——因为"哪些消息该发"这件事，从来没被记下来过。
>
> 这就是双写不一致：订单库和下游是两个系统，没有一个事务能同时管住。发件箱（Outbox）解决的就是这件事，先把"要发什么"写进自己库里的表，再让一个后台搬运工慢慢送出去。

## 一、这个问题到底是什么

领域事件丢失的根因不是消息中间件不靠谱，而是业务数据和"待发事件"被分两次写，中间任何一个环节断掉，两条路就再也对不上。

先解释两个词。

**领域事件**：领域里发生了一件已经成立的事实，比如"订单已支付""库存已锁定"。它是过去式，不能被撤销，只能被补偿。DDD 里用它在限界上下文之间通信——订单上下文不直接调库存上下文，只宣布"我这儿付完钱了"，谁关心谁自己去订阅。

**限界上下文**：可以粗暴理解成一个业务边界，订单、库存、会员各是一个，各有自己的库和自己的代码，互相之间只能靠接口或消息说话。

问题就出在这个"说话"上。DDD 教你聚合根在状态变化时把事件攒起来，然后发出去。可发出去这个动作，是跨系统的写操作。订单库在 MySQL 的 A 实例上，库存服务在另一台机器上，中间还隔着一层网络。本地事务只管自己那一亩三分地，管不了别人。

于是就有了三种经典的翻车姿势：

| 写法 | 出问题的时刻 | 后果 |
| --- | --- | --- |
| 先更新订单库，再调下游 | 调下游超时、进程被 kill、机器重启 | 订单已支付，下游永远不知道，钱付了货没扣 |
| 先调下游，再更新订单库 | 下游成功了，本地事务回滚 | 库存扣了，订单还是待支付，越卖越少 |
| 都调成功，靠 catch 重试 | 重试本身又失败，或重试导致重复 | 要么彻底丢，要么下游扣两次 |

很多人第一反应是"我 catch 住异常，写个 for 循环重试三次"。这招在小流量下看着能用，其实是自欺欺人：重试队列在内存里，进程一挂，队列跟着蒸发。你要重试的东西，必须落在磁盘上，而且落盘这个动作要和业务数据绑在同一个事务里。

换个角度想：如果"要给库存服务发一条扣减消息"这件事，本身变成数据库里的一行记录，那它就和订单状态在同一个事务里，要么一起成功，要么一起失败，没有中间态。剩下的问题只是——谁来把这行记录送出去。

这就是发件箱模式。它的核心不是消息队列，而是一张表和一支搬运队。

## 二、底层原理到底怎么回事

发件箱的本质是把「跨系统的写」降级成「本地插入一行记录」，原子性由数据库事务保证，投递由后台任务负责，重复由下游幂等兜住。

整个链路拆开是五步：

```text
业务事务（一个本地事务）
  ├─ 1. 改订单状态 status=PAID
  └─ 2. 插一条 outbox_event (status=NEW)
        ↓ 事务提交，两件事同时生效
  3. 后台中继：扫出 NEW 的记录
  4. CAS 抢占：UPDATE ... WHERE id=? AND status='NEW'
  5. 调用下游 → 成功标记 SENT / 失败退避重试
```

第 1 步和第 2 步在同一个 `@Transactional` 里，共享同一个数据库连接、同一个事务号。订单更新成功、事件没插进去，事务整体回滚；事件插进去了订单没更新，同样回滚。数据库替你把原子性做了，这段没有任何分布式协调。

### 为什么不能在事务提交后再发

有人会想到 Spring 的 `@TransactionalEventListener(phase = AFTER_COMMIT)`：事务提交完再发消息，不就避开"库回滚了消息却发了"吗？方向对了一半。

它解决的是"回滚后别发"，但解决不了"提交后崩溃"。事务提交成功，方法还没执行到发消息那行，机器断电了——事件在内存里，跟着一起没了。你还是丢了。

发件箱把"发"这件事从内存搬到了磁盘，崩溃之后重启还能捡起来。这是它和监听器方案最本质的区别。

### 为什么中继要 CAS 抢占

中继是个定时任务，服务多实例部署时，三个实例会同时扫到同一批 NEW 记录。如果只判断"状态是 NEW 就发"，三条一样的消息就出去了。

所以发之前要先抢：

```sql
UPDATE outbox_event
SET status = 'SENDING', claimed_by = '实例A', claimed_at = NOW(3)
WHERE id = 1001 AND status = 'NEW';
```

MySQL 的行锁保证只有一个实例能把这条 UPDATE 的影响行数变成 1，其他的拿到 0，直接跳过。这跟 Quartz 集群靠表锁抢任务是同一个思路——用数据库当仲裁者，不需要引入额外的协调服务。

### 为什么一定是"至少一次"，而不是"正好一次"

中继的时序是"先发，后标记"。发出去之后、标记 SENT 之前，如果进程挂了，这条记录还是 SENDING 或 NEW，重启后会被再发一遍。反过来先标记再发，那就是真丢了。

两害相权，工程上统一选"可能重复，但绝不丢"，也就是至少一次投递。代价是下游必须幂等——同一个 `eventId` 处理两次和一次的结果相同。

幂等的做法别用"先 select 查有没有、没有就 insert"，并发下两个线程会同时查到"没有"。直接用唯一索引兜底：下游建一张 `event_id` 唯一键的处理记录表，插入成功才继续干活，插入撞键就说明处理过了。

### 顺序这件事也要提前想清楚

单实例、串行扫表、按 id 升序发，同一个订单的事件顺序是保住的。一旦多实例并发扫表，两个实例可能同时抢到同一订单的两条事件，谁先发出去就说不准了。

要严格顺序只有两条路：按聚合 id 做路由分区（同一订单永远落到同一个队列或同一个消费者），或者干脆串行化中继并接受吞吐上限。绝大多数业务用不到严格顺序，事件里带上版本号、下游做状态机校验就够了。

## 三、实战：手把手写代码

下面是一个能直接跑起来的最小工程：下单、支付、发件箱落库、后台中继投递、下游幂等扣减。为了让你一个工程就能验证，下游接口放在同一个应用里，中继通过 HTTP 调它；真实项目里把它拆成独立服务，代码一行不用改。

### 1. 建表语句

先在 MySQL 里建库和表。`outbox_event` 的索引是重点，中继每两秒扫一次，没索引就是全表扫描。

```sql
CREATE DATABASE IF NOT EXISTS order_db DEFAULT CHARSET utf8mb4;
USE order_db;

CREATE TABLE orders (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_no    VARCHAR(32)     NOT NULL,
    user_id     VARCHAR(32)     NOT NULL,
    amount      DECIMAL(12, 2)  NOT NULL,
    status      VARCHAR(16)     NOT NULL,
    version     BIGINT          NOT NULL DEFAULT 0,
    created_at  DATETIME(3)     NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE outbox_event (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_id      CHAR(36)        NOT NULL,
    event_type    VARCHAR(64)     NOT NULL,
    aggregate_id  VARCHAR(64)     NOT NULL,
    payload       TEXT            NOT NULL,
    status        VARCHAR(16)     NOT NULL DEFAULT 'NEW',
    attempts      INT             NOT NULL DEFAULT 0,
    next_retry_at DATETIME(3)     NOT NULL,
    claimed_by    VARCHAR(64)              DEFAULT NULL,
    claimed_at    DATETIME(3)              DEFAULT NULL,
    created_at    DATETIME(3)     NOT NULL,
    updated_at    DATETIME(3)     NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_event_id (event_id),
    KEY idx_status_retry (status, next_retry_at),
    KEY idx_status_claimed (status, claimed_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE inventory_deduct_log (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_id   CHAR(36)        NOT NULL,
    order_no   VARCHAR(32)     NOT NULL,
    created_at DATETIME(3)     NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_event_id (event_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

`uk_event_id` 有两个作用：防止同一个事件被中继重复插入，以及给下游当幂等键。`idx_status_retry` 服务中继的扫描条件，`idx_status_claimed` 服务卡死回收，两个都不能省。

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
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>order-outbox</artifactId>
    <version>1.0.0</version>
    <name>order-outbox</name>

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
            <artifactId>spring-boot-starter-data-jpa</artifactId>
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

`spring-boot-starter-data-jpa` 顺手带上了 `spring-jdbc` 和 `JdbcTemplate`，下游那段幂等插入正好用得上，不用额外加依赖。

### 3. application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: order-outbox
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/order_db?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai
    username: root
    password: root
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: none
    properties:
      hibernate:
        jdbc:
          time_zone: Asia/Shanghai

outbox:
  relay:
    interval-ms: 2000
    batch-size: 100
    max-attempts: 8
    stuck-timeout-seconds: 30

inventory:
  base-url: http://127.0.0.1:8080
```

`ddl-auto: none` 是故意的，表由上面的 SQL 建，不让 Hibernate 猜结构。`open-in-view: false` 关掉懒加载的长事务，避免中继调用下游时还攥着数据库连接。

### 4. 启动类

```java
package com.example.outbox;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class OrderOutboxApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderOutboxApplication.class, args);
    }
}
```

`@EnableScheduling` 必须有，中继靠它驱动。

### 5. 领域事件与聚合根

先定义事件的基础接口，中继和发件箱只认这个接口，不认具体事件类型。

```java
package com.example.outbox.common.event;

public interface DomainEvent {

    String eventId();

    String eventType();

    String aggregateId();
}
```

支付事件是一个 record，字段就是下游需要的全部信息。

```java
package com.example.outbox.order.domain;

import com.example.outbox.common.event.DomainEvent;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record OrderPaidEvent(
        String eventId,
        Long orderId,
        String orderNo,
        String userId,
        BigDecimal amount,
        String payChannel,
        LocalDateTime paidAt) implements DomainEvent {

    @Override
    public String eventType() {
        return "ORDER_PAID";
    }

    @Override
    public String aggregateId() {
        return orderNo;
    }
}
```

订单状态枚举：

```java
package com.example.outbox.order.domain;

public enum OrderStatus {
    CREATED,
    PAID,
    CANCELLED
}
```

聚合根继承 Spring Data 的 `AbstractAggregateRoot`，用 `registerEvent` 攒事件。它自带的 `domainEvents()` 和 `clearDomainEvents()` 正好用来"取事件、清事件"。

```java
package com.example.outbox.order.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import org.springframework.data.domain.AbstractAggregateRoot;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.UUID;

@Entity
@Table(name = "orders")
public class Order extends AbstractAggregateRoot<Order> {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "order_no", nullable = false, length = 32)
    private String orderNo;

    @Column(name = "user_id", nullable = false, length = 32)
    private String userId;

    @Column(name = "amount", nullable = false, precision = 12, scale = 2)
    private BigDecimal amount;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 16)
    private OrderStatus status;

    @Version
    @Column(name = "version", nullable = false)
    private long version;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    protected Order() {
    }

    public Order(String orderNo, String userId, BigDecimal amount) {
        this.orderNo = orderNo;
        this.userId = userId;
        this.amount = amount;
        this.status = OrderStatus.CREATED;
        this.createdAt = LocalDateTime.now();
    }

    public void pay(String payChannel) {
        if (this.status != OrderStatus.CREATED) {
            throw new IllegalStateException("当前状态不允许支付: " + this.status);
        }
        this.status = OrderStatus.PAID;
        registerEvent(new OrderPaidEvent(
                UUID.randomUUID().toString(),
                this.id,
                this.orderNo,
                this.userId,
                this.amount,
                payChannel,
                LocalDateTime.now()));
    }

    public Long getId() {
        return id;
    }

    public String getOrderNo() {
        return orderNo;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public OrderStatus getStatus() {
        return status;
    }
}
```

`pay()` 里那个 if 不是摆设。状态机校验放在聚合根内部，意味着"只有 CREATED 能变 PAID"这条规则只有一个入口，Controller 想绕过都不行。重复支付被挡住，顺带也挡掉了重复事件。

事件 id 用 UUID 在聚合根里生成，不是发件箱落库时生成。这样同一个事件在整个链路里从出生到投递都带着同一个身份证，下游拿它做幂等。

`pay()` 里用到了 `this.id`，所以支付得走独立接口，订单先落库再支付。要在一个事务里建单加支付，先 `saveAndFlush` 拿到 id 再调 `pay()`，不然事件里的 orderId 是 null。

### 6. 发件箱实体与仓储

```java
package com.example.outbox.outbox;

public enum OutboxStatus {
    NEW,
    SENDING,
    SENT,
    FAILED
}
```

```java
package com.example.outbox.outbox;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.LocalDateTime;

@Entity
@Table(name = "outbox_event")
public class OutboxEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, length = 36)
    private String eventId;

    @Column(name = "event_type", nullable = false, length = 64)
    private String eventType;

    @Column(name = "aggregate_id", nullable = false, length = 64)
    private String aggregateId;

    @Column(name = "payload", nullable = false, columnDefinition = "text")
    private String payload;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 16)
    private OutboxStatus status;

    @Column(name = "attempts", nullable = false)
    private int attempts;

    @Column(name = "next_retry_at", nullable = false)
    private LocalDateTime nextRetryAt;

    @Column(name = "claimed_by", length = 64)
    private String claimedBy;

    @Column(name = "claimed_at")
    private LocalDateTime claimedAt;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;

    protected OutboxEvent() {
    }

    public static OutboxEvent newPending(String eventId, String eventType, String aggregateId, String payload) {
        OutboxEvent event = new OutboxEvent();
        LocalDateTime now = LocalDateTime.now();
        event.eventId = eventId;
        event.eventType = eventType;
        event.aggregateId = aggregateId;
        event.payload = payload;
        event.status = OutboxStatus.NEW;
        event.attempts = 0;
        event.nextRetryAt = now;
        event.createdAt = now;
        event.updatedAt = now;
        return event;
    }

    public Long getId() {
        return id;
    }

    public String getEventId() {
        return eventId;
    }

    public String getEventType() {
        return eventType;
    }

    public String getAggregateId() {
        return aggregateId;
    }

    public String getPayload() {
        return payload;
    }

    public int getAttempts() {
        return attempts;
    }

    public OutboxStatus getStatus() {
        return status;
    }
}
```

仓储里的扫描、抢占、回收全用原生 SQL。JPQL 写不了 `LIMIT`，而 CAS 更新必须带 `WHERE status = 'NEW'` 这个条件，原生 SQL 最直白。

```java
package com.example.outbox.outbox;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

public interface OutboxEventRepository extends JpaRepository<OutboxEvent, Long> {

    @Query(value = """
            SELECT * FROM outbox_event
            WHERE status = 'NEW' AND next_retry_at <= NOW(3)
            ORDER BY id
            LIMIT :limit
            """, nativeQuery = true)
    List<OutboxEvent> findPending(@Param("limit") int limit);

    @Transactional
    @Modifying
    @Query(value = """
            UPDATE outbox_event
            SET status = 'SENDING', claimed_by = :worker, claimed_at = NOW(3), updated_at = NOW(3)
            WHERE id = :id AND status = 'NEW'
            """, nativeQuery = true)
    int claim(@Param("id") Long id, @Param("worker") String worker);

    @Transactional
    @Modifying
    @Query(value = "UPDATE outbox_event SET status = 'SENT', updated_at = NOW(3) WHERE id = :id",
            nativeQuery = true)
    int markSent(@Param("id") Long id);

    @Transactional
    @Modifying
    @Query(value = """
            UPDATE outbox_event
            SET status = :status, attempts = :attempts, next_retry_at = :nextRetryAt,
                claimed_by = NULL, claimed_at = NULL, updated_at = NOW(3)
            WHERE id = :id
            """, nativeQuery = true)
    int markFailure(@Param("id") Long id,
                    @Param("status") String status,
                    @Param("attempts") int attempts,
                    @Param("nextRetryAt") LocalDateTime nextRetryAt);

    @Transactional
    @Modifying
    @Query(value = """
            UPDATE outbox_event
            SET status = 'NEW', claimed_by = NULL, claimed_at = NULL, updated_at = NOW(3)
            WHERE status = 'SENDING' AND claimed_at < :deadline
            """, nativeQuery = true)
    int releaseStuck(@Param("deadline") LocalDateTime deadline);
}
```

`releaseStuck` 是中继的保险绳。一条记录被标记成 SENDING 之后如果进程被 kill，它会永远卡在那，没人再处理。中继每轮先把超时的 SENDING 打回 NEW，才算闭环。

### 7. 写入发件箱

发件箱写入器只做一件事：把领域事件序列化成 JSON，插一行。

```java
package com.example.outbox.outbox;

import com.example.outbox.common.event.DomainEvent;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
public class OutboxAppender {

    private final OutboxEventRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public OutboxAppender(OutboxEventRepository repository) {
        this.repository = repository;
    }

    public void append(DomainEvent event) {
        String payload;
        try {
            payload = objectMapper.writeValueAsString(event);
        } catch (RuntimeException e) {
            throw new IllegalStateException("领域事件序列化失败: " + event.eventId(), e);
        }
        repository.save(OutboxEvent.newPending(event.eventId(), event.eventType(), event.aggregateId(), payload));
    }
}
```

序列化失败必须抛异常，不能吞。吞掉的后果是业务数据提交了、事件没落库，又回到丢消息的老路上。这里抛异常，整个事务回滚，接口报错，人工介入，比静默丢强一万倍。

仓储接口：

```java
package com.example.outbox.order.domain;

import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRepository extends JpaRepository<Order, Long> {
}
```

应用服务把"改状态"和"写发件箱"圈在同一个事务里：

```java
package com.example.outbox.order.application;

import com.example.outbox.common.event.DomainEvent;
import com.example.outbox.order.domain.Order;
import com.example.outbox.order.domain.OrderRepository;
import com.example.outbox.outbox.OutboxAppender;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

@Service
public class OrderApplicationService {

    private final OrderRepository orderRepository;
    private final OutboxAppender outboxAppender;

    public OrderApplicationService(OrderRepository orderRepository, OutboxAppender outboxAppender) {
        this.orderRepository = orderRepository;
        this.outboxAppender = outboxAppender;
    }

    @Transactional
    public Long create(String userId, BigDecimal amount) {
        String orderNo = "ORD" + System.currentTimeMillis();
        Order order = new Order(orderNo, userId, amount);
        return orderRepository.save(order).getId();
    }

    @Transactional
    public void pay(Long orderId, String payChannel) {
        Order order = orderRepository.findById(orderId)
                .orElseThrow(() -> new IllegalArgumentException("订单不存在: " + orderId));

        order.pay(payChannel);

        for (Object raw : order.domainEvents()) {
            if (raw instanceof DomainEvent event) {
                outboxAppender.append(event);
            }
        }
        order.clearDomainEvents();
    }
}
```

`@Transactional` 加在 `pay` 上，库存扣减那步没在这里出现——它由中继异步完成。事务边界只包住两件本地的事：更新 orders、插入 outbox_event。事务越短，锁持有时间越短，这是发件箱顺带带来的好处。

### 8. 中继投递

中继是整篇文章的核心，值得逐行看。

```java
package com.example.outbox.outbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxEventRepository repository;
    private final RestClient inventoryClient;
    private final String workerId = UUID.randomUUID().toString();
    private final int batchSize;
    private final int maxAttempts;
    private final long stuckTimeoutSeconds;

    public OutboxRelay(OutboxEventRepository repository,
                       RestClient inventoryClient,
                       @Value("${outbox.relay.batch-size:100}") int batchSize,
                       @Value("${outbox.relay.max-attempts:8}") int maxAttempts,
                       @Value("${outbox.relay.stuck-timeout-seconds:30}") long stuckTimeoutSeconds) {
        this.repository = repository;
        this.inventoryClient = inventoryClient;
        this.batchSize = batchSize;
        this.maxAttempts = maxAttempts;
        this.stuckTimeoutSeconds = stuckTimeoutSeconds;
    }

    @Scheduled(fixedDelayString = "${outbox.relay.interval-ms:2000}")
    public void relay() {
        int released = repository.releaseStuck(LocalDateTime.now().minusSeconds(stuckTimeoutSeconds));
        if (released > 0) {
            log.warn("回收了 {} 条卡在 SENDING 的事件", released);
        }

        List<OutboxEvent> pending = repository.findPending(batchSize);
        for (OutboxEvent event : pending) {
            if (repository.claim(event.getId(), workerId) == 0) {
                continue;
            }
            try {
                deliver(event);
                repository.markSent(event.getId());
            } catch (Exception ex) {
                handleFailure(event, ex);
            }
        }
    }

    private void deliver(OutboxEvent event) {
        inventoryClient.post()
                .uri("/internal/inventory/deduct")
                .contentType(MediaType.APPLICATION_JSON)
                .body(event.getPayload())
                .retrieve()
                .toBodilessEntity();
    }

    private void handleFailure(OutboxEvent event, Exception ex) {
        int attempts = event.getAttempts() + 1;
        long backoff = backoffSeconds(attempts);
        LocalDateTime nextRetryAt = LocalDateTime.now().plusSeconds(backoff);

        if (attempts >= maxAttempts) {
            repository.markFailure(event.getId(), OutboxStatus.FAILED.name(), attempts, nextRetryAt);
            log.error("事件投递失败，已达最大重试次数 eventId={} eventType={}",
                    event.getEventId(), event.getEventType(), ex);
            return;
        }
        repository.markFailure(event.getId(), OutboxStatus.NEW.name(), attempts, nextRetryAt);
        log.warn("事件投递失败，{} 秒后重试 eventId={} attempts={}",
                backoff, event.getEventId(), attempts);
    }

    private long backoffSeconds(int attempts) {
        long delay = 1L << Math.min(attempts, 8);
        return Math.min(delay, 300);
    }
}
```

几个细节值得掰开。

`deliver` 里用 `retrieve().toBodilessEntity()`，下游返回 4xx/5xx 会直接抛异常，被 catch 到进入重试。这就是"发送成功"的定义：**下游明确回 2xx**，不是"我没抛异常"。用 `exchange` 手动判断状态码，很容易漏掉 500。

`fixedDelay` 不是 `fixedRate`。fixedDelay 是上一轮跑完再等 2 秒，避免下游变慢时任务堆叠在一起，把自己压垮。

`backoffSeconds` 用 2 的幂：2、4、8……最长 300 秒。下游抖动时别一秒钟锤它八次，退避本身就是保护。

重试次数到顶后状态置成 FAILED，不是继续无限重试。这类记录需要人来判断——多半是数据格式不对或下游接口改了，机器重试一万次也没用。监控盯 `status = 'FAILED'` 的数量，比盯日志靠谱。

### 9. 下游幂等消费

下游接口收到的是一条 JSON 字符串，反序列化成对象：

```java
package com.example.outbox.inventory;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record OrderPaidMessage(
        String eventId,
        Long orderId,
        String orderNo,
        String userId,
        BigDecimal amount,
        String payChannel,
        LocalDateTime paidAt) {
}
```

幂等扣减用一条 SQL 完成，不需要先查后插：

```java
package com.example.outbox.inventory;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

@Service
public class InventoryDeductService {

    private static final Logger log = LoggerFactory.getLogger(InventoryDeductService.class);

    private final JdbcTemplate jdbcTemplate;

    public InventoryDeductService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void deduct(OrderPaidMessage message) {
        int inserted = jdbcTemplate.update("""
                INSERT INTO inventory_deduct_log (event_id, order_no, created_at)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE id = id
                """, message.eventId(), message.orderNo(), LocalDateTime.now());

        if (inserted == 0) {
            log.info("重复投递，直接跳过 eventId={} orderNo={}", message.eventId(), message.orderNo());
            return;
        }
        log.info("库存扣减成功 orderNo={} amount={}", message.orderNo(), message.amount());
    }
}
```

`ON DUPLICATE KEY UPDATE id = id` 这个写法不优雅但极其管用：撞唯一键时不报错、不插入，MySQL 返回影响行数 0。是 0 就说明这条事件处理过了，直接返回 200。

为什么不抛异常再 catch？在 `@Transactional` 里捕获约束冲突异常，Hibernate 的会话可能已经处于不可用状态，事务提交时会冒出更难查的错。用一条 SQL 判断，绕开这个坑。

下游 Controller：

```java
package com.example.outbox.inventory;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/inventory")
public class InventoryController {

    private final InventoryDeductService inventoryDeductService;

    public InventoryController(InventoryDeductService inventoryDeductService) {
        this.inventoryDeductService = inventoryDeductService;
    }

    @PostMapping("/deduct")
    public ResponseEntity<Void> deduct(@RequestBody OrderPaidMessage message) {
        inventoryDeductService.deduct(message);
        return ResponseEntity.ok().build();
    }
}
```

### 10. 下单接口与 RestClient 配置

```java
package com.example.outbox.order.web;

import com.example.outbox.order.application.OrderApplicationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderApplicationService orderApplicationService;

    public OrderController(OrderApplicationService orderApplicationService) {
        this.orderApplicationService = orderApplicationService;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody CreateOrderRequest request) {
        Long orderId = orderApplicationService.create(request.userId(), request.amount());
        return ResponseEntity.ok(Map.of("orderId", orderId));
    }

    @PostMapping("/{orderId}/pay")
    public ResponseEntity<Void> pay(@PathVariable Long orderId, @RequestBody PayOrderRequest request) {
        orderApplicationService.pay(orderId, request.payChannel());
        return ResponseEntity.ok().build();
    }

    public record CreateOrderRequest(String userId, BigDecimal amount) {
    }

    public record PayOrderRequest(String payChannel) {
    }
}
```

```java
package com.example.outbox.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

@Configuration
public class RestClientConfig {

    @Bean
    public RestClient inventoryRestClient(RestClient.Builder builder,
                                          @Value("${inventory.base-url}") String baseUrl) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(2000);
        factory.setReadTimeout(3000);
        return builder.baseUrl(baseUrl).requestFactory(factory).build();
    }
}
```

超时是硬要求。不配超时的话，下游卡住，中继线程就跟着卡死，整个发件箱停止流动——比丢消息更糟。

### 11. 跑起来验证

```bash
mvn spring-boot:run
```

另开一个终端：

```bash
# 下单
curl -s -X POST http://127.0.0.1:8080/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u1001","amount":99.00}'

# 支付（把上一步返回的 orderId 填进去）
curl -s -X POST http://127.0.0.1:8080/api/orders/1/pay \
  -H 'Content-Type: application/json' \
  -d '{"payChannel":"ALIPAY"}'

# 看发件箱状态，NEW -> SENDING -> SENT 应该几秒内走完
mysql -uroot -p order_db -e "SELECT id,event_type,status,attempts FROM outbox_event ORDER BY id;"

# 看下游处理记录
mysql -uroot -p order_db -e "SELECT event_id,order_no FROM inventory_deduct_log;"
```

再手动执行一次同样的 INSERT，把同一条 payload 重发，你会看到下游日志打出"重复投递，直接跳过"，而库存记录不会多一行。这就是幂等的实证，别只相信代码看着对。

## 四、踩坑经验和最佳实践

发件箱的坑集中在四类：发送和标记的时序、卡死状态、表膨胀、幂等写错。

### 坑一：把发送和状态更新塞进同一个大事务

有人在 `relay()` 上直接加 `@Transactional`，然后在里面调下游、改状态。发送成功、事务回滚，状态回到 NEW，下一轮再发一遍；反过来先改状态再发送，发送失败但事务提交了，消息就永远丢了。

正确做法是每步独立事务：发送在事务外，标记 SENT 是一次短事务。听起来"不够原子"，但发件箱的设计前提本来就是"至少一次"，靠下游幂等收敛，而不是强行让两步原子。

### 坑二：SENDING 状态成了"僵尸记录"

服务发到一半被 kill -9，记录停在 SENDING，扫描条件只认 NEW，这条事件再也没人管。线上表现是"发件箱里明明有记录，下游就是收不到"。

排查顺序：先按 `status='SENDING'` 数一下有多少，再看 `claimed_at` 有多久没动。超过业务允许的时间就是僵尸，代码里的 `releaseStuck` 会把它打回 NEW。生产上还要加告警：SENDING 超过 5 分钟的数量大于 0 就该有人看一眼。

### 坑三：outbox 表涨到几千万行，中继越来越慢

没有清理策略的表迟早出问题。SENT 的记录不是业务数据，留 7 天足够查问题。给清理单独一个定时任务：

```sql
DELETE FROM outbox_event
WHERE status = 'SENT' AND updated_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)
LIMIT 5000;
```

一次删 5000 行、循环删，别一条 DELETE 删几百万行——长事务、大 undo、主从延迟，全都来了。

### 坑四：幂等靠"先查后插"

```text
if (select count(*) from log where event_id = ? == 0) { insert ... }
```

两个中继实例同时投递，两个线程同时查到 0，同时插入，下游扣两次库存。并发下这个判断根本不成立。

唯一索引是唯一可靠的锁。要么 `INSERT ... ON DUPLICATE KEY UPDATE`，要么捕获 `DuplicateKeyException`（注意事务已脏的问题），要么用 `INSERT IGNORE` 再看影响行数。三种都行，前提是表上真有那个唯一键。

### 几条经验

- payload 只放下游真正需要的字段，别把整个聚合序列化进去。字段一多，下游升级就绑死在你的事件结构上。
- 事件里带 `eventType` 和版本号（比如 `ORDER_PAID_V1`），将来加字段时下游能分辨老新格式。
- 中继的 batch-size 别调太大。100 条一轮、2 秒一轮，够每秒 50 条；真到高吞吐再改成批量标记 SENT，别一上来就 5000 条。
- FAILED 的记录必须有人管。做个接口或页面把它们列出来，支持人工重投，比重试次数调大有用得多。
- 别用发件箱干"实时性要求毫秒级"的事。2 秒一轮的轮询，天生就有秒级延迟。

## 五、性能对比和技术选型

发件箱不是唯一解，选之前先看自己的约束：一致性要求、是否已有 MQ、能不能接受改表。

| 方案 | 一致性 | 侵入性 | 适合什么场景 |
| --- | --- | --- | --- |
| 本地消息表（发件箱） | 最终一致，延迟秒级 | 业务库加一张表 + 一个中继 | 已有业务库、不想强依赖 MQ、量中等 |
| RocketMQ 事务消息 | 最终一致，延迟毫秒级 | 业务要接 MQ，broker 要支持回查 | 已在用 RocketMQ、吞吐要求高 |
| Seata AT 模式 | 强一致，靠全局锁 | 高，数据源要代理，改造成本大 | 短事务、内部系统、不能容忍中间态 |
| 定时对账补偿 | 最终一致，延迟分钟到小时 | 最低，独立任务 | 所有方案的兜底，不是主方案 |

性能上，发件箱给每次业务写多了一次 insert，同库同事务，开销基本可以忽略——本来就要写订单，多写一行小表，差距在微秒级。真正的瓶颈在中继：一轮 100 条、每条一次 HTTP，单实例大约每秒 30~50 条。要提速有三个方向：批量投递（下游提供批量接口）、多实例并发（CAS 已经保证不重复）、按聚合 id 分片路由。

我自己的偏好：**业务库已经有 MySQL、团队规模不大，就用发件箱**。它不引入新组件，出问题能在自己库里查得清清楚楚，比"消息到底发没发"这种黑盒强太多。已经重度使用 RocketMQ 且量很大的团队，事务消息更省事，但要注意它的事务回查只保证"消息最终会发"，消费端幂等一样跑不掉。

Seata 这类强一致方案，我建议只在"绝对不能出现中间态"的场景用，比如账务核心。它把锁放大到全局，吞吐和运维复杂度都是数量级的代价，普通业务订单根本不需要。

## 六、总结

领域事件丢失的根因是跨系统写没有共同事务，发件箱用一张表把这件事变回本地事务。

落地只需要记住四件事：

- 事件和业务数据在同一个本地事务里落库，靠数据库保证原子性。
- 中继先 CAS 抢占再发送，多实例不会重复；发完再标记，宁可重复不可丢。
- 下游用唯一键做幂等，别用"先查后插"。
- SENDING 要能回收、SENT 要能清理、FAILED 要有人看。

代码不长，难的是把这些细节都想在前面。真出了事故，你回头看的不是"消息中间件为什么不靠谱"，而是"当初为什么没把那行记录写下来"。

文 / 会编程的吕洞宾

## 参考资料

- [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [AbstractAggregateRoot 官方 Javadoc](https://docs.spring.io/spring-data/commons/docs/current/api/org/springframework/data/domain/AbstractAggregateRoot.html)
- [RestClient 官方 Javadoc](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/client/RestClient.html)
- [Spring Boot 通用配置项](https://docs.spring.io/spring-boot/appendix/application-properties/index.html)

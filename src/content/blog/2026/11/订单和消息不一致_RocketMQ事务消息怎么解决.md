---
title: "订单和消息不一致，RocketMQ事务消息怎么解决"
date: 2026-11-12T09:00:00+08:00
category: "中间件"
tags: ["rocketmq"]
---

> 下单接口里，代码先写订单表，再发一条消息让积分服务加积分。发消息超时抛异常，接口返回失败，用户又点了一次；最后订单一条，积分加了两回。反过来也发生过：消息出去了，本地事务回滚，积分加了，订单查不到。两个系统都没报错，账就是对不上。这不是手滑，是本地事务和远程消息之间，天生缺一个共同的成功点。

## 一、订单和消息不一致，问题到底出在哪

结论：数据库事务和消息发送分属两个系统，没有任何一个事务能同时管住两者的提交，所以「先写库再发消息」和「先发消息再写库」都存在不一致窗口。

先把最常见的三种写法摆出来，对号入座。

| 写法 | 出问题的时刻 | 最终结果 |
| --- | --- | --- |
| 先写订单表，再发消息 | 发消息失败或超时 | 有订单，没消息 |
| 先发消息，再写订单表 | 消费者比本地提交更快 | 有消息，查不到订单 |
| 把发消息塞进 `@Transactional`，异常直接 catch | 事务没提交，或者后面回滚 | 消费者读不到；消息也撤不回 |

第一种写法最普遍。写库成功了，`producer.send()` 抛个超时，代码打了个日志就返回。订单在，积分没加。更麻烦的是「超时」不等于「失败」：Broker 可能已经收下消息，只是响应回来晚了。你如果重试，消息就重复了。

第二种写法看起来更稳，其实把风险推给了消费端。消息先到 Broker，消费者可能比订单库提交还快，一查订单不存在，重试几次后丢弃。订单服务这边如果写库失败，消息已经发出去了，撤不回来。

第三种最隐蔽。很多人以为加了 `@Transactional` 就万事大吉，但事务提交发生在方法返回之后。方法里发消息时，订单还没提交，消费者读不到；就算读到了，后面事务回滚，消息也不会跟着消失。把异常 catch 掉不抛，事务照样提交，消息却没发出去，等于自己骗自己。

有人会问：那我把发消息放到事务提交之后，用 `TransactionSynchronization#afterCommit` 不就行了？

这只解决了「消费者读不到」的问题，解决不了「提交后发消息失败」。事务已经提交，消息发不出去，你手里没有任何回滚手段，只能靠补偿任务或者人工对账。本质还是最终一致，只是把窗口挪了个位置。

事务消息要干的事很明确：**把「消息是否对消费者可见」交给 Broker，并且和本地事务的执行结果绑在一起。** 本地事务成功，消息才可见；本地事务失败，消息永远不出现；生产者没来得及回话，Broker 主动来问。

## 二、RocketMQ 事务消息的原理

结论：RocketMQ 事务消息用「半消息 + 本地事务 + 回查」三步，把本地数据库事务和消息可见性做成一个整体。

流程不复杂，先看图。

```
Producer（订单服务）          Broker                    MySQL
      |                         |                         |
      |--- 1. 发送半消息 ------->|                         |
      |<-- 2. 落盘成功 ----------|                         |
      |--- 3. 执行本地事务 ------------------------------>|
      |--- 4. commit / rollback->|                         |
      |                         |--- 5. 恢复到真实 topic  |
```

拆开说。

1. 生产者先发一条「半消息」给 Broker。半消息被写进内部 topic `RMQ_SYS_TRANS_HALF_TOPIC`，业务消费者看不到它。
2. Broker 落盘成功，给生产者回一个确认。到这一步，消息已经安全存下来了，但还没生效。
3. 生产者执行本地事务，比如往 `orders` 表插一条订单。
4. 本地事务有结果了，生产者告诉 Broker：提交还是回滚。
5. 提交，Broker 把消息从半消息 topic 恢复到真实业务 topic，消费者这才能看到；回滚，Broker 标记删除，消息不会出现在业务 topic。

关键在「如果第 4 步没发生」：生产者进程崩了、网络断了、回包丢了，Broker 不知道这条消息该不该放行。

这时 Broker 会主动回查。默认半消息超过 6 秒还没收到确认，就开始回查，之后每 60 秒一次，最多 15 次。对应 Broker 的三个参数：`transactionTimeOut`、`transactionCheckInterval`、`transactionCheckMax`。

回查请求发给生产者组，由组里任意一个还活着的生产者实例处理。处理逻辑就是 `checkLocalTransaction`：去数据库查这笔订单到底在不在。在，提交；不在，继续等。

注意，回查查的必须是持久化状态，不能查内存里的 Map。生产者重启后内存什么都没了，只有数据库还认得这笔订单。

### 三个返回值，别乱用

`executeLocalTransaction` 和 `checkLocalTransaction` 都返回 `LocalTransactionState`，只有三个值：

- `COMMIT_MESSAGE`：本地事务确定成功，放行消息。
- `ROLLBACK_MESSAGE`：本地事务确定失败，丢弃消息。
- `UNKNOW`：现在判断不了，等 Broker 下次回查。

最危险的写法，是回查时查不到订单就直接返回 `ROLLBACK_MESSAGE`。本地事务可能只是还没提交，或者主从延迟导致从库还没同步。你一回滚，半消息被丢掉，本地事务随后提交成功，订单有了，消息永远没了。

查不到就返回 `UNKNOW`，让 Broker 再问几次。只有确定业务失败，才回滚。

反过来，`executeLocalTransaction` 里把数据库异常全 catch 掉然后返回 `COMMIT_MESSAGE`，等于告诉 Broker「事务成功了」，消息直接放行。订单没写进去，积分倒是加了。这种 bug 对账时最难查，因为两边日志都「正常」。

还有个边界：15 次回查都拿不到明确结果，Broker 会放弃这条半消息并记日志。它不会进死信队列，也不会自动补偿。所以半消息堆积和回查失败必须做监控，不能等业务方发现积分少了才去翻日志。

### 它保证什么，不保证什么

事务消息保证的是：本地事务成功与消息可见，这两件事要么一起成立，要么一起不成立。

它不保证消费只发生一次。消息投递仍然是 at-least-once，消费者重启、网络抖动、消费超时，都可能让同一条消息再来一遍。消费端幂等不是可选项，是这套方案的一部分。

它也不支持延迟消息和批量消息。事务消息的发送路径和普通消息不一样，别指望在同一个 producer 上混着用所有特性。

## 三、实战：Spring Boot 接入 RocketMQ 事务消息

结论：订单服务只负责发半消息和执行本地事务，消费端用唯一键去重，整条链路就能做到最终一致。

先看项目全貌，所有类都在 `com.example.rocketmqtx` 包下，复制即可运行。

```
rocketmq-tx-demo
├── pom.xml
└── src/main
    ├── java/com/example/rocketmqtx
    │   ├── OrderApplication.java
    │   ├── Order.java
    │   ├── OrderRepository.java
    │   ├── OrderLocalService.java
    │   ├── OrderTransactionListener.java
    │   ├── RocketMqProducerConfig.java
    │   ├── OrderService.java
    │   ├── OrderController.java
    │   └── OrderConsumerConfig.java
    └── resources
        ├── application.yml
        └── schema.sql
```

本地先起一个 RocketMQ，nameserver 和 broker 各一个：

```bash
export ROCKETMQ_HOME=/opt/rocketmq
cd /opt/rocketmq
nohup sh bin/mqnamesrv > /tmp/namesrv.log 2>&1 &
nohup sh bin/mqbroker -n 127.0.0.1:9876 > /tmp/broker.log 2>&1 &
```

本地 broker 默认允许自动创建 topic；如果关掉了自动创建，先用 `mqadmin` 建一个 `order-tx-topic`。

### 1. pom.xml

演示用 H2 内存库，省掉装 MySQL 的步骤；换成生产库时，把 H2 依赖换成 MySQL 驱动，改一下连接串即可，业务代码不用动。

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
    <artifactId>rocketmq-tx-demo</artifactId>
    <version>1.0.0</version>

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
            <groupId>org.apache.rocketmq</groupId>
            <artifactId>rocketmq-client</artifactId>
            <version>5.5.1</version>
        </dependency>
        <dependency>
            <groupId>com.h2database</groupId>
            <artifactId>h2</artifactId>
            <version>2.5.252</version>
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

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:h2:mem:orderdb;MODE=MySQL;DB_CLOSE_DELAY=-1
    driver-class-name: org.h2.Driver
    username: sa
    password: ""

rocketmq:
  name-server: 127.0.0.1:9876
  producer-group: order_tx_producer_group
  consumer-group: order_tx_consumer_group
  topic: order-tx-topic
```

### 3. schema.sql

Spring Boot 对嵌入式数据库默认会执行 `schema.sql`，不用额外配置。

```sql
CREATE TABLE IF NOT EXISTS orders (
    order_id   VARCHAR(64) PRIMARY KEY,
    user_id    BIGINT        NOT NULL,
    amount     DECIMAL(10, 2) NOT NULL,
    status     VARCHAR(16)   NOT NULL,
    created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_notify (
    order_id    VARCHAR(64) PRIMARY KEY,
    notified_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`orders` 是本地事务写的数据，`order_notify` 是消费端去重用的表。`order_id` 做主键，同一条消息来第二遍，插入会撞主键，直接跳过。

### 4. 启动类和订单模型

启动类没有特殊配置，`@SpringBootApplication` 扫到同包下的组件就行。

```java
package com.example.rocketmqtx;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}
```

订单模型用 record，字段和 `orders` 表一一对应。它只在生产者进程内传递，不会被序列化进消息体。

```java
package com.example.rocketmqtx;

import java.math.BigDecimal;
import java.time.Instant;

public record Order(String orderId, long userId, BigDecimal amount, String status, Instant createdAt) {
}
```

`Order` 会作为参数直接传给事务监听器，不经过序列化。消息体里只放订单 ID，用户和金额放在消息属性里，消费端读属性就够了。

### 5. 订单仓储和本地事务

仓储类只做两件事：写订单、按订单号查存在性。回查逻辑依赖 `existsById`，所以查询必须走数据库，不能加本地缓存。

```java
package com.example.rocketmqtx;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.util.List;
import java.util.Map;

@Repository
public class OrderRepository {

    private final JdbcTemplate jdbcTemplate;

    public OrderRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void insert(Order order) {
        jdbcTemplate.update(
                "INSERT INTO orders (order_id, user_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)",
                order.orderId(),
                order.userId(),
                order.amount(),
                order.status(),
                Timestamp.from(order.createdAt()));
    }

    public boolean existsById(String orderId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM orders WHERE order_id = ?", Integer.class, orderId);
        return count != null && count > 0;
    }

    public Map<String, Object> findOrder(String orderId) {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT order_id, user_id, amount, status, created_at FROM orders WHERE order_id = ?",
                orderId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public int countNotify(String orderId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM order_notify WHERE order_id = ?", Integer.class, orderId);
        return count == null ? 0 : count;
    }
}
```

本地事务单独抽成一个 Bean，方法上加 `@Transactional`。监听器调用它时走的是 Spring 代理，异常才能触发回滚。

```java
package com.example.rocketmqtx;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderLocalService {

    private final OrderRepository orderRepository;

    public OrderLocalService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional
    public void createOrder(Order order) {
        orderRepository.insert(order);
    }
}
```

`createOrder` 单独放在一个 Bean 里，是为了让 `@Transactional` 经过 Spring 代理生效。如果写在监听器里自己调自己，事务注解会被绕过，出了异常也回滚不了。

### 6. 事务监听器

这是整篇文章的核心。本地事务在这里执行，回查逻辑也在这里。

```java
package com.example.rocketmqtx;

import org.apache.rocketmq.client.producer.LocalTransactionState;
import org.apache.rocketmq.client.producer.TransactionListener;
import org.apache.rocketmq.common.message.Message;
import org.apache.rocketmq.common.message.MessageExt;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;

@Component
public class OrderTransactionListener implements TransactionListener {

    private static final Logger log = LoggerFactory.getLogger(OrderTransactionListener.class);

    private final OrderLocalService orderLocalService;
    private final OrderRepository orderRepository;

    public OrderTransactionListener(OrderLocalService orderLocalService,
                                    OrderRepository orderRepository) {
        this.orderLocalService = orderLocalService;
        this.orderRepository = orderRepository;
    }

    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        Order order = (Order) arg;
        try {
            orderLocalService.createOrder(order);
            return LocalTransactionState.COMMIT_MESSAGE;
        } catch (DuplicateKeyException e) {
            // 同一个订单重复执行，说明之前已经成功，直接放行消息
            log.warn("订单已存在，按成功处理 orderId={}", order.orderId());
            return LocalTransactionState.COMMIT_MESSAGE;
        } catch (DataAccessException e) {
            // 数据库超时、连接断开，事务到底提交没提交不知道，交给 Broker 回查
            log.error("本地事务结果未知，等待回查 orderId={}", order.orderId(), e);
            return LocalTransactionState.UNKNOW;
        }
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        String orderId = msg.getUserProperty("orderId");
        boolean exists = orderRepository.existsById(orderId);
        if (exists) {
            return LocalTransactionState.COMMIT_MESSAGE;
        }
        // 查不到不代表失败，可能事务还没提交，也可能是主从延迟
        log.info("回查未找到订单，继续等待 orderId={}", orderId);
        return LocalTransactionState.UNKNOW;
    }
}
```

两个 catch 的区别很关键。`DuplicateKeyException` 说明订单已经写进去了，属于重复执行，可以按成功处理。`DataAccessException` 说明结果不确定，必须返回 `UNKNOW`，让 Broker 回查。如果你在这里返回 `ROLLBACK_MESSAGE`，数据库其实提交成功了，消息也会被丢掉。

### 7. 生产者配置

生产者用 `TransactionMQProducer`，启动前必须把监听器设置进去，否则发送时会直接报 `TransactionListener is null`。

```java
package com.example.rocketmqtx;

import org.apache.rocketmq.client.producer.TransactionMQProducer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RocketMqProducerConfig {

    @Bean(initMethod = "start", destroyMethod = "shutdown")
    public TransactionMQProducer transactionMQProducer(
            @Value("${rocketmq.name-server}") String nameServer,
            @Value("${rocketmq.producer-group}") String producerGroup,
            OrderTransactionListener transactionListener) {
        TransactionMQProducer producer = new TransactionMQProducer(producerGroup);
        producer.setNamesrvAddr(nameServer);
        producer.setTransactionListener(transactionListener);
        producer.setSendMsgTimeout(3000);
        producer.setRetryTimesWhenSendFailed(2);
        return producer;
    }
}
```

`initMethod = "start"` 让 Spring 在 Bean 初始化时启动生产者，`destroyMethod = "shutdown"` 保证应用关闭时释放资源。生产者组名必须固定，Broker 回查时会发给这个组，组名每次启动都变，就没人能回答回查了。

### 8. 下单服务

下单服务只负责组装消息和发起事务消息发送，真正的数据库写入在监听器里完成。

```java
package com.example.rocketmqtx;

import org.apache.rocketmq.client.exception.MQClientException;
import org.apache.rocketmq.client.producer.LocalTransactionState;
import org.apache.rocketmq.client.producer.TransactionMQProducer;
import org.apache.rocketmq.client.producer.TransactionSendResult;
import org.apache.rocketmq.common.message.Message;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;

@Service
public class OrderService {

    private final TransactionMQProducer producer;
    private final String topic;

    public OrderService(TransactionMQProducer producer,
                        @Value("${rocketmq.topic}") String topic) {
        this.producer = producer;
        this.topic = topic;
    }

    public PlaceOrderResult placeOrder(long userId, BigDecimal amount) throws MQClientException {
        String orderId = UUID.randomUUID().toString().replace("-", "");
        Order order = new Order(orderId, userId, amount, "CREATED", Instant.now());

        Message message = new Message(
                topic,
                "ORDER_CREATED",
                orderId,
                orderId.getBytes(StandardCharsets.UTF_8));
        message.putUserProperty("orderId", orderId);
        message.putUserProperty("userId", String.valueOf(userId));
        message.putUserProperty("amount", amount.toPlainString());

        TransactionSendResult result = producer.sendMessageInTransaction(message, order);
        LocalTransactionState state = result.getLocalTransactionState();

        if (state == LocalTransactionState.ROLLBACK_MESSAGE) {
            throw new IllegalStateException("本地事务已回滚，订单创建失败");
        }
        return new PlaceOrderResult(orderId, state);
    }

    public record PlaceOrderResult(String orderId, LocalTransactionState state) {
    }
}
```

注意，`UNKNOW` 不抛异常。它不代表失败，只代表「现在还不知道」，订单可能已经写进去了。接口把状态原样返回，前端别一看不是成功就引导用户重新下单，否则会生成两笔订单。真实项目里应该提供一个按订单号查询的接口，让用户刷新结果。

### 9. 控制器

控制器暴露两个接口：一个下单，一个按订单号查结果。查询接口在演示里用来确认订单和积分通知是否都落库。

```java
package com.example.rocketmqtx;

import org.apache.rocketmq.client.exception.MQClientException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;
    private final OrderRepository orderRepository;

    public OrderController(OrderService orderService, OrderRepository orderRepository) {
        this.orderService = orderService;
        this.orderRepository = orderRepository;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody CreateOrderRequest request)
            throws MQClientException {
        OrderService.PlaceOrderResult result =
                orderService.placeOrder(request.userId(), request.amount());
        return ResponseEntity.ok(Map.of(
                "orderId", result.orderId(),
                "transactionState", result.state().name()));
    }

    @GetMapping("/{orderId}")
    public ResponseEntity<Map<String, Object>> query(@PathVariable String orderId) {
        Map<String, Object> order = orderRepository.findOrder(orderId);
        if (order == null) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> body = new LinkedHashMap<>(order);
        body.put("notifyCount", orderRepository.countNotify(orderId));
        return ResponseEntity.ok(body);
    }

    public record CreateOrderRequest(long userId, BigDecimal amount) {
    }
}
```

### 10. 消费端

消费端监听业务 topic，收到消息后先写去重表，再执行真正的业务动作。演示里业务动作简化成一行日志。

```java
package com.example.rocketmqtx;

import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerConcurrently;
import org.apache.rocketmq.client.exception.MQClientException;
import org.apache.rocketmq.common.message.MessageExt;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;

@Configuration
public class OrderConsumerConfig {

    private static final Logger log = LoggerFactory.getLogger(OrderConsumerConfig.class);

    @Bean(initMethod = "start", destroyMethod = "shutdown")
    public DefaultMQPushConsumer orderConsumer(
            @Value("${rocketmq.name-server}") String nameServer,
            @Value("${rocketmq.consumer-group}") String consumerGroup,
            @Value("${rocketmq.topic}") String topic,
            JdbcTemplate jdbcTemplate) {
        DefaultMQPushConsumer consumer = new DefaultMQPushConsumer(consumerGroup);
        consumer.setNamesrvAddr(nameServer);
        consumer.subscribe(topic, "*");
        consumer.setConsumeThreadMin(4);
        consumer.setConsumeThreadMax(16);

        consumer.registerMessageListener((MessageListenerConcurrently) (messages, context) -> {
            for (MessageExt message : messages) {
                String orderId = new String(message.getBody(), StandardCharsets.UTF_8);
                String userId = message.getUserProperty("userId");
                String amount = message.getUserProperty("amount");
                try {
                    jdbcTemplate.update(
                            "INSERT INTO order_notify (order_id) VALUES (?)", orderId);
                    log.info("积分发放成功 orderId={} userId={} amount={}", orderId, userId, amount);
                } catch (DuplicateKeyException e) {
                    log.info("重复消息，跳过 orderId={}", orderId);
                } catch (Exception e) {
                    log.error("消费失败，稍后重试 orderId={}", orderId, e);
                    return ConsumeConcurrentlyStatus.RECONSUME_LATER;
                }
            }
            return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
        });

        return consumer;
    }
}
```

消费端没有用 `orderId` 做内存去重，而是直接让数据库主键兜底。内存去重重启就没了，多实例之间也不共享，只有唯一约束才是真的幂等。

### 11. 跑起来

启动应用后，发一笔订单：

```bash
curl -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":1001,"amount":99.00}'
```

返回类似：

```json
{"orderId":"8f3c1a2b4d5e4f6a9b0c1d2e3f4a5b6c","transactionState":"COMMIT_MESSAGE"}
```

再查订单和消费结果：

```bash
curl http://localhost:8080/orders/8f3c1a2b4d5e4f6a9b0c1d2e3f4a5b6c
```

返回里 `notifyCount` 应该是 1。把同一条消息重复投递，这个数还是 1，说明唯一键去重生效了。

## 四、踩坑经验和最佳实践

结论：事务消息的坑，九成出在回查逻辑和消费幂等上，而不是发送代码本身。

### 回查查不到就回滚，消息直接丢

这是最常见的线上事故。本地事务还在执行，或者主从延迟几百毫秒，回查线程去从库一查，没有，返回 `ROLLBACK_MESSAGE`。Broker 把半消息删了，本地事务随后提交成功。订单有了，积分永远没有。

回查逻辑只认两件事：查到记录就提交，查不到就 `UNKNOW`。如果读写分离，回查最好强制走主库，或者至少接受短暂延迟，别急着下结论。

### 把异常吞掉返回 COMMIT

`executeLocalTransaction` 里 `try { ... } catch (Exception e) { return COMMIT_MESSAGE; }`，看起来「保证消息发出去」，实际是让消息在订单没落库的情况下被消费。这种问题不会立刻报错，只会在对账时冒出来。

只有确定本地事务提交成功，才返回 `COMMIT_MESSAGE`。不确定就 `UNKNOW`。

### 生产者组每次启动都换

有人图省事，组名拼上时间戳或者 UUID。Broker 回查时按组找生产者，找不到人，半消息一直堆着，15 次之后被放弃。组名固定，多实例用同一个组。

### 消费端不做幂等

事务消息只保证「本地事务成功 ⇔ 消息可见」，不保证只消费一次。消费者重启、超时重试、Broker 重投，都会让同一条消息再来。用业务唯一键、去重表或者状态机，选一个能落地的。

### 半消息堆积没人看

`RMQ_SYS_TRANS_HALF_TOPIC` 的消息数量、回查失败日志、Broker 放弃半消息的日志，都要进监控。事务消息的失败是静默的，不会像普通消息那样进死信队列等你处理。

### 大事务塞进本地事务

本地事务执行时间越长，半消息处于「未决」状态越久，回查线程压力越大。下单主链路只写必要的表，发积分、发短信这些动作交给消费端，别在一个事务里干完所有事。

之前一个支付项目就踩过这个坑：回调里先更新订单状态，再同步发积分消息，`send` 超时 3 秒。大促时 Broker 抖了一下，`send` 抛超时，代码 catch 住只打了日志，订单状态已经提交。用户看到「支付成功」，积分没加。更糟的是那条超时的消息其实到了 Broker，消费端加了积分；补偿任务又扫到「未发消息」，补发了一次。一笔支付，积分加了两回。

后来改成事务消息，消费端用 `payment_id` 做唯一键，补偿任务只负责查漏，不再盲目重发。对账从每天几十条降到零。

## 五、事务消息、本地消息表、Seata 怎么选

结论：已有 RocketMQ 的核心链路优先事务消息；没有 MQ 就用本地消息表；Seata 留给真正需要跨库原子性的后台操作。

| 方案 | 一致性 | 额外依赖 | 适合场景 |
| --- | --- | --- | --- |
| RocketMQ 事务消息 | 最终一致，有回查兜底 | RocketMQ | 下单、支付等已有 MQ 的核心链路 |
| 本地消息表 | 最终一致，靠定时任务重试 | 业务库 + 调度任务 | 没上 MQ，或者想自己掌控重试节奏 |
| Seata AT | 接近强一致 | Seata Server、undo_log | 跨库短事务、后台操作 |
| 最大努力通知 | 最终一致，可靠性最弱 | 通知接口 + 查询接口 | 对外商户回调 |

事务消息的优点是代码侵入小，本地事务和发消息在一个方法里完成，不用额外建消息表。代价是绑定 RocketMQ，而且回查逻辑必须写对。

本地消息表把消息和业务数据写在同一个库、同一个事务里，定时任务扫表投递。它不依赖 MQ 的高级特性，换 Kafka、RabbitMQ 都能用，缺点是多了张表、多了扫描延迟，消息量大时扫表也会成为负担。

Seata AT 适合「两个库必须一起成功」的短事务，比如后台调账。它要锁数据、写 undo_log，性能开销不小，别塞进高并发下单主链路。

一句话：事务消息买的是「本地事务和消息可见性绑定」，不是端到端强一致。别指望它替你解决消费失败和业务幂等。

## 六、总结

事务消息的核心就三件事：半消息先存住，本地事务决定放不放行，生产者失联时 Broker 回查。

落地时盯紧三个点：回查必须查持久化状态，查不到返回 `UNKNOW`；消费端必须幂等，唯一键比内存去重靠谱；半消息堆积和回查失败必须有监控。

消息中间件能帮你兜住失败，兜不住你没想清楚的业务状态。

文 / 会编程的吕洞宾

## 参考资料

- [RocketMQ 事务消息](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
- [RocketMQ 快速开始](https://rocketmq.apache.org/docs/quickStart/01quickstart/)
- [Apache RocketMQ 5.5.1 Release](https://github.com/apache/rocketmq/releases/tag/rocketmq-all-5.5.1)
- [Spring Boot Reference Documentation](https://docs.spring.io/spring-boot/index.html)

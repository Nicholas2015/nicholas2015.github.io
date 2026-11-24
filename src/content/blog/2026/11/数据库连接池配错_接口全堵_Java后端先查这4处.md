---
title: "数据库连接池配错，接口全堵，Java后端先查这4处"
date: 2026-11-08T09:00:00+08:00
category: "数据库"
tags: ["mysql"]
---

> 周二下午三点，订单接口的响应时间从 80 毫秒涨到 6 秒，网关开始大面积 504。运维加了四台机器，情况反而更糟。日志里翻来覆去只有一句：`Connection is not available, request timed out after 30000ms`。这不是数据库撑不住了，是连接池的参数把你卖了。池子里只有 20 个连接，一条 SQL 平均跑 2 秒，这台服务理论上最多顶住 10 QPS，剩下的请求全在队列里干等。下面这四个参数，配错一个就够你加班到半夜。

## 一、这个问题到底是什么

连接池打满的本质，不是"连接数量不够"，而是"借出去的连接回不来"。

打个比方。连接池就是停车场，连接就是车位，每个 HTTP 请求都是一辆要停进来的车。车位只有 20 个，车停进去办完事就得开走。现在的问题是：有的车进去以后赖着不走，后面的车只能在门口排队，排到 30 秒还没位置，直接掉头走人——这就是你看到的 `Connection is not available`。

真实线上，车位不够只是表象，背后的原因通常就这几类：

| 现象 | 真实原因 | 先查什么 |
| --- | --- | --- |
| 报 `Connection is not available, request timed out after 30000ms` | 池里连接被占满，等待队超时 | `SHOW PROCESSLIST` 看有没有长事务、慢 SQL |
| 报 `Communications link failure` | 连接早就被 MySQL 单方面关掉了，池里还以为是活的 | `maxLifetime` 和 MySQL `wait_timeout` 的大小关系 |
| 白天正常，凌晨定时任务一跑就卡死 | 批量任务独占连接，业务线程饿死 | 定时任务和业务是否共用同一个池 |
| 加了机器更慢 | 连接总数翻倍，数据库连接数和锁竞争暴涨 | 数据库 `max_connections`、CPU、上下文切换 |
| QPS 上不去，CPU 却不高 | 池的吞吐上限 = 池大小 ÷ 平均 SQL 耗时 | 慢 SQL，不是加连接 |

第一个要纠正的观念：连接池不是越大越好。它更像一个限流器，池子大小决定了你能同时压给数据库多少并发。你把它调大，等于把水龙头拧大，数据库那头该堵还是堵，只是堵的位置从应用挪到了数据库。

HikariCP 是 Spring Boot 默认的连接池，`spring-boot-starter-jdbc` 和 `spring-boot-starter-data-jpa` 都会自动带上它。也就是说，你可能从来没配过它，但它一直在用默认参数跑你的核心业务。默认值长这样：

- `maximumPoolSize` = 10
- `minimumIdle` = 10（等于最大值，即固定大小池）
- `connectionTimeout` = 30000 毫秒
- `maxLifetime` = 1800000 毫秒（30 分钟）
- `keepaliveTime` = 0（关闭）
- `leakDetectionThreshold` = 0（关闭）

十个连接，对一台四核机器跑中小流量业务勉强够用；一旦有慢 SQL、有长事务、有批量任务，立刻见底。而 30 秒的等待超时，会让请求在池子门口白白挂半分钟，把 Tomcat 线程也一起拖住。

## 二、底层原理到底怎么回事

### 一次借连接，HikariCP 到底做了什么

HikariCP 借连接的过程分四步，理解了这四步，参数为什么这么配就全通了。

1. 先从 `ConcurrentBag` 里拿一个本地线程缓存的空闲连接。每个线程有自己的小仓库，绝大多数请求在这一步就返回了，无锁、极快。
2. 本地没有，就去全局的空闲列表里抢。抢到之前会做一次存活检查，但只在连接空闲超过 500 毫秒时才检查，避免每次 borrow 都发一次网络往返。
3. 全局也没有空闲的，看当前连接总数是否小于 `maximumPoolSize`。小于就新建一个物理连接——这一步要跟 MySQL 握手、鉴权，通常 5 到 20 毫秒，比复用慢两个数量级。
4. 总数已经到顶，线程进入等待队列，一直等到有人归还连接，或者等到 `connectionTimeout` 超时抛异常。

关键在第四步。`connectionTimeout` 不是"SQL 执行超时"，是"排队等车位的超时"。配 30 秒的意思就是：车位满了，你在门口站 30 秒，30 秒后还没人走，才告诉你失败。这 30 秒里，Tomcat 的工作线程被你占着，什么都干不了。

### 池子该开多大，公式比直觉靠谱

HikariCP 官方 wiki 里给了一个公式，来自 PostgreSQL 社区多年的压测经验：

```
connections = ((core_count * 2) + effective_spindle_count)
```

四核、一块 SSD，算下来是 9 个连接。听着少得离谱对吧？但压测数据就是这么打脸：连接数从 10 加到 100，吞吐几乎不涨，延迟反而翻倍。

原因不复杂。一个数据库连接在 MySQL 服务端就是一个线程，加一份会话内存。100 个并发连接意味着 100 个线程抢同一把锁、抢同一份 Buffer Pool，操作系统还要在它们之间来回切换上下文。真正干活的时间被切碎了。

所以更靠谱的算法是从吞吐倒推：

```
需要的连接数 ≈ 目标 QPS × 平均 SQL 耗时（秒）
```

目标 200 QPS，平均 SQL 3 毫秒，算出来 0.6，向上取整配 10 个绰绰有余。反过来，如果你的 SQL 平均 2 秒，想扛 50 QPS，那得 100 个连接——但这时该做的是优化 SQL，不是买更多连接。

这个公式还有个残酷的推论：**池的吞吐上限 = 池大小 ÷ 平均 SQL 耗时**。20 个连接、2 秒一条 SQL，天花板就是 10 QPS，你加多少台应用服务器都没用，因为每台机器都卡在同一个比例上。

### maxLifetime 和 MySQL wait_timeout：一对隐形杀手

MySQL 有个参数叫 `wait_timeout`，默认 28800 秒，八小时。含义是：一条连接空闲超过八小时，MySQL 主动把它踢掉。

问题在于，MySQL 踢人的时候不会发通知。它只是把服务端的会话关了，客户端 socket 还挂着。HikariCP 池子里这条连接看起来完好无损，下次借出去，一执行 SQL 就报 `Communications link failure`。

所以 `maxLifetime` 必须小于 `wait_timeout`，而且要留足余量。惯例是设成 20 到 30 分钟，让连接在 MySQL 动手之前自己先退休。这就是为什么很多团队把 `maxLifetime` 从 30 分钟调到 20 分钟以后，那种"每天早上第一条请求必失败"的诡异问题就消失了。

`keepaliveTime` 是另一层保险。它对空闲连接定期发一次心跳，防止中间的网络设备（防火墙、NAT、负载均衡）因为长时间没流量把连接表项清掉。设 5 分钟比较稳妥，前提是它小于 `maxLifetime`。

### 连接泄漏：最脏的一种打满

还有一种打满，日志里看不到慢 SQL，`SHOW PROCESSLIST` 里一堆 `Sleep` 状态的连接，但池子就是满的。

这是连接泄漏。典型写法是用完没关：手写了 `Connection`、`Statement`、`ResultSet` 却没放在 try-with-resources 里；或者 `@Transactional` 方法里抛了异常但被外层吞掉，事务挂起，连接不归还。

HikariCP 有个专门的探测器：`leakDetectionThreshold`。设成 20000，意思是连接被借出超过 20 秒还没归还，就打印一条带完整调用栈的 WARN 日志。这条日志对定位泄漏极其好用，因为它直接告诉你连接是在哪个类、哪一行被借走的。生产环境建议常开，代价只是每个连接多一个定时检查。

## 三、实战：手把手写代码

下面这个项目可以直接跑。功能很简单：一个订单查询接口，一个故意变慢的接口用来复现池打满，一个定时任务把池的实时状态打出来。

目录结构：

```
pool-demo
├── pom.xml
└── src
    └── main
        ├── java/com/example/pooldemo
        │   ├── PoolDemoApplication.java
        │   ├── monitor/PoolMonitor.java
        │   └── web/OrderController.java
        └── resources
            ├── application.yml
            └── schema.sql
```

### 第一步：pom.xml

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
    <artifactId>pool-demo</artifactId>
    <version>1.0.0</version>
    <name>pool-demo</name>
    <description>数据库连接池调优示例</description>

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
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>com.zaxxer</groupId>
            <artifactId>HikariCP</artifactId>
            <version>7.1.0</version>
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

`spring-boot-starter-jdbc` 会自动装配 `DataSource` 和 `JdbcTemplate`，不需要你写任何配置类。HikariCP 的版本父 POM 里也管着，这里显式写出来只是为了让你清楚实际跑的是哪个版本。

### 第二步：application.yml

```yaml
server:
  port: 8080
  tomcat:
    threads:
      max: 200

spring:
  application:
    name: pool-demo
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/pool_demo?useSSL=false&serverTimezone=Asia/Shanghai&characterEncoding=utf8
    username: root
    password: root123
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      pool-name: order-pool
      maximum-pool-size: 20
      minimum-idle: 20
      connection-timeout: 3000
      validation-timeout: 1000
      idle-timeout: 600000
      max-lifetime: 1200000
      keepalive-time: 300000
      leak-detection-threshold: 20000
      initialization-fail-timeout: 1
      register-mbeans: true

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics
  endpoint:
    health:
      show-details: always

logging:
  level:
    com.zaxxer.hikari: INFO
```

一个个说清楚，别照抄完不知道在干嘛：

- `maximum-pool-size: 20` 和 `minimum-idle: 20` 设成一样，就是固定大小池。好处是稳态下不会因为流量波动反复创建、销毁连接。既然连接数本来就是按吞吐算出来的，就没必要让它弹性伸缩。
- `connection-timeout: 3000` 把排队时间从 30 秒砍到 3 秒。车位满了就快速失败，让上游重试或者降级，别让线程干挂着。这是最容易被忽略、收益最大的一个改动。
- `max-lifetime: 1200000` 是 20 分钟，稳稳落在 MySQL 默认 `wait_timeout`（8 小时）之内。如果你公司把 `wait_timeout` 调成了 600 秒，那这个值要跟着往下调。
- `keepalive-time: 300000` 每 5 分钟给空闲连接发一次心跳活络一下，防中间网络设备清表项。
- `leak-detection-threshold: 20000` 连接借出 20 秒未归还就报警。注意这个阈值要大于你最慢的正常 SQL 耗时，否则全是误报。
- `idle-timeout` 在固定大小池里其实不生效，因为空闲连接数不会降到 `minimumIdle` 以下。留着是为了以后改弹性池时不用再翻文档。
- `connection-test-query` 故意没写。MySQL 驱动支持 JDBC4 的 `isValid()`，比执行一条 `SELECT 1` 更快，HikariCP 会自动走这条路。

### 第三步：建表脚本

```sql
CREATE DATABASE IF NOT EXISTS pool_demo DEFAULT CHARACTER SET utf8mb4;
USE pool_demo;

CREATE TABLE IF NOT EXISTS t_order (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_no VARCHAR(32) NOT NULL,
    user_id BIGINT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user_id (user_id),
    KEY idx_created_at (created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

手动在 MySQL 里执行一遍。表结构很简单，`created_at` 上有索引，是为了让后面的排序查询走索引而不是全表扫。

### 第四步：启动类

```java
package com.example.pooldemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class PoolDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(PoolDemoApplication.class, args);
    }
}
```

`@EnableScheduling` 是给下面的监控任务用的。没有它 `@Scheduled` 不会生效——这个坑我见人踩过不止一次。

### 第五步：订单接口

```java
package com.example.pooldemo.web;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final JdbcTemplate jdbcTemplate;

    public OrderController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/recent")
    public List<Map<String, Object>> recent(@RequestParam(defaultValue = "20") int limit) {
        String sql = "SELECT id, order_no, user_id, amount, status, created_at " +
                "FROM t_order ORDER BY created_at DESC LIMIT ?";
        return jdbcTemplate.queryForList(sql, limit);
    }

    @GetMapping("/slow")
    public Map<String, Object> slow(@RequestParam(defaultValue = "2") int seconds) {
        Integer result = jdbcTemplate.queryForObject("SELECT SLEEP(?)", Integer.class, seconds);
        return Map.of("sleptSeconds", seconds, "result", result);
    }
}
```

`/orders/slow` 是这次排查的主角。它执行 `SELECT SLEEP(2)`，一条 SQL 占住一个连接整整 2 秒。用它来压测，你能亲眼看到池子是怎么被填满的。

压测方法：开 30 个并发打 `/orders/slow?seconds=2`，池只有 20 个连接，立刻就会有 10 个线程进入等待队列；再持续压，等待队列越来越长，3 秒后开始成片报 `Connection is not available`。

```bash
# 需要先装 hey 或 ab，这里用 hey
hey -z 30s -c 30 "http://127.0.0.1:8080/orders/slow?seconds=2"
```

### 第六步：连接池监控

```java
package com.example.pooldemo.monitor;

import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;

@Component
public class PoolMonitor {

    private static final Logger log = LoggerFactory.getLogger(PoolMonitor.class);

    private final HikariPoolMXBean poolMXBean;

    public PoolMonitor(DataSource dataSource) {
        HikariDataSource hikariDataSource = (HikariDataSource) dataSource;
        this.poolMXBean = hikariDataSource.getHikariPoolMXBean();
    }

    @Scheduled(fixedDelay = 10000)
    public void report() {
        if (poolMXBean == null) {
            log.warn("没有拿到 HikariPoolMXBean，检查 register-mbeans 是否开启");
            return;
        }

        int active = poolMXBean.getActiveConnections();
        int idle = poolMXBean.getIdleConnections();
        int total = poolMXBean.getTotalConnections();
        int waiting = poolMXBean.getThreadsAwaitingConnection();

        log.info("连接池状态 active={} idle={} total={} waiting={}", active, idle, total, waiting);

        if (waiting > 0) {
            log.warn("有 {} 个线程在排队等连接，此时 active={}，先查慢 SQL，别急着调大池子", waiting, active);
        }
        if (active == total && total > 0) {
            log.warn("连接已全部借出，池子处于饱和状态");
        }
    }
}
```

这四个指标就是排查的全部依据：

- `active` 高、`waiting` 为 0 → 池子够用，问题在数据库本身慢。
- `active` 到顶、`waiting` 持续大于 0 → 池子小了，或者有慢 SQL 占着不放。
- `active` 很低、`total` 却等于最大值 → 连接泄漏，赶紧看 `leakDetectionThreshold` 打出来的栈。
- `waiting` 忽高忽低 → 流量尖峰，考虑限流或者给关键业务单独开一个池。

`register-mbeans: true` 打开后，Actuator 的 `/actuator/metrics/hikaricp.connections.active` 也能读到同样的数据，方便接 Prometheus。访问 `/actuator/health` 还能看到数据库连通性详情。

## 四、踩坑经验和最佳实践

### 坑一：把 connectionTimeout 设成 30 秒

这是默认值，也是事故放大器。池满的时候，请求不是立刻失败，而是挂 30 秒。Tomcat 默认 200 个线程，30 秒内能堆积的请求足够把整个服务拖死，连健康检查都超时，K8s 直接把 Pod 重启，然后新 Pod 起来继续被压垮——雪崩就这么形成的。

改成 3 秒，甚至 2 秒。快速失败 + 上游重试，比全体卡死强一百倍。

### 坑二：在事务里调远程接口

```java
@Transactional
public void createOrder(OrderDTO dto) {
    orderMapper.insert(dto);
    // 这一行是灾难：HTTP 调用可能超时 5 秒
    inventoryClient.deduct(dto.getSkuId(), dto.getCount());
    // 事务直到方法结束才提交，连接一直被占着
}
```

事务开启的那一刻就绑定了一个连接，直到方法返回才归还。中间夹一个 5 秒的 HTTP 调用，等于这个连接被白白占用 5 秒。20 个连接，QPS 直接被压到 4。

正确做法是把远程调用挪到事务外面，或者用本地消息表做最终一致。总之，事务方法里只留数据库操作。

### 坑三：批量任务和在线业务共用一个池

凌晨跑对账，一个 `foreach` 循环查了 80 万次，每次借一次连接。业务接口同时被打满，用户侧全白屏。

给批量任务单独配一个 `DataSource`，池小一点（5 到 10 个），并且加上 `@Qualifier` 隔离。两个池加起来的总连接数仍然要控制在数据库能承受的范围内。

### 坑四：maxLifetime 大于 wait_timeout

前面讲过原理，这里给结论：`maxLifetime` 一定要小于 MySQL 的 `wait_timeout`，并且至少留 2 到 3 分钟余量。查一下当前值：

```sql
SHOW VARIABLES LIKE 'wait_timeout';
SHOW VARIABLES LIKE 'interactive_timeout';
```

很多云数据库（尤其是带连接代理的）实际空闲断连时间比 `wait_timeout` 更短，遇到莫名其妙的 `Communications link failure`，先把 `maxLifetime` 砍到 10 分钟试试。

### 坑五：忘记关连接

用 `JdbcTemplate` 一般不会泄漏，它内部管好了。但只要你手写过这种代码，就一定会漏：

```java
Connection conn = dataSource.getConnection();
PreparedStatement ps = conn.prepareStatement(sql);
ResultSet rs = ps.executeQuery();
// 中间抛异常，下面三行永远执行不到
rs.close();
ps.close();
conn.close();
```

要么用 try-with-resources，要么老老实实放 finally 里。开了 `leakDetectionThreshold` 之后，这种代码活不过 20 秒就会被日志点名。

### 一份可以直接抄的参数清单

| 参数 | 建议值 | 理由 |
| --- | --- | --- |
| maximum-pool-size | 10 到 20，按 `QPS × SQL 耗时` 算 | 超过 20 收益极小，竞争成本上升 |
| minimum-idle | 等于 maximum-pool-size | 固定池，避免抖动 |
| connection-timeout | 2000 到 3000 毫秒 | 快速失败，别拖死线程 |
| validation-timeout | 1000 毫秒 | 连接校验不能比借连接还慢 |
| max-lifetime | 1200000（20 分钟） | 必须小于 wait_timeout |
| keepalive-time | 300000（5 分钟） | 防中间设备清连接 |
| leak-detection-threshold | 20000（20 秒） | 大于最慢正常 SQL，生产常开 |
| initialization-fail-timeout | 1 | 启动时连不上就直接失败，别带病上线 |

## 五、性能对比和技术选型

国内 Java 圈主流就三个池：HikariCP、Druid、Tomcat JDBC Pool。

| 维度 | HikariCP | Druid | Tomcat JDBC |
| --- | --- | --- | --- |
| 性能 | 最高，字节码精简，无锁借还 | 中等，功能多带来开销 | 中等偏上 |
| Spring Boot 默认 | 是 | 否，需手动引入 starter | 否 |
| 监控能力 | 基础指标 + Micrometer | 极强，SQL 统计、慢 SQL 日志、Wall 防火墙 | 基础 |
| 连接泄漏检测 | 有，带调用栈 | 有 | 有 |
| 维护状态 | 活跃 | 活跃 | 随 Tomcat 走 |
| 适合场景 | 绝大多数业务服务 | 需要 SQL 审计、分库分表的场景 | 老项目沿用 |

我的建议很直接：新项目用 HikariCP，别犹豫。它的借还路径短，压测数据一直领先，而且 Spring Boot 开箱即用，出问题资料也多。

只有当你有明确的 SQL 审计需求——比如金融、政企项目要求记录每一条执行的 SQL、要防 SQL 注入、要做慢 SQL 排行——才上 Druid。它的 `StatFilter` 确实好用，但代价是每次执行多一层拦截器。为了"看起来功能全"而选 Druid，然后监控页面一年没打开过，那是纯浪费。

至于 Tomcat JDBC Pool，基本只在维护十几年前的老项目时才会遇到，新项目没有理由选它。

## 六、总结

连接池的问题，九成不是"配小了"，而是"借出去的回不来"。

排查顺序固定死：先看 `waiting` 和 `active`，判断是池子饱和还是泄漏；再看 `SHOW PROCESSLIST`，找长事务和慢 SQL；最后核对 `maxLifetime` 和 `wait_timeout` 的关系，排掉连接失效。

四个参数记牢。`maximumPoolSize` 按 `QPS × SQL 耗时` 倒推，10 到 20 个通常够用。`connectionTimeout` 从 30 秒砍到 3 秒，让故障快速暴露而不是慢慢发酵。`maxLifetime` 必须小于 MySQL 的 `wait_timeout`，20 分钟是个安全值。`leakDetectionThreshold` 生产环境常开，20 秒就能抓到没关连接的代码。

最后一句：池子调大是止痛药，不是治病。SQL 慢、事务长、连接漏，这三个根因不解决，你把池子调到 200，只是把数据库一起拖下水。

## 参考资料

- [HikariCP 官方仓库](https://github.com/brettwooldridge/HikariCP)
- [About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [Spring Boot 官方文档：SQL Databases](https://docs.spring.io/spring-boot/reference/data/sql.html)
- [MySQL 8.4 Reference Manual：Server System Variables](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_wait_timeout)

文 / 会编程的吕洞宾

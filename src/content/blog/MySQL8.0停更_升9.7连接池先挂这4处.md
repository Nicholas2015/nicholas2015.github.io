---
title: "MySQL 8.0停更 升9.7连接池先挂这4处"
date: 2026-11-15T09:00:00+08:00
category: "数据库"
tags: ["mysql"]
---

> MySQL 8.0 在 2026 年 4 月 30 日走完生命周期，社区版不再发补丁。不少团队拖到年底才动，测试库刚升上去，服务就起不来：Hikari 初始化失败，日志里躺着一行 `Public Key Retrieval is not allowed`。代码没改，数据没丢，卡住的是账号认证这一层。这篇把三个高频报错的来路、握手过程到底发生了什么、以及一套能直接跑的自检工具讲清楚。

## 一、升级后连不上，问题到底出在哪

**升级 MySQL 之后应用连不上，九成不是驱动 bug，而是账号用的认证插件、和连接走不走加密，这两件事没对齐。**

报错有三种，长得完全不一样，指向的却是同一处：

| 报错原文 | 真实含义 | 常见触发 |
| --- | --- | --- |
| `Unable to load authentication plugin 'mysql_native_password'` | 客户端要用的插件，服务端已经没有了 | 账号还是 native 插件，库升到 9.x |
| `Public Key Retrieval is not allowed` | 服务端要求加密传密码，客户端没被允许取公钥 | 明文连接 + caching_sha2 完整认证 |
| `Access denied for user 'app_rw'@'10.0.3.21'` | 密码对，但认证方式对不上，或哈希没迁移 | 只改了插件没重设密码 |

第一种最典型。2019 年前后建的项目，账号基本是这么来的：

```sql
CREATE USER 'app_rw'@'%' IDENTIFIED WITH mysql_native_password BY 'xxx';
```

当时这么写不是偷懒。那会儿用的 Connector/J 5.1.x，碰上 `caching_sha2_password` 直接报「未知插件」，只能退回老插件。库升级之后，账号记录还在 `mysql.user` 里，密码哈希也还在，可服务端已经没有能校验它的代码。插件被卸载，账号等于一把没有锁孔的钥匙。

第二种更阴。它不报「插件不存在」，而是报「公钥不让取」，看着像权限问题，实际是加密通道没谈拢。这个放到第二节细讲。

第三种最好骗人。插件改对了，`ALTER USER` 却漏了 `BY '新密码'`，密码哈希原地不动，登录照样失败，报错还跟密码输错一模一样。

### 为什么现象是「服务起不来」而不是「接口报错」

连接池把一次单点失败放大成了启动故障。

Hikari 的 `initializationFailTimeout` 默认值是 1，含义是启动时立刻拿一条连接，拿不到就抛 `PoolInitializationException`。这个异常在 `DataSource` 初始化阶段抛出，Spring 上下文创建直接中断，进程退出。

所以你看到的是「服务启动失败」，不是「某个接口 500」。更容易误判的是：用 mysql 命令行能正常登进去。命令行客户端和 JDBC 驱动的默认参数不是一套，命令行默认会尝试 TLS，驱动那边可能早被人在 URL 里写了 `sslMode=DISABLED`。

排查从这三个问题开始，一个都别跳：

1. 这个账号现在是什么插件？`SELECT user, host, plugin FROM mysql.user WHERE user = 'app_rw';`
2. 这条连接有没有真加密？连上后执行 `SHOW STATUS LIKE 'Ssl_cipher';`，空值就是明文。
3. 服务端还有没有 RSA 公钥可用？`SHOW VARIABLES LIKE 'caching_sha2_password%';`

## 二、认证握手到底发生了什么

**MySQL 9.x 只认 `caching_sha2_password`，密码必须经过 TLS 或者服务端 RSA 公钥加密才能出门，两条路都不通，连接就被拒。**

先搞清楚插件是什么。认证插件是服务端的一段校验逻辑，客户端必须能配合它完成挑战应答。换插件不是换个开关，是换一套密码学协议。

`mysql_native_password` 的流程很短：服务端给 20 字节随机盐，客户端算两次 SHA1 交回去，服务端比对。SHA1 快，快就意味着能被 GPU 批量试。这套东西在 2010 年代够用，放到今天就属于裸奔——不加密连接也能认证，抓包拿到的应答可以离线爆破。

`caching_sha2_password` 是 8.0 起的默认插件，用 SHA256，还在服务端加了一层缓存。握手分两条路径：

1. **快速路径**：服务端缓存里有这个账号的哈希，直接挑战应答，一次往返搞定。
2. **完整路径**：缓存没有（首次连接、服务重启、缓存被刷），客户端必须把明文密码交上去，但得加密——走 TLS，或者向服务端要 RSA 公钥自己加密。

`allowPublicKeyRetrieval` 管的就是第二条路里「能不能向服务端要公钥」，默认 `false`。要不到，报 `Public Key Retrieval is not allowed`。

为什么默认关掉？因为公钥是握手时明文发过来的。中间人可以冒充服务器，塞给你一把自己的公钥，你拿它加密密码，人家用私钥一解就到手了。相当于快递员上门取件，你不验工牌就把包裹递出去。

### sslMode 默认值埋的雷

`sslMode` 的默认值是 `PREFERRED`，意思是「能加密就加密，不行就拉倒」。

MySQL 8.0 初始化时会自签一套证书，所以开箱即用时 TLS 是通的，`caching_sha2_password` 走 TLS 就能过，什么问题都没有。可一旦服务器关了 TLS，或者你的 URL 里写了 `sslMode=DISABLED`，连接退回明文，这时才需要 RSA 公钥，报错也跟着来。

同一份配置，在 A 库能跑、在 B 库炸，原因常常就在这。`PREFERRED` 还允许降级，攻击者把 TLS 握手打断，连接就自动掉到明文，这叫降级攻击。生产环境用 `VERIFY_CA`，把证书校验上，降级这条路才算堵死。

三种连接方式放一起看：

| 方式 | URL 关键参数 | 密码加密 | 抗中间人 | 适用场景 |
| --- | --- | --- | --- | --- |
| TLS 优先 | `sslMode=PREFERRED` | 是 | 可被降级 | 内网、联调 |
| TLS 校验证书 | `sslMode=VERIFY_CA` + 信任库 | 是 | 是 | 生产 |
| 明文 + RSA | `sslMode=DISABLED&allowPublicKeyRetrieval=true` | 是（公钥可伪造） | 否 | 仅本机 |

### 哈希不能直接换算

`mysql_native_password` 在 8.4 里默认禁用，到 9.0 被彻底删除。9.7 是 LTS，支持到 2031 年，升级路线基本是 8.0 直接跳到 9.7，中间没有缓冲带。

从 native 迁到 sha2，密码哈希不能换算。SHA1 的散列值推不出 SHA256 的散列值，所以每个账号都得用 `ALTER USER ... BY '明文密码'` 重设一次。这一步不做，插件改了照样登不上。

这也是升级必须排窗口的原因：你手里得有这些账号的明文密码。没有就只能在库里改，或者走一遍找回流程。

## 三、实战：写一个能跑的自检工具

**这套工具在升级前后各跑一次，能把插件、TLS、公钥、账号清单四件事一次看清，不用登服务器敲十条命令。**

### 3.1 完整的 pom.xml

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

    <groupId>com.lvdongbin</groupId>
    <artifactId>mysql-doctor</artifactId>
    <version>1.0.0</version>
    <name>mysql-doctor</name>

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
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>9.7.0</version>
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

驱动坐标是 `com.mysql:mysql-connector-j`，不是老掉牙的 `mysql:mysql-connector-java:5.1.49`。后者早就停更，新参数它不认，拿它连 9.x 只会浪费时间。

### 3.2 完整的 application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: mysql-doctor
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/shop?sslMode=PREFERRED&connectionTimeZone=Asia/Shanghai
    username: app_rw
    password: ${DB_PASSWORD:change-me}
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      pool-name: shop-pool
      maximum-pool-size: 8
      minimum-idle: 2
      connection-timeout: 3000
      validation-timeout: 2000
      initialization-fail-timeout: 10000
      keepalive-time: 60000

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      show-details: always

logging:
  level:
    com.mysql.cj: INFO
```

URL 里两个参数值得说。

`sslMode=PREFERRED` 让驱动自己去谈 TLS。9.x 服务端自带自签证书，谈判大概率成功，密码就走加密通道了。

`connectionTimeZone=Asia/Shanghai` 是替代 `serverTimezone` 的新参数。`TIMESTAMP` 类型在会话时区里做转换，服务器时区从 `SYSTEM` 改成 `UTC` 之后如果还按老参数配，报表时间会整体偏 8 小时，这种事故比连不上更折磨人。

`initialization-fail-timeout: 10000` 给的是 10 秒重试窗口，配合容器编排的启动探针用。设成 `-1` 是另一回事，那是「别在启动时校验」，问题会被藏到第一个真实请求里。

### 3.3 自检主程序（纯 JDBC，不依赖 Spring 上下文）

```java
package com.lvdongbin.mysqldoctor;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public class AuthPluginDoctor {

    private static final String HOST = "127.0.0.1";
    private static final int PORT = 3306;
    private static final String DATABASE = "shop";
    private static final String USER = "app_rw";
    private static final String PASSWORD = "change-me";

    public static void main(String[] args) {
        String base = "jdbc:mysql://" + HOST + ":" + PORT + "/" + DATABASE
                + "?connectionTimeZone=Asia/Shanghai";

        System.out.println("=== 1. 服务器与账号现状 ===");
        try (Connection conn = DriverManager.getConnection(base + "&sslMode=PREFERRED", USER, PASSWORD)) {
            printVersion(conn);
            printTls(conn);
            printAccounts(conn);
            printRsaVars(conn);
        } catch (SQLException e) {
            System.out.println("[FAIL] 连默认配置都进不去：" + e.getMessage());
            System.out.println("       先确认账号存在、密码正确，再看下面的明文探测结果。");
        }

        System.out.println();
        System.out.println("=== 2. 三种连接方式探测 ===");
        probe(base, "TLS 优先", "&sslMode=PREFERRED");
        probe(base, "明文 + 取公钥", "&sslMode=DISABLED&allowPublicKeyRetrieval=true");
        probe(base, "明文不取公钥", "&sslMode=DISABLED");
    }

    private static void printVersion(Connection conn) throws SQLException {
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT VERSION(), CURRENT_USER()")) {
            if (rs.next()) {
                System.out.println("服务端版本：" + rs.getString(1));
                System.out.println("当前身份  ：" + rs.getString(2));
            }
        }
    }

    private static void printTls(Connection conn) throws SQLException {
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SHOW STATUS LIKE 'Ssl_cipher'")) {
            if (rs.next()) {
                String cipher = rs.getString(2);
                boolean plain = cipher == null || cipher.isEmpty();
                System.out.println("连接加密  ：" + (plain ? "空（明文在跑）" : cipher));
            }
        }
    }

    private static void printAccounts(Connection conn) throws SQLException {
        String sql = "SELECT user, host, plugin FROM mysql.user ORDER BY user, host";
        List<String> needMigrate = new ArrayList<>();
        int total = 0;
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            while (rs.next()) {
                total++;
                String user = rs.getString(1);
                String host = rs.getString(2);
                String plugin = rs.getString(3);
                if (plugin == null || !"caching_sha2_password".equals(plugin)) {
                    needMigrate.add(user + "@" + host + "  ->  " + plugin);
                }
            }
        } catch (SQLException e) {
            System.out.println("账号清单  ：查不了（缺 mysql 库读权限），换个管理账号跑这一条");
            System.out.println("            原始错误：" + e.getMessage());
            return;
        }
        System.out.println("账号总数  ：" + total + "，需要迁移的：" + needMigrate.size());
        for (String line : needMigrate) {
            System.out.println("  [待迁移] " + line);
        }
    }

    private static void printRsaVars(Connection conn) throws SQLException {
        String sql = "SHOW VARIABLES LIKE 'caching_sha2_password%'";
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            while (rs.next()) {
                System.out.println(rs.getString(1) + " = " + rs.getString(2));
            }
        }
    }

    private static void probe(String base, String label, String extra) {
        String url = base + extra;
        long start = System.currentTimeMillis();
        try (Connection conn = DriverManager.getConnection(url, USER, PASSWORD);
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SHOW STATUS LIKE 'Ssl_cipher'")) {
            String cipher = rs.next() ? rs.getString(2) : null;
            long cost = System.currentTimeMillis() - start;
            String mode = (cipher == null || cipher.isEmpty()) ? "明文" : cipher;
            System.out.printf("[OK]   %-12s 耗时 %3d ms，加密=%s%n", label, cost, mode);
        } catch (SQLException e) {
            System.out.printf("[FAIL] %-12s %s%n", label, e.getMessage());
        }
    }
}
```

`main` 里先用 `PREFERRED` 连一次，拿到版本、加密状态、账号清单、RSA 配置；再用三种 URL 各连一次，把「哪种组合能用」直接打出来。

第三种探测一定会失败，它复现的就是生产上那条 `Public Key Retrieval is not allowed`。故意留着，是为了让读者亲眼看到报错长什么样——见过一次，下次在日志里就不会认不出来。

`printAccounts` 里做了降级处理：应用账号通常没有 `mysql` 库的读权限，查询会抛 1142。这里不吞异常，而是打印原始错误，提示换管理账号跑。

### 3.4 应用侧代码：一行都不用改

```java
package com.lvdongbin.mysqldoctor;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class MysqlDoctorApplication {

    public static void main(String[] args) {
        SpringApplication.run(MysqlDoctorApplication.class, args);
    }
}
```

```java
package com.lvdongbin.mysqldoctor.order;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class OrderRepository {

    private final JdbcTemplate jdbcTemplate;

    public OrderRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<String> findRecentOrderNos(int limit) {
        String sql = "SELECT order_no FROM t_order ORDER BY id DESC LIMIT ?";
        return jdbcTemplate.queryForList(sql, String.class, limit);
    }

    public int countByStatus(String status) {
        String sql = "SELECT COUNT(*) FROM t_order WHERE status = ?";
        Integer count = jdbcTemplate.queryForObject(sql, Integer.class, status);
        return count == null ? 0 : count;
    }
}
```

```java
package com.lvdongbin.mysqldoctor.order;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderRepository orderRepository;

    public OrderController(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @GetMapping("/recent")
    public List<String> recent(@RequestParam(defaultValue = "10") int limit) {
        return orderRepository.findRecentOrderNos(Math.min(limit, 100));
    }

    @GetMapping("/count")
    public String count(@RequestParam(defaultValue = "PAID") String status) {
        return status + " 状态订单数：" + orderRepository.countByStatus(status);
    }
}
```

业务代码没有任何数据库认证相关的逻辑，升级时也不该有。连不上是基础设施层的问题，往业务代码里加 try-catch 只会把故障藏起来。

启动后访问 `http://localhost:8080/orders/recent` 验证链路，`http://localhost:8080/actuator/health` 看连接池状态。

### 3.5 账号迁移脚本

```sql
-- 建库建表，给自检工程准备数据
CREATE DATABASE IF NOT EXISTS shop
    DEFAULT CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE shop;

CREATE TABLE IF NOT EXISTS t_order (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    order_no    VARCHAR(32)  NOT NULL,
    status      VARCHAR(16)  NOT NULL,
    amount      DECIMAL(12,2) NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no),
    KEY idx_status_created (status, created_at)
) ENGINE = InnoDB;

INSERT INTO t_order (order_no, status, amount) VALUES
    ('SO202611150001', 'PAID',    199.00),
    ('SO202611150002', 'PAID',    58.50),
    ('SO202611150003', 'PENDING', 320.00);

-- 1. 摸清现状：哪些账号还在用老插件
SELECT user, host, plugin FROM mysql.user ORDER BY user, host;

-- 2. 逐个迁移，密码必须重新设，哈希换算不过来
ALTER USER 'app_rw'@'%'      IDENTIFIED WITH caching_sha2_password BY '换成真实强密码';
ALTER USER 'report_ro'@'%'   IDENTIFIED WITH caching_sha2_password BY '换成真实强密码';
ALTER USER 'canal'@'%'       IDENTIFIED WITH caching_sha2_password BY '换成真实强密码';
ALTER USER 'backup'@'%'      IDENTIFIED WITH caching_sha2_password BY '换成真实强密码';

-- 3. 复核：这条查询返回空，才算迁完
SELECT user, host, plugin
FROM mysql.user
WHERE plugin IS NULL OR plugin <> 'caching_sha2_password';

-- 4. 精确看某个账号的建号语句
SHOW CREATE USER 'app_rw'@'%';

-- 5. 8.4 过渡期还能临时开回老插件（9.x 已经没有这个开关）
-- SET PERSIST mysql_native_password = ON;
```

脚本里的账号清单要按实际情况补全。除了应用主账号，还有报表库、binlog 同步、备份、监控采集、DBA 个人号——任何一个漏掉，都会在升级后的某天凌晨以「任务失败」的形式冒出来。

第 3 条复核语句是验收标准。它返回空，才说明没有漏网的。

## 四、踩坑经验和最佳实践

**升级后的故障，绝大多数出在「以为改了其实没改」和「以为安全其实不安全」这两类。**

下面几条是按发生频率排的。

**只改插件，没重设密码。** `ALTER USER 'app_rw'@'%' IDENTIFIED WITH caching_sha2_password;` 不带 `BY`，插件是换了，哈希还是老的，登录报 `Access denied`。密码错和哈希不兼容，在应用日志里长得一模一样。判断办法：用 mysql 命令行手动登一次，能进就是驱动侧参数问题，进不去就是账号问题。

**把 `allowPublicKeyRetrieval=true` 抄进生产。** 本地图省事加上的参数，跟着配置文件一起上线了。这个参数一开，任何能连到 3306 的人都能冒充服务器套走密码，安全扫描也会直接标高危。生产用 `sslMode=VERIFY_CA` 加信任库，这条路走得通，也不需要取公钥。

**用 `initialization-fail-timeout: -1` 掩盖启动失败。** 服务确实起来了，健康检查也绿了，第一个真实请求才炸。排查时间直接翻倍，因为你已经失去了「启动即失败」这个信号。这个参数该配成多少，取决于容器编排给多久启动窗口，不该拿来遮丑。

**只改了一个数据源。** 读写分离、多数据源的项目，主库改了从库没改；或者从库压根不允许改，因为同步账号在老实例上。还有一层容易被忘：中间代理。云上数据库代理、ProxySQL、MaxScale 里各自存着后端账号，应用改了，代理连不上后端，报错还是从应用侧先冒出来。

**驱动还是 5.1.x。** `mysql:mysql-connector-java:5.1.49` 不认 `sslMode`，也不支持 9.x 的新认证流程，报错信息还特别含糊。换 `com.mysql:mysql-connector-j`，坐标和包名都变了，`com.mysql.jdbc.Driver` 要改成 `com.mysql.cj.jdbc.Driver`。

**时区参数没跟着换。** `serverTimezone` 是旧名，新参数叫 `connectionTimeZone`。服务器时区从 `SYSTEM` 变为 `UTC` 后，`TIMESTAMP` 读写会整体偏移。金额表没事，日志表和统计表会集体错位，而且错得很规律——每天固定差 8 小时。

**密码策略卡住迁移。** 8.0.13 之后 `validate_password` 变成组件，默认策略更严。迁移时随手写的临时密码会被拒，报 `ERROR 1819`。要么按策略设强密码，要么在迁移窗口内临时调低策略，改完再调回去。

## 五、性能对比和技术选型

**认证插件本身对 QPS 的影响可以忽略，真正影响性能的是连接建立的频率和是否走 TLS。**

`mysql_native_password` 用 SHA1，`caching_sha2_password` 用 SHA256，单次哈希开销差几倍，但绝对值都在微秒级。差别体现在握手往返次数上：

| 项目 | native | caching_sha2 快速路径 | caching_sha2 完整路径 |
| --- | --- | --- | --- |
| 哈希算法 | SHA1 两次 | SHA256 + 缓存 | SHA256 + RSA/TLS |
| 额外往返 | 0 | 0 | 1~2 次 |
| 单次连接开销 | 基准 | 基本持平 | 多 1~5 ms |
| 是否强制加密 | 否 | 否 | 是 |

连接池把连接建立次数压到很低。一个 8 连接的池子，跑一整天可能只建几十次连接，多出来的几毫秒摊到业务请求上，连零头都算不上。真正要担心的是短连接模式——每次请求新建连接，完整路径的额外往返会被放大几十倍。

TLS 的开销也要分开看。握手贵，对称加密便宜。连接复用之后走的是 AES，服务器普遍有 AES-NI 指令，吞吐损失通常在个位数百分比。所以别为了性能关 TLS，那点收益换不来安全债。

选型上我的立场很明确：

- **生产环境**：`sslMode=VERIFY_CA` + `caching_sha2_password`。证书校验必须开，`PREFERRED` 的降级口子留着就是隐患。
- **同机房内网**：`sslMode=PREFERRED` 可以接受，但要知道它在降级时是静默的。
- **本机开发**：`sslMode=DISABLED&allowPublicKeyRetrieval=true` 图个方便没问题，前提是这个配置永远不出现在生产分支里。

从 8.0 到 9.7 的升级路径只有一条，中间没有 8.4 缓冲带可选。9.7 是 LTS，支持到 2031 年，一次到位比来回折腾省事。真要做灰度，就在应用侧做，别在数据库版本上做。

## 六、总结

**MySQL 9.x 只认 `caching_sha2_password`，密码必须走 TLS 或 RSA 加密，两个条件缺一个，连接就断在握手阶段。**

升级前把三件事做完，故障率能降一大截：

1. 用自检工具跑一遍账号清单，把所有非 `caching_sha2_password` 的账号列出来，包括代理、同步、备份、监控用的
2. 备好每个账号的明文密码，`ALTER USER` 时一并重设，哈希换算不过来
3. URL 里确认 `sslMode` 和 `connectionTimeZone`，生产用 `VERIFY_CA`

日志里那行 `Public Key Retrieval is not allowed` 不是权限问题，是加密通道没谈成。想清楚这句话，剩下都是照着改参数。

数据库升级最贵的部分从来不是升级本身，是那些没人记得的账号。

## 参考资料

- [MySQL Support — End of Life Notice](https://www.mysql.com/support/eol-notice.html)
- [MySQL 9.7 Reference Manual — caching_sha2_password Pluggable Authentication](https://dev.mysql.com/doc/refman/9.7/en/caching-sha2-pluggable-authentication.html)
- [MySQL 9.0 Release Notes — mysql_native_password 移除说明](https://dev.mysql.com/doc/relnotes/mysql/9.0/en/news-9-0-0.html)
- [Connector/J — Security Connection Properties](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-security.html)
- [Maven Central — com.mysql:mysql-connector-j](https://central.sonatype.com/artifact/com.mysql/mysql-connector-j)

文 / 会编程的吕洞宾

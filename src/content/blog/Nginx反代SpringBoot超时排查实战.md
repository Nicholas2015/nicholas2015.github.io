---
title: "Nginx 反代 Spring Boot 超时排查实战"
date: 2026-10-08T09:00:00+08:00
category: "中间件"
tags: ["spring-boot", "nginx"]
---

> 一个 Spring Boot 服务本地跑得好好的，挂到 Nginx 后面就开始偶发 504。更邪门的是，后端日志里业务明明跑完了，总耗时不到 3 秒，Nginx 却告诉客户端“上游超时”。代码没报错、数据库没慢、监控一片绿。问题往往不在 Java 代码里，而在 Nginx 和 Tomcat 之间那条看不见的链路上。这篇把链路上的超时判定、连接复用、真实 IP 三件事拆开讲，配一套能直接跑的代码，带你排查一次、看懂一次。

## 一、这个问题到底是什么

**Nginx 报 `upstream timed out`、后端日志却显示业务已正常完成，九成以上是代理侧的超时阈值和连接管理出了问题，不是 Spring Boot 变慢了。**

先把“慢”和“超时”拆开看。慢是绝对值，超时是比较——只要等待时间超过某条阈值，就被判成超时，哪怕后端跑完只需要 100 毫秒。

线上撞上这个报错，先按角色把三方看到的现象对齐：

- **客户端**：等了一会儿，收到 504 Gateway Timeout，或者连接被直接重置。
- **Nginx 的 error.log**：`upstream timed out (110: Connection timed out) while reading response header from upstream`。
- **Spring Boot 的日志**：请求进来了，业务也执行完了，日志里没有任何异常。

三方各说各话，是因为每个环节只记录“自己那一秒”。Nginx 等上游的时间、上游自己执行的时间，本来就是两个独立的数。

再看一个更隐蔽的变体：**客户端收到 504，后端却真的执行了两次。** 订单服务重复扣款、通知服务重复发送短信，很多就是这么来的。原因是 Nginx 默认会在上游超时之后，把请求重试到下一个上游节点，而单机部署时“下一个节点”还是同一个后端。超时就不只是体验问题，它变成了数据问题。

所以排查的第一原则是：**先确定超时发生在哪一段链路上，再谈参数怎么调。** 上来就随手把 `proxy_read_timeout` 改大，等于闭着眼睛吃止痛药。

## 二、底层原理到底怎么回事

**一次经过 Nginx 转发的请求，走的是两段彼此独立的连接，超时判定和连接管理都要分两段看。**

### 两段链路，两套超时

画出来是这样：

```
客户端 ──(连接A)──> Nginx ──(连接B)──> Spring Boot / Tomcat
```

- 连接 A 在客户端和 Nginx 之间，超时参数是 `client_header_timeout`、`client_body_timeout`、`send_timeout`。
- 连接 B 在 Nginx 和 Tomcat 之间，超时参数是 `proxy_connect_timeout`、`proxy_send_timeout`、`proxy_read_timeout`。

这次要解决的是连接 B。几个常用指令的默认值如下，来自 Nginx 官方文档：

| 指令 | 默认值 | 管的是什么 |
| --- | --- | --- |
| `proxy_connect_timeout` | 60s | Nginx 和上游建立 TCP 连接的最长等待 |
| `proxy_send_timeout` | 60s | 向上游发送请求时，两次写操作之间的最长间隔 |
| `proxy_read_timeout` | 60s | 从上游读响应时，两次读操作之间的最长间隔 |
| `client_max_body_size` | 1m | 客户端请求体上限，超了返回 413 |
| `proxy_next_upstream` | `error timeout` | 哪些失败要换一个上游重试 |

### `proxy_read_timeout` 不是“总耗时”

这是最容易被理解错的一条。

`proxy_read_timeout` 描述的是“**两次成功读操作之间的间隔上限**”，不是整个响应的总时长。后端如果先吐出响应头，随后每 10 秒发一次数据、连续发 5 分钟，只要每次间隔都小于阈值，Nginx 就一直陪着。反过来，后端若 60 秒内一声不吭，Nginx 直接判超时，哪怕它下一秒就能算完。

把它理解成“心跳间隔上限”更准确。SSE 推送、流式下载这类长连接场景，最容易在这里翻车，要么阈值太小被误杀，要么为了等流式响应把阈值调到很大，连带把真正的卡死也一起放过了。

### 上游连接池：默认是短连接

**Nginx 默认不做上游连接复用，每个请求都重新和 Tomcat 建一条 TCP 连接。**

短连接的代价是实打实的：三次握手多一个 RTT，请求越密集开销越明显；更要命的是大量连接进入 TIME_WAIT 状态，占满本机端口，高峰期直接连不出去了。

开启连接复用要写齐三件套，缺一个都不生效：

1. `upstream` 块里加 `keepalive 64;`，声明一条最多 64 空闲连接的池子；
2. `location` 里写 `proxy_http_version 1.1;`，因为只有 HTTP/1.1 才谈得上长连接；
3. `location` 里写 `proxy_set_header Connection "";`。

第三条最容易被漏掉。Nginx 会把客户端请求里的 `Connection` 头原样转发给上游，客户端如果带的是 `Connection: close`，复用池里刚建好的连接转头就被关掉。把 `Connection` 置成空字符串，才是明确告诉上游“这条连接留着别关”。

### 真实 IP 为什么会丢

**不显式转发请求头，Tomcat 拿到的客户端地址永远是 Nginx 自己的地址。**

TCP 连接是 Nginx 替客户端建的，所以 `request.getRemoteAddr()` 只会返回 Nginx 的 IP。想让后端知道真实来源，只能靠 HTTP 头传递：

- `X-Real-IP`：只放一个 IP，即直接连到 Nginx 的那台客户端。
- `X-Forwarded-For`：一条 IP 链，每经过一层代理追加一个，形如 `客户端IP, 代理1IP, 代理2IP`。

Spring Boot 这边还要配一句 `server.forward-headers-strategy=framework`，它会让 Tomcat 的 `RemoteIpValve` 生效，`getRemoteAddr()` 才会按请求头里的内容还原。至于限流、审计这类按 IP 统计的逻辑，不配这一句，全公司就只有一个“用户”。

## 三、实战：手把手写代码

**下面这套代码可以直接跑起来，专门用来复现“后端很快、Nginx 却报超时”的场景。**

### 1. Maven 依赖

`pom.xml` 完整内容如下，父工程锁定了依赖版本，`java.version` 用 21：

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
    <artifactId>nginx-timeout-demo</artifactId>
    <version>1.0.0</version>
    <name>nginx-timeout-demo</name>
    <description>复现并排查 Nginx 反代 Spring Boot 超时问题</description>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.1</version>
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

### 2. 启动类

一个再普通不过的入口类，不需要额外注解：

```java
package com.example.nginxdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class NginxTimeoutDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(NginxTimeoutDemoApplication.class, args);
    }
}
```

### 3. 三个探针接口

这个 Controller 提供三个接口：`/api/fast` 立刻返回，用来压测连接复用；`/api/slow` 按参数睡一段时间，用来撞超时；`/api/whoami` 把真实 IP 相关的头原样吐出来，用来验证转发配置。

```java
package com.example.nginxdemo.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class ProbeController {

    private static final Logger log = LoggerFactory.getLogger(ProbeController.class);

    @GetMapping("/fast")
    public Map<String, Object> fast() {
        return Map.of("status", "ok", "serverCostMs", 0);
    }

    @GetMapping("/slow")
    public Map<String, Object> slow(@RequestParam(defaultValue = "80000") long ms) throws InterruptedException {
        long start = System.currentTimeMillis();
        log.info("slow 请求开始，将睡眠 {} ms", ms);
        Thread.sleep(ms);
        long cost = System.currentTimeMillis() - start;
        log.info("slow 请求结束，实际耗时 {} ms", cost);
        return Map.of("status", "done", "sleepMs", ms, "serverCostMs", cost);
    }

    @GetMapping("/whoami")
    public Map<String, Object> whoami(HttpServletRequest request) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("remoteAddr", request.getRemoteAddr());
        info.put("remoteHost", request.getRemoteHost());
        info.put("remotePort", request.getRemotePort());
        info.put("xForwardedFor", request.getHeader("X-Forwarded-For"));
        info.put("xRealIp", request.getHeader("X-Real-IP"));
        info.put("host", request.getHeader("Host"));
        info.put("scheme", request.getScheme());
        info.put("serverPort", request.getServerPort());
        log.info("whoami remoteAddr={} xff={}", request.getRemoteAddr(), request.getHeader("X-Forwarded-For"));
        return info;
    }
}
```

### 4. 配置文件

`application.yml` 完整内容如下。`forward-headers-strategy: framework` 就是上面说的真实 IP 开关；线程和排队参数先给个够用的值，方便压测时观察：

```yaml
server:
  port: 8080
  forward-headers-strategy: framework
  tomcat:
    threads:
      max: 200
      min-spare: 20
    accept-count: 200
    max-connections: 8192

spring:
  application:
    name: nginx-timeout-demo

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics

logging:
  level:
    com.example.nginxdemo: INFO
```

### 5. Nginx 配置

这是完整的一份 `nginx.conf`，可以直接放到 `/etc/nginx/nginx.conf`。关键点都用注释标了出来，重点看 `upstream` 块和 `location /api/` 里的三件套：

```nginx
user  nginx;
worker_processes  auto;
worker_rlimit_nofile 65535;

error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  4096;
    multi_accept        on;
    use                 epoll;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    # 记录上游真实耗时，排查超时全靠这几个变量
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" "$http_user_agent" '
                      'rt=$request_time urt=$upstream_response_time uct=$upstream_connect_time ust=$upstream_status';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout  65;
    keepalive_requests 10000;
    client_max_body_size 10m;

    gzip              on;
    gzip_min_length   1024;
    gzip_types        text/plain text/css application/json application/javascript text/xml application/xml;

    upstream spring_boot_backend {
        server 127.0.0.1:8080 max_fails=3 fail_timeout=30s;

        # 连接池：最多缓存 64 条到上游的空闲长连接
        keepalive 64;
        keepalive_requests 10000;
        keepalive_timeout 55s;
    }

    server {
        listen       80;
        server_name  _;

        location /api/ {
            # 末尾不带斜杠，原样透传 /api/xxx 路径
            proxy_pass http://spring_boot_backend;

            # 开启上游长连接的三件套
            proxy_http_version 1.1;
            proxy_set_header Connection "";

            # 真实 IP 与协议信息
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-Host  $host;
            proxy_set_header X-Forwarded-Port  $server_port;

            # 三段超时，按业务耗时留余量
            proxy_connect_timeout 3s;
            proxy_send_timeout    30s;
            proxy_read_timeout    90s;

            # 单机部署下禁止超时重试，避免请求被执行两次
            proxy_next_upstream error timeout http_502 http_503 http_504;
            proxy_next_upstream_tries 1;

            proxy_buffering on;
            proxy_buffers  16 16k;
            proxy_buffer_size 16k;
        }

        location /actuator/health {
            proxy_pass http://spring_boot_backend;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            access_log off;
        }
    }
}
```

### 6. 跑起来，四步验证

先启动 Spring Boot，再校验并加载 Nginx 配置：

```bash
# 启动后端（项目根目录执行）
mvn spring-boot:run

# 校验配置语法，确认没问题再 reload
sudo nginx -t -c /etc/nginx/nginx.conf
sudo nginx -c /etc/nginx/nginx.conf
# 已运行中则用：sudo nginx -s reload
```

然后按顺序跑下面四条命令，每条都在验证一个怀疑点：

```bash
# 1) 直连后端，确认后端本身很快
curl -s "http://127.0.0.1:8080/api/fast"

# 2) 走 Nginx，验证真实 IP 有没有透传过来
curl -s "http://127.0.0.1/api/whoami"

# 3) 让后端睡 80 秒，Nginx 的 proxy_read_timeout 是 90s，应当能等到结果
curl -i "http://127.0.0.1/api/slow?ms=80000"

# 4) 压测连接复用，同时盯住 TIME_WAIT 的数量
ab -n 5000 -c 100 "http://127.0.0.1/api/fast"
ss -s
ss -tan state time-wait | wc -l
```

第 3 步把 `proxy_read_timeout` 临时改回默认的 60s 再跑一次，就能看到 504，后端日志里却是正常跑完的——这就是文章开头那个现象的最小复现。把 `keepalive 64;` 那行注释掉，再跑第 4 步，`time-wait` 的数量会明显往上跳。

## 四、踩坑经验和最佳实践

**超时和连接复用这两个坑，踩一次就够记一辈子，我把最常见的六个列在这儿。**

**1. 代理超时小于后端耗时，504 之外还多送一次重复执行。**
`proxy_read_timeout` 默认 60s，业务一旦跑 70s 就必超时。更危险的是 `proxy_next_upstream` 默认包含 `timeout`，Nginx 会拿同一个后端再打一遍，接口本身又不是幂等的，账就乱了。我现在的做法是：单机部署直接把 `proxy_next_upstream_tries` 设成 1，或者干脆改造接口支持幂等键。

**2. 三件套缺一个，连接池等于没开。**
`keepalive`、`proxy_http_version 1.1`、`proxy_set_header Connection ""` 必须同时出现。只写 `keepalive 64;` 是最常见的半吊子配置：连接池建了，但请求头里带 `Connection: close`，连接用完即弃，看着有池子，实际还是短连接。

**3. Nginx 池里连接的存活时间，要比后端长连接超时长。**
Tomcat 对空闲连接有自己的超时（`server.tomcat.connection-timeout` 那类参数）。如果 Nginx 池中闲置的连接比后端先被关掉，复用时就撞上一条已经半死的连接，报 `upstream prematurely closed connection while reading response header`，客户端看到 502。稳妥做法是让 Nginx 侧 `keepalive_timeout` 明显小于后端空闲超时。

**4. 日志里别只看 `$request_time`。**
`$request_time` 是从客户端读到第一个字节到发完响应的总时长，包含客户端自己慢、网络慢的部分。判断到底谁慢，要看 `$upstream_response_time`：它才是后端真正的耗时。这两个数一对比，锅在谁头上立刻清楚。

**5. `proxy_pass` 末尾加不加斜杠，路径完全不一样。**
`proxy_pass http://backend;` 会把原始 URI 原样转发，后端收到 `/api/fast`；写成 `proxy_pass http://backend/;` 则会用斜杠后面的部分替换掉匹配到的前缀。这两个写法都对，但含义不同，改配置前先想清楚，不然 404 找半天。

**6. 上传大文件被 413 拦住，不是代码问题。**
`client_max_body_size` 默认只有 1m，图片、附件一超就返回 413 Request Entity Too Large，而且这个错在 Spring Boot 侧根本看不到日志。按业务实际体积往上调就行。

## 五、性能对比和技术选型

**短连接和长连接池的差别，只在“连接建立”这一段，但这一段在高并发下占比很大。**

| 对比项 | 短连接（默认） | 上游连接池 |
| --- | --- | --- |
| 每请求开销 | 三次握手 + 四次挥手 | 复用已建连接 |
| TIME_WAIT 堆积 | 严重 | 明显减少 |
| 本机端口占用 | 高，可能耗尽 | 稳定在池子大小附近 |
| 配置成本 | 零 | 三件套 + 池大小 |
| 适用场景 | 请求量极低 | 绝大多数生产环境 |

至于 Nginx 和 Spring Cloud Gateway 怎么选，我的立场很明确：**流量入口、TLS 卸载、静态资源、四层转发交给 Nginx；业务级的鉴权、灰度、按用户维度的限流交给 Gateway。** 别用 Gateway 去做 Nginx 擅长的活，它的定位是业务网关，跑在 JVM 上，扛纯转发不划算。两个叠在一起，Nginx 在最外层做第一道缓冲，Gateway 在后面做业务路由，是最常见的组合。

## 六、总结

排查“Nginx 反代 Spring Boot 超时”，按这个顺序走，基本不会跑偏：

1. 先看 Nginx 的 error.log 和 access_log 里的 `$upstream_response_time`，确认是代理侧超时还是后端真的慢；
2. 再去对齐两段的超时参数，重点记住 `proxy_read_timeout` 管的是“两次读之间的间隔”，不是总耗时；
3. 然后检查上游长连接三件套写全没有，这是连接数问题的根源；
4. 最后处理真实 IP 的透传，别让日志和限流全是 Nginx 自己的地址。

超时参数没有“标准答案”，它取决于你的业务最慢那一个接口愿意等多久。所有阈值都应该从业务耗时倒推出来，而不是从别人的博客里抄。

## 参考资料

1. [ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
2. [ngx_http_upstream_module](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)
3. [ngx_http_core_module](https://nginx.org/en/docs/http/ngx_http_core_module.html)
4. [Spring Boot Reference Documentation](https://docs.spring.io/spring-boot/index.html)
5. [Spring Boot: Build Systems](https://docs.spring.io/spring-boot/reference/using/build-systems.html)

文 / 会编程的吕洞宾

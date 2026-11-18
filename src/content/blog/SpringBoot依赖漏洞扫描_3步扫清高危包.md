---
title: "Spring Boot依赖漏洞扫描：3步扫清高危包"
date: 2026-10-15T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> Text4Shell 那波风头过后，团队定了条规矩：Java 项目上线前必须过一遍依赖扫描。上周我把这条规矩落到自己的 Spring Boot 服务上，工具一跑，报告里躺着 3 个高危 jar。我盯着 `mvn dependency:tree` 打出来的几百行坐标看了半天——这些包一个都不是我主动引入的，全是某个 starter 顺手带进来的。挨个查版本号对应哪个 CVE？做不到。这篇把最后跑通的方案完整写下来：工具怎么选、pom 怎么配、怎么接进 CI，以及我实打实踩过的坑。

## 一、Spring Boot 项目的依赖漏洞，问题到底出在哪

一句话结论：依赖漏洞扫描，就是把你项目真正用到的每个第三方 jar 和它的版本号，拿去公开漏洞库里比对一遍，看哪些版本命中了已知 CVE。

先说三个现实。

**第一，你引入的依赖远比你以为的多。** 一个加了 `spring-boot-starter-web` 的项目，`mvn dependency:list` 数出来的 jar 少说七八十个。我那个服务最终依赖 127 个，里面绝大多数我不认识。

**第二，漏洞是随时间长出来的。** 你今天锁定一个版本，它今天是干净的，不代表三个月后还干净。CVE 是持续新增的，NVD 每天都在收录。项目越大、依赖越老，"哪天爆雷"只是概率问题。

**第三，手工排查根本做不到。** `dependency:tree` 只告诉你坐标和版本，不会告诉你这个版本有没有洞。要判断得自己去 NVD 一个包一个包查，一百多个包查完人就废了。而且 CVE 和包的对应关系有时候很绕——同一个 CVE 可能影响好几个包，同一个包在不同版本下受影响情况还不一样。

举个真实的例子，也是我这次扫出来的头号问题。项目直接依赖了 `commons-text` 1.9，用来做字符串模板替换。这个版本命中了 CVE-2022-42889，也就是 Text4Shell，CVSS 评分 9.8（满分 10）。

为什么这么严重？`commons-text` 的 `StringSubstitutor` 默认开启了一堆"插值器"，其中包含 `script`、`dns`、`url` 三种。如果模板内容来自用户输入，攻击者构造 `${script:javascript:...}` 这样的字符串，就能在服务端执行代码。拿它去拼用户传进来的文本，等于把机器交出去。

## 二、扫描器的底层原理，四步走

扫描器不是靠猜的。不管哪家工具，核心流程都是这四步。

**第一步，收集依赖清单。** Maven 插件在构建时读的是 Maven 已经解析好的依赖树，包括所有传递依赖和它们最终生效的版本。这里的关键词是"最终生效"：同一个包被多条路径引入时，Maven 的仲裁规则会挑一个版本，扫描器拿到的就是那个。所以扫描结果和运行时真实加载的 jar 是对得上的，不是纸上谈兵。

**第二步，把依赖转成 SBOM。** SBOM 是 Software Bill of Materials 的缩写，材料清单，本质是一份标准化的"我用了哪些组件、什么版本"的表格。目前主流格式是 CycloneDX。每个组件在 SBOM 里有一个唯一标识叫 purl（package URL），长这样：

```
pkg:maven/org.apache.commons/commons-text@1.9
```

这个格式的好处是机器和人都能读。甲方或者监管部门要"软件物料清单"，你直接把文件交出去就行。

**第三步，拿清单去漏洞库比对。** 这是最容易出岔子的环节，值得多说两句。NVD（美国国家漏洞数据库）里的 CVE 记录，描述漏洞用的是一套叫 CPE 的命名规则，形如 `cpe:2.3:a:apache:commons_text:1.9:*:*:*:*:*:*:*`。扫描器得先把你 SBOM 里的组件映射成 CPE，再去库里带 CPE 的记录里找匹配。

问题就出在"映射"上。这个映射靠组件名、厂商名、版本范围做模糊匹配，没人给你打保票。所以经常出现两种情况：真漏洞没匹配上（漏报），无关的 CVE 匹配到了你头上（误报）。这也是后面必须把误报处理讲清楚的原因。

**第四步，定级并决定是否拦截。** 每条命中的漏洞带一个 CVSS 分数，0 到 10。工具按你设的阈值判断：分数超过阈值，构建失败。阈值配置很关键——默认值是不拦截，永远不失败。所以很多团队扫了半年，报告出了一堆，一次也没拦住过人。

再说下数据从哪来。扫描器运行时要先更新本地漏洞库，数据从 NVD 的 API 拉取，缓存在本地。第一次运行要下载几百 MB 的漏洞数据，时间从十几分钟到几十分钟不等。而且现在的 NVD API 需要申请 Key 才能按正常速度使用，不带 Key 会被限速，更新过程慢到你以为程序卡死了。这个坑下面单独讲。

## 三、实战：3 步跑起来

先说结论：三步就是把插件配上、把漏洞库更新好、把扫描绑到构建里。

### 项目骨架

一个最小可用的 Spring Boot 服务，目录长这样：

```
dep-scan-demo
├── pom.xml
├── dependency-check-suppressions.xml
└── src
    └── main
        ├── java
        │   └── com/example/depscan
        │       ├── DependencyScanDemoApplication.java
        │       └── controller/TextController.java
        └── resources
            └── application.yml
```

`TextController` 的存在只有一个目的：让 `commons-text` 真的被代码用到，这样扫描器扫出问题才有说服力。真实项目里换成你自己的代码即可。

### 主启动类

```java
package com.example.depscan;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DependencyScanDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DependencyScanDemoApplication.class, args);
    }
}
```

标准的 Spring Boot 入口，没什么可说的。

### 用到了存在漏洞的库的 Controller

```java
package com.example.depscan.controller;

import org.apache.commons.text.StringSubstitutor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

@RestController
public class TextController {

    @GetMapping("/render")
    public String render(@RequestParam String template) {
        Map<String, String> values = new HashMap<>();
        values.put("app", "dep-scan-demo");
        StringSubstitutor substitutor = new StringSubstitutor(values);
        return substitutor.replace(template);
    }
}
```

这段代码的作用是：把请求参数 `template` 里的 `${app}` 占位符替换成 `dep-scan-demo`，然后返回。写起来很顺手，问题在于 `StringSubstitutor` 默认还认识别的插值器——`${script:...}`、`${dns:...}`、`${url:...}`。传入 `${script:javascript:java.lang.Runtime.getRuntime().exec('id')}` 这类字符串，它就会尝试在服务端执行东西。1.10 之后的版本默认把这几个危险的插值器关掉了。这就是"版本差一点点，处境差一大截"。

### application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: dep-scan-demo

logging:
  level:
    root: INFO
```

### 第 1 步：配好 pom.xml

这是全文的核心，完整贴出来：

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
    <artifactId>dep-scan-demo</artifactId>
    <version>1.0.0</version>
    <name>dep-scan-demo</name>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <dependency-check.version>13.0.0</dependency-check.version>
        <cyclonedx.version>2.9.3</cyclonedx.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.apache.commons</groupId>
            <artifactId>commons-text</artifactId>
            <version>1.9</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.1</version>
                <executions>
                    <execution>
                        <id>repackage</id>
                        <goals>
                            <goal>repackage</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>

            <plugin>
                <groupId>org.cyclonedx</groupId>
                <artifactId>cyclonedx-maven-plugin</artifactId>
                <version>2.9.3</version>
                <configuration>
                    <projectType>application</projectType>
                    <schemaVersion>1.6</schemaVersion>
                    <outputFormat>json</outputFormat>
                </configuration>
                <executions>
                    <execution>
                        <phase>package</phase>
                        <goals>
                            <goal>makeAggregateBom</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>

            <plugin>
                <groupId>org.owasp</groupId>
                <artifactId>dependency-check-maven</artifactId>
                <version>13.0.0</version>
                <configuration>
                    <failBuildOnCVSS>7</failBuildOnCVSS>
                    <nvdApiKey>${env.NVD_API_KEY}</nvdApiKey>
                    <formats>
                        <format>HTML</format>
                        <format>JSON</format>
                    </formats>
                    <suppressionFiles>
                        <suppressionFile>dependency-check-suppressions.xml</suppressionFile>
                    </suppressionFiles>
                    <skipTestScope>true</skipTestScope>
                    <skipProvidedScope>true</skipProvidedScope>
                </configuration>
                <executions>
                    <execution>
                        <id>dependency-check</id>
                        <phase>verify</phase>
                        <goals>
                            <goal>check</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
```

几个关键点解释一下：

- `failBuildOnCVSS` 设成 7。7 分以上算高危，构建直接失败。这是整个配置里最有用的一行——没有它，扫描报告就只是给别人看的 PDF。
- `nvdApiKey` 从环境变量 `NVD_API_KEY` 读。别硬编码在 pom 里，pom 会进仓库。
- `skipTestScope` 和 `skipProvidedScope` 设为 true。测试依赖和 provided 依赖不进运行时的包，扫它们只会制造噪音。
- CycloneDX 插件绑在 `package` 阶段，跑完打包顺手产出 `target/bom.json`。
- Dependency-Check 绑在 `verify` 阶段，也就是 `mvn verify` 的最后一步。

### 第 2 步：准备 API Key 和误报文件

先去 NVD 官网申请一个 API Key，免费，填个邮箱就行，链接在文末参考资料里。然后：

```bash
export NVD_API_KEY=你的key
```

接着在项目根目录建 `dependency-check-suppressions.xml`，用来压制确认过的误报或者已经接受的风险：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<suppressions xmlns="https://jeremylong.github.io/DependencyCheck/dependency-suppression.1.3.xsd">

    <suppress until="2027-01-31Z">
        <notes><![CDATA[
        commons-text 的 Text4Shell。这个接口只在内网调用，且参数由我们自己的模板拼接，
        本次先接受风险。2027-01-31 之后本压制自动失效，到时必须升级到 1.10 以上。
        ]]></notes>
        <packageUrl regex="true">^pkg:maven/org\.apache\.commons/commons-text@.*$</packageUrl>
        <cve>CVE-2022-42889</cve>
    </suppress>

</suppressions>
```

用法说明：`until` 写一个过期时间，到点压制自动失效，防止"临时容忍"变成"永久遗忘"。`packageUrl` 用正则匹配到具体组件，`cve` 指定要压的漏洞编号。扫描器每次出声时都会提示哪条压制规则一条都没匹配上，所以规则不会悄悄烂在文件里。

### 第 3 步：跑扫描，看结果

```bash
# 生成 SBOM
mvn -B -DskipTests org.cyclonedx:cyclonedx-maven-plugin:2.9.3:makeAggregateBom

# 依赖漏洞扫描（会用到 pom 里的配置）
mvn -B -DskipTests org.owasp:dependency-check-maven:13.0.0:check
```

第一条命令产出 `target/bom.json`。第二条在 `target/` 下生成 `dependency-check-report.html`，浏览器打开就是一份带排名的漏洞清单：哪个包、哪个版本、命中哪个 CVE、CVSS 多少、修复版本是哪个。

如果把上面的压制文件去掉，构建会因为 `commons-text` 1.9 的 9.8 分直接失败。把版本升到 1.10 以上，重跑，失败消失——这就是这套机制最直观的用法。

### 接进 CI

本地跑靠自觉，CI 里跑才叫规矩。一份完整的 GitHub Actions 配置：

```yaml
name: dependency-scan

on:
  push:
    branches: [ main ]
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven

      - name: 缓存 NVD 漏洞库
        uses: actions/cache@v4
        with:
          path: ~/.m2/repository/org/owasp/dependency-check-data
          key: nvd-data-${{ github.run_id }}
          restore-keys: nvd-data-

      - name: 生成 SBOM
        run: mvn -B -DskipTests org.cyclonedx:cyclonedx-maven-plugin:2.9.3:makeAggregateBom

      - name: 依赖漏洞扫描
        env:
          NVD_API_KEY: ${{ secrets.NVD_API_KEY }}
        run: mvn -B -DskipTests org.owasp:dependency-check-maven:13.0.0:check

      - name: 上传报告
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dependency-check-report
          path: |
            target/dependency-check-report.html
            target/bom.json
```

三个动作值得注意：

- `NVD_API_KEY` 从仓库 Secrets 里读，不写死在 workflow 里。
- 缓存 NVD 数据目录。第一次跑要下载几百 MB 漏洞数据，缓存之后后续构建直接复用，时间从几十分钟压到一两分钟。
- 上传报告用 `if: always()`。构建因为漏洞失败的时候，报告才是最需要看的东西，别让它随构建一起丢。

## 四、踩坑经验和最佳实践

**踩坑一：不带 API Key，第一次扫描能卡到你怀疑人生。** 我第一版没配 Key，`mvn verify` 跑了四十分钟还在"更新漏洞库"。NVD 的 API 不带 Key 时限流非常严，加上要拉的数据量大，结果就是慢到没有任何反馈。申请 Key 只要一分钟，别省这一步。

**踩坑二：报告说"0 漏洞"，先别高兴。** 大概率是本地漏洞库压根没更新成功。更新失败时扫描器不会报错，只会拿旧数据继续扫，或者干脆认为数据是空的。养成习惯：第一次扫描后看一眼日志里"数据库更新完成"的时间戳，是当天才作数。

**踩坑三：默认不拦截，等于白扫。** `failBuildOnCVSS` 的默认值是不拦截。很多团队接进流水线然后发现"从来没红过"，以为是自己代码干净，其实只是阈值没设。设成 7 是个合理的起步值。

**踩坑四：误报要有出口，但不能有后门。** 误报多了团队就会关掉扫描，所以必须有压制机制。但压制有两条纪律：一是写清楚为什么，二是设 `until` 过期时间。没有过期时间的压制规则，一年后没人记得它为什么存在，也没人敢删。

**踩坑五：别在每次 `mvn test` 之前自动扫描。** 一次扫描几十秒到几分钟，本地开发高频触发非常难受。放在 `verify` 阶段，或者干脆只在 CI 跑，本地需要时手动敲命令。

**踩坑六：升级到"最新版本"不等于安全。** 见过把依赖升到某个月的最新小版本就觉得万事大吉的，结果那个"最新"还是那个有洞的版本。判断依据永远是报告里给出的具体修复版本，不是"看起来比较新"。

几条我推荐的实践：

- 依赖版本统一收口。能靠 Spring Boot 的 BOM 管理的就别自己拍版本号，收口之后升级只改一处，漏洞面也小。
- 扫描频率和构建频率对齐。PR 必扫，主干每日扫一次——新 CVE 会持续冒出来，只在提交时扫会漏掉。
- SBOM 留档。每次发布产出的 `bom.json` 存起来，将来爆出某组件漏洞时，你能第一时间反查哪些线上版本受影响。

## 五、性能对比和技术选型

三种主流路线的对比：

| 方案 | 数据来源 | 部署方式 | 误报控制 | 成本 |
| --- | --- | --- | --- | --- |
| OWASP Dependency-Check | NVD | Maven 插件/CLI，本地或 CI 直接跑 | 靠压制文件，中等 | 免费 |
| CycloneDX SBOM + 外部扫描器（如 Trivy、Grype） | NVD、GHSA、OSV 等多个源 | 先出 SBOM，再离线扫描文件 | 多源交叉，较好 | 免费 |
| 商业 SCA（Snyk、Mend 等） | 厂商自建库 | 平台或编辑器插件，需上传依赖信息 | 人工复核，最好 | 收费 |

我的建议很直接：**起步就用 OWASP Dependency-Check 接进 CI，别一上来买商业工具。** 免费方案的主要短板是误报，但误报是可以管理的——你有压制文件，有明确的止血流程。等团队规模上来了、误报多到压不动了，再考虑换。

如果对误报零容忍，走第二条路：用 CycloneDX 出 SBOM，交给 Trivy 或 Grype 扫。多数据源交叉能让误报明显下降，代价是要多维护一个扫描工具。这条路还有个额外好处——SBOM 文件本身越来越成为合规交付的硬要求，你顺手就交了。

## 六、总结

整个过程就三步：

1. pom 里挂上 CycloneDX 插件出 SBOM，挂上 Dependency-Check 做扫描，`failBuildOnCVSS` 设成 7。
2. 申请 NVD API Key，写到环境变量里；建好压制文件，每条压制带过期时间。
3. 扫描绑到 `verify`，在 CI 里跑，报告用 `if: always()` 上传。

整件事的价值不在"扫出多少个漏洞"，而在于把"我用的东西有没有已知问题"这件事从人肉排查变成流水线的一部分。第一次配好大概花半小时，之后每次提交都在替你把关。

装完就去把自己项目扫一遍。我赌至少能扫出几个你从没听说过的包。

## 参考资料

- 【OWASP Dependency-Check 项目主页】https://owasp.org/www-project-dependency-check/
- 【dependency-check-maven 插件文档】https://jeremylong.github.io/DependencyCheck/dependency-check-maven/
- 【dependency-check-maven 配置项说明】https://jeremylong.github.io/DependencyCheck/dependency-check-maven/configuration.html
- 【NVD API Key 申请页面】https://nvd.nist.gov/developers/request-an-api-key
- 【CycloneDX Maven Plugin】https://github.com/CycloneDX/cyclonedx-maven-plugin
- 【CycloneDX 规范概览】https://cyclonedx.org/specification/overview/
- 【Spring Boot 官方文档】https://docs.spring.io/spring-boot/

文 / 会编程的吕洞宾

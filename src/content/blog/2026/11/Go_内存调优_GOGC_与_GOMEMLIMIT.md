---
title: Go 内存调优：GOGC 与 GOMEMLIMIT
date: 2026-11-23 21:08:27
tags: ["Go", "GC", "GOMEMLIMIT", "内存调优"]
categories: go
---

# Go 内存调优：GOGC 与 GOMEMLIMIT

去年冬天，一个订单导出服务被 OOMKilled，容器配额 512Mi。运维把 pprof 图甩过来：inuse_space 180MiB，怎么看都不像泄漏。可 RSS 就是六百多兆，重启一次能撑两天，然后继续被杀。

两边都没说错。错在我们把「Go 认为自己用了多少内存」和「操作系统认为这个进程用了多少内存」当成了同一件事。

## 一、GC 盯的只是堆

Go 的 GC 是并发的三色标记清除。对象分三种颜色：白，还没被访问到；灰，访问到了但字段还没扫完；黑，自己和字段都扫完了。标记开始时所有对象都是白的，从根集合——goroutine 栈、全局变量、寄存器——出发，把能碰到的对象染黑，剩下的白对象这一轮清掉。

标记和业务代码同时跑，所以要靠写屏障兜底：GC 期间每一次指针赋值都要额外记一笔，防止刚被引用的对象漏标。代价是赋值变贵，CPU 缓存被搅乱。Go 因此给标记阶段定了个硬约束：最多吃掉 25% 的 CPU。

分配太快、标记跟不上怎么办？runtime 会拉当前这个 goroutine 去帮忙扫，叫 mark assist。这玩意儿比 STW 阴得多。STW 只有两次，通常几百微秒，日志里都未必看得见；assist 是散在每一个请求里的延迟抖动，火焰图上表现为「业务代码莫名其妙变慢了」，你还找不到热点，因为热点在 runtime 里。

还有一件事得说清：GC 只管 Go 堆。goroutine 栈、mcache、GC 自己的元数据、cgo 分配、mmap 的文件、二进制本身，都不在堆里，或者只被部分统计。RSS 是操作系统视角，比 heap 大是常态，不是异常。而且进程把内存还给 OS 特别不积极，scavenger 是慢慢来的，不是 GC 完就立刻归还。

那场事故的真相很朴素：活堆 180MiB，GOGC 默认 100，于是 GC 允许堆涨到 360MiB 才动手，加上还没归还的碎片和 runtime 结构，峰值轻松破 500，正好压在容器天花板下面。平时没事，一波流量就顶穿了。

## 二、GOGC 是个倍数，不是目标值

GOGC 的语义经常被读错。它不是「堆到多少兆就 GC」，而是一个比例：

```
下一次 GC 的堆目标 = 上次 GC 结束时的存活堆 × (1 + GOGC/100)
```

Go 1.27 里默认还是 100，也就是允许堆在存活数据的基础上翻一倍。

举个具体的：活堆 60MiB，GOGC=100，那堆涨到 120MiB 触发 GC，也就是说要分配 60MiB 才回收一次。如果这个服务每秒分配 400MiB，一秒就是六到七次 GC。每次都把 60MiB 活对象重新扫一遍，指针越多越慢。你看到的是 CPU 高、延迟抖，其实是 GC 在追着你的分配速度跑。

反过来，活堆 2GiB 的服务，GOGC=100 意味着允许再涨 2GiB。内存是够，但 GC 一轮要扫 2GiB，标记时间拉长，峰值也更吓人。同一个参数，在小堆服务上是「GC 太频繁」，在大堆服务上是「峰值太高」，这就是它烦人的地方。

调节方向很简单：调低 GOGC，GC 更频繁、峰值更低、CPU 更高；调高 GOGC 反过来。GOGC=off 关掉按比例触发，这时候就得有别的机制接管，否则堆会一直长到 OOM。

## 三、GOMEMLIMIT 才是那个天花板

从 Go 1.19 起，runtime 提供了一个软上限：`GOMEMLIMIT`，也可以用 `runtime/debug.SetMemoryLimit` 在运行中改。

它的工作方式不复杂：runtime 每轮都算两个堆目标，一个是 GOGC 算出来的，一个是内存上限反推出来的，取小的那个。所以它没改 GC 算法，只是给堆目标加了个盖子。快到上限时 GC 提前启动，把内存压回去。

它统计哪些内存？Go runtime 管理的全部：堆、goroutine 栈、runtime 数据结构、GC 元数据。不统计哪些？cgo 分配、mmap 的文件页、操作系统还没回收的内存、子进程。

所以别把 GOMEMLIMIT 设成容器的 limit。我一般按 limit 的 80% 给，剩下的当缓冲。理由很实在：那些不在统计范围内的内存真实存在，堆碎片也要地方待，留点余量比精确调参便宜。

有个坑必须提：活堆贴着 limit 会死循环。每轮 GC 只能回收一点点，于是 GC 不停地跑，CPU 打满，QPS 掉到接近零，进程还活着但已经不干活了。这不是理论，我线上见过一次，排查时 gctrace 刷屏，live 值死死贴住 limit。判断方法很直接：GC 频率暴涨 + live 接近上限，就是它。真遇到了，要么加内存，要么减活对象，调参数救不回来。

## 四、先把数看清楚

下面这份代码可以直接跑。它做三件事：预热一个约 120MiB 的缓存当「活堆」，起一个 goroutine 不停制造临时对象模拟流量，每秒打印一次 live、goal、已归还量和 GC 次数。

**go.mod**

```go
module gcdemo

go 1.27.4
```

**main.go**

```go
package main

import (
	"fmt"
	"os"
	"runtime/debug"
	"runtime/metrics"
	"strconv"
	"sync"
	"time"
)

type item struct {
	id   int
	data []byte
}

var cache sync.Map

func warmCache(n int) {
	for i := 0; i < n; i++ {
		cache.Store(i, &item{id: i, data: make([]byte, 1024)})
	}
}

// handle 模拟一次请求：拼一段响应，产生几 KB 临时对象。
func handle(id int) []byte {
	buf := make([]byte, 0, 4096)
	for i := 0; i < 32; i++ {
		buf = strconv.AppendInt(buf, int64(id), 10)
		buf = append(buf, ':')
		buf = strconv.AppendInt(buf, int64(i), 10)
		buf = append(buf, ';')
	}
	return buf
}

func sample(name string) float64 {
	s := []metrics.Sample{{Name: name}}
	metrics.Read(s)
	switch s[0].Value.Kind() {
	case metrics.KindUint64:
		return float64(s[0].Value.Uint64())
	case metrics.KindFloat64:
		return s[0].Value.Float64()
	default:
		return 0
	}
}

func main() {
	limitMiB := 800
	if v := os.Getenv("MEMLIMIT_MIB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limitMiB = n
		}
	}
	old := debug.SetMemoryLimit(int64(limitMiB) << 20)
	fmt.Printf("memory limit: %d MiB (previous: %d bytes)\n", limitMiB, old)

	warmCache(120000) // 约 120 MiB 常驻

	go func() {
		for i := 0; ; i++ {
			_ = handle(i)
			time.Sleep(50 * time.Microsecond)
		}
	}()

	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for range tick.C {
		live := sample("/gc/heap/live:bytes")
		goal := sample("/gc/heap/goal:bytes")
		cycles := sample("/gc/cycles/total:gc-cycles")
		released := sample("/memory/classes/heap/released:bytes")
		fmt.Printf("live=%4.0fMiB goal=%4.0fMiB released=%4.0fMiB gc=%3.0f\n",
			live/(1<<20), goal/(1<<20), released/(1<<20), cycles)
	}
}
```

跑起来：

```bash
MEMLIMIT_MIB=200 GODEBUG=gctrace=1 go run .
```

故意把上限压到 200MiB，会看到 goal 被 limit 拽住，GC 次数明显变密。改成 800 再跑，goal 回到 GOGC 算出来的值附近。这两个数字的差别，就是 GOMEMLIMIT 干的事。

gctrace 的输出大概长这样，数字随机器变：

```
gc 7 @3.658s 0%: 0.14+8.3+0.003 ms clock, 1.7+0.11/23/63+0.046 ms cpu, 168->168->134 MB, 182 MB goal, 0 MB stacks, 0 MB globals, 12 P
```

看三处就够：`168->168->134 MB` 是 GC 前、标记中、GC 后的堆大小，最后那个 134 才是活对象；`182 MB goal` 是本轮目标，注意它明显小于 134 的两倍——200MiB 的上限在这里说了话，GOGC 本来允许它涨到 268；开头那个百分比是整个进程生命周期里 GC 占用的 CPU 比例，长期超过 10%，说明分配速度和堆大小不匹配。

## 五、三种场景，三种配法

**内存受限的容器服务。** 这是最常见的。容器 1Gi，GOMEMLIMIT 给 800MiB，GOGC 保持默认。这样正常流量下 GOGC 说了算，突发流量下 limit 兜底，不会因为一次尖峰就被 OOMKilled。别把 GOGC 设成 off 只靠 limit，那等于把所有判断都压在一个软限制上，活对象一多就进入空转模式。

**延迟敏感的 API。** 很多人第一反应是把 GOGC 调低「减少单次暂停」。方向错了。Go 的 STW 早就是亚毫秒级，你感受到的抖动基本来自 mark assist 和 CPU 争抢。调低 GOGC 只会让 GC 更频繁，CPU 更紧张，抖动更明显。真遇到延迟问题，先看 pprof 里的分配，再看 GOGC 是不是被人改成 20 了——这种配置我见过不止一次，改的人还挺自豪。

**离线批处理。** 反过来，可以大胆一点。GOGC=400 甚至 off，配一个宽裕的 limit，让 GC 少来烦你。阶段之间如果确实需要腾地方，手动调一次 `debug.FreeOSMemory()` 比反复 GC 划算。批处理任务的特点是没有用户在等，吞吐优先。

## 六、pprof 找的是分配源

GC 是结果，分配才是原因。这句话值得贴在显示器上。

服务里匿名导入了 `net/http/pprof` 并挂了 `http.DefaultServeMux` 的话，可以直接这么看：

```bash
go tool pprof -sample_index=alloc_space -http=:8080 http://127.0.0.1:6060/debug/pprof/heap
```

`inuse_space` 是当前还活着的，看泄漏用它；`alloc_space` 是累计分配量，看 GC 压力用它。后者经常被忽略，但它才解释「为什么 GC 这么忙」。一个函数 inuse 只有几 MB，alloc_space 几十 GB，那就是它。

再看 `allocs` 视图，按对象个数排。小对象多到离谱的时候，GC 的成本不在字节数上，在扫描次数和元数据上。这时候优化方向是合并分配、复用缓冲，不是加内存。

## 七、少分配比调参有用

几个真管用的：

- `sync.Pool` 复用临时 buffer。它适合「用完就扔、随时可以重建」的东西，别往里塞连接、别指望里面的对象一定还在，GC 随时会清空它。
- 预分配容量。`make([]byte, 0, 4096)` 和 `make([]byte, 0)` 在循环 append 里的差别是几倍。
- 拼字符串用 `strings.Builder`，别用 `+=`。后者每次都新建一个字符串，分配量随长度平方增长。
- 切片存值不存指针。`[]item` 的扫描成本远低于 `[]*item`，缓存局部性也更好。指针是 GC 的工作量。
- 少做 `[]byte` 和 `string` 的来回转换。每次转换都是一次拷贝，路径上的热点函数尤其明显。
- map 给个初始容量。扩容时的 rehash 是全量分配，赶上流量高峰就是一次小型的 GC 冲击。

最后一条，也是最容易被忽略的：接口。把一个具体类型塞进 `interface{}` 可能会逃逸到堆上，哪怕它只有两个字段。这种分配在业务代码里到处都是，pprof 上一看就是「runtime.convT」占了一大块，这时候该改的是数据结构，不是 GC 参数。

## 收尾

调 GC 参数是最后一步，不是第一步。顺序应该是：pprof 找分配源 → 改代码少分配 → 设 GOMEMLIMIT 防顶穿 → 最后才动 GOGC。

反过来的顺序我也试过，结果是把一次三行代码就能解决的分配问题，调成了半个月的参数玄学。

## 参考资料

- [A Guide to the Go Garbage Collector](https://go.dev/doc/gc-guide)
- [Getting to Go: The Journey of Go's Garbage Collector](https://go.dev/blog/ismmkeynote)
- [runtime/debug: SetMemoryLimit](https://pkg.go.dev/runtime/debug#SetMemoryLimit)
- [runtime/metrics](https://pkg.go.dev/runtime/metrics)
- [runtime: Environment Variables](https://pkg.go.dev/runtime#hdr-Environment_Variables)

文 / 会编程的吕洞宾

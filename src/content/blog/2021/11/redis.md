---
title: "Redis基础"
date: 2021-11-08T20:37:00+08:00
category: "中间件"
tags: ["redis"]
---

[Redis学习参考网站](http://redisdoc.com)

## 1. 数据类型及基本操作指令

> * String 
> * Hash
> * List
> * Set
> * Zset
>

* String操作

   * 基础指令

      - [SET](http://redisdoc.com/string/set.html)
      - [SETNX](http://redisdoc.com/string/setnx.html)
      - [SETEX](http://redisdoc.com/string/setex.html)
      - [PSETEX](http://redisdoc.com/string/psetex.html)
      - [GET](http://redisdoc.com/string/get.html)
      - [GETSET](http://redisdoc.com/string/getset.html)
      - [STRLEN](http://redisdoc.com/string/strlen.html)
      - [APPEND](http://redisdoc.com/string/append.html)
      - [SETRANGE](http://redisdoc.com/string/setrange.html)
      - [GETRANGE](http://redisdoc.com/string/getrange.html)
      - [INCR](http://redisdoc.com/string/incr.html)
      - [INCRBY](http://redisdoc.com/string/incrby.html)
      - [INCRBYFLOAT](http://redisdoc.com/string/incrbyfloat.html)
      - [DECR](http://redisdoc.com/string/decr.html)
      - [DECRBY](http://redisdoc.com/string/decrby.html)
      - [MSET](http://redisdoc.com/string/mset.html)
      - [MSETNX](http://redisdoc.com/string/msetnx.html)
      - [MGET](http://redisdoc.com/string/mget.html)

   * incr指令

      * 用途：分布式ID、计数器

     * setnx 如果不存在则存入，否则存入失败

       * 用途：锁（互斥标志）
       * 问题：如果并发了怎么办？不会存在并发，因为命令执行是单线程，只要能保证抢标记

   * 场景

      * 缓存，存储session
        
      * 分布式锁，单线程
        
       * 计数器，分布式ID
        
       * 问题：死锁（锁 必须得有 有效期）
      
       ```java
           // 伪代码
                 if(set) // 拿到锁
                {
                  .... // 系统挂了
                  // 设置过期时间 该处逻辑不会被执行
                }
       ```
      
      

* Hash操作

  * 基础指令

    - [HSET](http://redisdoc.com/hash/hset.html)
    - [HSETNX](http://redisdoc.com/hash/hsetnx.html)
    - [HGET](http://redisdoc.com/hash/hget.html)
    - [HEXISTS](http://redisdoc.com/hash/hexists.html)
    - [HDEL](http://redisdoc.com/hash/hdel.html)
    - [HLEN](http://redisdoc.com/hash/hlen.html)
    - [HSTRLEN](http://redisdoc.com/hash/hstrlen.html)
    - [HINCRBY](http://redisdoc.com/hash/hincrby.html)
    - [HINCRBYFLOAT](http://redisdoc.com/hash/hincrbyfloat.html)
    - [HMSET](http://redisdoc.com/hash/hmset.html)
    - [HMGET](http://redisdoc.com/hash/hmget.html)
    - [HKEYS](http://redisdoc.com/hash/hkeys.html)
    - [HVALS](http://redisdoc.com/hash/hvals.html)
    - [HGETALL](http://redisdoc.com/hash/hgetall.html)
    - [HSCAN](http://redisdoc.com/hash/hscan.html)

  * 特点：结构型数据，统计数据

    商品 浏览数、下单数

  * 场景

    * 购物车

    * 可以作为分布式锁，并且可以做的更好

    * 能做重入锁，重入：同一个线程能够多次加锁 , 类似大门上锁，上了多把锁，只有自己才有钥匙解锁

      必要因素：1.互斥（key） 2.线程ID（file） 3.重入次数（value）

* List 操作

  * 基础指令
    - [LPUSH](http://redisdoc.com/list/lpush.html)
    - [LPUSHX](http://redisdoc.com/list/lpushx.html)
    - [RPUSH](http://redisdoc.com/list/rpush.html)
    - [RPUSHX](http://redisdoc.com/list/rpushx.html)
    - [LPOP](http://redisdoc.com/list/lpop.html)
    - [RPOP](http://redisdoc.com/list/rpop.html)
    - [RPOPLPUSH](http://redisdoc.com/list/rpoplpush.html)
    - [LREM](http://redisdoc.com/list/lrem.html)
    - [LLEN](http://redisdoc.com/list/llen.html)
    - [LINDEX](http://redisdoc.com/list/lindex.html)
    - [LINSERT](http://redisdoc.com/list/linsert.html)
    - [LSET](http://redisdoc.com/list/lset.html)
    - [LRANGE](http://redisdoc.com/list/lrange.html)
    - [LTRIM](http://redisdoc.com/list/ltrim.html)
    - [BLPOP](http://redisdoc.com/list/blpop.html)
    - [BRPOP](http://redisdoc.com/list/brpop.html)
    - [BRPOPLPUSH](http://redisdoc.com/list/brpoplpush.html)
  * 特点：有序的、元素可以重复的集合
  * 场景：消息队列（比如：blpop），不建议使用，作为消息队列没有任何回应，Redis AP模式，数据可靠性不

  > 说明：
  >
  > AP模式：优先保证可用性
  >
  > CP模式：优先保证数据一致性
  >
  > 一致性(Consistency) (等同于所有节点访问同一份最新的数据副本)
  > 可用性(Availability)(每次请求都能获取到非错的响应——但是不保证获取的数据为最新数据)
  > 分区容错性(Partition tolerance)(以实际效果而言，分区相当于对通信的时限要求。系统如果不能在时限内达成数据一致性，就意味着发生了分区的情况，必须就当前操作在C和A之间做出选择)

* Set操作

  * 基础指令
    - [SADD](http://redisdoc.com/set/sadd.html)
    - [SISMEMBER](http://redisdoc.com/set/sismember.html)
    - [SPOP](http://redisdoc.com/set/spop.html)
    - [SRANDMEMBER](http://redisdoc.com/set/srandmember.html)
    - [SREM](http://redisdoc.com/set/srem.html)
    - [SMOVE](http://redisdoc.com/set/smove.html)
    - [SCARD](http://redisdoc.com/set/scard.html)
    - [SMEMBERS](http://redisdoc.com/set/smembers.html)
    - [SSCAN](http://redisdoc.com/set/sscan.html)
    - [SINTER](http://redisdoc.com/set/sinter.html)
    - [SINTERSTORE](http://redisdoc.com/set/sinterstore.html)
    - [SUNION](http://redisdoc.com/set/sunion.html)
    - [SUNIONSTORE](http://redisdoc.com/set/sunionstore.html)
    - [SDIFF](http://redisdoc.com/set/sdiff.html)
    - [SDIFFSTORE](http://redisdoc.com/set/sdiffstore.html)
  * 特点：无序的、元素不可以重复的集合
  * 场景：
    * 抽奖 随机弹出（移除[SPOP]和不移除奖池[SRANDMEMBER]）
    * 交集、差集、并集
    * 点赞

* ZSet操作

  * 基础指令
    - [ZADD](http://redisdoc.com/sorted_set/zadd.html)
    - [ZSCORE](http://redisdoc.com/sorted_set/zscore.html)
    - [ZINCRBY](http://redisdoc.com/sorted_set/zincrby.html)
    - [ZCARD](http://redisdoc.com/sorted_set/zcard.html)
    - [ZCOUNT](http://redisdoc.com/sorted_set/zcount.html)
    - [ZRANGE](http://redisdoc.com/sorted_set/zrange.html)
    - [ZREVRANGE](http://redisdoc.com/sorted_set/zrevrange.html)
    - [ZRANGEBYSCORE](http://redisdoc.com/sorted_set/zrangebyscore.html)
    - [ZREVRANGEBYSCORE](http://redisdoc.com/sorted_set/zrevrangebyscore.html)
    - [ZRANK](http://redisdoc.com/sorted_set/zrank.html)
    - [ZREVRANK](http://redisdoc.com/sorted_set/zrevrank.html)
    - [ZREM](http://redisdoc.com/sorted_set/zrem.html)
    - [ZREMRANGEBYRANK](http://redisdoc.com/sorted_set/zremrangebyrank.html)
    - [ZREMRANGEBYSCORE](http://redisdoc.com/sorted_set/zremrangebyscore.html)
    - [ZRANGEBYLEX](http://redisdoc.com/sorted_set/zrangebylex.html)
    - [ZLEXCOUNT](http://redisdoc.com/sorted_set/zlexcount.html)
    - [ZREMRANGEBYLEX](http://redisdoc.com/sorted_set/zremrangebylex.html)
    - [ZSCAN](http://redisdoc.com/sorted_set/zscan.html)
    - [ZUNIONSTORE](http://redisdoc.com/sorted_set/zunionstore.html)
    - [ZINTERSTORE](http://redisdoc.com/sorted_set/zinterstore.html)
  * 特点：有序的、元素不可以重复的集合
  * 排序：如果score相同，用key的ASCII码排序
  * 场景：排行榜


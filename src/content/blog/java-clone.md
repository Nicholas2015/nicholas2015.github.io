---
title: "java拷贝技术探究"
date: 2014-06-26T20:37:00+08:00
category: "java"
tags: ["java"]
---

##  浅拷贝和深拷贝的区别

> 浅拷贝： 对当前对象进行克隆，并克隆该对象所包含的8种基本数据类型和String类型的属性（对当前对象拷贝一份并重新分配内存，即产生了新的对象）。但如果被克隆的对象中包含除了8种数据类型和String类型外的其他类型的属性，浅拷贝并不会克隆这些属性（即不会为这些属性分配内存，而是引用原来对象中的属性）
>
> 深拷贝： 深拷贝是在浅拷贝的基础上，递归地克隆除了8种基本类型和String类型之外的属性（即为这些属性重新分配内存而非引用原来对象中的属性）

## 浅拷贝（Shallow Clone）

### 构建实体类

```java
package com.nicholas.example.model;

import lombok.Getter;
import lombok.Setter;
import lombok.ToString;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * @author Nicholas
 */
@Getter
@Setter
@ToString
public class User implements Cloneable, Serializable {

    /**
     * 编号
     */
    private int id;

    /**
     * 名称
     */
    private String name;

    /**
     * 属性信息
     */
    private Map<String,Object> props;

    @Override
    public Object clone() throws CloneNotSupportedException {
        return super.clone();
    }
}

```

###　浅拷贝测试

```java
package com.nicholas.example.test;

import java.util.HashMap;
import java.util.Map;

public class CloningTest {

    public static void main(String[] args) throws CloneNotSupportedException {
        User origin = new User();
        origin.setId(1);
        origin.setName("Nicholas");
        Map<String, Object> props = new HashMap<>(2);
        props.put("salary",10000);
        props.put("city","NanJing");
        origin.setProps(props);

        User cloneUser = (User) origin.clone();

        // 检查user和cloneUser的属性是否一致
        System.out.println("user: " + origin);
        System.out.println("cloneUser: " + cloneUser);
        System.out.println("user and cloneUser === test: " + (origin == cloneUser));

        // 检查user和cloneUser的props是否一致
        System.out.println("user props: " + origin.getProps());
        System.out.println("cloneUser props: " + cloneUser.getProps());
        System.out.println("user and cloneUser props === test: " + (origin.getProps() == cloneUser.getProps()));

        // 让我们看看对默认克隆的影响
        // 修改user对象的props
        origin.getProps().put("title","CTO");
        origin.getProps().put("city","ChangZhou");
        System.out.println("cloneUser props:" + cloneUser.getProps());

        // 修改user的name
        origin.setName("SunChunYang");
        System.out.println("cloneUser name:" + cloneUser.getName());
    }
}
```

### 结果输出

```bash
D:\Develop\env\java\jdk-11.0.2\bin\java.exe ...
com.example.demo.model.CloningTest
user: User(id=1, name=Nicholas, props={salary=10000, city=NanJing})
cloneUser: User(id=1, name=Nicholas, props={salary=10000, city=NanJing})
user and cloneUser === test: false
user props: {salary=10000, city=NanJing}
cloneUser props: {salary=10000, city=NanJing}
user and cloneUser props === test: true
cloneUser props:{salary=10000, title=CTO, city=ChangZhou}
cloneUser name:Nicholas

Process finished with exit code 0
```

## 深拷贝（Deep Clone）

### 构建实体类

```java
/**
 * @author Nicholas
 */
@Getter
@Setter
@ToString
public class User implements Cloneable, Serializable {

    /**
     * 编号
     */
    private int id;

    /**
     * 名称
     */
    private String name;

    /**
     * 属性信息
     */
    private Map<String,Object> props;

    /**
     * 方法一：最原始的实现方式，经过构造方法手建立
     * 优势：
     * 1.实现简单直观
     * 2.不须要依赖额外的接口和第三方包
     * 缺点：
     * 1.成员变量发生变更须要修改方法，不知足开闭原则；
     * 2.不具备可复用性；
     */
    @Override
    public Object clone() {
       User copyUser = new User();
        copyUser.setId(this.getId());
        copyUser.setName(this.getName());
        if (this.getProps() != null) {
            Map<String, Object> hm = new HashMap<>(2);
            String key;
            Iterator<String> it = this.props.keySet().iterator();
            // Deep Copy of field by field
            while (it.hasNext()) {
                key = it.next();
                hm.put(key, this.props.get(key));
            }
            copyUser.setProps(hm);
        }
        return copyUser;
    }
    
    /**
     * 方法二：使用Object的clone方法实现
     * 优势：
     * 1.较方式1实现更简单，不须要关注copy细节；
     * 2.不须要依赖第三方包；
     * 3.不修改引用类型成员变量不须要修改代码
     * 缺点：
     * 1.须要实现Cloneable，重写父类clone方法，不知足里式替换；
     * 2.且引用类型成员变量发生变更须要修改方法，不知足开闭原则；
     * 3.不具备可复用性；
     */
    public User clone() throws CloneNotSupportedException {
        User cloneUser = (User) this.clone();
        if (this.getProps() != null) {
            Map<String, Object> hm = new HashMap<>(2);
            String key;
            Iterator<String> it = this.props.keySet().iterator();
            // Deep Copy of field by field
            while (it.hasNext()) {
                key = it.next();
                hm.put(key, this.props.get(key));
            }
            cloneUser.setProps(hm);
        }
        return cloneUser;
    }

    /**
     * 方法三：使用Java自带的流方式实现
     * 优势：
     * 1.不破坏类的封装，无需了解被copy对象的内部
     * 2.不须要依赖第三方包
     * 3.代码可复用
     * 缺点：
     * 1.须要实现Serializable接口，会有额外的开销
     */
    public User clone() throws IOException, ClassNotFoundException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        ObjectOutputStream oos = new ObjectOutputStream(bos);
        oos.writeObject(this);
        ByteArrayInputStream bis = new ByteArrayInputStream(bos.toByteArray());
        ObjectInputStream ois = new ObjectInputStream(bis);
        return (User)ois.readObject();
    }

    /**
     * 方法四：使用第三方包Jackson实现
     * 优势：
     * 1.不破坏类的封装，无需了解被copy对象的内部
     * 2.不须要实现接口
     * 3.代码可复用
     * 缺点：
     * 1.须要依赖第三方包
     * 2.内部实现复杂
     */
    public User clone() throws JsonProcessingException {
        ObjectMapper objectMapper = new ObjectMapper();
        return objectMapper.readValue(objectMapper.writeValueAsString(this), User.class);
    }
}
```

### 深拷贝测试

```java
package com.nicholas.example.test;

import java.util.HashMap;
import java.util.Map;

public class CloningTest {

    public static void main(String[] args) throws CloneNotSupportedException {
        User origin = new User();
        origin.setId(1);
        origin.setName("Nicholas");
        Map<String, Object> props = new HashMap<>(2);
        props.put("salary",10000);
        props.put("city","NanJing");
        origin.setProps(props);

        User cloneUser = (User) origin.clone();

        // 检查user和cloneUser的属性是否一致
        System.out.println("user: " + origin);
        System.out.println("cloneUser: " + cloneUser);
        System.out.println("user and cloneUser === test: " + (origin == cloneUser));

        // 检查user和cloneUser的props是否一致
        System.out.println("user props: " + origin.getProps());
        System.out.println("cloneUser props: " + cloneUser.getProps());
        System.out.println("user and cloneUser props === test: " + (origin.getProps() == cloneUser.getProps()));

        // 让我们看看对默认克隆的影响
        // 修改user对象的props
        origin.getProps().put("title","CTO");
        origin.getProps().put("city","ChangZhou");
        System.out.println("cloneUser props:" + cloneUser.getProps());

        // 修改user的name
        origin.setName("SunChunYang");
        System.out.println("cloneUser name:" + cloneUser.getName());
    }
}
```

### 结果输出

```shell
D:\Develop\env\java\jdk-11.0.2\bin\java.exe ...
user: User(id=1, name=Nicholas, props={salary=10000, city=NanJing})
cloneUser: User(id=1, name=Nicholas, props={city=NanJing, salary=10000})
user and cloneUser === test: false
user props: {salary=10000, city=NanJing}
cloneUser props: {city=NanJing, salary=10000}
user and cloneUser props === test: false
cloneUser props:{city=NanJing, salary=10000}
cloneUser name:Nicholas

Process finished with exit code 0
```


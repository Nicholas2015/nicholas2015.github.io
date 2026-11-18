---
title: "MySQL免安装版部署"
date: 2021-06-22T22:45:16+08:00
category: "运维"
tags: ["database"]
---

## 下载地址

[MySQL下载地址](https://downloads.mysql.com/archives/community/)

## 安装步骤

* 解压压缩包，并新建my.ini文件以代替my-default.ini文件
* my.ini文件内容如下：
```ini
[mysql]
#设置mysql客户端默认字符集
default-character-set=utf8
[mysqld]
#设置3306端口
port = 3306 
#设置mysql的安装目录
basedir=D:\\Program Files\\Mysql
#设置mysql数据库的数据的存放目录
datadir=D:\\Program Files\\Mysql\\data
#允许最大连接数
max_connections=200
#服务端使用的字符集默认为8比特编码的latin1字符集
character-set-server=utf8
#创建新表时将使用的默认存储引擎
default-storage-engine=INNODB
```

* 以管理员身份打开cmd命令窗口，进入到mysql安装目录中，执行如下命令：

``` bash
# 初始化,此时mysql安装目录下已经自动创建了data文件夹。
mysqld --initialize-insecure --user=mysql
# 安装mysql服务，此处注意：是mysqld不是mysql
mysqld install
# 启动mysql服务
net start mysql
# 登录连接mysql客户端
mysql -u root -p
# 进入mysql控制台,修改root用户密码
alter user 'root'@'localhost' identified by '新密码'
# -------其它命令，此处不执行---------
# 停止mysql服务
net stop mysql
# 删除已安装的mysql服务
mysqld remove
```

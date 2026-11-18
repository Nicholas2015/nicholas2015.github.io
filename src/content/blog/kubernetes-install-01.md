---
title: "kubernetes环境搭建"
date: 2021-06-26T09:13:00+08:00
category: "运维"
tags: ["kubernetes"]
---

## 1. 环境搭建前期准备



### 组件版本

- Kubernetes 1.11.2
- Docker 18.06.0-ce
- Etcd v3.3.9
- Flanneld v0.10.0
- TLS 认证通信（所有组件，如etcd、kubernetes master 和node）
- RBAC 授权
- kubelet TLS Bootstrapping
- kubedns v1.14.10、dashboard v1.10.0、heapster v1.5.4等插件

### etcd 集群 && k8s master 机器 && k8s node 机器

- master01：ip1
- node01: ip2
- node02: ip3
- node03: ip4

### 集群环境变量

后续部署将会使用到的全局变量，定义如下（根据自己的机器、网络修改）：

```shell
# TLS Bootstrapping 使用的Token，可以使用命令 head -c 16 /dev/urandom | od -An -t x | tr -d ' ' 生成
$ export BOOTSTRAP_TOKEN="8981b594122ebed7596f1d3b69c78223"

# 建议使用未用的网段来定义服务网段和Pod 网段
# 服务网段(Service CIDR)，部署前路由不可达，部署后集群内部使用IP:Port可达
$ export SERVICE_CIDR="10.254.0.0/16"
# Pod 网段(Cluster CIDR)，部署前路由不可达，部署后路由可达(flanneld 保证)
$ export CLUSTER_CIDR="172.30.0.0/16"

# 服务端口范围(NodePort Range)
$ export NODE_PORT_RANGE="30000-32766"

# etcd集群服务地址列表
$ export ETCD_ENDPOINTS="https://ip1:2379,https://ip2:2379,https://ip3:2379"

# flanneld 网络配置前缀
$ export FLANNEL_ETCD_PREFIX="/kubernetes/network"

# kubernetes 服务IP(预先分配，一般为SERVICE_CIDR中的第一个IP)
$ export CLUSTER_KUBERNETES_SVC_IP="10.254.0.1"

# 集群 DNS 服务IP(从SERVICE_CIDR 中预先分配)
$ export CLUSTER_DNS_SVC_IP="10.254.0.2"

# 集群 DNS 域名
$ export CLUSTER_DNS_DOMAIN="cluster.local."

# MASTER API Server 地址
$ export MASTER_URL="k8s-api.virtual.local"
```



## 2. 创建CA 证书和密钥

`kubernetes` 系统各个组件需要使用`TLS`证书对通信进行加密，这里我们使用`CloudFlare`的PKI 工具集[cfssl](https://pkg.cfssl.org/) 来生成Certificate Authority(CA) 证书和密钥文件， CA 是自签名的证书，用来签名后续创建的其他TLS 证书。

### 安装 CFSSL

```shell
$ wget https://pkg.cfssl.org/R1.2/cfssl_linux-amd64
$ chmod +x cfssl_linux-amd64
$ sudo mv cfssl_linux-amd64 /usr/k8s/bin/cfssl

$ wget https://pkg.cfssl.org/R1.2/cfssljson_linux-amd64
$ chmod +x cfssljson_linux-amd64
$ sudo mv cfssljson_linux-amd64 /usr/k8s/bin/cfssljson

$ wget https://pkg.cfssl.org/R1.2/cfssl-certinfo_linux-amd64
$ chmod +x cfssl-certinfo_linux-amd64
$ sudo mv cfssl-certinfo_linux-amd64 /usr/k8s/bin/cfssl-certinfo

$ export PATH=/usr/k8s/bin:$PATH
$ mkdir ssl && cd ssl
$ cfssl print-defaults config > config.json
$ cfssl print-defaults csr > csr.json
```













借鉴于https://blog.qikqiak.com/post/manual-install-high-available-kubernetes-cluster
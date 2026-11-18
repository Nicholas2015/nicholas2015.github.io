---
title: "Ollama：零代码部署大模型，轻松玩转AI"
date: 2025-02-22T17:30:00+08:00
category: "AI"
tags: ["AI"]
---

## 一、Ollama下载和安装

### 1. ollama官网地址[Ollama](https://ollama.com/)

![image-20250222143712704](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222143712754.png)

### 2.ollama下载

![image-20250222143740877](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222143740926.png)

根据自己需要部署的操作系统选择

![image-20250222143818974](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222143819026.png)

### 3.Linux操作系统安装（此处以Rocky Linux v9.5为例）

* 下载ollama

  ![image-20250222144026375](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222144026426.png)

  

* 执行复制命令，等待下载和安装结束

  ```shell
  curl -fsSL https://ollama.com/install.sh | sh
  ```

  ![image-20250222144100032](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222144100052.png)

  > 安装结束后会出现如下内容，说明已经安装完成
  >
  > ⚠️⚠️⚠️由于本猿使用的linux服务器没有安装显卡（GPU），所以会出现如下的警告

  ![image-20250222160650087](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222160650109.png)

* 校验是否安装成功

  ```shell
  # 打开cmd命令行界面，快捷键 Win+R
  ollama -v
  ```

  > 执行后会看到如下的结果

  ![image-20250222160905771](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222160905789.png)

  ```shell
  # 输入如下命令查看是否正常运行
  sudo systemctl status ollama
  ```

  > 出现如下结果则说明正常运行

  ![image-20250222161017832](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222161017860.png)

* 修改模型保存路径（根据自己的目录空间大小决定，如果空间足够充足可以不进行调整）

  * 编辑ollama.service文件
  
    ```shell
    # 编辑/etc/systemd/system/ollama.service文件
    sudo vim /etc/systemd/system/ollama.service
    ```
  
  * 在[Service]标记下，添加如下内容，如下图所示（如果实在不理解什么涵义，直接添加下面内容就可以）
  
    > 模型变更文件夹创建
  
    ```shell
    # 执行命令创建自定义模型保存目录
    sudo mkdir -p /opt/ollama/models
    ```
  
    > 根据需求添加模型文件保存路径配置
  
    ```shell
    # 修改Ollama的host地址，默认是127.0.0.1，只能本地访问，无法在其他同网络电脑上访问
    Environment="OLLAMA_HOST=0.0.0.0"
    # 跨域处理
    Environment="OLLAMA_ORIGINS=*"
    # 模型保存目录更换,此处/opt/ollama/models文件夹根据自己需求变化创建，如果不需要变更模型保存文件夹，则不需要配置
    Environment="OLLAMA_MODELS=/opt/ollama/models"
    ```
  
    ![image-20250222162331030](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222162331061.png)
  
  * 保存该文件内容
  
    ```shell
    # 按下Esc键
    # 同时按下`Shift`和`:`
    # 输入wq回车
    wq
    ```
  
    ![image-20250222162624206](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222162624227.png)
  
  * 重新加载刷新配置
  
    ```shell
    # 刷新配置
    sudo systemctl daemon-reload
    ```
  
  * 重启ollama
  
    ```shell
    # 重启ollama
    sudo systemctl restart ollama
    ```
  
  * 如果需要每次系统重启，ollama随机启动运行，在执行如下命令
  
    ```shell
    # 配置Ollama服务随机启动
    sudo systemctl enable ollama
    ```
  
  * 校验是否重启成功
  
    ```shell
    sudo systemctl status ollama
    ```
  
    > 如果出现如下情况，则说明失败
  
    ![image-20250222163625890](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222163625913.png)
  
    ```shell
    # 执行如下命令，检查服务启动失败原因
    sudo journalctl -u ollama
    ```
  
    > 我们会发现此处提示报错原因是没有权限在之前创建的模型的目录下创建文件夹
  
    ![image-20250222163611783](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222163611834.png)
  
    > 给创建的模型文件夹授权
  
    ```shell
    # 将目标路径的所属用户和组改为root用户
    sudo chown -R root:root /opt/ollama/models
    # 将文件夹权限更换为777
    sudo chmod -R 777 /opt/ollama/models
    # 再次执行如下重启命令
    sudo systemctl restart ollama
    # 查看启动状态
    sudo systemctl status ollama
    ```
  
    > 如果出现如下情况，则说明启动成功
  
    ![image-20250222164259004](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222164259042.png)

* 检验模型目录是否切换成功

  ```shell
  # 执行如下命令查看是否生成blobs文件夹
  sudo ll /opt/ollama/models
  ```

  ![image-20250222165254372](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222165254397.png)

* 同局域网访问，检验是否可以，在另一台电脑浏览器中访问http://192.168.1.72:11434/，地址根据自己服务器地址更换

  > 如果出现如下界面，则说明可以访问成功

  ![image-20250222165752890](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222165752926.png)

  > 如果还是不可以，请检查是否服务器防火墙没有开放该端口
  >
  > 本猿使用的服务器操作系统(Rocky Linux v9.5)端口开放方法如下：

  ```shell
  # 开放端口
  sudo firewall-cmd --zone=public --permanent --add-port=11434/tcp
  # 刷新系统配置，使其生效
  sudo firewall-cmd --reload
  ```

  

* 



### 4.Windows操作系统安装

* 下载ollama

  ![image-20250222152149571](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222152149631.png)

* 双击OllamaSetup.exe文件安装，会出现如下界面

  ![image-20250222152252194](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222152252222.png)

* 点击Install进行安装

  > 🎗️🎗️🎗️说明:
  >
  > 此处无法选择安装目录，默认安装路径为 C:\Users\\`用户名`\AppData\Local\Programs
  >
  > 此处`用户名`根据用户具体的计算机名称调整

* 校验是否安装成功

  ```bash
  # 打开cmd命令行界面，快捷键 Win+R
  ollama -v
  ```

  > 看到如下结果说明ollama已经安装成功

  ![image-20250222153122003](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222153122026.png)

  > 或者查看任务栏中是否存在如下图标，如果存在说明安装成功

  ![image-20250222153315526](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222153315547.png)

  > 也可以在浏览器中输入如下地址http://127.0.0.1:11434/访问，出现如下内容说明安装成功

  ![image-20250222153736110](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222153736131.png)

* 修改模型保存路径（根据自己的目录空间大小决定，如果空间足够充足可以不进行调整）

  * 进入系统设置界面，滚动页面翻到最下方，选择系统信息

  ![image-20250222153931597](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222153931637.png)

  * 选择高级系统设置

    ![image-20250222154116797](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222154116824.png)

  * 点击环境变量

    ![image-20250222154140618](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222154140643.png)

  * 新建用户环境变量

    ![image-20250222155324451](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222155324484.png)

  * 添加环境变量信息，然后一路确定下去就可以了

    ![image-20250222155446065](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222155446088.png)

    > 🎗️🎗️🎗️说明：
    >
    > * 模型路径修改，配置内容如下：
    >   * 变量名：OLLAMA_MODELS
    >   * 变量值：H:\ollama\models（根据自己的目录更换，此处是本猿使用的路径）
    > * 如果还需要给局域网其他电脑使用，需要添加如下两个配置
    >   * 添加OLLAMA_HOST
    >     * 变量名：OLLAMA_HOST
    >     * 变量值：0.0.0.0
    >   * 添加OLLAMA_ORIGINS
    >     * 变量名：OLLAMA_ORIGINS
    >     * 变量值：*

  * 重启ollama工具，在任务中找到ollama图标，然后右击鼠标右键，点击Quit Ollama

    ![image-20250222155936754](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222155936776.png)

  * 检查模型保存文件目录是否变更

    > ollama原默认模型保存路径C:\Users\用户名\\.ollama\models

    ![image-20250222160505367](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222160505397.png)

    > 修改后会发现，在更换的目录下多了一个blobs文件夹，说明已经更换成功

    ![image-20250222160253785](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222160253810.png)

* 5.模型下载

  > 下载模型，此处以deepseek r1 7B为例

  * 首先到ollama官方查找模型

    ![image-20250222170301802](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222170301868.png)

    

  * 此处我们选择deepseek-r1

    ![image-20250222170822986](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222170823047.png)

  * 官方提供的命令是直接下载并运行模型

    ```shell
    ollama run deepseek-r1:7b
    ```

    > 下载模型状态如下

    ![image-20250222171012512](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222171012539.png)

    > 下载完成自动运行模型

    ![image-20250222171800521](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222171800550.png)

    > 进行提问

    ![image-20250222171913484](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222171913518.png)

  * 如果想不直接运行仅拉取下载模型，执行如下命令

    ```shell
    ollama pull deepseek-r1:7b
    ```

  

### 5.使用图形化界面访问部署好的模型，此处使用AnythingLLM

  * 下载AnythingLLM，https://anythingllm.com/

  ![image-20250222172320903](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222172320975.png)

  > 根据自己的电脑系统选择适合的安装包

  ![image-20250222173033987](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173034058.png)

  * 双击AnythingLLMDesktop.exe进行安装，根据自己喜好选择安装目录

    ![image-20250222172530489](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222172530521.png)

  * 配置AnyThingLLM

    ![image-20250222173219237](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173219282.png)

  * 创建工作区

    ![image-20250222173313191](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173313237.png)

  * 配置模型连接方式以及默认使用什么模型

    > 选择聊天设置

    ![image-20250222173519198](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173519243.png)

    > 选择工作区LLM提供者

    ![image-20250222173554301](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173554357.png)

    > 选择提供商

    ![image-20250222173622400](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173622452.png)

    > 在列表中选择Ollama

    ![image-20250222173700443](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173700498.png)

    > 配置Ollama服务连接地址

    ![image-20250222173756261](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222173756310.png)

    > 此处地址根据实际情况选择
    >
    > * 如果是本地服务（AnythingLLM工具和Ollama在同一台电脑上），填入http://127.0.0.1:11434
    > * 如果是非本地服务（AnythingLLM工具和Ollama不在同一台电脑上），填入http://服务器IP:11434
    >
    > 此处本猿以服务器部署的地址来配置

    ![image-20250222174143936](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222174143980.png)

    > 配置页翻到最下方，更新工作区配置

    ![image-20250222174253002](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222174253049.png)

  * 回到工作区界面

    ![image-20250222174408999](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222174409046.png)

  * 输入聊天内容进行聊天

    ![image-20250222174503598](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222174503643.png)

  * 结果反馈

    ![image-20250222174601334](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222174601409.png)


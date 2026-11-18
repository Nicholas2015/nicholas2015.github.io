---
title: "LM Studio模型本地化部署：快速入门指南！"
date: 2025-02-16T20:30:00+08:00
category: "AI"
tags: ["AI"]
---

> 特殊说明：
>
> huggingface.co网站需要科学上网才可访问

* 下载LM Studio，地址：[LM Studio - Discover, download, and run local LLMs](https://lmstudio.ai/)

  ![image-20250222212131369](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212131407.png)

* 根据自己自己操作系统下载对应的版本，此处以windows环境为例，下载如下版本：

  ![image-20250222212201573](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212201595.png)

* 安装LM Studio

  * 双击LM-Studio-0.3.9-6-x64.exe

    ![image-20250222212236070](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212236095.png)

  * 根据自己的喜好，选择安装目录

    ![image-20250222212302786](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212302810.png)

  * 点击安装，等待安装完成

  * 安装完成后，点击完成，如果想立即使用，则不要去掉勾选项（运行LM Studio）

    ![image-20250222212325304](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212325327.png)

* LM Studio 使用

  * 打开LM Studio ,默认情况是没有加载任何模型，需要下载模型

    ![image-20250222212432670](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212432716.png)

  * 首先根据自己的喜好调整模型保存路径

    ![image-20250222212447092](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212447137.png)

  * 下载模型

    * 方式一：到[Hugging Face – The AI community building the future.](https://huggingface.co/)下载开源模型

      * 进入Hugging Face网站

        ![image-20250222212506288](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212506350.png)

      * 搜索模型(deepseek r1)，选择See all results for "deepseek r1 7b gguf"

        > 说明：LM Studio 需要加载的模型文件要为gguf结尾的文件
        >
        > 我们还会看到一些safetensors结尾的文件，这种格式的文件，需要转换成gguf格式的文件才可以在LM Studio中使用

        ![image-20250222212603191](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212603226.png)

      * 搜索结果如下，筛选出最后欢迎或者下载量最大的即可

        ![image-20250222212621422](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212621528.png)

      * 从上面的结果选择其中一个，此处我选择lmstudio-community下面的模型，选择后我们会看到如下结果

        ![image-20250222212637138](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212637184.png)

      * 选择Files and versions，下载对应的模型文件即可

        ![image-20250222212653376](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212653419.png)

      * 在前面配置好的模型保存路径文件夹下创建模型保存的目录，如下所示：

        ![image-20250222212709422](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212709441.png)

        > 说明：此处作者使用的是在H:\models这个路径
        >
        > 我们需要根据下载的模型创建如下的目录
        >
        > 首先我们需要在H:\models目录下创建lmstudio-community文件夹
        >
        > 然后再在H:\models\lmstudio-community目录下创建DeepSeek-R1-Distill-Qwen-7B-GGUF文件夹
        >
        > 最后将下载好的模型放在H:\models\lmstudio-community\DeepSeek-R1-Distill-Qwen-7B-GGUF
        >
        > lmstudio-community是指发布者
        >
        > DeepSeek-R1-Distill-Qwen-7B-GGUF是指模型名称

        ![image-20250222212725180](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212725201.png)

    * 方式二：在LM Studio工具中下载开源模型

      * 选择发现标签（放大镜图标），会弹出如下选择框

        ![image-20250216193944111](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212738345.png)

      * 根据上面的操作结果，我们会发现，选择了模型但是右侧提示No result found！！！

        > 此处是因为下载源在国内无法正常使用

      * 修改模型下载源

        > 说明：此处我们需要修改两个文件，首先进入LM Studio的安装目录，此处以作者的为例，我的安装目录在D:\Develop\tools\LM Studio
        >
        > 1.第一个文件，D:\Develop\tools\LM Studio\resources\app\.webpack\main\index.js
        >
        > 2.第二个文件，D:\Develop\tools\LM Studio\resources\app\.webpack\renderer\main_window.js
        >
        > 将这两个文件中所有的`huggingface.co`替换为`hf-mirror.com`

      * 关闭LM Studio，重新打开，我们会发现，刚刚无法下载的模型，均可以下载

        ![image-20250216194907340](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212747630.png)
    
    * 加载模型，调用模型进行使用
    
      * 回到聊天界面，选择模型加载
    
        ![image-20250216195034768](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212755026.png)
    
      * 选择加在模型，会列出所有本地下载好的模型，此处我们使用示例中的模型
    
        ![image-20250216195156978](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212802893.png)
    
      * 加载模型
    
        ![image-20250216195217313](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212810356.png)
    
      * 创建聊天
    
        ![image-20250216195238424](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212815920.png)
    
      * 在此处输入需要对话的内容 

        ![image-20250216195412268](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212833899.png)
      
      * 反馈结果
      
        ![image-20250216195541431](https://raw.githubusercontent.com/Nicholas2015/Pictures/ollama/20250222212842068.png)

# 万能翻唱 · WanNengFanChang

> 给一首歌 → 复制某个音色 → 用它唱任意别的歌。

一个跑在本机的通用 AI 翻唱工具（SVC，歌声转换）。参照 `dsh-cover` 插件的流水线实现，但**脱离 DSH、零 npm 依赖**：后端只用 Node.js 内置模块，前端是单文件原生 HTML，重活交给本机已有的 Python + GPU 大模型。自带 **Web 界面、环境检测、一键下载模型**。

![流水线](https://img.shields.io/badge/pipeline-download%20%E2%86%92%20separate%20%E2%86%92%20convert%20%E2%86%92%20mix%20%E2%86%92%20export-blue)
![runtime](https://img.shields.io/badge/node-%3E%3D24-green)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 功能

- **三种取源**：B 站搜索 / 本地文件 / BV 号。
- **音色库**：预设音色 + 上传自己的参考人声（一段干净 wav/mp3 即可）。
- **可调参数**：扩散步数、CFG、人声增益、**降调 / 自动音域适配**（专治高音破音）、预览模式。
- **环境检测面板**：打开页面自动扫描 12 项依赖，缺失的模型**点击即下载**（国内镜像 + 断点续传），还能导出一键安装 PowerShell 脚本。
- **桌面版体验**：`点这个启动.vbs`（或 `万能翻唱.exe`）双击即拉起后端并打开**无地址栏独立窗口**，像原生软件。

## 五阶段流水线

| 阶段 | 干什么 | 依赖 |
|---|---|---|
| download | 取音频源（B 站/本地），预览模式先切片 | ffmpeg |
| separate | UVR5 人声分离，去掉伴奏 | `bs_roformer` 模型（约 305MB） |
| convert | Seed-VC 把人声换成目标音色 | DiT / bigvgan / whisper 等权重（约 2.4GB） |
| mix | 翻唱人声混回伴奏（逐声道相加 + loudnorm），降调时伴奏同步移调 | ffmpeg |
| export | 导出 mp3 / wav / 纯人声 | ffmpeg |

需要 **NVIDIA GPU**（已在 RTX 5060 Laptop 8GB 上验证）。整首歌通常 3～8 分钟，取决于长度与显卡。

---

## 快速开始

### 第 1 步：准备依赖（只需一次）

本项目复用三个外部重资产，请自行安装（各有许可证，见文末）：

1. **Node.js ≥ 24**（加入 PATH）。
2. **GPT-SoVITS 整合包**（提供 `runtime/python.exe`、`ffmpeg.exe`、`ffprobe.exe`、`tools/uvr5`）——[RVC-Project/GPT-SoVITS releases](https://github.com/RVC-Project/GPT-SoVITS/releases)。
3. **Seed-VC** 源码 + Python 依赖 + 模型权重——[Plachtaa/seed-vc](https://github.com/Plachtaa/seed-vc)（仓库已归档只读，仍可 clone）。

不想手动装模型？**先启动应用**，页面顶部的「⚙ 环境检测与依赖安装」面板会列出缺什么、给出下载按钮和一键安装脚本。

### 第 2 步：配置路径

复制示例配置，改成你自己机器上的实际位置：

```bash
copy config.example.json config.local.json
```

编辑 `config.local.json`（**此文件已 gitignore，不会提交**）：

```json
{
  "port": 18321,
  "node": "",
  "gst": "D:/你的/GPT-SoVITS目录",
  "songs": "D:/你的/AI-Song目录",
  "models": "D:/你的/AI-Song/models"
}
```

| 键 | 含义 |
|---|---|
| `port` | 后端端口（默认 18321，避开 Clash 等代理默认的 7890） |
| `node` | node.exe 路径；**留空则从 PATH 查找** |
| `gst` | GPT-SoVITS 整合包根目录（python/ffmpeg/uvr5 都在其下） |
| `songs` | Seed-VC 源码与 Python 依赖的根目录（`src/seed-vc-hf`、`env/pylibs`、`voices` 都在其下） |
| `models` | 模型权重根目录 |

也可用环境变量覆盖：`PORT` / `WFC_GST` / `WFC_SONGS` / `WFC_MODELS` / `WFC_NODE`（优先级最高）。配置加载逻辑见 `config.mjs`：内置默认 < `config.example.json` < `config.local.json` < 环境变量。

### 第 3 步：启动

任选其一：

- **（推荐）双击 `点这个启动.vbs`** —— 拉起后端 + 打开无地址栏独立窗口，不触发 SmartScreen。
- 双击 `万能翻唱.exe` —— 同上，但个人编译无签名，首次可能被 Windows SmartScreen 拦（点「更多信息 → 仍要运行」）。
- 双击 `启动万能翻唱.bat` —— 拉起后端 + 默认浏览器（有地址栏）。
- 命令行：`node server.mjs`，然后浏览器打开 `http://127.0.0.1:18321`。

首次打开若显示"连接失败"，刷新一下即可（后端启动有 1～2 秒延迟）。关掉独立窗口 / 黑窗口 = 停止服务。服务**只监听 127.0.0.1**，不对外网开放。

## 用法

1. **选音色**：下拉框选预设音色，或上传一段干净参考人声。
2. **选歌**：B 站搜索 / 本地文件 / BV 号，三选一。
3. **开始**：先勾「预览模式」（默认 60s 起截 10s）几十秒确认方向，满意了再关掉跑整首。跑完在页面试听 / 下载。

### 参数

- **扩散步数**（默认 30）：越低越快、音质略降；预览可用 20。
- **CFG 强度**（默认 0.7）：越低越贴参考音色。
- **人声增益**（默认 0 dB）。
- **降调（半音）**（默认 0，范围 -12~12）：**高音破音就填负数**（如 -2~-5）。换声默认保留原曲音高，超出目标音色舒适音域就会硬拉失真；降调把整首移到音色舒服的区间。人声与伴奏**同步移调**，不走调。
- **自动音域适配**（默认关）：让目标音色音高中位数贴合原曲，另一种缓解破音思路，可与降调分别试。
- **预览起点 / 片段长**（默认 60s / 10s）：起点超出音频长度会自动从 0 秒重截。

---

## 项目结构

```
万能翻唱/
  config.mjs              配置加载器（单一配置源，三层回退）
  config.example.json     示例配置（提交）
  config.local.json       本机私有配置（gitignore）
  server.mjs              零依赖后端（HTTP API + 任务队列 + 五阶段流水线）
  env-manager.mjs         环境检测 / 一键下载 / 安装脚本生成
  bili.mjs                B 站取源（搜索 / 选优 / 取音频流）
  这个也行.html           前端单文件（CSS/JS 内联）
  scripts/                三个 Python 脚本（分离 / 换声 / 混音，自包含副本）
  点这个启动.vbs          推荐启动器（无 SmartScreen 提示）
  万能翻唱.exe            桌面启动器（C# 编译，可选）
  启动万能翻唱.bat        备用启动器（默认浏览器）
  Launcher.cs             桌面启动器源码（改后可用下方命令重编译）
  试听样例_*.mp3          端到端测试成品
  data/                   运行时任务产物（gitignore）
```

重编译桌面启动器（改了 `Launcher.cs` 后，Windows）：

```bat
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:WFC.exe /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll Launcher.cs
ren WFC.exe 万能翻唱.exe
```

---

## 来源与致谢

- `scripts/` 下的三个 Python 脚本与 `bili.mjs` 是自包含副本，改写自 **dsh-cover** 插件的实现；此做法是为了绕开该插件 `pnpm file:` 软链导致的脚本路径问题。
- 核心能力来自开源社区：[GPT-SoVITS](https://github.com/RVC-Project/GPT-SoVITS)、[Seed-VC](https://github.com/Plachtaa/seed-vc)、[UVR5 / bs_roformer](https://github.com/Anjok07/ultimatevocalremovergui)。

## 许可证与免责

本项目代码以 [MIT](LICENSE) 授权。**本项目不包含任何第三方模型权重或预训练文件**；GPT-SoVITS、Seed-VC、UVR5 及各模型权重各有自己的许可证与使用条款，版权归各自作者所有，请自行遵守。

本项目仅供个人学习与研究使用。请使用你有权使用的音色与音频素材；由此产生的任何侵权或法律责任由使用者自行承担。

## 已知边界

- B 站取源依赖第三方接口，偶尔因 cookie / 限流失败；失败请改用本地文件或 BV 号。
- 服务是**单并发队列**（一次只跑一个任务），提交多个会排队。
- 中文路径在某些终端日志里显示乱码（GBK 显示问题），不影响实际文件与运行。
- 环境检测自动下载走 `hf-mirror.com` 国内镜像；有代理想用官方源，改 `env-manager.mjs` 顶部的 `HF` 常量。首次下载约 2.5GB，耗时较久属正常。

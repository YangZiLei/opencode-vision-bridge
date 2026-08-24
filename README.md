# opencode-vision-bridge

> 让纯文本主模型也能"看图"——把图片桥接给 MiMo V2.5 免费多模态子代理
> Give text-only main models vision — bridge images to a free MiMo V2.5 multimodal subagent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 缘由 / Why

许多 opencode 用户的主模型是**纯文本模型**（DeepSeek V4、GLM-5.x 等）。当你在对话中粘贴或拖入一张图片时，opencode 会在**发送请求前**就拒绝图片附件：

```
ERROR: Cannot read "image.png" (this model does not support image input).
```

这不是配置问题，而是模型的**架构限制**——纯文本模型没有视觉神经元。市面上已有的方案（MCP 视觉服务器、OCR 工具）大多要求额外的 API Key、本地服务或部署步骤，且无法解决"图片在消息装配阶段就被 opencode 拦截"这一核心卡点。

**本项目用最轻量的方式解决：一个插件 + 一个子代理，按模型运行时能力自动判定。**

## 安装 / Installation

> 一条命令完成安装与注册，无需手动复制文件、无需手动改配置。
> One command installs and registers everything — no manual file copying or config editing.

### 一键安装（npx）/ One-command install (npx)

本地已 clone 本仓库（或持有本地路径）时，用 `npx` 直接执行安装器：

```bash
# 全局安装（默认）：安装到 ~/.config/opencode/ 并写入全局 opencode 配置
npx /path/to/opencode-vision-bridge install --global

# 项目级安装：安装到当前项目 .opencode/ 并写入项目 opencode.json
npx /path/to/opencode-vision-bridge install --local

# 跳过所有交互确认（CI / 自动化场景）
npx /path/to/opencode-vision-bridge install --global --yes

# 卸载
npx /path/to/opencode-vision-bridge uninstall --global
```

安装器特性：

- **幂等**：重复执行 install 不会产生重复的插件条目或文件
- **安全卸载**：`uninstall` 只删除安装器自己放置的文件；你手动改过的 `text-models.json`（黑名单）或 `vision.md`（如更换过模型）会原样保留
- **无需手动注册**：插件路径自动写入 `opencode.json` / `opencode.jsonc` 的 `plugin` 数组
- 安装完成后会打印验证方法（如何确认插件已生效）

<details>
<summary>手动安装 / Manual install（不推荐，高级用户）</summary>

### 1. 复制文件

将 `plugins/` 和 `agent/` 两个目录下的文件复制到你的 opencode 配置目录：

- **Windows**: `C:\Users\<你的用户名>\.config\opencode\`
- **macOS / Linux**: `~/.config/opencode/`

（`plugins` 或 `agent` 文件夹不存在就手动新建）

### 2. 注册插件（必须）

推荐在 `opencode.json` 的 `plugin` 数组中**显式声明**插件路径（最稳妥，不依赖版本行为差异）：

```json
{
  "plugin": [
    "C:\\Users\\<你的用户名>\\.config\\opencode\\plugins\\vision-bridge.mjs"
  ]
}
```

> 如果 `plugin` 数组已有其他条目（如 `@cortexkit/opencode-magic-context@latest`），把新条目追加进去即可。

### 3. 重启 opencode

配置只在启动时加载。桌面版需要完全退出后重新打开，并新建一个会话；
仅关闭当前聊天窗口或最小化应用不会重新加载插件。

</details>

## 设计思路 / Design

```
┌──────────┐  粘贴/拖拽图片  ┌─────────────────────┐
│  用户     │ ─────────────▶ │  opencode 消息装配    │
└──────────┘                 └──────────┬──────────┘
                                        │
                        vision-bridge.mjs 插件
                        （system.transform 捕获模型能力
                         + messages.transform 桥接图片）
                                        │
              ┌─────────────────────────┴──────────────────────┐
              │ 运行时能力：capabilities.input.image            │
              │ false（纯文本）→ 图片转"路径"文本 part          │
              │ true（视觉）→ 原样放行直接看图                 │
              └─────────────────────────┬──────────────────────┘
                                        │
                 ┌──────────────────────┴──────────────┐
                 ▼                                     ▼
  主模型收到路径文本 + 系统强制委派规则          视觉模型收到图片
  → 调用 vision 子代理 (MiMo V2.5)               → 直接理解图片
  → 子代理 Read 图片 → 返回描述
```

### 三个组件 / Components

| 组件 | 作用 |
|---|---|
| `plugins/vision-bridge.mjs` | 插件。`experimental.chat.system.transform` 捕获当前模型的**运行时能力**（`capabilities.input.image`），`messages.transform` 据此判定：纯文本模型把图片 part 替换为带路径的文本 part，视觉模型原样放行 |
| `plugins/text-models.json` | `textModels` **兜底**黑名单 + `forceBridge` 强制桥接覆盖（均支持通配符）。黑名单仅在模态未知/缓存未命中时生效——正常情况零维护 |
| `agent/vision.md` | vision 子代理，挂载 `opencode/mimo-v2.5-free`（opencode 内置免费多模态模型，零注册零费用） |

### 关键设计决策 / Key decisions

1. **能力检测为主、黑名单兜底**：每次请求通过 `system.transform` 拿到当前模型的 `capabilities.input.image`，纯文本即桥接、视觉即放行——**无需手动维护名单**，模型目录怎么变都自动适配。仅当缓存未命中时回退到黑名单，保证弱模型环境下依旧可用。
2. **系统强制委派规则**：光把图片换成路径文本，部分模型（如 big-pickle）会无视内联指令、直接回复"我看不了图"。插件在 `system.transform` 里向纯文本模型的 system prompt 注入**强制规则**：遇到 `[Image attachment: ...]` 必须调用 vision 子代理，不许拒绝。
3. **覆盖粘贴场景**：TUI 里 Ctrl+V 粘贴的图片是 base64 data URI（无磁盘路径），插件会解码写入临时目录 `%TEMP%/opencode-vision/` 再引用路径。
4. **自动维护临时目录**：
   - 图片超过 24 小时后删除；清理任务最多每 3 天执行一次（`VISION_BRIDGE_MAX_AGE_HOURS` 可调）
   - SHA-256 内容哈希去重，同一张图重复粘贴只保留一份（含并发 transform 的索引回填）
5. **零依赖、零配置项之外**：纯 JS ESM 插件，无 npm 依赖；兜底黑名单路径可用 `VISION_BRIDGE_CONFIG` 环境变量覆盖。

## Requirements

- Tested with opencode **v1.18.x**. Older versions may not support the
  `experimental.chat.messages.transform` hook.
- No separate Node.js installation is required when the plugin is loaded by
  opencode; it uses standard ESM and Node-compatible built-ins.

## 使用 / Usage

直接**粘贴图片**（Ctrl+V）或**拖拽图片**，然后正常提问：

- 视觉模型（qwen3.x、MiMo、Claude、GPT、glm-5v-turbo 等）→ 直接看图
- 纯文本模型（DeepSeek、GLM-5.x、big-pickle 等）→ 自动判定并派给 vision 子代理识别

无需任何特殊指令，也**无需配置黑名单**（能力检测自动生效）。

## 配置 / Configuration

### 兜底黑名单 `textModels`（通常无需修改）

正常情况插件按模型**运行时能力**判定，不依赖名单。黑名单仅在**模态信息未知**（provider 元数据缺失 `input.image`/`attachment` 布尔值）或能力缓存未命中时兜底。在 `plugins/text-models.json` 的 `textModels` 数组追加：

```json
{
  "textModels": [
    "*/deepseek*",
    "*/hy3*",
    "your-provider/your-model"
  ]
}
```

- 支持通配符：`*/deepseek*` 匹配任意 provider 下的 deepseek 系列
- ⚠️ JSON 数组最后一项后面**不能有逗号**（否则解析失败、黑名单静默失效）
- 注意：`textModels` **不能**覆盖已上报视觉能力的模型——那类需求用下面的 `forceBridge`

### 强制桥接 `forceBridge`（例外覆盖）

个别模型的元数据**谎报**支持图像（`input.image: true`）但实际经常失败。把这类模型加入 `forceBridge` 数组，插件会无视能力元数据、一律桥接给 vision 子代理：

```json
{
  "forceBridge": [
    "your-provider/broken-vision-model"
  ]
}
```

- 同样支持通配符与精确 `provider/model` 写法；默认 `[]`（空，不覆盖任何模型）
- 命中 `forceBridge` 的模型同时会收到强制委派规则——两个钩子共用同一判定函数 `decideBridge`，规则注入与桥接行为永远一致

**判定优先级**：`forceBridge` > 运行时能力（模态已知时）> `textModels` 兜底（模态未知时）> 放行。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_BRIDGE_CONFIG` | `~/.config/opencode/plugins/text-models.json` | 判定配置文件路径（`textModels` 兜底黑名单 + `forceBridge` 强制桥接） |
| `VISION_BRIDGE_MAX_AGE_HOURS` | `24` | 临时图片保留时长（小时） |

### 更换视觉子代理模型

`agent/vision.md` 默认使用 `opencode/mimo-v2.5-free`（免费）。若免费档额度受限，可换成其他多模态模型，只需修改 `vision.md` 第一行的 `model:` 字段。

**Key 在哪里配置？** 取决于模型所属的 provider：

- **`opencode` provider（免费模型）**：无需配置 key，opencode 内置免费模型开箱即用（如 `opencode/mimo-v2.5-free`）。
- **`opencode-go` provider（付费套餐）**：需要先订阅 opencode Go 套餐。可通过下方链接订阅（含返利码，订阅后双方均可获 $5 使用额度）：
  ```
  https://opencode.ai/go?ref=D0HTW594YM
  ```
  订阅并登录后，`opencode-go` 下的模型（`opencode-go/mimo-v2.5`、`opencode-go/qwen3.7-plus` 等）即可在 `model:` 中使用，无需手动填 key。
- **第三方 provider（`anthropic`、`openrouter`、`google` 等）**：需要用 opencode 的认证命令添加 key：
  ```bash
  opencode auth login
  ```
  按提示选择 provider 并粘贴 API Key（也可用 `opencode auth` 子命令管理）。登录后该 provider 的所有模型即可在 `model:` 中使用，例如 `anthropic/claude-sonnet-4-6`。
- **环境变量方式**：部分 provider 支持直接通过环境变量注入 key（如 `ANTHROPIC_API_KEY=xxx`、`OPENROUTER_API_KEY=xxx`），设置后重启 opencode 即可。

> 判断一个 provider 是否可用：在 opencode 中运行 `opencode models`，能列出该 provider 的模型即代表 key 已配置成功。

## 如何判断模型是否支持图像？

以下只是常见示例，不是永久有效的模型能力清单。实际能力以 provider
当前返回的 `modalities` 为准；遇到不确定的模型请先实测。

常见示例：

| 纯文本（需桥接） | 视觉（直接看图） |
|---|---|
| `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4-flash-free` | `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.8-max` |
| `glm-5` / `glm-5.1` / `glm-5.2` | `glm-5v-turbo` / `glm-4.6v`（带 `v`） |
| `qwen3.7-max` / `qwen3.6`（非 plus） | `mimo-v2.5` / `mimo-v2.5-free` |
| `kimi-k2.7-code` | `kimi-k2.6` / `kimi-k3` |
| `hy3` / `minimax-m2.7` | `gpt-5.x` / `grok-4.x` / Claude 全系 / `minimax-m3` |

## 隐私说明 / Privacy

- 粘贴的图片会以临时文件形式写入系统临时目录（`%TEMP%/opencode-vision/`），供 vision 子代理读取。
- 图片二进制不会由本项目永久保存；桥接后的文件路径会作为文本进入模型上下文/聊天历史。
- 图片最终会发送给视觉模型 API（默认是 opencode 内置免费 MiMo 云服务），敏感截图请自行斟酌。

## 免责声明 / Disclaimer

**非官方项目 / Not an official project**

本项目是独立第三方项目，与 opencode（anomalyco）、DeepSeek、小米（MiMo）等组织及其产品**无任何隶属、背书或合作关系**；本项目作者不对其行为负责。

> This project is an independent third-party project with **no affiliation, endorsement, or partnership** with opencode (anomalyco), DeepSeek, Xiaomi (MiMo), or their products; the authors are not responsible for their conduct.

**商标 / Trademarks**

README 中出现的所有产品名称、商标与服务标记均为**各自所有者的财产**，此处仅用于描述兼容性与用途（nominative use），不构成任何授权、赞助或关联声明。

> All product names, trademarks, and service marks appearing in this README are the **property of their respective owners**, used solely to describe compatibility and intended use — no authorization, sponsorship, or association is implied.

**上游服务 / Upstream services**

本项目依赖 opencode 内置免费模型（如 `opencode/mimo-v2.5-free`）等上游服务。其可用性、额度与条款可能随时调整或终止；本项目不保证其持续可用，也不承担因上游变更导致的任何损失。

> This project relies on upstream services such as opencode's built-in free models (e.g. `opencode/mimo-v2.5-free`). Their availability, quotas, and terms may change or be discontinued at any time; this project does not guarantee continued availability and is not liable for any resulting loss.

**数据与合规 / Data & compliance**

经本插件桥接的图片会被发送至视觉模型 API（默认 opencode 免费 MiMo 云服务），**处理敏感内容前请自行评估合规风险**；本项目本身不收集任何用户数据，无遥测。

> Images bridged through this plugin are sent to the vision model API (by default opencode's free MiMo cloud service). **Assess compliance risks yourself before handling sensitive content**; this project collects no user data and has no telemetry.

**按现状提供 / AS-IS**

本软件按「现状」（AS-IS）提供，作者不对其适用性、可靠性或准确性作任何明示或默示担保，详见 [LICENSE](LICENSE)。

> The software is provided "AS IS" without warranty of any kind, express or implied, as detailed in [LICENSE](LICENSE).

## 调试 / Debugging

插件默认静默运行。遇到问题时，开启调试日志查看完整决策流程：

```bash
# Windows PowerShell
$env:VISION_BRIDGE_DEBUG="1"; opencode run -m <你的模型> -f <图片路径>

# macOS / Linux
VISION_BRIDGE_DEBUG=1 opencode run -m <your-model> -f <image-path>
```

桌面版需要从启动它的环境继承 `VISION_BRIDGE_DEBUG=1`，或使用同一配置启动 CLI 会话进行诊断。日志输出到 opencode 当前进程的控制台/日志；本插件不会额外创建 `plugin-loaded.log` 文件。

开启后控制台会输出：

```
[vision-bridge] plugin loaded
[vision-bridge] injected delegation rule for opencode/big-pickle
[vision-bridge] transform fired for opencode/big-pickle
[vision-bridge]   runtime caps: text-only, BRIDGING image
[vision-bridge]   deduped image -> /var/folders/.../opencode-vision/1785912345678-abc-image.png
```

关键日志含义：

| 日志 | 含义 |
|---|---|
| `plugin loaded` | 插件成功加载（若没出现=插件未注册/加载失败） |
| `injected delegation rule for provider/model` | 已向将被桥接的模型的 system prompt 注入强制委派规则（与桥接判定同源） |
| `transform fired for provider/model` | 钩子被触发，识别到目标模型 |
| `runtime caps: image input supported, PASS` | 运行时能力判定为视觉模型，放行 |
| `runtime caps: text-only, BRIDGING image` | 运行时能力判定为纯文本，开始转换 |
| `forceBridge match, BRIDGING image` | 命中 `forceBridge` 强制桥接名单（无视能力元数据） |
| `not in text blacklist (modality unknown or cache miss), PASS` | 模态未知（元数据缺失）或缓存未命中，且不在兜底黑名单，放行 |
| `in text blacklist, BRIDGING image` | 模态未知或缓存未命中，命中兜底黑名单，转换 |
| `deduped image` | 检测到重复图片，复用已有文件 |
| `wrote <path>` | 新图片已写入临时目录 |

## 常见问题 / FAQ

**Q: 模型列表里没有 `opencode/mimo-v2.5-free`？**
A: 免费模型是 opencode 内置的，一般都有。若没有，按上文"更换视觉子代理模型"处理。

**Q: 插件没生效？**
A: 检查：① `plugin` 数组是否显式注册（必须，不会自动发现）；② 是否重启了 opencode；③ `agent/vision.md` 是否就位；④ 若仍未委派，确认版本 ≥ v1.1.0（含 system 强制规则），旧版只能靠黑名单 + 模型自觉。

**Q: 主模型还是回复"我看不了图"、不调用子代理？**
A: 新版已注入强制委派规则，正常不会再出现。若仍有，请确认完全重启 opencode（桌面端需退出整个应用而非关窗口），并检查是否用了旧版插件文件。

**Q: 图片会被存到哪里？会不会越堆越多？**
A: 存在 `%TEMP%/opencode-vision/`。图片超过 24 小时后会删除，清理任务最多每 3 天执行一次；内容哈希去重会让同一张图只保留一份。

## Contributing

Issues and PRs are welcome. Before submitting:

1. For bugs: include your opencode version (`opencode --version`), the model you were using, and relevant `[vision-bridge]` log lines (run with `VISION_BRIDGE_DEBUG=1`)
2. For new features: open an issue first to discuss the approach
3. Run `node --check plugins/vision-bridge.mjs` to verify syntax before committing

You can also run the dependency-free smoke tests:

```bash
npm test
```

## License

[MIT](LICENSE)

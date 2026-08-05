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

**本项目用最轻量的方式解决：一个插件 + 一个子代理 + 一份黑名单。**

## 设计思路 / Design

```
┌──────────┐  粘贴/拖拽图片  ┌─────────────────────┐
│  用户     │ ─────────────▶ │  opencode 消息装配    │
└──────────┘                 └──────────┬──────────┘
                                        │
                        vision-bridge.mjs 插件（transform 钩子）
                                        │
              ┌─────────────────────────┴──────────────────────┐
              │ 模型在纯文本黑名单？                            │
              │ 是 → 图片 part 转成"图片路径"文本 part          │
              │ 否 → 原样放行（视觉模型直接看图）               │
              └─────────────────────────┬──────────────────────┘
                                        │
                 ┌──────────────────────┴──────────────┐
                 ▼                                     ▼
  主模型收到路径文本                           视觉模型收到图片
  → 调用 vision 子代理 (MiMo V2.5)              → 直接理解图片
  → 子代理 Read 图片 → 返回描述
```

### 三个组件 / Components

| 组件 | 作用 |
|---|---|
| `plugins/vision-bridge.mjs` | 插件。在 `experimental.chat.messages.transform` 钩子中，仅对**黑名单内的纯文本模型**把图片 part 替换为带路径的文本 part |
| `plugins/text-models.json` | 纯文本模型黑名单（支持通配符）。黑名单外的模型一律原样放行 |
| `agent/vision.md` | vision 子代理，挂载 `opencode/mimo-v2.5-free`（opencode 内置免费多模态模型，零注册零费用） |

### 关键设计决策 / Key decisions

1. **黑名单而非白名单**：默认只桥接已知纯文本模型（DeepSeek），其余模型全部放行。好处是视觉模型永远不会被误转；遇到新的纯文本模型只需在黑名单加一行。
2. **覆盖粘贴场景**：TUI 里 Ctrl+V 粘贴的图片是 base64 data URI（无磁盘路径），插件会解码写入临时目录 `%TEMP%/opencode-vision/` 再引用路径。
3. **自动维护临时目录**：
   - 图片超过 24 小时后删除；清理任务最多每 3 天执行一次（`VISION_BRIDGE_MAX_AGE_HOURS` 可调）
   - SHA-256 内容哈希去重，同一张图重复粘贴只保留一份
4. **零依赖、零配置项之外**：纯 JS ESM 插件，无 npm 依赖；黑名单路径可用 `VISION_BRIDGE_CONFIG` 环境变量覆盖。

## Requirements

- Tested with opencode **v1.18.x**. Older versions may not support the
  `experimental.chat.messages.transform` hook.
- No separate Node.js installation is required when the plugin is loaded by
  opencode; it uses standard ESM and Node-compatible built-ins.

## 安装 / Installation

### 1. 复制文件

将 `plugins/` 和 `agent/` 两个目录下的文件复制到你的 opencode 配置目录：

- **Windows**: `C:\Users\<你的用户名>\.config\opencode\`
- **macOS / Linux**: `~/.config/opencode/`

（`plugins` 或 `agent` 文件夹不存在就手动新建）

### 2. 注册插件（必须）

opencode 对全局 `plugins/` 目录下的文件**不会自动发现**，必须在 `opencode.json` 的 `plugin` 数组中显式声明：

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

## 使用 / Usage

直接**粘贴图片**（Ctrl+V）或**拖拽图片**，然后正常提问：

- 视觉模型（qwen3.x、MiMo、Claude、GPT、glm-5v-turbo 等）→ 直接看图
- 黑名单内的纯文本模型（DeepSeek、GLM-5.x）→ 自动派给 vision 子代理识别

无需任何特殊指令。

## 配置 / Configuration

### 扩展黑名单

遇到新的纯文本模型报 "does not support image input" 时，在 `plugins/text-models.json` 的 `textModels` 数组追加：

```json
{
  "textModels": [
    "*/deepseek*",
    "your-provider/your-model"
  ]
}
```

- 支持通配符：`*/deepseek*` 匹配任意 provider 下的 deepseek 系列
- ⚠️ JSON 数组最后一项后面**不能有逗号**（否则解析失败、黑名单静默失效）

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_BRIDGE_CONFIG` | `~/.config/opencode/plugins/text-models.json` | 黑名单文件路径 |
| `VISION_BRIDGE_MAX_AGE_HOURS` | `24` | 临时图片保留时长（小时） |

### 更换视觉子代理模型

`agent/vision.md` 默认使用 `opencode/mimo-v2.5-free`（免费）。若免费档额度受限，可换成其他多模态模型，只需修改 `vision.md` 第一行的 `model:` 字段。

**Key 在哪里配置？** 取决于模型所属的 provider：

- **`opencode` provider（免费模型）**：无需配置 key，opencode 内置免费模型开箱即用（如 `opencode/mimo-v2.5-free`）。
- **`opencode-go` provider（付费套餐）**：需要先订阅 opencode Go 套餐。推荐通过下方链接订阅（可获 $5 使用额度）：
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
[vision-bridge] loaded 1 blacklist patterns
[vision-bridge] transform fired for opencode/deepseek-v4-flash-free
[vision-bridge]   in blacklist, BRIDGING image
[vision-bridge]   wrote C:\Users\...\1785912345678-abc-image.png
```

关键日志含义：

| 日志 | 含义 |
|---|---|
| `plugin loaded` | 插件成功加载（若没出现=插件未注册/加载失败） |
| `loaded N blacklist patterns` | 黑名单读取成功（0 = JSON 解析失败或文件不存在） |
| `transform fired for provider/model` | 钩子被触发，识别到目标模型 |
| `model declares image capability, PASS` | 模型自带视觉，放行 |
| `not in text blacklist, PASS` | 不在黑名单，放行 |
| `in blacklist, BRIDGING image` | 命中黑名单，开始转换 |
| `deduped image` | 检测到重复图片，复用已有文件 |
| `wrote <path>` | 新图片已写入临时目录 |

## 常见问题 / FAQ

**Q: 模型列表里没有 `opencode/mimo-v2.5-free`？**
A: 免费模型是 opencode 内置的，一般都有。若没有，按上文"更换视觉子代理模型"处理。

**Q: 插件没生效？**
A: 检查：① `plugin` 数组是否显式注册（必须，不会自动发现）；② 是否重启了 opencode；③ 黑名单 JSON 是否合法（尾逗号会导致静默失效）。

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

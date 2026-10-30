# Pi Coding Agent - Magpie Provider 拓展

为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供的 [Magpie](https://github.com/yetone/magpie) 网关供应商扩展插件。

通过该扩展，你可以在 Pi 中配置任意 Magpie 统一网关地址与 API Key，自动发现网关提供的所有模型及对应参数（上下文窗口、输出限制、思考档位、协议原生路由、多模态输入支持等），并在会话中无缝调用。

---

## 功能特性

1. **灵活开放的登录配置**
   - 纯开放设计，不预设任何私有地址；
   - **环境变量即插即用**：支持设置环境变量 `MAGPIE_BASE_URL`，设置后在 `/login` 中只需直接填入 API Key，极大简化登录流程；
   - **多种接入途径**：
     - 在系统或终端配置环境变量 `MAGPIE_BASE_URL` 与 `MAGPIE_API_KEY`；
     - 在 Pi 原生 `/login` 或 `/login magpie` 中直接登录；
     - 直接编辑 `<agent-dir>/auth.json` 配置文件；如需覆盖模型元数据，可使用 `models.json` 的 `modelOverrides`。
   - 支持本地网关或任何远程托管的 Magpie 网关。

2. **自动模型与参数发现机制**
   - 请求 Magpie 的 `/v1/models` 接口获取网关发布的所有模型列表；
   - **原生协议自适应路由**：识别各模型的 `native_endpoints`，将 Claude 消息原生请求路由至 Anthropic Messages API、将 GPT 响应原生请求路由至 OpenAI Responses、其他模型走 OpenAI Chat Completions 或 Gemini，避免多层转译损失；
   - **模型参数精确匹配**：
     - 上下文窗口 (`contextWindow`) 与最大回复限制 (`maxTokens`)
     - 思考推理状态 (`reasoning`) 与思考档位映射 (`thinkingLevelMap`：`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
     - Claude 4.6+/5+ 自适应思考参数 (`forceAdaptiveThinking`)
     - 多模态能力（支持图片输入 `input: ["text", "image"]`）
     - 价格与计费元数据 (`cost`) 与提示词缓存周期 (`promptCache`)
   - 过滤非对话模型（如 embedding、rerank 等），并按模型 ID 去重。

3. **启动不等待网络，刷新全异步**
   - 凭据由 Pi 持久化到 `<agent-dir>/auth.json`；模型目录由 Pi 的模型存储（`<agent-dir>/models-store.json`）持久化；
   - 启动和列表命令直接复用上次的模型目录，不联网等待，Pi 启动速度不受影响；
   - 启动后在后台异步刷新，刷新失败时继续使用缓存（与 Pi 内置 provider 行为一致）；
   - 登录与模型同步均在内存中动态热生效，无需 `reload` 重置会话，不中断当前工作流。

---

## 安装

```bash
pi install npm:@evalexp/magpie-provider
```

仅在单次会话中临时加载：

```bash
pi -e npm:@evalexp/magpie-provider
```

也可以把 `index.ts` 放到 `<agent-dir>/extensions/` 目录下，让 Pi 随启动自动加载。

---

## 使用指南

### 1. 登录与配置网关

本插件完全遵循 Pi 的原生机制，所有操作直接在 Pi 原生的 `/login` 中完成，不引入任何自定义斜杠命令。

#### 推荐方式：设置 `MAGPIE_BASE_URL` + 原生 `/login`

1. **设置环境变量 `MAGPIE_BASE_URL`**（在系统环境变量或 shell 配置文件中）：
   ```bash
   # Windows PowerShell
   $env:MAGPIE_BASE_URL = "https://your-gateway.example.com"

   # Linux / macOS
   export MAGPIE_BASE_URL="https://your-gateway.example.com"
   ```

2. **在 Pi 中执行 `/login`**：
   ```text
   /login
   ```
   （或者直接运行 `/login magpie`）
   在弹出的供应商列表中选择 **Magpie Gateway**。因为已配置 `MAGPIE_BASE_URL`，Pi **不会重复要求输入地址**，而是直接提示输入 API Key：
   ```text
   Magpie API Key (https://your-gateway.example.com):
   ```
   输入后回车，插件会自动请求网关 `/v1/models`，自动解析所有模型及其参数并持久化，即刻生效。

#### 免交互方式：全环境变量配置

如果你不想在界面中输入，可以直接设置两个环境变量：
```bash
export MAGPIE_BASE_URL="https://your-gateway.example.com"
export MAGPIE_API_KEY="sk-your-api-key"
```
启动 Pi 时，插件会自动发现并加载网关的所有模型。

#### 纯交互方式：首次未设置环境变量

如果未设置环境变量，直接在 Pi 中运行 `/login magpie`：
1. 提示输入网关地址：`Magpie Gateway URL (or set MAGPIE_BASE_URL env var):`
2. 提示输入 API Key：`Magpie API Key:`

配置完成后凭据会自动保存到 `<agent-dir>/auth.json`，后续启动无需重复输入。

---

### 2. 刷新模型列表（Refresh Models）

当网关新增、删除模型或更新参数时，有以下几种原生刷新方式：

1. **会话中直接打开 `/model` 选择器**：
   插件注册了 `refreshModels` 原生钩子，每次在 Pi 会话中打开 `/model` 菜单时，Pi 均会在后台自动调用 `refreshModels` 与网关通讯并同步最新模型，无需重启。
2. **终端 CLI 命令**：
   ```bash
   pi update --models
   ```
   这会主动触发各供应商的 `refreshModels` 钩子并重新拉取模型列表。
3. **重新认证**：
   直接在会话中再次执行 `/login magpie`，即可重新拉取网关模型。

---

### 3. 选择模型并开始对话

配置完成后，使用 Pi 自带的 `/model` 命令即可选择网关提供的模型：

```text
/model magpie/<model-id>
```

或者在启动 Pi 时直接指定：

```bash
pi --model "magpie/<model-id>:high" "帮我分析当前项目结构"
```

其中 `<model-id>` 是 `/v1/models` 返回的模型 ID，替换为你所用网关实际提供的模型即可。

---

## 环境变量

| 变量 | 说明 |
|---|---|
| `MAGPIE_BASE_URL` | Magpie 网关地址，如 `https://your-gateway.example.com`（可省略末尾 `/v1`） |
| `MAGPIE_API_KEY` | Magpie API Key，设置后无需再通过 `/login` 输入 |

两者的优先级：进程环境变量 > `auth.json` 中保存的凭据。

---

## 说明

- 模型 ID、显示名、上下文窗口、最大输出、思考档位、模态能力与价格均来自网关 `/v1/models` 响应；网关未提供某项元数据时，插件会采用保守的默认值（如未知模态按纯文本处理）。
- 价格按 Pi 的计费单位（USD / 百万 token）归一化；缓存读写价格仅在网关提供时启用。
- 本项目仅作为 Pi 与 Magpie 网关之间的适配层，不内置任何具体网关地址或模型。

---

## License

[MIT](./LICENSE) © evalexp

# dsh-effort-sync

把 **DSH 模型目录里的推理等级**与**供应商实际声明的能力**对齐。

> 宣传页：**https://dc1024.github.io/dsh-effort-sync/**（源码在 `docs/`）

两个入口，共用同一段逻辑：

- **设置界面 → 模型** 页尾部的「**同步推理等级**」按钮 —— 点一下就把供应商公布的等级补齐（本文档新增）。
- **工具 `sync_reasoning_levels`** —— 给 agent 用，默认 dry-run。

## 为什么需要它

DSH 自己做不到这件事，原因是契约缺一个槽位：

- **发现契约没有推理字段**：`LlmDiscoveredModel = { id, name?, contextWindow?, maxTokens?, inputModalities? }`
  —— 所以即使供应商在 `/v1/models` 里报了能力，DSH 也搬不进来。
- **推理能力只有一条入口**：`LlmResolvedModelInfo.reasoning`，而它来自适配器自报或目录声明
  （`reasoningEfforts`）。
- 结果：像 **magpie** 这样已经提供 `supported_reasoning_levels` 的网关，在界面上加完模型后，模型选择器里依然没有思考强度可选。

本插件读上游、写目录，补上这一段。写回走的是 `configEditor` —— **和设置界面同一条正规路径**。

## 界面按钮

座位是官方声明的加性扩展点 `settings.models.footer`（由 `@deepseek-ai/dsh-client-ui-settings-models`
声明），**不覆盖任何自带 UI**。按钮的工作流：

1. 读取每个往 `providers` 里声明的供应商（含手写 patch 层里的）；
2. 用 `credentials.resolve(apiKeyEnv)` 取密钥，请求 `<baseURL>/models`；
3. 把两边都有、而目录里还缺的等级写回 `reasoningEfforts`；
4. 在按钮下方直接列出**写了哪些模型、从什么变到什么**、以及哪些值被跳过。

一个供应商读不通只会被单独报告，不会挡住其它供应商的写入。

> 客户端插件（`dsh.client`）**需要重启 DSH 才会挂载**；host 半边的改动是热加载的。配置写入本身即时生效。

## 工具用法

```
用 sync_reasoning_levels 看看会改什么         # dryRun 默认 true，只报告差异
用 sync_reasoning_levels 应用（dryRun=false）  # 真正写回配置
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `provider` | 全部 | 要同步的 provider key（如 `magpie`）；不传则同步所有声明的供应商 |
| `dryRun` | `true` | 只报告差异，不写（**界面按钮相反：点击即写**） |
| `noneMapsToOff` | `false` | 是否把上游的 `none` 档映射成 DSH 的 `off`（**按上游而异，默认不猜**） |
| `only` | 全部 | 只同步指定的模型 id |
| `replace` | `false` | 用上游列表**替换**声明（默认是加性合并；替换有掉档风险，见下） |

## 安全设计

1. **默认不写**：工具 `dryRun` 默认 true；界面按钮是显式点击，写完把差异回报给你。
2. **只写 DSH 认识的等级**：词表固定 `off / minimal / low / medium / high / xhigh / max`；上游多出来的值（如 `none`）只报告、不猜。
3. **保留既有 wire 拼写**：已存在的映射（如 `max: ultra`）不会被覆盖 —— 与设置界面同一规则。
4. **不动上游没广告的模型**：查不到的模型原样跳过，并在报告里说明。
5. **加性优先**：中转网关公布的档位常是上游能力的**保守子集**（实测 magpie 对某模型只报 low/high/max，而上游六档全收），所以默认只增不减；`replace` 需显式开启。
6. **不碰凭据**：只经 `credentials.resolve(apiKeyEnv)` 取值，不落盘、不打印。
7. **不整块改写供应商**：只写 `models` 这一项，并且是从**有效配置**（含下层）+ 本层已有内容重建的，不会把下层手写的 `apiKeyEnv`/`baseURL` 变成空值，也不会丢模型。

## 两个已知边界

- **`reasoning: false` 不代劳**：若上游对某模型标 `reasoning: false`，插件**不会**替你写 `reasoningEfforts: false`
  （那会让选择器消失，属于行为变更）。它只在报告里提示你手工决定。
- **`none` 档不猜**：见 `noneMapsToOff`。

## 自测

`node rehearsal.mjs` 用假 ctx + 假上游跑全流程（真实 HTTP 走的是本插件自己的路由），断言覆盖：

- dry-run 只算差异、**零写入**；
- 应用后写入的模型表**结构与拼写**（保留 `max: ultra`、新档用同一性拼写、不动无关模型）；
- 幂等（第二次点击无改动、无冗余写入）；
- 单个供应商读不通 / 缺密钥 / 无模型 / 未知 provider / 非 POST 请求的错误路径。

宣传页另有一条渲染自检（防止首屏空白与横向溢出这两类老坑）：

```bash
node tools/verify-site-chrome.mjs   # 无头 Chromium 直接经 CDP 驱动，输出截图与量测
```

它用 DevTools 协议量 `scrollWidth` / 元素可见性 / 溢出元素，桌面与移动各出一张全页截图，报告写在 `.verify/`。

## 安装

```bash
pnpm pack        # 产出 dsh-effort-sync-<version>.tgz
```

然后在 DSH：**设置 → 插件** → 安装 tarball（或 `plugin_manager install_bundle <tarball>`），**重启 DSH**。

> 升级务必 bump 版本号：DSH 按 generation 路径缓存已加载的 ESM。

## 改动记录

| 版本 | 内容 |
|---|---|
| 0.2.0 | 加界面按钮（client 半 + `settings.models.footer`）、`POST /dsh-effort-sync/sync`、逐供应商报告与容错、`replace` 选项、离线 rehearsal 与 `tools/pack.mjs` |
| 0.1.2 | 加性合并（只增不减）、多供应商同步、`tools/` 探针 |
| 0.1.1 | 保留既有 wire 拼写、跳过未知等级 |
| 0.1.0 | 首个版本：`sync_reasoning_levels` 工具，默认 dry-run |

## License

MIT

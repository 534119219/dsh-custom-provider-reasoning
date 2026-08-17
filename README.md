# dsh-custom-provider-reasoning

dsh host 插件：让**自定义提供方**（GUI「添加自定义提供方」创建的、pi-ai 目录之外的手写路由）的所有模型，都能在 composer 的模型选择器里选择**思考强度（推理等级）**，并且选择会真正发往线上。

## 问题背景

- composer 的模型选择器只在适配器为**该确切模型**公布了 `reasoning` 元数据时才显示推理等级行；
- `dsh-llm-pi-ai` 只会从 `llm-pi-ai` 设置分节里模型条目的 `reasoningEfforts` 声明物化这份元数据；
- 而设置 UI 刻意不写这个字段（推理强度是按模型的能力，提供方级控件无法表达）。

结果就是：内置提供方（如 DeepSeek）可选思考强度，自定义提供方的模型一律「当前模型未提供推理等级」。

## 插件做什么

在支持的原厂配置缝上补齐缺口：每当 `llm-pi-ai` 设置变化或适配器目录发布时，插件自动为每个**合格模型条目**写入 `reasoningEfforts`（默认 `off / low / medium / high`，wire 拼写与等级同名——OpenAI 兼容端点标准词汇）。

下游一切照旧走原厂链路：`session.models` / `llm.models` 目录 RPC、请求期校验（`resolveCallConfig`）、以及线上翻译（pi-ai 对 OpenAI 兼容端点发送 `reasoning_effort: low|medium|high`）。

### 合格规则

| 场景 | 是否注入 |
|---|---|
| 自定义路由（`declared`）上的模型，无 `reasoningEfforts` | ✅ 注入 |
| 目录路由上、pi-ai 目录未收录的模型（`scope: all`） | ✅ 注入 |
| 已有 `reasoningEfforts` 的模型（手调字典或显式 `false`） | ❌ 永不触碰* |
| pi-ai 目录已收录的模型（目录自带推理元数据） | ❌ 交给目录 |

\* 唯一例外：恰好等于**内置默认字典**（`off/low/medium/high`）的条目只可能是插件自己写的，因此会在配置的 `levels` 变化时被自动刷新为新配置——这样在 patch 里调高 `levels` 能覆盖到插件已经处理过的提供方，而用户手写的配置始终权威。

注入是**幂等**的：模型一旦被覆盖就不再写入，不会与设置 UI 打架，也不会循环。

## 安装

把本目录加入 web profile（`~/.dsh/profiles/web`）：

```jsonc
// package.json
{
  "dependencies": {
    "dsh-custom-provider-reasoning": "github:534119219/dsh-custom-provider-reasoning"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-custom-provider-reasoning"   // 追加到列表末尾
      ]
    }
  }
}
```

然后在 profile 目录执行：

```bash
pnpm install
```

重启 `dsh web`。启动后插件会自动把 `reasoningEfforts` 写入 `~/.dsh/settings.yaml` 的自定义路由模型条目（例如）：

```yaml
llm-pi-ai:
  providers:
    scnet:
      models:
        - id: DeepSeek-V4-Pro
          reasoningEfforts:
            off:
            low: low
            medium: medium
            high: high
```

之后打开 composer 模型选择器，选择该模型即可看到推理等级（Default / Off / Low / Medium / High）。

## 配置

插件支持配置（放在 profile 的 `cordis.patch.yml` 对应行或插件设置页）：

```yaml
- id: dsh-custom-provider-reasoning
  name: 'dsh-custom-provider-reasoning'
  config:
    enabled: true          # 总开关，默认 true
    scope: declared        # declared（默认，只处理自定义路由）| all（额外覆盖目录路由上目录未收录的模型）
    verify: false          # 发布后逐个 resolveModelInfo 并记录推理元数据（诊断用）
    levels:
      off:                 # 留空 = 支持但不发送任何内容（端点用自己的默认）
      low: low
      medium: medium
      high: high
      max: max
```

`levels` 的键必须是 pi-ai 的思考等级（`off / minimal / low / medium / high / xhigh / max`），值是对应线上拼写；除 `off` 外都必须是非空字符串。至少要有 `off` 之外的等级，否则插件拒绝启动（避免把路由配置弄成不可服务）。

## 注意事项

- **端点兼容性**：默认按 OpenAI 兼容 `reasoning_effort` 词汇注入。若端点不认 `reasoning_effort`，请求可能报错——这时可以在 `settings.yaml` 里把该模型的 `reasoningEfforts` 改成端点支持的拼写，或直接设 `reasoningEfforts: false` 关闭（插件不会覆盖显式声明）。
- **方言端点**：需要 `compat.thinkingFormat`（如 deepseek / qwen / together）的端点，请在 `settings.yaml` 的路由或模型上自行配置 `compat`——插件只补 `reasoningEfforts`，不猜方言。
- **运行时**：插件启动即生效（写入设置后下一次请求边界生效）；新增/编辑自定义提供方无需重启。已存在的自定义提供方（如 scnet）在插件写入 `reasoningEfforts` 后**无需重启 GUI** 即可看到推理等级——设置文件被 host 热加载。重启 GUI 只用于加载插件本身（保证未来新增的自定义提供方也被自动覆盖）。

## 工作原理（代码地图）

- `lib/index.js` — `apply()`：监听 `llm/adapters-updated`、`settings/updated`、`settings/document-updated`，串行执行 `refresh()`；`planOps()` 纯函数计算最小 `settings.mutate` 路径操作。
- 路由「自定义」判定来自 `ctx.llm.listConfigurableProviders()` 的 `declared` 标志（与设置 UI 的「自定义」标签同一来源），不依赖 pi-ai 内部实现。

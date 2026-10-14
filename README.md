# for-DSH

> 我的 **DeepSeek Harness（DSH）** 插件与工具集合。

**中文** | [English](#english)

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-4b6bfb.svg)

---

## 插件

| 插件 | 说明 | 平台 | 状态 |
| --- | --- | --- | --- |
| [`dsh-context-alert`](plugins/dsh-context-alert/) | **上下文压力提醒**：读取官方 `contextPressure` 投影，在回合结束主动提醒你该开新会话了，避免在毫无预警的情况下被有损压缩 | Windows | 0.1.0 · 37 项测试通过 |

## 目录结构

```
plugins/<插件名>/      每个插件自成一体：有自己的 package.json / README / LICENSE
LICENSE                整仓库许可（MIT）
```

每个插件目录都可以单独拎出来安装，也符合 DSH 的 plugin bundle 约定。

## 安装

见各插件自己的 README。共同前提：

- DSH `0.2.0-rc.2`
- Node `>= 22.5`
- Windows（`dsh-context-alert` 的通知后端依赖 PowerShell；后续插件若跨平台会单独标注）

## License

[MIT](LICENSE) © 2026 yierzhao23-debug

---

## English

A collection of my plugins and tools for **DeepSeek Harness (DSH)**.

| Plugin | Description | Platform | Status |
| --- | --- | --- | --- |
| [`dsh-context-alert`](plugins/dsh-context-alert/README.en.md) | **Context pressure alerts**: reads the official `contextPressure` projection and warns you at the end of a turn when it is time to start a fresh session — before silent lossy compaction kicks in | Windows | 0.1.0 · 37 tests passing |

Layout: `plugins/<name>/` — every plugin is self-contained (its own `package.json`, README and LICENSE) and can be installed on its own. Common requirements: DSH `0.2.0-rc.2`, Node `>= 22.5`.

Licensed under [MIT](LICENSE) © 2026 yierzhao23-debug

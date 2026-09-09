# AGENTS.md — dsh-web-recorder

> 面向 AI 编码助手的项目说明。本文件描述项目真实结构，修改代码前请先阅读；若改动与本文件描述不一致，请同步更新本文件。

## 项目概览

`dsh-web-recorder` 是一个 DSH（DeepSeek Harness，`dsh web`）插件：网页操作录制器。

面向「用户手动操作浏览器，插件在后台录制」的场景：优先 CDP attach 到正在运行的浏览器窗口（显式 `cdpUrl` 或自动发现带调试端口的 Playwright MCP 浏览器），否则启动一个有头浏览器窗口（默认本机 Edge），记录其中每次点击/输入/表单提交（UI 事件线）和每个网络请求/响应/失败（网络事件线），事件实时落盘 `events.jsonl`；停止录制后生成 Markdown 摘要报告 `report.md`。录制产物供大模型分析，归纳「业务流程 × 接口调用序列 × 数据契约」并沉淀为 skill。

插件只负责「旁观并记录」，不直接操作页面——打开页面/按步骤操作由驱动方完成（真人、playwright MCP、browser-use 等）。设计初衷等背景详见 `README.md`（中文，另有 `README_EN.md` 英文版）。

注册 3 个工具：

| 工具 | 说明 |
| --- | --- |
| `recorder_start(url?, waitSeconds?)` | 开始录制：attach 到已有浏览器窗口（cdpUrl / 自动发现 MCP CDP 端口）或启动有头浏览器，可导航到起始 URL；`waitSeconds` 让录制先等 N 秒再记录（跳过登录/初始化噪音），默认 0 立即记录 |
| `recorder_stop()` | 停止录制：生成 `report.md`；attach 模式只断开 CDP 连接，插件自启窗口才关闭；幂等 |
| `recorder_status()` | 查询状态：是否在录制、事件计数、产物目录、上次收尾结果 |

用户直接关掉浏览器窗口会自动收尾（`reason: browser-closed`），已录数据不丢。

## 技术栈

- **语言**：TypeScript（ES2022 / NodeNext，strict 模式），ESM（`"type": "module"`）
- **运行时**：Node.js ≥ 18（Windows 上由 fnm 管理，见「环境」节）
- **包管理**：pnpm ≥ 8（lockfile 为 `pnpm-lock.yaml`）
- **构建**：tsdown（产物输出到 `lib/`，`.js` 而非 `.mjs`，见 `tsdown.config.ts`）
- **类型检查**：`tsc --noEmit`（`tsconfig.json` 只做检查不发产物）
- **单元测试**：vitest
- **关键依赖**：
  - `playwright-core`（dependencies）：浏览器驱动，不下载 Chromium，使用本机已装浏览器（默认 `channel: msedge`）
  - `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`（peerDependencies，由宿主 DSH 提供）：插件框架、工具定义、配置校验

## 构建与常用命令

```sh
pnpm install       # 安装依赖(devDependencies 与 peerDependencies 对齐)
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run, 单元测试(report 生成纯函数)
pnpm test:watch    # vitest watch 模式
pnpm build         # tsdown 产物到 lib/(插件加载与 smoke 依赖该产物)
pnpm smoke         # 真实 Edge 端到端冒烟(需本机已装浏览器, 产物在 reports/)
pnpm smoke:cdp     # CDP attach 模式端到端冒烟(需本机已装浏览器, 产物在 reports/)
pnpm smoke:mcp     # MCP 浏览器自动发现 attach 冒烟(模拟带调试端口的 MCP Chrome, 产物在 reports/)
pnpm smoke:wait    # 等待期(前置剔除)冒烟: 验证 waitSeconds 等待期内不记录、等待期后正常记录
```

注意：`pnpm smoke` / `pnpm smoke:cdp` 依赖 `lib/index.js`，**改动源码后须先 `pnpm build`** 再跑冒烟。发布前钩子 `prepublishOnly` 会自动构建。

## 代码结构

```
src/
  index.ts    插件入口: export const name = 'dsh-web-recorder', inject = ['tools'],
              Config(schemastery schema) 与 apply(ctx, config) —— 注册 3 个工具,
              管理单会话生命周期(session/lastResult), 插件卸载时经 ctx.effect 兜底收尾。
              Config 默认值由 RECORDER_DEFAULTS 单一来源提供(schema 与 apply 兜底共用)。
  session.ts  RecorderSession 录制会话核心: 启动浏览器(cdpUrl / 自动发现 MCP CDP 端口 /
              等待期 waitSeconds(录制开始后先等 N 秒再记录, 等待期内事件整组丢弃: request 不登记
              requestId 故其响应/失败一并忽略; 计时自 startedAt 起算, 覆盖浏览器启动与起始页导航) /
              channel / executablePath, attach 优先、失败回退接管或新开)、注入 INIT_SCRIPT(捕获阶段
              监听 click/change/submit, 经 exposeBinding 回传 UI 事件; attach 模式对已加载页面
              直接 evaluate 补装)、监听 request/response/requestfailed/console 事件, 事件内存留存
              + 逐行写 events.jsonl; stop() 幂等收尾, 浏览器被关闭时自动 finalize。
              finalize 经 finalizePromise 去重(stop / 关窗口 / 插件卸载可能并发触发), 只跑一次。
  report.ts   generateMarkdown(events, meta): 从事件序列生成 Markdown 摘要
              (统计概览 + 操作时间线 + 网络请求明细表 + 失败请求), 纯函数。
  types.ts    RecordedEvent 联合类型(navigate/click/change/submit/request/response/
              requestfailed/console)、RecorderOptions、SessionStats、StopResult、
              ToolError/toolError 错误信封。
  stats.ts    SessionStats 计数的单一口径: createSessionStats / accumulateEvent(会话 push 时增量累加) /
              countEvents(报告一次性统计), 两处共用, 避免口径漂移。
  init-script.ts  注入页面的 UI 事件采集脚本 INIT_SCRIPT(click/change/submit 捕获 + selector/label 提取)。
  browser-discovery.ts  Playwright MCP 浏览器的发现与接管(仅 Windows 实现: PowerShell CIM 查
              user-data-dir、读 DevToolsActivePort 得 CDP 端口、读 Chrome Sessions 的 Tabs 文件取最近
              URL、kill 后轮询等进程退出); createMcpBrowserProbe() 返回探针, 同一次 start 内缓存
              user-data-dir(避免重复 spawn), 非 Windows 一律返回 undefined 直接回退新开窗口。
lib/          tsdown 构建产物(已 gitignore), 入口 lib/index.js
tests/
  report.test.ts  vitest 单元测试, 直接跑 TS 源码(无需 build), 只测 generateMarkdown
  smoke.mjs       端到端冒烟(手工运行): 本地起 HTTP 服务, 真实 Edge 录制并断言产物
  smoke-cdp.mjs   CDP attach 模式冒烟: 先启带调试端口浏览器, 再 attach 录制
  smoke-mcp-attach.mjs  MCP 自动发现冒烟: 模拟带 --remote-debugging-port=0 的 MCP Chrome
                        (user-data-dir 含 ms-playwright-mcp), 断言自动 attach、不杀进程
tools/recorder-cli.mjs  CLI 启动器(插件未加载期间的等效入口): node tools/recorder-cli.mjs
                        <起始URL> <停止信号文件>, 用 lib/ 的 RecorderSession 录制
scripts/generate-podcast-cover.mjs  用 playwright-core 渲染 assets/podcast-cover.png
cordis.patch.yml  DSH 插件清单(被 package.json 的 dsh.bundle.patch 引用),
                  id/name 均为 dsh-web-recorder, 与 src/index.ts 的 export const name 一致
submission/       awesome-dsh-plugin 投稿草稿(不入仓库, 已 gitignore)
assets/           README 截图与封面
```

## 代码约定

- **注释与文档使用简体中文**；保留需求注释，必要处添加说明。本项目刻意保留「为什么这样做」的注释（如 CDP 回退、Windows 浏览器进程驻留、junction realpath 处理等），删除或改写代码时先读相关注释。
- 源码相对导入**带 `.ts` 后缀**（`allowImportingTsExtensions`），产物由 tsdown 转换。
- 对外输出对象字面量类型用 `type` 别名而非 `interface`（隐式索引签名可赋给 `Record<string, JsonValue>`，见 `types.ts` 注释）。
- 配置默认值单一来源：`RECORDER_DEFAULTS`（`src/index.ts`），schemastery schema 与 `apply` 兜底不得各自硬编码。
- 错误返回统一走 `toolError({type, message, hint})` 信封（`type: 'state' | 'browser' | 'internal'`），工具的 `output.render` 负责把结果渲染成给模型看的文本。
- `RecorderSession.stop()` / `finalize()` 必须幂等：用户关浏览器、插件卸载、`recorder_stop` 三条路径会并发触发收尾，`stopResult` 只允许设置一次；报告生成/写盘失败不得阻断收尾。
- 页面/请求映射（`pageIds` / `requestIds`）用 `WeakMap`：不持强引用，长时间录制不会把已关闭的页面与已完成请求堆积在内存；请求失败（终态）时主动 `delete`。
- 事件计数只走 `src/stats.ts`：会话侧 `push` 时增量累加，报告侧 `countEvents` 一次性统计，两处不得各写一份 `switch`。
- 等待期（前置剔除）只有 `waitSeconds` 一个入参（工具调用时传，默认 0），不进 Config；丢弃逻辑集中在 `RecorderSession.waiting()` 与各事件入口的早退分支，等待期内被丢的事件只累计 `skipped` 供回显。
- 启动中途失败要释放已建的浏览器与事件流；attach 失败同样要断开已建立的连接（`start` / `tryAttach` 的 catch 里处理）。
- 保留 `console.log` 等调试输出，仅在明确要求时删除。
- Node 版本由 fnm 管理（`D:\fnm\node-versions`，`fnm list` 查看）。
- 运行时产物默认落在**当前工作目录**（harness 会话 cwd）下 `reports/recorder/rec-<HH-mm-ss>/`，该目录不可写时退回插件仓库根的 `reports/recorder`；`reports/` 已 gitignore。

## 测试策略

- **单元测试**（`pnpm test`）：vitest，直接运行 TS 源码无需构建。覆盖 `report.ts` 的 `generateMarkdown` 纯函数（`tests/report.test.ts`）与 `stats.ts` 的计数口径（`tests/stats.test.ts`）。
- **端到端冒烟**（`pnpm smoke` / `pnpm smoke:cdp` / `pnpm smoke:mcp` / `pnpm smoke:wait`）：非测试框架的手工脚本，需要本机安装 Edge（或 Chrome）。前三者分别覆盖新开窗口录制、显式 cdpUrl attach、MCP 浏览器 CDP 端口自动发现 attach，`smoke:wait` 覆盖等待期（等待期内不记录、等待期后正常记录）；`smoke:cdp`/`smoke:mcp` 还断言 `stop` 后外部浏览器进程不被关闭。断言 `events.jsonl` 与 `report.md` 内容（点击/输入/请求/响应/脱敏）。
- 修改 `session.ts` 事件采集逻辑后，应跑 `pnpm build && pnpm smoke`（CDP 相关改动另跑 `pnpm smoke:cdp`）验证；修改 `report.ts` 至少跑 `pnpm test` + `pnpm typecheck`。

## 安全注意事项

- 请求头中的敏感头（`cookie`、`authorization`、`proxy-authorization`、`x-api-key`、`set-cookie`，可配 `redactHeaders`）默认脱敏为 `<redacted>`。
- 密码输入框的值不落盘，只记录输入动作（`redacted: true`）。
- 请求体/响应体截断到 `maxBodyBytes`（默认 16384）。
- **请求体/响应体不做内容级脱敏**（可能含 token 等业务数据）——`events.jsonl` 含完整请求头/体，按敏感数据处理，勿外发、勿提交到仓库（`reports/` 已 gitignore，注意保持）。
- `src/browser-discovery.ts` 中有针对 Playwright MCP 浏览器的检测/接管逻辑（Windows 专用：经 PowerShell CIM 查进程、读 `DevToolsActivePort` 自动发现 CDP 端口并 attach、读 Chrome Sessions 的 Tabs 文件提取 URL、`Stop-Process` 关闭旧进程）——涉及杀进程，改动需格外谨慎；非 Windows 平台该模块整体返回 `undefined`（回退新开窗口），不要为非 Windows 引入会误杀进程的实现。

## 环境

- 开发机为 Windows（Git Bash 执行 shell 命令）；浏览器检测/接管等逻辑含 Windows 专用实现。
- 插件加载：DSH 经 profile node_modules 的 junction 链接加载本包，`src/index.ts` 中 `import.meta.url` 需先 `realpathSync` 还原真实路径再上溯（勿删该处理）。
- `@deepseek-ai/dsh-tools` 的 peerDependencies 范围必须带显式预发布分支（harness 以 rc 版本发布，无分支的宽范围会被 node-semver 静默排除）——升级版本时注意保持该形态。

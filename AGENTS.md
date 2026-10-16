# AGENTS.md — dsh-web-recorder

> 面向 AI 编码助手的项目说明。本文件描述项目真实结构，修改代码前请先阅读；若改动与本文件描述不一致，请同步更新本文件。

## 项目概览

`dsh-web-recorder` 是一个 DSH（DeepSeek Harness，`dsh web`）插件：网页操作录制器。

面向「用户手动操作浏览器，插件在后台录制」的场景：优先 CDP attach 到正在运行的浏览器窗口（显式 `cdpUrl`，或自动发现**本机任何带 `--remote-debugging-port` 的 Chromium**，Playwright MCP 浏览器优先），否则启动一个有头浏览器窗口（默认本机 Edge，**自带 CDP 端口 + 持久 profile**），记录其中每次点击/输入/表单提交（UI 事件线）和每个网络请求/响应/失败（网络事件线），事件实时落盘 `events.jsonl`；停止录制后生成 Markdown 摘要报告 `report.md`。录制产物供大模型分析，归纳「业务流程 × 接口调用序列 × 数据契约」并沉淀为 skill。

「零配置接入」是本插件的核心目标之一：attach 不再依赖用户预先给 MCP 写配置（谁开了调试端口就接管谁），而插件自启的窗口也会把自身 CDP 地址回显给模型（`cdpUrl`），让驱动方反过来连上来接管——两个方向都能协同，无需手工准备浏览器环境。

插件只负责「旁观并记录」，不直接操作页面——打开页面/按步骤操作由驱动方完成（真人、playwright MCP、browser-use 等）。设计初衷等背景详见 `README.md`（中文，另有 `README_EN.md` 英文版）。

注册 3 个工具：

| 工具 | 说明 |
| --- | --- |
| `recorder_start(url?, waitSeconds?)` | 开始录制：attach 到已有浏览器窗口（cdpUrl / 自动发现本机任何开了调试端口的 Chromium）或启动有头浏览器，可导航到起始 URL；自启窗口带 `--remote-debugging-port=0`，返回 `cdpUrl` + `profileDir` 供驱动方连接；`waitSeconds` 让录制先等 N 秒再记录（跳过登录/初始化噪音），默认 0 立即记录；同时把本次录制登记为宿主后台任务并返回 `jobId` |
| `recorder_stop()` | 停止录制：生成 `report.md`；attach 模式**只断开录制连接、不关闭外部浏览器**（`disconnectBrowser()`），插件自启窗口才关闭；幂等 |
| `recorder_status()` | 查询状态：是否在录制、事件计数、产物目录、本次录制窗口的 `cdpUrl`、`jobId`、上次收尾结果 |

用户直接关掉浏览器窗口会自动收尾（`reason: browser-closed`），已录数据不丢；此时后台任务随之结算，模型收到完成通知被唤醒继续总结（见「后台任务」约定）。

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
pnpm test          # vitest run, 单元测试(report / stats 纯函数)
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
              recorder_start / recorder_status 回显 cdpUrl 与 profileDir(零配置接入的可见性)。
  session.ts  RecorderSession 录制会话核心: 启动浏览器(cdpUrl / 自动发现本机任意开了调试端口的
              Chromium / 等待期 waitSeconds(录制开始后先等 N 秒再记录, 等待期内事件整组丢弃: request
              不登记 requestId 故其响应/失败一并忽略; 计时自 startedAt 起算, 覆盖浏览器启动与起始页
              导航) / channel / executablePath / userDataDir, attach 优先、失败回退接管或自启窗口)、
              launchBrowser() 用 launchPersistentContext + `--remote-debugging-port=0` 起窗口
              (端口从 profile 下 DevToolsActivePort 读出 → cdpUrl(); 持久 profile 保留登录态,
              失败自动回退临时 profile)、disconnectBrowser() 只断 CDP 连接不关外部浏览器、
              注入 INIT_SCRIPT(捕获阶段监听 click/change/submit, 经 exposeBinding 回传 UI 事件;
              attach 模式对已加载页面直接 evaluate 补装)、监听 request/response/requestfailed/console
              事件(requestStartedAt 结算响应耗时 durationMs), 事件内存留存 + 逐行写 events.jsonl;
              status()/snapshot() 供实时查询, finished() 暴露「收尾完成」信号供宿主后台任务结算;
              stop() 幂等收尾, 浏览器被关闭时自动 finalize。
              finalize 经 finalizePromise 去重(stop / 关窗口 / 插件卸载可能并发触发), 只跑一次。
  report.ts   generateMarkdown(events, meta): 从事件序列生成 Markdown 摘要
              (统计概览 + 操作时间线 + 网络请求明细表 + 失败请求), 纯函数。
  types.ts    RecordedEvent 联合类型(navigate/click/change/submit/request/response/
              requestfailed/console)、RecorderOptions、SessionStats、StopResult、
              ToolError/toolError 错误信封。
  stats.ts    SessionStats 计数的单一口径: createSessionStats / accumulateEvent(会话 push 时增量累加) /
              countEvents(报告一次性统计), 两处共用, 避免口径漂移。
  init-script.ts  注入页面的 UI 事件采集脚本 INIT_SCRIPT(click/change/submit 捕获 + selector/label 提取)。
  browser-discovery.ts  本机 Chromium 的 CDP 发现与接管(仅 Windows 实现: 一条 PowerShell 语句
              扫出所有带 --remote-debugging-port 的顶层进程 → 端口为 0 时读其 user-data-dir 下
              DevToolsActivePort 取实际端口 → MCP 特征优先排序; 另外读 Chrome Sessions 的 Tabs 文件
              取最近 URL、kill MCP 进程后轮询等退出); createBrowserProbe() 返回探针, 同一次 start 内
              缓存扫描结果(避免重复 spawn), 非 Windows 返回空直接回退新开窗口。
              所有 PowerShell 调用统一走 runPowerShell(EncodedCommand + $ProgressPreference 抑制噪音)。
lib/          tsdown 构建产物(已 gitignore), 入口 lib/index.js
tests/
  report.test.ts  vitest 单元测试, 直接跑 TS 源码(无需 build), 只测 generateMarkdown
  stats.test.ts   vitest 单元测试, 覆盖计数口径
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
- `ctx.jobs`（宿主后台任务运行时）是**可选能力**，不得写进 `inject`：运行时用 `ctx.get('jobs')` 取，取不到就退化（不返回 `jobId`，行为与加入该能力前一致）；类型上只声明用到的成员的本地最小接口（`JobsRuntime`），避免为可选能力引入 `@deepseek-ai/dsh-jobs` 依赖。
- 后台任务的结算只走 `RecorderSession.finished()`（收尾 → job 结算 → 宿主通知模型），`job.hooks.cancel` 落到 `session.stop()`；`recorder_stop` 拿到结果后再 `read` 一次把任务标为已报告，避免模型重复收到完成通知。
- 事件计数只走 `src/stats.ts`：会话侧 `push` 时增量累加，报告侧 `countEvents` 一次性统计，两处不得各写一份 `switch`。
- 等待期（前置剔除）只有 `waitSeconds` 一个入参（工具调用时传，默认 0），不进 Config；丢弃逻辑集中在 `RecorderSession.waiting()` 与各事件入口的早退分支，等待期内被丢的事件只累计 `skipped` 供回显。
- **attach 模式收尾只能断开、绝不关闭外部浏览器**：`stop()` 走 `disconnectBrowser()`——实测（playwright-core 1.63 + Edge）`browser.close()` 在 `connectOverCDP` 场景下会把外部浏览器进程真的关掉（调试端口随即 404），而「接管用户的窗口、录完就关掉它」会连带搞挂 MCP 会话；因此优先关底层连接（只断 WebSocket），拿不到内部句柄才回退公开 API。改动这段务必跑 `pnpm smoke:cdp` + `pnpm smoke:mcp`。
- **自启窗口固定带 `--remote-debugging-port=0` 且用持久 profile**（`launchPersistentContext` + `userDataDir`，默认 `~/.dsh-web-recorder/browser-profile`）：前者让窗口暴露 CDP 端口、供驱动方 connectOverCDP 接管（零配置接入的另一半），后者让登录态跨次录制保留；profile 不可用时退回临时 profile，不让「记住登录态」挡掉「能录」。
- **工具 `output.schema` 与 TS 侧类型必须对齐**：`defineTool` 能从 schema 精确推断 `render` / `execute` 的类型，字段对不上会直接编译失败（例如 `additionalProperties: true` 的 `counts` 要写成 `Record<string, JsonValue>`、字面量联合要配 `enum`、可选性要与 `required` 一致）。改 schema 后跑 `pnpm typecheck` 验证。
- 启动中途失败要释放已建的浏览器与事件流；attach 失败同样要断开已建立的连接（`start` / `tryAttach` 的 catch 里处理）。
- 保留 `console.log` 等调试输出，仅在明确要求时删除。
- Node 版本由 fnm 管理（`D:\fnm\node-versions`，`fnm list` 查看）。
- 运行时产物默认落在**当前工作目录**（harness 会话 cwd）下 `reports/recorder/rec_<DD>_<HH-mm-ss>/`（本地「日」+ 时分秒，不含年月），该目录不可写时退回插件仓库根的 `reports/recorder`；`reports/` 已 gitignore。

## 测试策略

- **单元测试**（`pnpm test`）：vitest，直接运行 TS 源码无需构建。覆盖 `report.ts` 的 `generateMarkdown`（`tests/report.test.ts`）与 `stats.ts` 的计数口径（`tests/stats.test.ts`）。
- **端到端冒烟**（`pnpm smoke` / `pnpm smoke:cdp` / `pnpm smoke:mcp` / `pnpm smoke:wait`）：非测试框架的手工脚本，需要本机安装 Edge（或 Chrome）。前三者分别覆盖新开窗口录制、显式 cdpUrl attach、MCP 浏览器 CDP 端口自动发现 attach，`smoke:wait` 覆盖等待期（等待期内不记录、等待期后正常记录）。
- **「外部浏览器没被关掉」的断言必须用 CDP 的 HTTP 端点**（`/json/version` 探进程、`/json/list` 探页面 target），**不要**用 `connectOverCDP` 重连或复用 Playwright 的对象句柄：同一个 Node 进程里 recorder 断开 CDP 后，Playwright 会把本进程内其他 client 的句柄一并置为 closed（它自己的客户端状态清理），浏览器与页面其实都活着——跨进程的真实协作方（Playwright MCP / 另一个脚本）不受影响。用句柄断言会得到假失败。
- **CI**（`.github/workflows/ci.yml`）：push / PR 即触发 GitHub Actions。`test` job（ubuntu-latest + Node 22 + pnpm 10）跑 `install --frozen-lockfile` → `typecheck` → `test` → `build`；`smoke` job 安装 Chrome 与 xvfb（有头模式需要虚拟 X server，`SMOKE_CHANNEL=chrome`）跑 `smoke` / `smoke:wait` / `smoke:cdp`，失败时上传 `reports/` 产物。`smoke:mcp` 依赖 Windows 专用发现逻辑，不放 Linux CI。
- 修改 `session.ts` 事件采集逻辑后，应跑 `pnpm build && pnpm smoke`（CDP / 断开 / 自启窗口相关改动另跑 `pnpm smoke:cdp` + `pnpm smoke:mcp`）验证；修改 `report.ts` 至少跑 `pnpm test` + `pnpm typecheck`；改 `src/index.ts` 的 tool schema 必跑 `pnpm typecheck`。

## 安全注意事项

- 请求头中的敏感头（`cookie`、`authorization`、`proxy-authorization`、`x-api-key`、`set-cookie`，可配 `redactHeaders`）默认脱敏为 `<redacted>`。
- 密码输入框的值不落盘，只记录输入动作（`redacted: true`）。
- 请求体/响应体截断到 `maxBodyBytes`（默认 16384）。
- **请求体/响应体不做内容级脱敏**（可能含 token 等业务数据）——`events.jsonl` 含完整请求头/体，按敏感数据处理，勿外发、勿提交到仓库（`reports/` 已 gitignore，注意保持）。
- `src/browser-discovery.ts` 中有针对本机 Chromium 的检测/接管逻辑（Windows 专用：经 PowerShell CIM 查进程、读 `DevToolsActivePort` 自动发现 CDP 端口并 attach、读 Chrome Sessions 的 Tabs 文件提取 URL、`Stop-Process` 关闭旧的 MCP 进程）——涉及杀进程，改动需格外谨慎。**`killMcpBrowser()` 只允许匹配带 `ms-playwright-mcp` 特征的进程，绝不能扩大到「所有带调试端口的浏览器」**（否则会杀掉用户自己的浏览器）。非 Windows 平台该模块整体返回空（回退新开窗口），不要为非 Windows 引入会误杀进程的实现。
- 浏览器 profile 目录（默认 `~/.dsh-web-recorder/browser-profile`）保存着目标站的登录态 / cookie，属于敏感数据：不要提交到仓库、不要外发；`reports/` 与它都在仓库之外或已 gitignore。

## 环境

- 开发机为 Windows（Git Bash 执行 shell 命令）；浏览器检测/接管等逻辑含 Windows 专用实现。
- 插件加载：DSH 经 profile node_modules 的 junction 链接加载本包，`src/index.ts` 中 `import.meta.url` 需先 `realpathSync` 还原真实路径再上溯（勿删该处理）。
- `@deepseek-ai/dsh-tools` 的 peerDependencies 范围必须带显式预发布分支（harness 以 rc 版本发布，无分支的宽范围会被 node-semver 静默排除）——升级版本时注意保持该形态。

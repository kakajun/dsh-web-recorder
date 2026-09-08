# dsh-web-recorder

**语言：简体中文 · [English](README_EN.md)**

网页操作录制器插件：面向「用户手动操作浏览器，插件在后台录制」的场景。启动一个有头浏览器窗口（默认本机 Edge），用户在窗口里正常点网页，插件在后台记录每次点击 / 输入 / 表单提交和每个网络请求 / 响应 / 失败，停止后生成 Markdown 摘要报告。

## 设计初衷

要让 agent 直接通过接口对接某个业务平台（例如 EIP 类系统），前提是先搞清楚三件事：平台暴露了哪些接口、每个业务步骤对应调用哪个、参数和响应是什么格式。传统做法是查接口文档或逆向前端代码，但文档往往缺失或过时，而且就算有了接口清单，也很难把「用户在页面上的业务操作」和「背后触发的接口调用」一一对上。

本插件换一种思路：**不逆向，只留操作依据**。开发者在一个有头浏览器窗口里，把目标业务流程手动完整跑一遍即可——之后不需要再翻文档，因为这次操作留下的原始数据已经回答了上面三个问题：

- **UI 事件线**：每一步点击 / 输入 / 表单提交发生在何时、落在哪个元素、填了什么值；
- **网络事件线**：每一步操作触发了哪些 `xhr`/`fetch` 请求——method、URL、请求头、请求体、响应体、失败原因。

两类事件按时间交错实时写入 `events.jsonl`，两条线天然对齐：任何一个业务步骤，都能在原始数据里找到「它调了哪个接口、参数怎么填、返回了什么」。停止后生成的 `report.md` 再把这套操作时间线与请求明细整理成便于阅读的摘要。

得到这些原始依据后，交给大模型做分析：归纳出完整的「业务流程 × 接口调用序列 × 数据契约」，再沉淀为 skill——把流程拆成步骤，注明每步该调哪个接口、请求 / 响应长什么样、出错怎么办——让 agent 之后照着 skill 直接走接口完成任务，整个过程不再依赖人工演示。

一句话概括：**页面操作一遍 = 留下可分析的操作依据 = 大模型据此制作接口级 skill 的原料**。录制本身只是采集，分析和沉淀交给模型完成。

## 效果预览

下面是一次真实录制的产物截图（`tests/smoke.mjs` 冒烟测试在一个本地页面执行「输入关键词 → 查询 → 去第二页」的完整流程）。

**① `report.md` 摘要**——统计概览 + 操作时间线 + 网络请求明细，把「业务步骤」和「接口调用」整理在同一张表里：

![report.md 摘要](assets/screenshot-1.png)

**② `events.jsonl` 原始事件流**——每一行一个事件（导航 / 点击 / 输入 / 请求 / 响应…），按发生时间交错实时落盘，是分析时最完整的操作依据：

![events.jsonl 原始事件流](assets/screenshot-2.png)

两张图对照着看：一次「输入关键词并查询」的操作，在 `events.jsonl` 里留下了对应的 `POST /api/query` 请求与 `200` 响应事件，在 `report.md` 里则汇总成一行请求明细——这正是设计初衷里「页面操作一遍，留下可分析的操作依据」的直观体现。

## 注册的工具

| 工具                   | 说明                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `recorder_start(url?)` | 开始录制：启动有头浏览器并可导航到起始 URL；事件实时落盘 `events.jsonl` |
| `recorder_stop()`      | 停止录制：生成 `report.md` 摘要报告并关闭浏览器；幂等                   |
| `recorder_status()`    | 查询状态：是否在录制、事件分类计数、产物目录、上一次收尾结果            |

用户直接关掉浏览器窗口会自动收尾（`reason: browser-closed`），已录数据不丢。

## 录制内容

- **UI 事件**：点击（选择器 + 元素文本 + 坐标）、输入/选择变更（name + 值，密码框只记录动作不落值）、表单提交、页面导航。通过 `context.exposeBinding` + `addInitScript` 捕获阶段监听实现，覆盖新标签页与 iframe。
- **网络事件**：默认只录 `xhr`/`fetch` 接口调用（`requestResourceTypes` 可调）——每个请求的 method/URL/resourceType/请求头/请求体，响应的状态码与响应体（截断），失败请求的错误原因。可选记录 console 消息。
- **产物**：每次录制在 `<outputDir>/rec-<时间戳>/` 下生成 `events.jsonl`（完整数据，逐行实时写入）和 `report.md`（操作时间线 + 请求明细表 + 失败请求摘要）。

## Config 字段

| 字段                    | 默认值                                                          | 说明                                                                                                                     |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `channel`               | `msedge`                                                        | playwright-core 浏览器渠道（`msedge`/`chrome`），使用本机已装浏览器，不下载 Chromium                                     |
| `executablePath`        | `''`                                                            | 自定义浏览器可执行文件路径，非空时覆盖 `channel`                                                                         |
| `outputDir`             | `''`                                                            | 产物输出根目录；空则默认当前工作目录（用户正在操作的文件夹，harness 会话 cwd）下 `reports/recorder` |
| `captureResponseBodies` | `true`                                                          | 是否抓取 xhr/fetch 响应体                                                                                                |
| `maxBodyBytes`          | `16384`                                                         | 单个请求体/响应体最大记录字节数，超出截断                                                                                |
| `recordConsole`         | `false`                                                         | 是否记录 console 消息                                                                                                    |
| `requestResourceTypes`  | `xhr,fetch`                                                     | 逗号分隔的 resourceType 白名单，只有命中的请求才录制（响应/失败事件随请求一并过滤）；默认只录接口调用，静态资源/文档不录 |
| `redactHeaders`         | `cookie,authorization,proxy-authorization,x-api-key,set-cookie` | 逗号分隔的脱敏请求头名（大小写不敏感），命中头值记为 `<redacted>`                                                        |

## 构建与验证

```sh
pnpm install       # 安装依赖(devDependencies 与 peerDependencies 对齐)
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest 单元测试(report 生成纯函数)
pnpm build         # tsdown 产物到 lib/(插件加载与 smoke 依赖产物)
pnpm smoke         # 真实 Edge 端到端冒烟(需本机已装浏览器, 产物在 reports/)
```

## 仓库收录清单(awesome-dsh-plugin)

本仓库已按 awesome-dsh-plugin/contributing 对齐:

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`(见仓库根 `cordis.patch.yml`, 其中 id 与插件内部注册名 `dsh-web-recorder` 一致)
- 官方 `@deepseek-ai/*` 包放在 `peerDependencies`: `dsh-tools` 的范围带显式预发布分支(harness 以 rc 版本发布, 无分支的宽范围会被 node-semver 静默排除), `cordis`/`schemastery` 同为 peer 由宿主提供
- 运行时默认产物输出到**当前工作目录（用户正在操作的文件夹）**下 `reports/recorder`，可用 `Config.outputDir` 显式指定
- 附带真实冒烟测试 `tests/smoke.mjs`, 非占位仓库

若提交 awesome-dsh-plugin 收录条目:

1. 在 GitHub 仓库 Settings → Topics 添加 `dsh-plugin`
2. 一句话描述与代码实际能力一致、不夸大(例如称"3 个工具"就必须真有 3 个)
3. 可选: 发布 npm(须保证 `repository` 指回本仓库, 并去掉 `private: true`); 可选在仓库根放 `screenshots.json`

## 已知限制

- 只录制插件自己启动的浏览器窗口，无法录制用户已有的其他浏览器实例。
- 请求头中的敏感头默认脱敏；请求体/响应体不做内容级脱敏（可能含 token 等业务数据），`events.jsonl` 应按敏感数据处理，不要外发。
- 跨域 iframe 的 UI 事件依赖 init script 注入，极少数强 CSP 页面可能注入失败（网络事件不受影响）。
- 点击接口请求后立即跳转页面时，浏览器会取消该响应体的抓取，此场景响应体可能缺失（事件仍在，只是无 body）。

# dsh-web-recorder

网页操作录制器插件：面向「用户手动操作浏览器，插件在后台录制」的场景。启动一个有头浏览器窗口（默认本机 Edge），用户在窗口里正常点网页，插件在后台记录每次点击 / 输入 / 表单提交和每个网络请求 / 响应 / 失败，停止后生成 Markdown 摘要报告。

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
| `outputDir`             | `''`                                                            | 产物输出根目录；空则默认仓库根 `reports/recorder`（reports/ 是仓库约定的运行产物目录，不入库）                           |
| `captureResponseBodies` | `true`                                                          | 是否抓取 xhr/fetch 响应体                                                                                                |
| `maxBodyBytes`          | `16384`                                                         | 单个请求体/响应体最大记录字节数，超出截断                                                                                |
| `recordConsole`         | `false`                                                         | 是否记录 console 消息                                                                                                    |
| `requestResourceTypes`  | `xhr,fetch`                                                     | 逗号分隔的 resourceType 白名单，只有命中的请求才录制（响应/失败事件随请求一并过滤）；默认只录接口调用，静态资源/文档不录 |
| `redactHeaders`         | `cookie,authorization,proxy-authorization,x-api-key,set-cookie` | 逗号分隔的脱敏请求头名（大小写不敏感），命中头值记为 `<redacted>`                                                        |

## 构建与部署

```sh
pnpm install        # 安装 playwright-core 依赖
pnpm build          # tsdown 产物到 lib/
pnpm run register   # 注册进本机 dsh profile(cordis.patch.yml)
```

注册后**需要重启 DSH 服务才生效**（cordis patch 层变化）。

## 已知限制

- 只录制插件自己启动的浏览器窗口，无法录制用户已有的其他浏览器实例。
- 请求头中的敏感头默认脱敏；请求体/响应体不做内容级脱敏（可能含 token 等业务数据），`events.jsonl` 应按敏感数据处理，不要外发。
- 跨域 iframe 的 UI 事件依赖 init script 注入，极少数强 CSP 页面可能注入失败（网络事件不受影响）。
- 点击接口请求后立即跳转页面时，浏览器会取消该响应体的抓取，此场景响应体可能缺失（事件仍在，只是无 body）。

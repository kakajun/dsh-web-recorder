# dsh-web-recorder

**Languages: English · [简体中文](README.md)**

A browser-operation recorder plugin for DSH. It targets the scenario where a human drives the browser while the plugin records in the background: a headed browser window is launched (the local Edge by default); as you interact with pages normally, the plugin records every click / input / form submission and every network request / response / failure, then generates a Markdown summary report when recording stops.

## Why this plugin exists (design intent)

To have an agent talk to a business platform (e.g., an EIP-style system) directly through its APIs, you first need to answer three questions: which endpoints the platform exposes, which endpoint each business step maps to, and what the request / response shapes look like. The traditional approach is to read API docs or reverse-engineer the frontend code — but docs are often missing or outdated, and even with an endpoint list in hand, it is hard to line up “what the user does on the page” with “which API calls fire underneath”.

This plugin takes a different angle: **no reverse engineering — just keep the operation evidence**. As a developer, you first arm the recorder (`recorder_start`), then let the target business flow run completely inside a monitored headed browser window — driven either by a human manually, or step by step by a browser-automation tool such as playwright MCP / browser-use — and that is it: no more digging through docs afterwards, because the raw data left behind by this one session already answers all three questions:

- **UI event timeline**: when each click / input / form submission happened, which element it hit, and what value was entered;
- **Network event timeline**: which `xhr` / `fetch` requests each step triggered — method, URL, request headers, request body, response body, and failure reasons.

Both kinds of events are written to `events.jsonl` in real time, interleaved by the order they occur, so the two timelines are naturally aligned: for any business step you can find in the raw data “which API it called, how the parameters were filled in, and what came back”. Once recording stops, the generated `report.md` turns that operation timeline plus the request details into an easy-to-read digest.

Feed those raw records to an LLM for analysis: it can generalize the full picture of “business flow × API call sequence × data contract” and distill it into a skill — breaking the flow into steps, noting which endpoint to call per step, what the request / response look like, and how to handle errors — so the agent can later follow the skill to drive the same flow purely through APIs, without ever depending on a human demo again.

In one sentence: **walking the flow through once on the page = leaving analyzable operation evidence = the raw material for an LLM to build an API-level skill**. Recording is only the capture; analysis and distillation are left to the model.

## Preview

The screenshots below are artifacts from a real recording session (the `tests/smoke.mjs` smoke test running “enter keyword → query → go to page 2” against a local page).

**① `report.md` summary** — stats overview + operation timeline + network request details, presenting “business steps” and “API calls” side by side:

![report.md summary](assets/screenshot-1.png)

**② `events.jsonl` raw event stream** — one event per line (navigation / click / input / request / response …), written in real time in occurrence order; the most complete evidence for analysis:

![events.jsonl raw event stream](assets/screenshot-2.png)

Reading the two side by side: a single “enter keyword and query” action shows up in `events.jsonl` as the matching `POST /api/query` request and `200` response events, and in `report.md` as one request-detail row — a direct illustration of the “walk the flow through once, keep the analyzable evidence” idea described above.

## Registered tools

| Tool                   | Description                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `recorder_start(url?)` | Starts recording: launches a headed browser, optionally navigating to the starting URL; events are written to `events.jsonl` in real time |
| `recorder_stop()`      | Stops recording: generates the `report.md` summary and closes the browser; idempotent     |
| `recorder_status()`    | Reports status: whether recording is active, per-type event counts, output directory, and the result of the last wrap-up |

If the user closes the browser window directly, the session is finalized automatically (`reason: browser-closed`) and the recorded data is kept.

## Usage: how this plugin gets invoked

### When it is picked up (trigger scenarios)

Once the plugin is enabled, its three tools show up in the DSH session's tool list; “hitting” the plugin happens when the model chooses a tool, based on the tool names and descriptions. When the user's task is about “figuring out which APIs a web business flow calls under the hood, what the parameters / responses look like, and producing an API-level flow description or skill from that”, the model should proactively call `recorder_*`. Typical task phrasings:

- “Figure out the API calls and their order behind the ‘xxx’ flow on platform XX, and turn it into a skill so I can do it purely via APIs from now on”
- “What request does the ‘Query’ button on page XX send? How are the parameters passed?”
- “I'll walk through the flow on the page; you record it, then analyze it and produce an API-integration guide”

If the question can be answered without real page interaction (e.g., it is already answered in docs), the plugin usually won't be picked up.

### How the tools become available (loading)

This repository is itself a DSH plugin: the entry is `lib/index.js` (source `src/index.ts`); `package.json`'s `dsh.bundle.patch` points to the `cordis.patch.yml` at the repo root, which merges the plugin into the host profile (its `id` / `name` are both `dsh-web-recorder`); the official `@deepseek-ai/*` packages are provided by the host via `peerDependencies`. Once enabled, the tools enter the model's tool list and are selectable with no further declaration.

### Division of responsibilities: this plugin only “records” — “opening pages / acting” is up to a driver

The plugin **does not operate pages itself** — it exposes only `recorder_start` / `recorder_stop` / `recorder_status`, and its job is to “watch and record”: it launches a monitored headed browser window and logs, as raw events, every UI operation and network request happening inside it. Actually “opening page XXXX and performing the steps” is done by a **browser driver**, which can be:

1. **A human**: clicking / typing / navigating manually in the window the plugin popped up;
2. **playwright MCP**: the model uses it to open pages, click, fill forms, and execute the target flow step by step;
3. **Other browser-use style tools**: likewise acting as the “hands” that drive the browser through the flow.

The model (agent) orchestrates the session: arm the recorder first, direct the driver to run the flow, then wrap up and read the artifacts.

### Recommended flow with playwright MCP / browser-use (open page X → record the steps)

1. **(Optional) driver opens the page first**: let playwright MCP open the target page; as long as the MCP browser was started with `--remote-debugging-port` (see “Collaboration prerequisite” below), `recorder_start` auto-discovers its CDP port and **attaches to that already-open window** — no new browser is launched
2. **Arm the recorder**: `recorder_start()` — attaches to the existing window, or pops up the monitored browser and opens the start page; from this moment every operation and network request in the window is streamed to `events.jsonl`
3. **Driver runs the flow**: let playwright MCP / browser-use (or a human) execute the whole target flow **inside the same monitored window** — opening pages, filling forms, clicking submit, going to the next page… both the UI events of each step and the API calls they trigger are captured
4. **(Optional) check progress**: `recorder_status()` — whether recording, per-type event counts, artifact directory
5. **Wrap up**: `recorder_stop()` — generates the `report.md` summary (in attach mode it only disconnects the CDP session and leaves the external browser running; plugin-launched windows are closed; closing the window manually also finalizes the session)
6. **Analyze and distill**: the model reads `report.md` + `events.jsonl`, generalizes “flow steps × API calls × request/response contract”, and further distills it into a skill or an API-integration guide

### Collaboration prerequisite (important)

- Recording covers **the browser window the plugin attached to / started** (including its new tabs / iframes); operations by any driver (human or automation) are only captured when they happen **inside this window**.
- **Sharing one browser window with playwright MCP**: start the MCP browser with a remote debugging port and the recorder attaches automatically. Pass a config file to `@playwright/mcp` (`--config=path/to/playwright-mcp.config.json`) containing:
  ```json
  {
    "browser": {
      "launchOptions": {
        "args": ["--remote-debugging-port=0"]
      }
    }
  }
  ```
  With port `0`, Chrome picks a free port and writes it to the `DevToolsActivePort` file under its user-data-dir; `recorder_start` reads that file and attaches automatically (on Windows the MCP browser is located via the `ms-playwright-mcp` user-data-dir in the process command line). Without a debugging port the recorder cannot attach and falls back to takeover mode: it reads the MCP browser's current page URL, closes it, and re-opens the same page in a plugin-launched window.
- You can also set `cdpUrl` explicitly in the plugin Config (e.g. `http://127.0.0.1:9222`) to choose the attach target; it takes precedence over auto-discovery. In attach mode `recorder_stop` only disconnects the CDP session and never closes the external browser process.

### Prerequisites and caveats

- A browser must be installed locally: Edge by default (`channel: msedge`); `chrome` or a custom `executablePath` are configurable. The plugin never downloads a browser
- At least one browser driver must be present: a human demo, or an automation tool such as playwright MCP / browser-use
- The headed window is visible during recording by design, and closes when done
- `events.jsonl` contains full request/response data (headers/bodies); treat it as sensitive and do not share it

## What gets recorded

- **UI events**: clicks (selector + element text + coordinates), input / select changes (name + value; password fields record the action only, never the value), form submissions, and page navigations. Captured via `context.exposeBinding` + `addInitScript` phase listeners; covers new tabs and iframes.
- **Network events**: by default only `xhr` / `fetch` API calls are recorded (`requestResourceTypes` is configurable) — per request: method / URL / resourceType / request headers / request body; plus response status and response body (truncated), and error reasons for failed requests. Console messages can optionally be recorded.
- **Artifacts**: each session writes `<outputDir>/rec-<timestamp>/events.jsonl` (full data, appended line by line in real time) and `report.md` (operation timeline + request detail table + failed-request summary).

## Config fields

| Field                    | Default                                                       | Description                                                                                                            |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `channel`                | `msedge`                                                      | playwright-core browser channel (`msedge` / `chrome`); uses a browser already installed locally, never downloads Chromium |
| `executablePath`         | `''`                                                          | Custom browser executable path; overrides `channel` when non-empty                                                     |
| `cdpUrl`                 | `''`                                                          | CDP endpoint (e.g. `http://127.0.0.1:9222`); when set, attach to that existing browser first. When empty, a Playwright MCP browser with a debugging port is auto-discovered and attached; otherwise falls back to takeover / launching a new window |
| `outputDir`              | `''`                                                          | Root directory for artifacts; when empty, defaults to `reports/recorder` under the current working directory (the folder the user is working in, i.e. the harness session cwd) |
| `captureResponseBodies`  | `true`                                                        | Whether to capture xhr / fetch response bodies                                                                          |
| `maxBodyBytes`           | `16384`                                                       | Maximum number of bytes recorded for a single request / response body; anything beyond is truncated                     |
| `recordConsole`          | `false`                                                       | Whether to record console messages                                                                                      |
| `requestResourceTypes`   | `xhr,fetch`                                                   | Comma-separated resourceType whitelist; only matching requests are recorded (response / failure events are filtered along with the request). By default only API calls are recorded, not static assets or documents |
| `redactHeaders`          | `cookie,authorization,proxy-authorization,x-api-key,set-cookie` | Comma-separated request header names to redact (case-insensitive); matching header values are recorded as `<redacted>`  |

## Build & verify

```sh
pnpm install       # install dependencies (devDependencies aligned with peerDependencies)
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest unit tests (pure functions for report generation)
pnpm build         # tsdown output to lib/ (required by plugin loading and the smoke test)
pnpm smoke         # real-Edge end-to-end smoke test (needs a browser installed locally; artifacts under reports/)
pnpm smoke:mcp     # MCP auto-discovery attach smoke test (simulates an MCP Chrome with a debugging port)
```

## awesome-dsh-plugin compliance checklist

This repository is aligned with the [awesome-dsh-plugin/contributing](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) guide:

- `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml` (see `cordis.patch.yml` at the repo root; its `id` matches the internally registered name `dsh-web-recorder`)
- Official `@deepseek-ai/*` packages live in `peerDependencies`: `dsh-tools` is pinned with an explicit prerelease branch (the harness ships rc releases; a wide range without a branch is silently excluded by node-semver), and `cordis` / `schemastery` are peers provided by the host
- By default artifacts go to `reports/recorder` under the **current working directory (the folder the user is working in)**, overridable via `Config.outputDir`
- Ships a real smoke test `tests/smoke.mjs` — not a placeholder repository

If you are submitting an entry to awesome-dsh-plugin:

1. Add the `dsh-plugin` topic in GitHub repository Settings → Topics
2. The one-line description must match the actual capabilities without exaggeration (e.g., claiming “3 tools” means 3 tools really exist)
3. Optional: publish to npm (make sure `repository` points back to this repo and remove `private: true`); optionally put a `screenshots.json` at the repo root

## Known limitations

- Records only the browser window the plugin attached to / started (including its new tabs / iframes); operations in any other browser instance are not captured. For automation-driven recording, the driver must share the same browser instance: when the MCP browser runs with `--remote-debugging-port` the recorder auto-attaches over CDP (see “Collaboration prerequisite”); an MCP browser without a debugging port can only be handled by the takeover fallback (close old window, open a new one).
- Sensitive request headers are redacted by default; request / response bodies get no content-level redaction (they may contain business data such as tokens), so treat `events.jsonl` as sensitive data and do not share it.
- UI events in cross-origin iframes rely on init-script injection; pages with very strict CSP may block the injection (network events are unaffected).
- When a click fires an API request and the page navigates away immediately, the browser cancels the response-body capture; the response body may then be missing for that request (the event itself is still recorded, just without a body).

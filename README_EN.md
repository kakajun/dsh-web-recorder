# dsh-web-recorder

**Languages: English · [简体中文](README.md)**

A browser-operation recorder plugin for DSH. It targets the scenario where a human drives the browser while the plugin records in the background: a headed browser window is launched (the local Edge by default); as you interact with pages normally, the plugin records every click / input / form submission and every network request / response / failure, then generates a Markdown summary report when recording stops.

## Why this plugin exists (design intent)

To have an agent talk to a business platform (e.g., an EIP-style system) directly through its APIs, you first need to answer three questions: which endpoints the platform exposes, which endpoint each business step maps to, and what the request / response shapes look like. The traditional approach is to read API docs or reverse-engineer the frontend code — but docs are often missing or outdated, and even with an endpoint list in hand, it is hard to line up “what the user does on the page” with “which API calls fire underneath”.

This plugin takes a different angle: **no reverse engineering — just keep the operation evidence**. As a developer, you walk the target business flow manually in a headed browser window, and that is it — no more digging through docs afterwards, because the raw data left behind by this one session already answers all three questions:

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

## What gets recorded

- **UI events**: clicks (selector + element text + coordinates), input / select changes (name + value; password fields record the action only, never the value), form submissions, and page navigations. Captured via `context.exposeBinding` + `addInitScript` phase listeners; covers new tabs and iframes.
- **Network events**: by default only `xhr` / `fetch` API calls are recorded (`requestResourceTypes` is configurable) — per request: method / URL / resourceType / request headers / request body; plus response status and response body (truncated), and error reasons for failed requests. Console messages can optionally be recorded.
- **Artifacts**: each session writes `<outputDir>/rec-<timestamp>/events.jsonl` (full data, appended line by line in real time) and `report.md` (operation timeline + request detail table + failed-request summary).

## Config fields

| Field                    | Default                                                       | Description                                                                                                            |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `channel`                | `msedge`                                                      | playwright-core browser channel (`msedge` / `chrome`); uses a browser already installed locally, never downloads Chromium |
| `executablePath`         | `''`                                                          | Custom browser executable path; overrides `channel` when non-empty                                                     |
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

- Records only browser windows started by the plugin itself; it cannot record other browser instances you may already have open.
- Sensitive request headers are redacted by default; request / response bodies get no content-level redaction (they may contain business data such as tokens), so treat `events.jsonl` as sensitive data and do not share it.
- UI events in cross-origin iframes rely on init-script injection; pages with very strict CSP may block the injection (network events are unaffected).
- When a click fires an API request and the page navigates away immediately, the browser cancels the response-body capture; the response body may then be missing for that request (the event itself is still recorded, just without a body).

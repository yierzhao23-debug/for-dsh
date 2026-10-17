# dsh-context-alert

> **Context pressure alerts for DeepSeek Harness (DSH).** Watches the official `contextPressure` projection and, **at the end of a turn**, proactively tells you when it is time to start a fresh session. Also renders a pressure banner above the composer.

**English** | [中文](README.md)

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-Windows-0078d4.svg)
![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-4b6bfb.svg)
![tests](https://img.shields.io/badge/tests-75%20passing-brightgreen.svg)

---

## Requirements

| Item | Requirement |
| --- | --- |
| OS | **Windows only** — the notification backend is PowerShell (`NotifyIcon` balloon + SAPI speech) |
| DSH | `0.2.0-rc.2` (declared in `dsh.compatibility.dshReleases`) |
| Node | `>= 22.5` |
| Peer plugin | **Requires `dsh-token-meter`**, which registers the `contextPressure` projection. Without it the plugin still loads and says so explicitly instead of crashing |

---

## 1. Why this exists

| Fact | Source |
| --- | --- |
| **The official `ContextMeter` already shows occupancy**: a ring plus a percentage below the composer, click to open the `contextBreakdown` panel (system / tools / conversation). It renders inside the input bar's dock, **immediately below this plugin's banner**. | `ContextMeter` in `@deepseek-ai/dsh-client-ui-conversation` (source comment: `Composer context-occupancy meter: a ring and percentage below the card fed by the contextPressure projection`) |
| **But it only answers "how much, right now"**: its source contains no `compact` / `shadow` / `loss` / `notify` / threshold logic — no compaction count, no loss rate, no alerting of any kind. | ibid. (its source region checked item by item) |
| **DSH does not warn you about context pressure.** It silently auto-compacts once a threshold is hit. | `@deepseek-ai/dsh-compaction-basic` defaults: `thresholdRatio: 0.8`, `retainRatio: 0.16`, `headroomTokens: 65536` |
| Compaction is **lossy**: old content is folded into a summary and the detail is gone. | ibid. |
| **`dsh-context` does not alert you.** It is a visualization plugin (insights page, context tab, `/context` command, right-hand Context panel). The only `REMINDER` in its source is a `REMINDER_PREFIX` regex constant unrelated to alerting users; its preferences are all display-only. | `node_modules/dsh-context/lib/index.js` |

In other words: **by default, your context gets compacted without warning.** This plugin fills that gap.

### 1.1 Division of labour with the official `ContextMeter` (why the banner shows no percentage)

| Reading | Owner | Location |
| --- | --- | --- |
| Occupancy (percentage), token usage, context composition | **Official `ContextMeter`** | The ring in the input bar's dock; click to expand the panel |
| How many compactions, how much was shadowed, the information-loss rate | **This plugin's banner** | **Above** the composer (`conversation.input.dock`) |
| Proactive alerts at end of turn (desktop / speech) | **This plugin** | End of turn, independent of any UI |

The two sit directly on top of each other — the official ring lives in the `InputBar`'s dock, and `conversation.input.dock` renders immediately above the input bar — so **the banner's idle row deliberately does not repeat the percentage or the token usage**. Printing the same number twice, side by side, only makes you wonder which one is right. Only once `warnPct` is crossed, and the percentage has become part of the "time to switch sessions" judgement, does the banner bring it up next to the title.

---

## 2. Signal source: the official projection, not a guess

Occupancy is read from the `contextPressure` projection registered by `dsh-token-meter`. It is **not recomputed, not estimated, and never invented**.

On the host side, `ctx.sessionProjections.stateOf(session, 'contextPressure')` returns the internal state:

```
{ contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }
```

The official occupancy formula (`wire.view` in `dsh-token-meter/lib/types/usage-projection.js`):

```
projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
occupancy       = projectedTokens / contextWindow
```

**Why the delta instead of `pressureTokens` directly:** `pressureTokens` is the latest prompt size reported by the provider, while `sampledSurfaceTokens` was the surface size at the moment of that sample. The difference is what has grown *since* sampling. Using `pressureTokens` alone noticeably under-reports after a compaction.

On the client side `useProjection('contextPressure')` already yields the computed wire view (including `projectedTokens`), so the client **reads it directly** and does not re-implement the formula.

Every field is optional: when the window or usage is unavailable the answer is `null` — **better to say nothing than to invent a percentage**.

---

## 3. When it fires, and why it is not annoying

Alerts are hooked to **end of turn** (`agent/turn-stopping`) — the moment you are deciding what to send next, which is when an alert is actually actionable. Work in progress is never interrupted.

| Mechanism | Default | Purpose |
| --- | --- | --- |
| `warnPct` | 65% | Start alerting above this |
| `criticalPct` | 82% | Sits on the auto-compaction line (0.8); wording escalates to "switch now" |
| `rearmPct` | 45% | Only re-arm below this, so it does not nag around the threshold |
| `cooldownMs` | 10 min | Minimum gap between same-level alerts in one session |
| `maxAlertsPerSession` | 3 | Hard per-session cap |
| Critical bypasses cooldown | built in | If you ignored a warning and two minutes later you are on the compaction line, making you wait another 8 minutes is wrong |
| User-driven sessions only | built in | Only sessions where **you** sent a message are alerted; subagents and background sessions are left alone |
| Re-arm after compaction | built in | Compaction pushes occupancy back down, which automatically restores the alert budget |

---

## 4. Two surfaces

| Surface | Location | Notes |
| --- | --- | --- |
| **Pressure banner** | Above the composer (`conversation.input.dock`) | Idle: a single small line, `已压缩 2 次　·　信息丢失率 52.2%` (occupancy and token usage belong to the official ring just below — **not repeated**). Above `warnPct` it expands into multiple lines whose headline is "the Nth auto-compaction of this conversation is about to start", followed by percentage, token usage and the last shadowed amount; turns red when critical |
| **Settings section** | Settings → Plugins → Context alert (`settings.section`) | Thresholds, cooldown, cap, notification mode, plus a "send a test alert" button |

Both surfaces use only `--dsw-alias-*` theme tokens (`state-warn-primary`, `state-error-primary`, `bg-layer-2`, `label-*`), so light and dark themes follow automatically. No hard-coded colors (except the icon, which is an art asset).

---

## 5. Commands

```
/ctxalert                       # occupancy of every session, thresholds, pending state
/ctxalert on | off              # enable / disable
/ctxalert test [warn|critical]  # fire a test alert immediately
/ctxalert warn=65 critical=82 rearm=45 cooldown=10 max=3
```

---

## 6. Installation

### 6.1 Get the plugin directory

```powershell
git clone https://github.com/yierzhao23-debug/for-dsh.git
# the plugin lives in for-dsh\plugins\dsh-context-alert
```

Or use **Code → Download ZIP** on the repository page and take just the `plugins\dsh-context-alert` directory.

### 6.2 Recommended: the built-in Plugin Manager

If your profile enables `@deepseek-ai/dsh-plugin-manager`, use `plugin_manager`'s `install_bundle` with the plugin directory's **absolute path** as the target. This is the officially recommended route; it registers the dependency and selects the bundle for you.

### 6.3 Manual installation (equivalent, needs your approval)

1. Put the plugin directory at `%USERPROFILE%\.dsh\plugins\dsh-context-alert`
2. Create a junction (no administrator rights needed):

   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-context-alert" "%USERPROFILE%\.dsh\plugins\dsh-context-alert"
   ```

3. Edit `%USERPROFILE%\.dsh\profiles\<profile>\package.json`:
   - add `"dsh-context-alert": "link:../../plugins/dsh-context-alert"` to `dependencies`
   - add `"dsh-context-alert"` to `dsh.profile.bundles`
4. **Restart DSH** — the bundle list is read at startup and changes do not take effect while running.

> The official guide explicitly discourages manual installation (it considers such writes the job of `install_bundle`). It is documented here because some profiles do not enable the Plugin Manager.

### 6.4 Verify the installation

```
node verify-install.mjs
```

A read-only check of 13 items: whether the profile manifest registers the plugin, whether the `node_modules` mount point exists, whether it resolves by name, whether the host entry and `./client` export are in place, whether the patch inserts the right lines, whether the client `inject` covers the slot hosts it registers with, whether the module id registered by the client bundle equals the package name, and whether `alert.ps1` is pure ASCII. **Run it before restarting DSH** — it catches "the plugin was never loaded at all". Worth re-running after a DSH upgrade or after moving the plugin.

> The script deliberately uses the profile directory, not its own location, as the require base. The script lives inside the plugin package, and the package declares a `"./package.json"` export, so Node's self-reference would resolve to the copy of the source sitting next to the script — silently running the whole check against a workspace copy. That trap was hit for real.

---

## 7. Configuration

Runtime configuration lives in `%USERPROFILE%\.dsh\context-alert\config.json` (written by the settings panel and `/ctxalert`; it is the single source of truth).

| Environment variable | Effect |
| --- | --- |
| `DSH_CTX_ALERT_HOME` | Override the config directory (default `~/.dsh/context-alert`) |
| `DSH_CTX_ALERT_DRYRUN=1` | Dry-run: log only, never pop up. For self-checks and tests |
| `DSH_CTX_ALERT_SOUND` | Sound name, default `explode` (used by `sound` / `both` modes; drop the file in `~/.dsh/context-alert/sounds/`) |

---

## 8. Notification backend (`alert.ps1`)

A dependency-free PowerShell script. The payload travels as a base64 (UTF-8 JSON) environment variable, `DSH_CTX_ALERT_PAYLOAD`, so that non-ASCII text is not mangled by command-line quoting or code pages.

| Mode | Behavior |
| --- | --- |
| `toast` | `NotifyIcon` balloon (10 s) |
| `speak` | Offline SAPI synthesis, preferring a `zh*` voice; falls back to the COM `SAPI.SpVoice` interface if `System.Speech` fails |
| `sound` | Uses `~/.dsh/context-alert/sounds/<name>.wav` when present (root overridable via `DSH_CTX_ALERT_HOME`), otherwise the system sound |
| `both` | Speech + desktop |
| `probe` | Reports only the number of audio output devices; used for the startup self-check |

The script first calls `waveOutGetNumDevs()`. **With no output device it never attempts SAPI** (SAPI would otherwise throw a deeply misleading "no voice installed, or no voice available for the current security settings"); instead it states plainly that there is no audio device and alerts will appear as desktop balloons.

The script reads **its own** directory only: drop `<name>.wav` into `~/.dsh/context-alert/sounds/` to customise the sound (the default name is `explode`, overridable via `DSH_CTX_ALERT_SOUND`). It **never reads another plugin's files** — so nothing else has to be installed first, and moving or uninstalling another plugin cannot affect this one.

The script itself is **pure ASCII**: Windows PowerShell 5.1 decodes a BOM-less `.ps1` using the system ANSI code page, so non-ASCII source text would be garbled. All user-facing text arrives through the base64 payload.

---

## 9. Relationship to existing plugins

The **notification delivery** part of this plugin follows the proven approach of [`dsh-plugin-notify`](https://github.com/huguangyu666/dsh-plugin-notify) (by huguangyu666, MIT) — in particular the "Node spawns PowerShell, payload passed as base64" channel. Credit to the original author.

The two have different jobs. `dsh-plugin-notify` answers "**how does a message reach your eyes**" (desktop toast / speech / sound, covering turn end, approvals and questions). This plugin answers "**given that context is filling up, when should that be said, how often, and how do we avoid being annoying**" (reads the `contextPressure` projection + a threshold hysteresis state machine + end-of-turn triggering).

There is **no runtime coupling** between them: this plugin's source imports nothing from `dsh-plugin-notify`, and its sound file now lives in its own directory (`~/.dsh/context-alert/sounds/`) rather than that plugin's. Uninstalling `dsh-plugin-notify` cannot affect this one.

The closest neighbour is actually official rather than third-party: the **`ContextMeter`** shipped in `@deepseek-ai/dsh-client-ui-conversation`, which renders a context-occupancy ring in the input bar's dock, directly below this plugin's banner. It answers "how much context is in use right now"; this plugin deliberately does **not** repeat that reading and answers the questions the ring cannot — how many compactions have happened, how much was shadowed, what the information-loss rate is, and whether it is time to switch sessions. See §1.1.

> If you know of another plugin that proactively alerts on context pressure, please open an issue and this section will be updated.

---

## 10. Verification status (stated honestly)

**Verified**

- `watch.js` pure logic: occupancy formula, hysteresis, cooldown, escalation bypassing cooldown, per-session cap, re-arm after compaction, and never inventing a number from missing fields.
- `index.js` host half: runs the real `apply()` against a fake ctx, covering hook registration, pressure feeding, `userDriven` filtering, end-of-turn triggering, `session/disposed` cleanup, every command branch, the three HTTP routes, and graceful degradation when `sessionProjections` is absent.
- Full suite: **75 passed, 0 failed** (Node 24.21.0, `node run-tests.mjs`).
- `alert.ps1`: `toast` (the balloon really appears), `probe`, and a clean error exit on a missing payload, all exercised on the author's machine.
- Every JS file passes `node --check`; the three JSON files validate; `alert.ps1` passes the pure-ASCII check.

**Not verified**

- **The visual result of the client half.** The development session had no usable browser control, and the official verification guide explicitly forbids substituting simulated React/DOM for real-machine verification. The banner and settings panel are therefore only verified down to "syntax + manifest + slot registration" — **you should confirm the rendering yourself after restarting**.
- **The real Node-subprocess → PowerShell link.** The development sandbox does not allow Node to spawn subprocesses with piped stdio (EPERM), so `runScript()` ran in dry-run mode. The spawn form is identical to the one already in use in `dsh-plugin-notify`, but strictly speaking only a real machine closes this loop.
- **Audio output on the author's machine**: `waveOutGetNumDevs() = 0`, and all 13 output endpoints in the registry report `DeviceState=4` (NOTPRESENT). **Speech and sound do not play on that machine**; alerts appear as desktop balloons. Plugging in headphones or speakers and restarting DSH restores them (the startup log carries a self-check line).

**Known deviations from the official guide**

- The Client locale service is not used; UI strings are written directly in Chinese. Rationale: this is a single-user Chinese environment, and wiring the locale service would require validating an API the author was not confident about, while a throwing slot component empties the entire slot entry.
- Adjustable settings are carried by `config.json` + `settings.section` rather than `export const Config` (schemastery). Same rationale: `dsh-plugin-notify`'s source comments record that dsh 0.2.0-rc.2 removed `ctx.settings.register`, leaving configuration to `config.json` plus a client settings section — which is what this implementation does.

---

## 11. Layout

```
index.js              host half: hooks, notifications, HTTP routes, /ctxalert
watch.js              pure logic: occupancy formula + threshold hysteresis state machine (unit-testable without DSH)
client.js             client half: pressure banner + settings panel (hand-written ModuleLoader bundle)
alert.ps1             notification backend (pure ASCII, no dependencies)
cordis.patch.yml      bundle patch
package.json          manifest (dsh.bundle.patch + dsh.client)
locale/{zh,en}.json   Plugin Manager card copy
icon.svg              icon
test/                 unit and integration tests
run-tests.mjs         same-process test entry point
verify-install.mjs    installation check (read-only, 13 items)
```

```bash
node run-tests.mjs      # run the tests
node verify-install.mjs # verify the installation
```

> `node --test` spawns a subprocess per file and collects output over pipes, which trips EPERM in a restricted sandbox; importing in-process is equivalent and unaffected.

---

## 12. Design notes

- **Alerts live on the host, not the client.** `useProjection` only exists while a given session tab is mounted, so a tab-based plugin cannot alert reliably — switch tabs and the alert is gone. The host-side `stateOf()` does not depend on any UI.
- **Subscribes to `session/event` rather than `sessionProjections.onChanged()`.** The listener argument shape of `onChanged` is not pinned down in the API directory, whereas the `session/event` signature is explicit. The current approach reads the projection in O(1) and **never re-scans `session.events`**, matching the official requirement not to keep log-derived state outside a projection. Should `onChanged`'s shape be confirmed later, switching to it would reduce wake-ups further.
- **Registered on `conversation.input.dock`, not `conversation.composer.dock`.** The former is proven to inject `useProjection` into its components by two built-in examples (`QueueDock` / `TodoDock`); the latter is unverified. Choosing a verified slot beats choosing the one that looks more appropriate.
- **No volume boosting for sounds.** That would need an extra dependency such as `pycaw`; the payoff does not justify the complexity.

---

## License

[MIT](LICENSE) © 2026 yierzhao23-debug

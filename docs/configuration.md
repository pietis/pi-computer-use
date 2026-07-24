# Configuration

Configuration controls browser access, strict accessibility execution, and the macOS agent cursor.

## Files

Global config:

```text
~/.pi/agent/extensions/pi-computer-use.json
```

Project config:

```text
.pi/computer-use.json
```

Project config overrides global config. Environment variables override both.

Example:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "observation_mode": "fused",
  "exception_handler": false,
  "exception_handler_confidence": 0.85,
  "headless": false,
  "cursor_overlay": true
}
```

Run `/computer-use` in Pi to show the active config and its source.

## Options

### `browser_use`

Default: `true`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `managed_browser`

Default: `"chrome"`

Selects `"helium"` or `"chrome"` for `launch_browser`. The debugging port is always allocated internally and isn't part of the model-facing contract.

### `observation_mode`

Default: `"fused"`

Controls the default desktop observation and the successor observation created
after every `act_ui` call:

- `"semantic"` uses the Accessibility tree without image capture or OCR.
- `"fused"` keeps the current balanced behavior: Accessibility plus image
  evidence, with OCR escalation when needed.
- `"visual"` always captures an image and runs OCR.

An explicit `observe_ui.mode` overrides this setting for that initial
observation. Successor observations continue to use this configured mode.
Semantic successor states have no image coordinates; call
`observe_ui({ mode: "fused" })` or `observe_ui({ mode: "visual" })` before a
later coordinate action.

For a one-session capture-free experiment without editing a config file:

```bash
PI_COMPUTER_USE_OBSERVATION_MODE=semantic pi
```

Run `/computer-use` inside Pi and confirm `observation_mode: semantic`. Compare
the same workflow against `PI_COMPUTER_USE_OBSERVATION_MODE=fused pi`. Keep the
model, thinking level, prompt, open apps, and window state the same so the
comparison primarily measures observation cost.

### `exception_handler`

Default: `false`

When enabled, a conclusively failed desktop `act_ui` transaction invokes one
small exception-handler model call with thinking disabled. The handler sees the
failed actions and the bounded successor AX outline. It can either escalate to
the main agent or return one guarded recovery containing at most three semantic
`press`, ref-based `click`, or `setText` actions.

Automatic recovery has deliberately narrow limits:

- an observable `expect` postcondition is required
- every action ref must exist in the successor AX outline
- coordinates, drag, raw key input, and unguarded actions are rejected
- `setText` may only reuse text already present in the failed transaction
- only one automatic recovery attempt is made
- ambiguous actions with an `unknown` outcome are never replayed

This keeps the normal path at one planning call plus native batch execution.
Known native fallback remains first; the lightweight model is called only after
the native transaction has conclusively produced `didnt`.

### `exception_handler_model`

Default: the current Pi model

Set this to a configured `provider/model-id` to use a smaller, faster model for
exception handling. The model must already be available through Pi's model
registry and authentication. The call requests thinking `off` independently of
the main session's thinking level.

### `exception_handler_confidence`

Default: `0.85`

Minimum confidence from `0` to `1` required before a model-proposed recovery can
execute. Lower-confidence decisions are converted to escalation without
performing an action.

### `headless`

Default: `false`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, and the agent cursor overlay are blocked. When `false` (the default), Pi prefers verified semantic activation when it is credible, preserves the focus established by editable clicks for dependent keyboard input, and may retry keyboard input in the foreground when a background attempt conclusively produced no value change. Ambiguous pointer actions are never replayed blindly.

### `cursor_overlay`

Default: `true`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point during non-headless background delivery. Foreground actions that control the physical cursor don't display the overlay. The overlay doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting.

## Environment variables

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_MANAGED_BROWSER=helium
PI_COMPUTER_USE_MANAGED_BROWSER=chrome
PI_COMPUTER_USE_OBSERVATION_MODE=semantic
PI_COMPUTER_USE_OBSERVATION_MODE=fused
PI_COMPUTER_USE_OBSERVATION_MODE=visual
PI_COMPUTER_USE_EXCEPTION_HANDLER=0
PI_COMPUTER_USE_EXCEPTION_HANDLER=1
PI_COMPUTER_USE_EXCEPTION_HANDLER_MODEL=provider/model-id
PI_COMPUTER_USE_EXCEPTION_HANDLER_CONFIDENCE=0.85
PI_COMPUTER_USE_HEADLESS=0
PI_COMPUTER_USE_HEADLESS=1
PI_COMPUTER_USE_CURSOR_OVERLAY=0
PI_COMPUTER_USE_CURSOR_OVERLAY=1
PI_COMPUTER_USE_DELIVERY_POLICY=default
PI_COMPUTER_USE_DELIVERY_POLICY=foreground
PI_COMPUTER_USE_CDP_PORT=9222
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback. `PI_COMPUTER_USE_DELIVERY_POLICY` is a debugging input; normal policy belongs in configuration rather than individual model calls.

For a capture-free session with the lightweight exception handler:

```bash
PI_COMPUTER_USE_OBSERVATION_MODE=semantic \
PI_COMPUTER_USE_EXCEPTION_HANDLER=1 \
pi --thinking off
```

The `--thinking off` flag controls the main planning call. Exception-handler
calls request thinking off regardless of this flag.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

When CDP is active, discovered pages participate in the same root and state system as desktop UI. `launch_browser` configures CDP automatically and returns an observed page state. `navigate_browser` and `evaluate_browser` accept only CDP browser-page states; native browser windows continue to use the normal desktop observe/act tools.

With the variable unset, CDP is inactive.

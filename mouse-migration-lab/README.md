# Mouse Migration Lab

Mouse Migration Lab is a local-first Vite/React application with an optional
Tauri 2 desktop shell. Windows desktop runs prefer a native, batched `WM_INPUT`
backend; web and macOS use browser Pointer Lock.

## Version and run data

- Application/package/Tauri version: `0.4.0`
- Public run schema: `schema: 2`
- Schema-2 runs written by the previous `0.1.0`, `0.2.0`, and `0.3.0` builds
  are accepted and normalized to `appVersion: 0.4.0` on import. Measurement arrays and
  metrics are not rewritten.

## Device measurement boundary

- Device profiles keep the DPI and polling rate configured by the user, as aim
  trainers do; neither value is silently replaced by browser observations.
- A five-second Pointer Lock / `WM_INPUT` capture records the backend, raw-input
  status, movement sample count, device count, median/p95 event interval, and
  observed event rate. Browser event coalescing means this is not claimed as the
  mouse's configured polling rate.
- DPI calibration requires the user to move a known physical distance. An
  estimate is produced only when the backend confirms unadjusted relative
  counts, and applying it to the configured profile is a separate action.
- The latest measurement is stored locally with its source and timestamp and is
  copied into each run snapshot. Generic mouse identity and configured DPI are
  intentionally not queried through WebHID because browsers protect standard
  mouse collections and vendor protocols are not portable.

Reference behavior: [Aimlabs keeps CPI/DPI and sensitivity as explicit user
configuration](https://aimlabs.com/articles/aimlabs/how-to-configure-and-convert-your-sensitivity-in-aimlabs/),
[Roblox exposes relative mouse delta and sensitivity rather than hardware
DPI](https://create.roblox.com/docs/reference/engine/classes/UserInputService/GetLastInputType),
[Windows Raw Input exposes device metadata and sample-rate information where the
device supports it](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rid_device_info_mouse),
and [Pointer Events allows browser event delivery to be coalesced and
implementation-specific](https://www.w3.org/TR/pointerevents/).

## Windows build

The repository workflow at
`../.github/workflows/mouse-migration-lab-windows.yml` pins Node 22, Rust
1.88.0, `actions/checkout@v7.0.1`, `actions/setup-node@v7.0.0`, and
`tauri-apps/tauri-action@action-v1.0.0`.

- Push builds produce an NSIS installer only.
- A manual `workflow_dispatch` can opt into the additional MSI installer with
  the `include_msi` input.
- Workflow downloads are temporary GitHub Actions artifacts subject to the
  repository's artifact-retention policy; they are not a permanent release
  channel.
- Installers are currently unsigned. Certificate-backed Windows signing and
  formal tag releases remain follow-up work; no signature should be inferred
  from a successful build artifact.

The workflow runs format checking, tests, lint, and TypeScript checking before
the Tauri bundler performs the Vite production build.

## Windows input boundary

- `RegisterRawInputDevices` and `WM_INPUT` provide unaccelerated relative
  counts while the training session is active.
- Pointer Lock still owns cursor capture and ESC; DOM mouse events are not
  consumed by the native session, avoiding double counting.
- Native start/stop runs on the Windows UI thread, preserves WebView2 legacy
  messages, and restores Tao's prior process-wide Raw Input registration.
- Packets are drained from a bounded Rust queue in batches. Exported run
  metadata includes the backend and dropped-event count.
- Multiple physical mouse handles are currently aggregated. Real-device
  validation on Windows is required before treating this as a calibrated HID
  identity layer.

## Timing semantics

New runs carry `timingModel: dual-v2`. Each click has an attempt anchor:
multi-target rounds use round start then the previous click, while refreshed
single-target protocols use spawn/refresh (hold uses the latest reveal cue).
`reactionTime` is anchor to effective movement onset, `movementTime` is onset to
hit, and `completionTime` is anchor to hit. Onset is derived from recorded
input with a deadband and bounded idle-gap backtracking; no reliable onset is
reported as unavailable. `exposureAge` is diagnostic only. Reflex remains
spawn-to-hit. Legacy and obsolete `dual-v1` runs are not compared with v2.

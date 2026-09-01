# Mouse Migration Lab MVP

## Goal

Deliver a polished, local-first mouse migration instrument that is enjoyable to
use before it attempts to recommend a sensitivity. The MVP must preserve raw FPS
camera feel, provide repeatable test protocols, retain enough evidence to compare
two mice, and prove that the UI does not disturb the render/input hot path.

The product is not a clone of MsLab or Aimlabs. It recreates the relevant
interaction contracts and builds a distinct, device-migration-focused workflow.

## Primary user flow

1. Create or select a mouse profile.
2. Confirm game, DPI, polling rate, FOV, sensitivity, and test duration.
3. Pick one of seven protocols from visual task cards.
4. Enter a distraction-free, nearly full-screen Pointer Lock training state.
5. Finish the run and inspect performance, accuracy, angular error, acquisition,
   path efficiency, and input/frame health.
6. Save the run locally, replay it, export it, or compare it with a run from a
   second mouse.

## Experience states

| State | Required experience | Performance rule |
| --- | --- | --- |
| Prepare | Large live arena preview, protocol cards, compact calibration dock, recent device profiles | No decorative animation that continuously invalidates the canvas |
| Train | Arena owns almost the entire viewport; only timer, protocol, capture state, and optional minimal score remain | React updates at most 2 Hz; mouse events never set React state |
| Results | Clear summary, run health, trajectory/scatter visualization, device context, replay/export and A/B comparison | Charts render only after the run, never over the active hot path |

## Visual direction

The visual system is a Y2K pixel-game poster wrapped around a precise mouse
instrument. It should feel playful before the run and disciplined during it,
not like a generic admin dashboard or a neon esports template.

- Warm paper and soft-grey surfaces, candy pink signals, plum pixel outlines,
  violet secondary data, and hot-pink targets.
- A bright procedural calibration chamber: seamless floor and target wall,
  distance fade, subtle atmosphere, no visible geometry boundary.
- Poster-like hierarchy with a pixel display face for English HUD labels,
  compact readable Chinese copy, hard borders, and offset shadows.
- Protocol cards use small live or representative arena previews rather than
  decorative stock art.
- Prepare may use a PLAYER / HIGH SCORE / LIVES game-start composition, while
  Train removes decorative chrome and preserves only functional HUD elements.
- Motion is short and functional: state transitions, target spawn/hit feedback,
  and results reveal. No blur, parallax, or looping animation during training.
- Responsive desktop-first layout; at narrow widths the configuration and
  evidence panels stack, while the training canvas remains usable.

## Renderer and input contract

These requirements are non-negotiable because they define the feel of the tool.

- WebGL2 hot path with reusable typed buffers and no per-frame React render.
- True perspective projection with horizontal FOV converted by canvas aspect.
- Three.js-equivalent camera Euler order `YXZ`.
- Valorant scale: `degreesPerCount = sensitivity * 0.07`.
- `movementX` rotates yaw with the same sign convention as MsLab; `movementY`
  rotates pitch; no smoothing, interpolation, acceleration, or CSS transform.
- Pitch is clamped to approximately `[-67.6°, 67.6°]`; yaw wraps without a
  visible boundary.
- Pointer Lock requests `unadjustedMovement` and falls back cleanly when the
  browser does not support it.
- Targets and arena geometry share fixed world coordinates. Camera motion must
  never mutate target positions.
- Hit tests use spherical angular distance, not independent 2D yaw/pitch error.
- Arena grid is procedural or sufficiently tiled and distance-faded so no edge
  can enter the camera frustum during normal play.
- Training overlays must not intercept pointer input.

## Test protocols

| Protocol | MVP behavior | Primary evidence |
| --- | --- | --- |
| Four target | Four medium fixed targets; hit target respawns in the calibrated wall region | First-shot accuracy, acquisition, path efficiency |
| Character tracking | One readable humanoid/capsule target with lateral strafe and bounded jump behavior; hold fire to track | Crosshair coverage, reacquisition, direction-change loss |
| Three target | Three small distant targets distributed across a wide field | Wide transfer error and speed |
| Single chain | One small target; immediate deterministic respawn after a hit | Throughput, miss rate, angular error |
| Reflex single | Randomized appearance delay; premature shot is recorded; deterministic from seed | Reaction time and first-shot error |
| Micro adjust | Small targets close to center with low angular separation | Fine correction error and overshoot |
| Angle hold | Target peeks from a real occluder at varied side/distance; hit changes the next pattern | Hold stability and reaction after reveal |

Every protocol must be deterministic for the same seed and configuration. A
protocol may have a distinct arena treatment, but it must use the same camera and
input contract.

## Device profiles and session data

Device profiles are local browser data and contain:

- profile id and display name;
- mouse name/label;
- nominal DPI and polling rate;
- grip note (optional short text);
- game profile, sensitivity, and horizontal FOV;
- computed nominal cm/360 as context, not ground truth.

Run records retain:

- schema/app version and timestamps;
- device profile snapshot and protocol configuration;
- ordered target lifecycle records;
- raw movement events, derived yaw/pitch, clicks and frame timing;
- computed metrics and health flags.

Keep the most recent 20 sessions locally. Import/export must validate the public
schema and reject malformed or inconsistent timelines. Reopening a saved run must
replay the same visible target/camera history.

## Results and comparison

The MVP does not automatically prescribe a new sensitivity. It provides a
scientific comparison surface:

- headline: accuracy/coverage, acquisition or reaction, median angular error,
  and path efficiency;
- health: FPS, p50/p95/p99 frame time, severe-frame ratio, input event rate,
  and long tasks;
- spatial evidence: click-error scatter or tracking error over time;
- movement evidence: angular path over time and overshoot/reversal markers when
  available;
- A/B comparison: select two compatible runs and show absolute values and
  percentage deltas with device/profile labels;
- a run is marked non-comparable when protocol, duration, FOV, or seed contract
  is incompatible.
- Evidence assessment separates hard-invalid runs from readable runs with
  warnings. It checks completion, click and successful-hit sample counts or tracking effective
  milliseconds, movement events, severe-frame ratio, and long tasks using
  exported thresholds; it never presents these gates as statistical
  confidence.
- Compatible A/B runs receive a deterministic metric-level verdict. Accuracy
  is treated as higher-is-better, while angular error, acquisition time, and
  path multiplier are lower-is-better. Changes below the exported practical
  thresholds are neutral. Only two minimum-quality runs with genuinely
  different sensitivities and an unambiguous better/worse result receive the
  conservative copy “当前证据更支持已测试的 X sensitivity”; the MVP does not
  claim an optimum.

## Performance acceptance

Validate in a production build in real Chrome with Pointer Lock.

- Renderer follows the display refresh cadence on the test machine.
- At 120 Hz baseline, p50 should remain near one refresh interval and p95 should
  not exceed 1.5x p50 during a representative 30 second run.
- Severe-frame ratio (frames over 2x median) is below 1%.
- Zero long tasks during the active 30 second run.
- Input events are captured without React state updates and the recorded rate is
  reported rather than assumed.
- Switching protocol, entering/exiting Pointer Lock, completing a run, replay,
  import, and export produce no uncaught console errors.

Measured performance is reported with browser, display refresh rate, protocol,
duration, and run conditions. A synthetic automation rate is never presented as
the mouse's hardware polling rate.

## Validation

- Pure unit tests cover sensitivity conversion, yaw wrapping, spherical hit
  distance, YXZ projection, seeded target generation, metric summaries, schema
  rejection, comparison compatibility and deltas, evidence-quality boundaries,
  metric directions, and conservative A/B verdicts.
- Runtime-facing tests exercise real public functions and browser-visible state;
  do not assert only on hard-coded logs or fixtures.
- Run `npm run format -- --check`, `npm test`, `npm run lint`, and
  `npm run build` before handoff.
- Perform visual QA for Prepare, Train, and Results at desktop and one narrow
  viewport.
- Perform a real Chrome Pointer Lock run for at least one click protocol and one
  tracking protocol.

## Non-goals for this MVP

- Automatic sensitivity recommendation or adaptive optimization algorithm.
- User accounts, cloud sync, leaderboards, social features, or deployment.
- Copying MsLab private scoring, branded assets, source, or exact visual design.
- A general-purpose scenario editor or community task marketplace.
- Native raw-HID access outside the browser Pointer Lock contract.

## Delivery gate

The MVP is done only when all seven protocols are playable, the three experience
states are coherent, device/run history and comparison work through public UI,
the arena has no visible grid boundary, replay/export remain valid, automated
validation passes, and the real-browser performance contract is measured.

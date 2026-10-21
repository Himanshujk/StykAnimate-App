# MCP server (prototype)

`scripts/mcp-server.mjs` is a stdio [MCP](https://modelcontextprotocol.io) server that lets an agent such as Claude Code build stick-figure animations and export videos. It is a developer tool for now, not part of the shipped app.

## How it works

The editor lives in a page, so the server drives one: it starts the dev server from this checkout when `STYK_URL` does not answer, opens the editor in Google Chrome through Playwright (`tests/support/playwright.mjs`) and calls `window.styk.editor` / `window.styk.actions`, the same surface the browser tests use. Exports and saves go through the app's own export flow. The server removes `showSaveFilePicker` from the page, so the app falls back to a download, which Playwright captures and copies to the requested path. Nothing leaves the machine.

Tool calls run one at a time against a single editor. Chrome is headless unless `STYK_MCP_HEADED=1`.

## Use it with Claude Code

```sh
npm ci
claude mcp add stykanimate -- node /absolute/path/to/StykAnimate-App/scripts/mcp-server.mjs
```

Set `STYK_PYTHON` (environment of the server) when `python3` is not the interpreter you want for the codec service. `npm run test:mcp` runs a full client-style round trip and writes its files to `artifacts/mcp-smoke/`; `npm test` covers the pose library.

## Tools

| Tool | Purpose |
| --- | --- |
| `build_animation` | Create a document from a keyframe spec (below). |
| `get_animation` | Read the open document back as a spec, omitting values equal to the previous frame. |
| `get_state` | Canvas, fps, frame count, duration, figures and the current keyframe's pose. |
| `list_poses` | The named pose library with each pose's joint angles. |
| `render_frame` | PNG of the artboard at up to six ticks, for the agent to look at its work. |
| `export_video` | Whole-animation MP4 (H.264, needs Chrome) or WebM, written to a path. |
| `save_project` | Editable `.styk` project written to a path. |
| `run_js` | Escape hatch: run an async function body in the page, with the full editor API. |

To change an animation, call `get_animation`, edit the spec and call `build_animation` again. A rebuilt `get_animation` spec is identical (`npm run test:mcp` checks this).

## The spec

- **Canvas:** `width`, `height`, `fps`, `background` (hex), `easing` (`auto`, `linear`, `ease-in`, `ease-out`, `constant`; a frame can override it).
- **Figures:** `{id, color, thickness}` for a stick figure, `{id, kind: "line", length, color, thickness}` and `{id, kind: "circle", radius, color}` for props. Later figures draw in front.
- **Frames:** each is a keyframe lasting `duration` ticks (1 tick is 1/fps second), interpolated to the next one by its easing. The final keyframe holds for one tick, so repeat the last pose to hold it. Anything a frame does not mention carries over from the previous frame.
  - `poses[figureId]`: `x`, `y` (hip or root, canvas pixels), `scale`, `pose` (a library name), `mirror` (flip to face left), `joints` (single angles, applied before mirroring) and `angle` (line props).
  - `camera`: `x`, `y` (offset of the view center from the canvas center, so 0,0 shows the whole canvas), `zoom` (1 is the full canvas) and `angle` in degrees.

The stick figure is the startup figure "Blue" without its IK controllers, with ten joints: `torso`, `head`, `l_upper_arm`, `l_forearm`, `r_upper_arm`, `r_forearm`, `l_thigh`, `l_shin`, `r_thigh`, `r_shin`. Angles are absolute screen degrees (0 points right, 90 down, -90 up), not relative to the parent joint, and `l_` rests on the screen-right side. Standing feet are 129 px × scale below the hip, so for a ground at `y = G` use hip `y = G - 129 × scale`.

The pose library (`scripts/mcp-poses.mjs`) holds `stand`, four `walk_*` poses, `run_a`/`run_b`, `crouch`, `jump`, `wave`, `arms_up`, `point`, `punch_ready`, `punch`, `kick`, `sit`, `fall` and `lie`, all facing right. They were checked in rendered contact sheets; they are starting points, not animation-quality keys.

Example: a walk is `walk_contact_a`, `walk_pass_a`, `walk_contact_b`, `walk_pass_b` repeated, 4 ticks each, with `x` advancing about 40 px per frame.

## Limits

- `build_animation` replaces the open document through `editor.load`, so it is not undoable. For undoable in-place edits use `run_js` with `editor.selectFrame(i)` and `editor.transaction(label, frame => …)`. Loaded documents run on the layer sheet, so read the current pose from `editor.selectionFrame`, not `editor.frame` (`get_state` does). Frame add, delete and retime commands do not map cleanly onto the layer sheet, which is why edits go through `get_animation`.
- Only the built-in figure, line and circle props, flat colors and one canvas background. Figures built in Build mode, text, images, effects and audio are reachable through `run_js` but have no dedicated tool.
- The editor runs in its own headless Chrome, not in an open desktop window, and the desktop-only video encoders are not used.
- No authentication: the server is a local stdio process spawned by the agent host.

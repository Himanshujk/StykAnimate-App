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

Set `STYK_PYTHON` (environment of the server) when `python3` is not the interpreter you want for the codec service. `npm run test:mcp` runs a full client-style round trip and writes its files to `artifacts/mcp-smoke/`.

## Tools

| Tool | Purpose |
| --- | --- |
| `build_animation` | Create a document from a keyframe spec: canvas, fps, background, figures (id, color, thickness) and frames with per-figure `x`, `y`, `scale` and joint angles in degrees. Values not mentioned carry over from the previous frame. |
| `get_state` | Canvas, fps, frame count, duration, figures, joint names and the current keyframe's pose. |
| `render_frame` | PNG of the artboard at up to six ticks, for the agent to look at its work. |
| `export_video` | Whole-animation MP4 (H.264, needs Chrome) or WebM, written to a path. |
| `save_project` | Editable `.styk` project written to a path. |
| `run_js` | Escape hatch: run an async function body in the page, with the full editor API. |

The figure is the startup stick figure "Blue" without its IK controllers: ten joints named `torso`, `head`, `l_upper_arm`, `l_forearm`, `r_upper_arm`, `r_forearm`, `l_thigh`, `l_shin`, `r_thigh`, `r_shin`. Angles are absolute screen angles (0 points right, 90 down, -90 up), not relative to the parent joint. A keyframe lasts `duration` ticks (1 tick is 1/fps second) and is interpolated to the next one by its easing; the final keyframe holds for one tick, so repeat the last pose to hold it.

## Limits

- `build_animation` replaces the open document through `editor.load`, so it is not undoable and cannot edit one frame in place. Use `run_js` with `editor.selectFrame(i)` and `editor.transaction(label, frame => …)` for undoable in-place edits. Loaded documents run on the layer sheet, so read the current pose from `editor.selectionFrame`, not `editor.frame` (`get_state` does).
- Only the built-in figure, flat colors and one canvas background. Figures built in Build mode, text, images, camera moves, effects and audio are reachable through `run_js` but have no dedicated tool.
- The editor runs in its own headless Chrome, not in an open desktop window, and the desktop-only video encoders are not used.
- No authentication: the server is a local stdio process spawned by the agent host.

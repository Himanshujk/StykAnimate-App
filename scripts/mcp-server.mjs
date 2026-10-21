// MCP server (stdio) that drives a StykAnimate editor running in Chrome, so an
// agent can build stick-figure animations and export videos. Prototype: the
// editor lives in a page and is reached through `window.styk`, the same way the
// browser tests reach it. See docs/MCP.md.
//
// Env: STYK_URL (default http://127.0.0.1:47831; started from this checkout when
// unreachable), STYK_PYTHON (interpreter for that server), STYK_MCP_HEADED=1
// (show the browser window), STYK_MCP_TIMEOUT_MS (export timeout, default 300000).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '../tests/support/playwright.mjs';
import { JOINTS, POSES, resolveSpec } from './mcp-poses.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.STYK_URL || 'http://127.0.0.1:47831';
const exportTimeout = Number(process.env.STYK_MCP_TIMEOUT_MS) || 300000;
const log = (...args) => process.stderr.write(`[styk-mcp] ${args.join(' ')}\n`);

// ---- editor session -------------------------------------------------------

let session = null; // {browser, page, server}

async function healthy() {
  try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; }
}

async function startServer() {
  if (await healthy()) return null;
  const port = new URL(url).port || '47831';
  log('starting StykAnimate server on port', port);
  const server = spawn(process.execPath, [path.join(appRoot, 'scripts/serve.mjs'), '--port', port], {
    cwd: appRoot, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
  });
  for (let i = 0; i < 60; i++) {
    if (await healthy()) return server;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  server.kill();
  throw new Error(`StykAnimate server did not start at ${url}. Start it with "npm run serve" (set STYK_PYTHON if needed).`);
}

async function editor() {
  if (session?.page && !session.page.isClosed()) return session.page;
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.STYK_MCP_HEADED !== '1' });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.stykStartupView = 'editor';
    // Without the File System Access picker the app saves through a download, which the server captures.
    delete window.showSaveFilePicker;
  });
  const page = await context.newPage();
  page.on('pageerror', error => log('pageerror', error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  session = { browser, page, server };
  return page;
}

/** Runs an app action that ends in a file save and returns the saved bytes. */
async function captureDownload(page, action) {
  const download = page.waitForEvent('download', { timeout: exportTimeout });
  download.catch(() => {});
  const run = page.evaluate(name => window.styk.actions[name](), action);
  const [saved] = await Promise.all([download, run]);
  const file = path.join(appRoot, 'artifacts', `mcp-${Date.now()}-${saved.suggestedFilename()}`);
  await mkdir(path.dirname(file), { recursive: true });
  await saved.saveAs(file);
  return { name: saved.suggestedFilename(), temp: file };
}

async function copyTo(temp, destination) {
  const { copyFile, stat } = await import('node:fs/promises');
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(temp, target);
  return { path: target, bytes: (await stat(target)).size };
}

// ---- page-side builders ---------------------------------------------------

/** Runs in the page. Builds a classic keyframe document from the spec and loads it. */
async function buildInPage({ spec, joints: JOINTS }) {
  const { emptyDocument, createFrame, createObject } = await import('/src/demo.mjs');
  const { createBlueStartupPose } = await import('/src/startup-blue-data.mjs');
  const base = createBlueStartupPose().figure;
  const restAngles = base.segments.map(segment => segment.angle_rad);
  const rad = degrees => degrees * Math.PI / 180;
  const argb = hex => (0xff000000 | parseInt(String(hex).replace('#', ''), 16)) >>> 0;
  const rgb = hex => { const n = parseInt(String(hex).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

  const report = emptyDocument();
  report.canvas_width = spec.width ?? 960;
  report.canvas_height = spec.height ?? 540;
  report.fps = spec.fps ?? 24;
  if (spec.background) report.backgrounds = [{ background_id: 1, kind: 2, color: argb(spec.background), name: 'Background' }];
  report._styk.name = spec.name ?? 'Claude animation';

  const figures = spec.figures?.length ? spec.figures : [{ id: 'figure' }];
  const ids = new Map();
  report.figure_types = figures.map((figure, index) => {
    ids.set(figure.id, index + 1);
    const definition = structuredClone(base);
    definition.figure_type_id = index + 1;
    definition.name = figure.id;
    if (figure.color) for (const segment of definition.segments) segment.color_rgb = rgb(figure.color);
    if (figure.thickness) for (const segment of definition.segments) if (segment.thickness > 0) segment.thickness = figure.thickness;
    return definition;
  });

  const state = new Map(figures.map(figure => [figure.id, {
    x: report.canvas_width / 2, y: report.canvas_height * 0.55, scale: 1, angles: [...restAngles],
  }]));
  report.keyframes = spec.frames.map((frame, frameIndex) => {
    const objects = figures.map((figure, index) => {
      const pose = frame.poses?.[figure.id] ?? {};
      const current = state.get(figure.id);
      if (pose.x !== undefined) current.x = pose.x;
      if (pose.y !== undefined) current.y = pose.y;
      if (pose.scale !== undefined) current.scale = pose.scale;
      for (const [joint, degrees] of Object.entries(pose.joints ?? {})) {
        const slot = JOINTS.indexOf(joint);
        if (slot < 0) throw new Error(`Frame ${frameIndex}: unknown joint "${joint}". Joints: ${JOINTS.join(', ')}`);
        current.angles[slot] = rad(degrees);
      }
      const object = createObject(report.figure_types[index], index + 1, current.x, current.y);
      object.scale = current.scale;
      object.angles = [...current.angles];
      return object;
    });
    const key = createFrame(objects, Math.max(1, Math.round(frame.duration ?? 6)));
    if (spec.background) key.background_id = 1;
    key._styk = { easing: { interpolation: frame.easing ?? spec.easing ?? 'auto' } };
    return key;
  });

  const { editor } = window.styk;
  editor.load(report, report._styk.name);
  editor.selectFrame(0);
  return summarize();

  function summarize() {
    return {
      frames: editor.report.keyframes.length,
      ticks: editor.totalTicks,
      fps: editor.report.fps,
      seconds: +(editor.totalTicks / editor.report.fps).toFixed(2),
      canvas: [editor.report.canvas_width, editor.report.canvas_height],
      figures: figures.map(figure => figure.id),
    };
  }
}

const readStateInPage = JOINTS => {
  const { editor } = window.styk;
  return {
    name: editor.name,
    dirty: editor.dirty,
    canvas: [editor.report.canvas_width, editor.report.canvas_height],
    fps: editor.report.fps,
    frames: editor.report.keyframes.length,
    ticks: editor.totalTicks,
    tick: editor.tick,
    frameIndex: editor.frameIndex,
    figures: editor.report.figure_types.map(figure => ({ id: figure.figure_type_id, name: figure.name, segments: figure.segment_count })),
    jointNames: JOINTS,
    currentFrame: editor.selectionFrame.objects.map(object => ({
      figure: editor.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)?.name,
      x: object.root_x, y: object.root_y, scale: object.scale,
      joints: Object.fromEntries(object.angles.slice(0, JOINTS.length).map((angle, i) => [JOINTS[i], +(angle * 180 / Math.PI).toFixed(1)])),
    })),
  };
};

/** Runs in the page. Reads the live document back as a build_animation spec (values equal to the previous frame are omitted). */
function readAnimationInPage(JOINTS) {
  const { editor } = window.styk;
  const report = editor.report, saved = { frame: editor.frameIndex, tick: editor.tick };
  const hex = rgb => `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
  const round = value => Math.round(value * 10) / 10;
  const figures = report.figure_types.map(figure => ({
    id: figure.name,
    ...(figure.segments[0]?.color_rgb ? { color: hex(figure.segments[0].color_rgb) } : {}),
  }));
  const background = report.backgrounds?.find(item => item.kind === 2);
  const previous = new Map();
  const frames = editor.timeline.map((entry, index) => {
    editor.selectFrame(index);
    const poses = {};
    for (const object of editor.selectionFrame.objects) {
      const name = report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)?.name;
      const now = { x: round(object.root_x), y: round(object.root_y), scale: round(object.scale), joints: {} };
      JOINTS.forEach((joint, slot) => { now.joints[joint] = round(object.angles[slot] * 180 / Math.PI); });
      const last = previous.get(name);
      const pose = {};
      for (const key of ['x', 'y', 'scale']) if (!last || last[key] !== now[key]) pose[key] = now[key];
      const joints = Object.fromEntries(JOINTS.filter(joint => !last || last.joints[joint] !== now.joints[joint]).map(joint => [joint, now.joints[joint]]));
      if (Object.keys(joints).length) pose.joints = joints;
      previous.set(name, now);
      if (Object.keys(pose).length) poses[name] = pose;
    }
    return {
      duration: entry.count,
      easing: report.keyframes[index]?._styk?.easing?.interpolation ?? 'auto',
      ...(Object.keys(poses).length ? { poses } : {}),
    };
  });
  editor.seek(saved.tick);
  return {
    name: editor.name, width: report.canvas_width, height: report.canvas_height, fps: report.fps,
    ...(background ? { background: hex([(background.color >> 16) & 255, (background.color >> 8) & 255, background.color & 255]) } : {}),
    figures, frames,
  };
}

// ---- tools ----------------------------------------------------------------

const textResult = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const tools = [
  {
    name: 'build_animation',
    description: [
      'Create a new stick-figure animation (replaces the open document) from a keyframe spec.',
      'Each frame is a keyframe lasting `duration` timeline ticks (1 tick = 1/fps s); the editor interpolates between keyframes using the easing.',
      'The last keyframe holds for one tick only, so repeat the final pose to hold it.',
      'Angles are absolute degrees on screen: 0 = pointing right, 90 = pointing down, 180 = left, -90 = up. y grows downward.',
      'Joints: torso, head, l_upper_arm, l_forearm, r_upper_arm, r_forearm, l_thigh, l_shin, r_thigh, r_shin (each limb angle is absolute, not relative to its parent; "l_" rests on the screen-right side, "r_" on the screen-left).',
      'Rest pose: torso -90, head -90, l_upper_arm 60, l_forearm 76, r_upper_arm 120, r_forearm 104, l_thigh 64, l_shin 87, r_thigh 116, r_shin 93.',
      'A figure not mentioned in a frame, or a joint/x/y/scale not mentioned, keeps its value from the previous frame. x,y is the hip/root position in canvas pixels.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        width: { type: 'integer', description: 'Canvas width, default 960.' },
        height: { type: 'integer', description: 'Canvas height, default 540.' },
        fps: { type: 'integer', description: 'Frames per second, default 24.' },
        background: { type: 'string', description: 'Hex color such as "#ffffff". Default is the editor background.' },
        easing: { type: 'string', enum: ['auto', 'linear', 'ease-in', 'ease-out', 'constant'], description: 'Default interpolation to the next keyframe.' },
        figures: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, color: { type: 'string', description: 'Hex color, e.g. "#e63946".' }, thickness: { type: 'number' } }, required: ['id'] },
        },
        frames: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              duration: { type: 'integer', description: 'Ticks until the next keyframe (>=1), default 6.' },
              easing: { type: 'string', enum: ['auto', 'linear', 'ease-in', 'ease-out', 'constant'] },
              poses: {
                type: 'object',
                description: 'Map of figure id to {pose, mirror, x, y, scale, joints:{jointName: degrees}}. `pose` starts from a named pose (see list_poses), `joints` then overrides single angles, and `mirror` flips the result to face left.',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    pose: { type: 'string', enum: Object.keys(POSES) },
                    mirror: { type: 'boolean' },
                    x: { type: 'number' }, y: { type: 'number' }, scale: { type: 'number' },
                    joints: { type: 'object', additionalProperties: { type: 'number' } },
                  },
                },
              },
            },
          },
        },
      },
      required: ['frames'],
    },
    async run(args) {
      const page = await editor();
      return textResult(await page.evaluate(buildInPage, { spec: resolveSpec(args), joints: JOINTS }));
    },
  },
  {
    name: 'get_state',
    description: 'Describe the open document: canvas, fps, frame count, duration, figures, joint names and the current keyframe\'s pose (degrees).',
    inputSchema: { type: 'object', properties: {} },
    async run() { return textResult(await (await editor()).evaluate(readStateInPage, JOINTS)); },
  },
  {
    name: 'get_animation',
    description: 'Read the open document back as a build_animation spec (omitting values equal to the previous frame). To change an animation, call this, edit the spec and pass it to build_animation; this is the supported way to add, remove, retime or repose frames.',
    inputSchema: { type: 'object', properties: {} },
    async run() { return textResult(await (await editor()).evaluate(readAnimationInPage, JOINTS)); },
  },
  {
    name: 'list_poses',
    description: 'List the named poses usable as `pose` in build_animation frames, with the joint angles of each (degrees, figure facing right).',
    inputSchema: { type: 'object', properties: {} },
    async run() { return textResult(Object.fromEntries(Object.entries(POSES).map(([name, { description, joints }]) => [name, { description, joints }]))); },
  },
  {
    name: 'render_frame',
    description: 'Render the animation at one or more timeline ticks to PNG images (clean artboard, no handles). Use this to look at your work. At most 6 ticks per call; default tick 0.',
    inputSchema: {
      type: 'object',
      properties: { ticks: { type: 'array', items: { type: 'integer' }, maxItems: 6 } },
    },
    async run({ ticks = [0] }) {
      const page = await editor();
      const content = [];
      for (const tick of ticks.slice(0, 6)) {
        await page.evaluate(value => { window.styk.editor.seek(value); }, tick);
        const { temp } = await captureDownload(page, 'export-png');
        const { readFile } = await import('node:fs/promises');
        content.push({ type: 'text', text: `tick ${tick}` }, { type: 'image', data: (await readFile(temp)).toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    },
  },
  {
    name: 'export_video',
    description: 'Export the whole animation to a video file on disk. Returns the path and size. mp4 needs H.264 support in Chrome; webm (VP9) is always available.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination file path, e.g. /Users/me/clip.mp4.' },
        format: { type: 'string', enum: ['mp4', 'webm'], description: 'Default: from the path extension, else mp4.' },
      },
      required: ['path'],
    },
    async run({ path: destination, format }) {
      const chosen = format ?? (destination.toLowerCase().endsWith('.webm') ? 'webm' : 'mp4');
      const page = await editor();
      const { temp } = await captureDownload(page, chosen === 'webm' ? 'export-video' : 'export-mp4');
      return textResult({ format: chosen, ...(await copyTo(temp, destination)) });
    },
  },
  {
    name: 'save_project',
    description: 'Save the animation as an editable StykAnimate project (.styk) at the given path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run({ path: destination }) {
      const page = await editor();
      const { temp } = await captureDownload(page, 'save-as');
      return textResult(await copyTo(temp, destination));
    },
  },
  {
    name: 'run_js',
    description: 'Escape hatch: evaluate a JavaScript expression or async function body in the editor page, where `window.styk.editor` (all editor commands) and `window.styk.actions` live. Returns the JSON-serialisable result. Use for anything the other tools do not cover.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Function body; use `return` to produce a value.' } }, required: ['code'] },
    async run({ code }) {
      const page = await editor();
      const result = await page.evaluate(async body => {
        const value = await new Function(`return (async () => { ${body} })()`)();
        return value === undefined ? null : JSON.parse(JSON.stringify(value));
      }, code);
      return textResult(result ?? 'ok');
    },
  },
];

// ---- JSON-RPC over stdio --------------------------------------------------

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let queue = Promise.resolve(); // one editor, so one tool call at a time

async function handle(message) {
  const { id, method, params } = message;
  const reply = result => id !== undefined && send({ id, result });
  const fail = (code, text) => id !== undefined && send({ id, error: { code, message: text } });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stykanimate', version: '0.1.0' } });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find(item => item.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
      try { return reply(await tool.run(params.arguments ?? {})); }
      catch (error) { return reply({ isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }); }
    }
    default:
      if (id !== undefined) return fail(-32601, `Method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  queue = queue.then(() => handle(message)).catch(error => log('error', error?.stack ?? error));
});

async function shutdown() {
  try { await session?.browser.close(); } catch { /* already gone */ }
  session?.server?.kill();
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

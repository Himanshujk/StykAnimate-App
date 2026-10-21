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

  // Each caption becomes a text figure (listed last, so in front) that is hidden until its keyed fade-in.
  const captions = (spec.captions ?? []).map((caption, index) => ({ ...caption, id: `caption_${index + 1}` }));
  const figures = [
    ...(spec.figures?.length || captions.length ? spec.figures ?? [] : [{ id: 'figure' }]),
    ...captions.map(caption => ({
      id: caption.id, kind: 'text', text: caption.text, fontSize: caption.fontSize ?? 36, color: caption.color ?? '#222222',
      bold: caption.bold, italic: caption.italic, alignment: 'center', anchor: 'center',
      outlineWidth: caption.outlineWidth, outlineColor: caption.outlineColor,
    })),
  ];
  const frames = spec.frames.map((frame, index) => index ? frame : {
    ...frame,
    poses: {
      ...Object.fromEntries(captions.map(caption => [caption.id, { x: caption.x ?? (spec.width ?? 960) / 2, y: caption.y ?? (spec.height ?? 540) - 40, opacity: 0 }])),
      ...frame.poses,
    },
  });
  const ids = new Map();
  // A prop is a single segment: a line (length, angle) or a filled circle (radius = length / 2).
  const segment = (extra, figure) => ({
    segment_id: 1, parent_id: 0, length: 100, angle_rad: 0, thickness: figure.thickness ?? 8, bend_rad: 0, primitive_code: 0,
    aux_code: 0, flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: rgb(figure.color ?? '#2b2b2b'),
    transparency: 0, visible: true, z_order: 1, ...extra,
  });
  const { createTextFigure } = await import('/src/text-authoring.mjs');
  report.figure_types = [];
  for (const [index, figure] of figures.entries()) {
    ids.set(figure.id, index + 1);
    let definition;
    if (figure.kind === 'text') {
      definition = await createTextFigure({
        text: figure.text, fontSize: figure.fontSize ?? 48, bold: figure.bold ?? false, italic: figure.italic ?? false,
        alignment: figure.alignment ?? 'center', color: rgb(figure.color ?? '#2b2b2b'), lineHeight: figure.lineHeight ?? 1.2,
        outlineWidth: figure.outlineWidth ?? 0, outlineColor: rgb(figure.outlineColor ?? '#000000'), figureTypeId: index + 1, name: figure.id,
      });
    } else if (figure.kind === 'line') {
      definition = { segments: [segment({ length: figure.length ?? 200 }, figure)] };
    } else if (figure.kind === 'circle') {
      definition = { segments: [segment({
        length: (figure.radius ?? 20) * 2, angle_rad: -Math.PI / 2, thickness: 0, primitive_code: 3, flags: 3,
        segment_type: 'circle', segment_kind: 'circleFill',
      }, figure)] };
    } else {
      definition = structuredClone(base);
      if (figure.color) for (const part of definition.segments) part.color_rgb = rgb(figure.color);
      if (figure.thickness) for (const part of definition.segments) if (part.thickness > 0) part.thickness = figure.thickness;
    }
    report.figure_types.push({ polyfills: [], image_assets: [], text_assets: [], ...definition, figure_type_id: index + 1, name: figure.id, segment_count: definition.segments.length });
  }

  const state = new Map(figures.map((figure, index) => [figure.id, {
    x: report.canvas_width / 2, y: report.canvas_height * 0.55, scale: 1, opacity: 1,
    angles: figure.kind === 'line' ? [rad(figure.angle ?? 0)] : figure.kind === 'circle' ? [-Math.PI / 2]
      : figure.kind === 'text' ? report.figure_types[index].segments.map(part => part.angle_rad) : [...restAngles],
  }]));
  // The native camera is an offset of the view's center from the canvas center, with scale as zoom.
  const camera = { x: 0, y: 0, zoom: 1, angle: 0, used: false };
  report.keyframes = frames.map((frame, frameIndex) => {
    for (const [name, value] of Object.entries(frame.camera ?? {})) {
      if (!(name in camera) || name === 'used') throw new Error(`Frame ${frameIndex}: unknown camera field "${name}". Fields: x, y, zoom, angle`);
      camera[name] = value;
      camera.used = true;
    }
    const objects = figures.map((figure, index) => {
      const pose = frame.poses?.[figure.id] ?? {};
      const current = state.get(figure.id);
      if (pose.x !== undefined) current.x = pose.x;
      if (pose.y !== undefined) current.y = pose.y;
      if (pose.scale !== undefined) current.scale = pose.scale;
      if (pose.opacity !== undefined) current.opacity = Math.min(1, Math.max(0, pose.opacity));
      if (pose.angle !== undefined) {
        if (figure.kind !== 'line') throw new Error(`Frame ${frameIndex}: "angle" only applies to line figures (${figure.id})`);
        current.angles[0] = rad(pose.angle);
      }
      if (figure.kind && figure.kind !== 'stick' && Object.keys(pose.joints ?? {}).length) throw new Error(`Frame ${frameIndex}: ${figure.kind} figure "${figure.id}" has no joints`);
      for (const [joint, degrees] of Object.entries(pose.joints ?? {})) {
        const slot = JOINTS.indexOf(joint);
        if (slot < 0) throw new Error(`Frame ${frameIndex}: unknown joint "${joint}". Joints: ${JOINTS.join(', ')}`);
        current.angles[slot] = rad(degrees);
      }
      const shift = figure.kind === 'text' ? (figure.anchor === 'center' ? 0.5 : figure.anchor === 'right' ? 1 : 0) * report.figure_types[index].segments[0].length * current.scale : 0;
      const object = createObject(report.figure_types[index], index + 1, current.x - shift, current.y);
      object.scale = current.scale;
      object.field28 = Math.round(255 * (1 - current.opacity)); // native opacity is stored as transparency 0-255
      object.angles = [...current.angles];
      return object;
    });
    const key = createFrame(objects, Math.max(1, Math.round(frame.duration ?? 6)));
    if (camera.used) key.camera = { is_default: false, x: camera.x, y: camera.y, scale: camera.zoom, angle_rad: rad(camera.angle) };
    if (spec.background) key.background_id = 1;
    key._styk = { easing: { interpolation: frame.easing ?? spec.easing ?? 'auto' } };
    return key;
  });

  if (captions.length) {
    const { evaluatedFrame, timeline } = await import('/src/pivot/geometry.mjs');
    const ticksOf = () => timeline(report).map(entry => entry);
    const end = () => ticksOf().at(-1).start;
    // Splits the keyframe segment holding `tick` so a key exists exactly there, with the pose the animation has at that tick.
    const split = tick => {
      const entries = ticksOf();
      const at = entries.findIndex((entry, i) => i < entries.length - 1 && entry.start < tick && tick < entry.start + entry.count);
      if (at < 0) return;
      const { start, count } = entries[at];
      const evaluated = evaluatedFrame(report, at, (tick - start) / count, tick);
      const key = structuredClone({ ...evaluated, objects: [] });
      for (const { runtime_segments, ...object } of evaluated.objects) key.objects.push(structuredClone(object));
      key.duration_raw = start + count - tick;
      key._styk = { easing: structuredClone(report.keyframes[at]._styk?.easing ?? { interpolation: 'auto' }) };
      report.keyframes[at].duration_raw = tick - start;
      report.keyframes.splice(at + 1, 0, key);
    };
    const plans = captions.map(caption => {
      const from = Math.round(caption.from ?? 0);
      const to = caption.to === undefined ? undefined : Math.round(caption.to);
      if (to !== undefined && to - from < 2) throw new Error(`${caption.id}: "to" must be at least 2 ticks after "from"`);
      const fade = Math.max(1, Math.min(Math.round(caption.fade ?? 4), to === undefined ? Infinity : Math.floor((to - from) / 2)));
      return { id: caption.id, from, to, fade };
    });
    const limit = end();
    for (const plan of plans) {
      const wanted = [plan.from, plan.from + plan.fade, ...(plan.to === undefined ? [] : [plan.to - plan.fade, plan.to])];
      for (const tick of wanted) if (tick > 0 && tick < limit) split(tick);
    }
    const opacityAt = (plan, tick) => {
      if (tick <= plan.from) return 0;
      if (tick < plan.from + plan.fade) return (tick - plan.from) / plan.fade;
      if (plan.to === undefined || tick <= plan.to - plan.fade) return 1;
      return tick < plan.to ? (plan.to - tick) / plan.fade : 0;
    };
    const entries = ticksOf();
    for (const [position, plan] of plans.entries()) {
      const typeId = ids.get(plan.id), width = report.figure_types[typeId - 1].segments[0].length;
      const screenX = captions[position].x ?? report.canvas_width / 2, screenY = captions[position].y ?? report.canvas_height - 40;
      report.keyframes.forEach((key, index) => {
        const object = key.objects.find(item => item.figure_type_id === typeId);
        object.field28 = Math.round(255 * (1 - opacityAt(plan, entries[index].start)));
        // Subtitles stay put on screen: undo the camera's pan and zoom (rotation is not compensated).
        const cam = key.camera && !key.camera.is_default ? key.camera : { x: 0, y: 0, scale: 1 };
        object.scale = 1 / cam.scale;
        object.root_x = report.canvas_width / 2 + cam.x + (screenX - report.canvas_width / 2) / cam.scale - width / 2 * object.scale;
        object.root_y = report.canvas_height / 2 + cam.y + (screenY - report.canvas_height / 2) / cam.scale;
      });
    }
  }

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
      joints: Object.fromEntries(object.angles.map((angle, i) => [object.angles.length === JOINTS.length ? JOINTS[i] : `angle${i}`, +(angle * 180 / Math.PI).toFixed(1)])),
    })),
  };
};

/** Runs in the page. Reads the live document back as a build_animation spec (values equal to the previous frame are omitted). */
async function readAnimationInPage(JOINTS) {
  const { readTextFigureOptions } = await import('/src/native-text-authoring.mjs');
  const { editor } = window.styk;
  const report = editor.report, saved = { frame: editor.frameIndex, tick: editor.tick };
  const hex = rgb => `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
  const round = value => Math.round(value * 10) / 10;
  const kindOf = figure => figure.segments.length !== 1 ? 'stick' : figure.segments[0].segment_kind === 'circleFill' ? 'circle' : figure.segments[0].segment_kind === 'text' ? 'text' : 'line';
  const textFields = figure => {
    const options = readTextFigureOptions(figure);
    return {
      text: options.text, fontSize: options.fontSize, ...(options.bold ? { bold: true } : {}), ...(options.italic ? { italic: true } : {}),
      alignment: options.alignment, lineHeight: options.lineHeight,
      ...(options.outlineWidth ? { outlineWidth: options.outlineWidth, outlineColor: hex(options.outlineColor) } : {}),
    };
  };
  const figures = report.figure_types.map(figure => {
    const kind = kindOf(figure), segment = figure.segments[0];
    return {
      id: figure.name,
      ...(kind === 'stick' ? {} : { kind }),
      ...(segment?.color_rgb ? { color: hex(segment.color_rgb) } : {}),
      ...(kind === 'line' ? { length: segment.length, thickness: segment.thickness } : {}),
      ...(kind === 'circle' ? { radius: segment.length / 2 } : {}),
      ...(kind === 'text' ? textFields(figure) : {}),
    };
  });
  const background = report.backgrounds?.find(item => item.kind === 2);
  const previous = new Map();
  let lastCamera = { x: 0, y: 0, zoom: 1, angle: 0 };
  const frames = editor.timeline.map((entry, index) => {
    editor.selectFrame(index);
    const poses = {};
    for (const object of editor.selectionFrame.objects) {
      const figure = report.figure_types.find(item => item.figure_type_id === object.figure_type_id), name = figure?.name;
      const kind = kindOf(figure);
      const now = { x: round(object.root_x), y: round(object.root_y), scale: round(object.scale), opacity: Math.round((1 - (object.field28 ?? 0) / 255) * 100) / 100, joints: {} };
      if (kind === 'stick') JOINTS.forEach((joint, slot) => { now.joints[joint] = round(object.angles[slot] * 180 / Math.PI); });
      else if (kind === 'line') now.angle = round(object.angles[0] * 180 / Math.PI);
      const last = previous.get(name);
      const pose = {};
      for (const key of ['x', 'y', 'scale', 'opacity', 'angle']) if (key in now && (!last || last[key] !== now[key])) pose[key] = now[key];
      const joints = Object.fromEntries(Object.keys(now.joints).filter(joint => !last || last.joints[joint] !== now.joints[joint]).map(joint => [joint, now.joints[joint]]));
      if (Object.keys(joints).length) pose.joints = joints;
      previous.set(name, now);
      if (Object.keys(pose).length) poses[name] = pose;
    }
    const native = editor.selectionFrame.camera;
    const camera = native && !native.is_default
      ? { x: round(native.x), y: round(native.y), zoom: round(native.scale), angle: round((native.angle_rad ?? 0) * 180 / Math.PI) } : lastCamera;
    const cameraChange = Object.fromEntries(Object.keys(camera).filter(key => camera[key] !== lastCamera[key]).map(key => [key, camera[key]]));
    lastCamera = camera;
    return {
      duration: entry.count,
      easing: report.keyframes[index]?._styk?.easing?.interpolation ?? 'auto',
      ...(Object.keys(cameraChange).length ? { camera: cameraChange } : {}),
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
      'A figure not mentioned in a frame, or a joint/x/y/scale not mentioned, keeps its value from the previous frame. x,y is the hip/root position in canvas pixels; standing feet are 129 px x scale below the hip (so hip y = ground y - 129 x scale), the head top about 122 px x scale above it.',
      'Figures are stick figures by default; kind "line" (length, angle in degrees, set per frame with pose.angle) and kind "circle" (radius) make props such as a ground line or a ball, positioned by x,y (a line starts at x,y, a circle is centered there). Figures listed later draw in front.',
      'Kind "text" (text, fontSize, color, bold, italic, alignment, anchor) draws words in the bundled Noto Sans. Pose x is the left edge of the block unless anchor is "center" or "right", and y is the bottom of the lettering. Text cannot change, so make one text figure per caption and show it with pose.opacity (0 hides, 1 shows; a frame with easing "constant" cuts instantly, other easings fade). For subtitles use `captions` instead: [{text, from, to, fade}] in ticks, which adds the text figure, the fade keys and any keyframes it needs for you (frames are split at exact ticks without changing the motion; y defaults to near the bottom, x to the center).',
      'A frame may set `camera` {x, y, zoom, angle}: x,y shift the view center from the canvas center in pixels (0,0 shows the whole canvas, positive x looks right), zoom 1 is the full canvas, 2 is twice as close, angle in degrees. Camera values also carry over.',
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
        captions: {
          type: 'array',
          description: 'Subtitles shown between two timeline ticks. Each becomes a text figure, fades in and out, and the keyframes it needs are inserted for you without changing the motion.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '\\n starts a new line.' },
              from: { type: 'integer', description: 'Tick where the fade-in starts, default 0.' },
              to: { type: 'integer', description: 'Tick where the fade-out ends; omit to keep it to the end.' },
              fade: { type: 'integer', description: 'Fade length in ticks, default 4; 1 is a near-instant cut.' },
              x: { type: 'number', description: 'Horizontal center, default the canvas center.' },
              y: { type: 'number', description: 'Bottom of the lettering, default 40 px above the canvas bottom.' },
              fontSize: { type: 'number', description: 'Default 36.' },
              color: { type: 'string', description: 'Hex, default "#222222".' },
              bold: { type: 'boolean' }, italic: { type: 'boolean' },
              outlineWidth: { type: 'number' }, outlineColor: { type: 'string' },
            },
            required: ['text'],
          },
        },
        figures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { type: 'string', enum: ['stick', 'line', 'circle', 'text'], description: 'Default stick.' },
              color: { type: 'string', description: 'Hex color, e.g. "#e63946".' },
              thickness: { type: 'number' },
              length: { type: 'number', description: 'line: length in pixels.' },
              angle: { type: 'number', description: 'line: starting angle in degrees (0 = right).' },
              radius: { type: 'number', description: 'circle: radius in pixels.' },
              text: { type: 'string', description: 'text: the words; \\n starts a new line. A text figure never changes its words, so use one figure per caption.' },
              fontSize: { type: 'number', description: 'text: size in pixels, default 48.' },
              bold: { type: 'boolean' }, italic: { type: 'boolean' },
              alignment: { type: 'string', enum: ['left', 'center', 'right'], description: 'text: alignment of lines within a multiline block, default center.' },
              anchor: { type: 'string', enum: ['left', 'center', 'right'], description: 'text: which point of the block pose x refers to, default left.' },
              lineHeight: { type: 'number' },
              outlineWidth: { type: 'number' }, outlineColor: { type: 'string' },
            },
            required: ['id'],
          },
        },
        frames: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              duration: { type: 'integer', description: 'Ticks until the next keyframe (>=1), default 6.' },
              camera: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number' }, angle: { type: 'number' } },
              },
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
                    angle: { type: 'number', description: 'line figures only: angle in degrees.' },
                    opacity: { type: 'number', description: '0 (invisible) to 1, default 1; interpolates, so it fades.' },
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

// Drives scripts/mcp-server.mjs over stdio like an MCP client: builds a short
// two-figure animation, renders frames, exports WebM and MP4 and saves a project.
// Needs Google Chrome (or STYK_BROWSER_*, see tests/support/playwright.mjs) and
// starts the dev server itself unless STYK_URL already answers. Output: artifacts/mcp-smoke/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'mcp-smoke');
await mkdir(output, { recursive: true });

const child = spawn(process.execPath, [path.join(root, 'scripts/mcp-server.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
const rpc = (method, params) => new Promise(resolve => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
async function call(name, args = {}) {
  const { result, error } = await rpc('tools/call', { name, arguments: args });
  assert.ok(!error, `${name}: ${JSON.stringify(error)}`);
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`);
  return result.content;
}
const json = content => JSON.parse(content.find(part => part.type === 'text').text);

try {
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
  assert.equal(init.serverInfo.name, 'stykanimate');
  const names = (await rpc('tools/list')).result.tools.map(tool => tool.name);
  for (const name of ['build_animation', 'get_state', 'render_frame', 'export_video', 'save_project', 'run_js']) assert.ok(names.includes(name), name);

  const wave = amount => ({ r_upper_arm: -40 + amount, r_forearm: -70 + amount * 1.6 });
  const built = json(await call('build_animation', {
    name: 'smoke', background: '#ffffff',
    figures: [{ id: 'blue', color: '#0d99ff' }, { id: 'red', color: '#e63946' }],
    frames: [
      { duration: 8, poses: { blue: { x: 300, y: 300 }, red: { x: 700, y: 300 } } },
      { duration: 8, poses: { blue: { x: 340, joints: wave(0) } } },
      { duration: 8, poses: { blue: { joints: wave(30) } } },
      { duration: 1, poses: { blue: { joints: wave(0) } } },
    ],
  }));
  assert.equal(built.frames, 4);
  assert.equal(built.ticks, 25);

  const state = json(await call('get_state'));
  assert.equal(state.currentFrame.length, 2);
  assert.equal(state.currentFrame[0].figure, 'blue');

  const images = (await call('render_frame', { ticks: [0, 12] })).filter(part => part.type === 'image');
  assert.equal(images.length, 2);
  assert.notEqual(images[0].data, images[1].data, 'tick 0 and 12 render differently');
  await writeFile(path.join(output, 'tick-12.png'), Buffer.from(images[1].data, 'base64'));

  for (const file of ['smoke.webm', 'smoke.mp4']) {
    const saved = json(await call('export_video', { path: path.join(output, file) }));
    assert.ok(saved.bytes > 1000, `${file} is empty`);
  }
  const project = json(await call('save_project', { path: path.join(output, 'smoke.styk') }));
  assert.equal((await readFile(project.path)).subarray(0, 4).toString(), 'STYK');
  assert.ok((await stat(path.join(output, 'smoke.mp4'))).size > 1000);

  const frames = json(await call('run_js', { code: 'return window.styk.editor.report.keyframes.length' }));
  assert.equal(frames, 4);

  // Named poses and mirroring build, and get_animation reads a document back to an equal spec.
  const posed = json(await call('build_animation', {
    name: 'poses', background: '#ffffff',
    figures: [{ id: 'ground', kind: 'line', length: 900, color: '#555555' }, { id: 'ball', kind: 'circle', radius: 20, color: '#f0a547' },
      { id: 'a', color: '#0d99ff' }, { id: 'b', color: '#e63946' },
      { id: 'title', kind: 'text', text: 'Hi there', fontSize: 40, anchor: 'center', color: '#222222' }],
    frames: [
      { duration: 6, poses: { title: { x: 480, y: 80, opacity: 0 }, ground: { x: 30, y: 420, angle: 0 }, ball: { x: 480, y: 400 }, a: { pose: 'walk_contact_a', x: 200 }, b: { pose: 'walk_contact_a', mirror: true, x: 700 } } },
      { duration: 6, camera: { x: 100, y: -20, zoom: 1.5, angle: 3 }, poses: { title: { opacity: 1 }, ball: { x: 520 }, a: { pose: 'walk_contact_b', x: 260 }, b: { pose: 'walk_contact_b', mirror: true, x: 640 } } },
      { duration: 1 },
    ],
  }));
  assert.equal(posed.ticks, 13);
  const spec = json(await call('get_animation'));
  assert.equal(spec.frames.length, 3);
  assert.equal(spec.figures[3].color, '#e63946');
  assert.equal(spec.figures[1].radius, 20);
  assert.equal(spec.figures[4].text, 'Hi there');
  assert.equal(spec.frames[0].poses.title.opacity, 0);
  assert.equal(spec.frames[1].poses.title.opacity, 1);
  assert.ok(Math.abs(spec.frames[0].poses.title.x - 480) > 20, 'centered text is shifted left by half its width');
  assert.deepEqual(spec.frames[1].camera, { x: 100, y: -20, zoom: 1.5, angle: 3 });
  assert.notEqual((await call('render_frame', { ticks: [0] }))[1].data, (await call('render_frame', { ticks: [6] }))[1].data);
  await call('build_animation', spec);
  assert.deepEqual(json(await call('get_animation')), spec, 'get_animation output survives a rebuild unchanged');
  assert.ok(Object.keys(json(await call('list_poses'))).includes('punch'));

  // An in-place edit shows in get_state and undoes.
  await call('run_js', { code: 'const e = window.styk.editor; e.selectFrame(0); e.transaction("smoke", f => { f.objects[2].root_x = 123; });' });
  const hero = async () => json(await call('get_state')).currentFrame.find(item => item.figure === 'a');
  assert.equal((await hero()).x, 123);
  await call('run_js', { code: 'window.styk.editor.undo();' });
  assert.equal((await hero()).x, 200);
  // Captions fade in and out between ticks, split keyframes without changing the motion, and survive a round trip.
  const captioned = json(await call('build_animation', {
    background: '#ffffff', easing: 'linear', figures: [{ id: 'hero', color: '#0d99ff' }],
    captions: [{ text: 'Hello!', from: 3, to: 8, fade: 2 }],
    frames: [{ duration: 10, camera: { x: 0, y: 0 }, poses: { hero: { pose: 'stand', x: 100 } } }, { duration: 1, camera: { x: 100 }, poses: { hero: { x: 300 } } }],
  }));
  assert.equal(captioned.ticks, 11);
  assert.equal(captioned.frames, 6, 'ticks 3, 5, 6 and 8 became keyframes');
  const sample = async tick => json(await call('run_js', { code: `
    const e = window.styk.editor; e.seek(${tick});
    const object = e.selectionFrame.objects.find(item => item.figure_type_id === 2);
    const width = e.report.figure_types[1].segments[0].length;
    return { hero: e.selectionFrame.objects.find(item => item.figure_type_id === 1).root_x, caption: 1 - object.field28 / 255,
      screenCenter: object.root_x + width / 2 * object.scale - e.selectionFrame.camera.x };` }));
  assert.equal((await sample(2)).caption, 0);
  assert.ok(Math.abs((await sample(4)).caption - 0.5) < 0.01, 'half faded in at tick 4');
  assert.equal((await sample(6)).caption, 1);
  assert.ok(Math.abs((await sample(7)).caption - 0.5) < 0.01, 'half faded out at tick 7');
  assert.equal((await sample(9)).caption, 0);
  for (const tick of [3, 6, 7]) assert.ok(Math.abs((await sample(tick)).screenCenter - 480) < 0.01, `caption stays centered on screen at tick ${tick}`);
  for (const tick of [3, 5, 7]) assert.ok(Math.abs((await sample(tick)).hero - (100 + 20 * tick)) < 0.01, `linear motion kept at tick ${tick}`);
  const captionedSpec = json(await call('get_animation'));
  assert.equal(captionedSpec.figures.at(-1).text, 'Hello!');
  await call('build_animation', captionedSpec);
  assert.deepEqual(json(await call('get_animation')), captionedSpec);

  console.log(`MCP smoke passed; files in ${output}`);
} finally {
  child.stdin.end();
}

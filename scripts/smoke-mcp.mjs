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
    name: 'poses', background: '#ffffff', figures: [{ id: 'a', color: '#0d99ff' }, { id: 'b', color: '#e63946' }],
    frames: [
      { duration: 6, poses: { a: { pose: 'walk_contact_a', x: 200 }, b: { pose: 'walk_contact_a', mirror: true, x: 700 } } },
      { duration: 6, poses: { a: { pose: 'walk_contact_b', x: 260 }, b: { pose: 'walk_contact_b', mirror: true, x: 640 } } },
      { duration: 1 },
    ],
  }));
  assert.equal(posed.ticks, 13);
  const spec = json(await call('get_animation'));
  assert.equal(spec.frames.length, 3);
  assert.equal(spec.figures[1].color, '#e63946');
  await call('build_animation', spec);
  assert.deepEqual(json(await call('get_animation')), spec, 'get_animation output survives a rebuild unchanged');
  assert.ok(Object.keys(json(await call('list_poses'))).includes('punch'));

  // An in-place edit shows in get_state and undoes.
  await call('run_js', { code: 'const e = window.styk.editor; e.selectFrame(0); e.transaction("smoke", f => { f.objects[0].root_x = 123; });' });
  assert.equal(json(await call('get_state')).currentFrame[0].x, 123);
  await call('run_js', { code: 'window.styk.editor.undo();' });
  assert.equal(json(await call('get_state')).currentFrame[0].x, 200);
  console.log(`MCP smoke passed; files in ${output}`);
} finally {
  child.stdin.end();
}

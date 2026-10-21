import assert from 'node:assert/strict';
import test from 'node:test';
import { JOINTS, POSES, mirror, poseNames, resolvePose, resolveSpec } from '../scripts/mcp-poses.mjs';

test('every library pose sets every joint to a finite angle', () => {
  for (const [name, { joints }] of Object.entries(POSES)) {
    assert.deepEqual(Object.keys(joints), JOINTS, name);
    for (const angle of Object.values(joints)) assert.ok(Number.isFinite(angle), name);
  }
});

test('mirroring flips angles across the vertical axis and swaps sides', () => {
  const flipped = mirror({ l_upper_arm: 60, r_thigh: 120, torso: -90 });
  assert.deepEqual(flipped, { r_upper_arm: 120, l_thigh: 60, torso: -90 });
  assert.deepEqual(mirror(mirror(POSES.walk_contact_a.joints)), POSES.walk_contact_a.joints);
});

test('a joint override applies before mirroring', () => {
  const plain = resolvePose({ pose: 'stand', joints: { l_forearm: 10 } });
  assert.equal(plain.joints.l_forearm, 10);
  const flipped = resolvePose({ pose: 'stand', joints: { l_forearm: 10 }, mirror: true });
  assert.equal(flipped.joints.r_forearm, 170);
});

test('other fields pass through and unknown names are rejected', () => {
  assert.deepEqual(resolvePose({ x: 5, y: 6 }), { x: 5, y: 6 });
  assert.throws(() => resolvePose({ pose: 'moonwalk' }), /Unknown pose "moonwalk"/);
  assert.throws(() => resolvePose({ joints: { elbow: 1 } }), /Unknown joint "elbow"/);
});

test('resolveSpec resolves every frame and keeps everything else', () => {
  const spec = resolveSpec({ fps: 12, frames: [{ duration: 3, poses: { a: { pose: poseNames()[0], x: 1 } } }, { duration: 2 }] });
  assert.equal(spec.fps, 12);
  assert.equal(spec.frames[0].poses.a.x, 1);
  assert.equal(spec.frames[0].poses.a.joints.torso, POSES[poseNames()[0]].joints.torso);
  assert.equal(spec.frames[1].poses, undefined);
});

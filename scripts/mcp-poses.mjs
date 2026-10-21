// Named poses for the MCP server's stick figure (see docs/MCP.md). Angles are
// absolute screen degrees: 0 points right, 90 down, -90 up. Figures face right;
// mirror() turns one to face left. Pure data and helpers, so tests can import it.

export const JOINTS = ['torso', 'head', 'l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm', 'l_thigh', 'l_shin', 'r_thigh', 'r_shin'];

const pose = (description, values) => {
  const joints = {};
  JOINTS.forEach((name, index) => { joints[name] = values[index]; });
  return Object.freeze({ description, joints: Object.freeze(joints) });
};

//                                      torso head  lUA   lFA   rUA   rFA   lTh   lSh   rTh   rSh
export const POSES = Object.freeze({
  stand:          pose('Relaxed standing, arms at the sides.',            [-90, -90,  70,  80, 110, 100,  72,  86, 108,  94]),
  walk_contact_a: pose('Walk: right leg reaches forward, heel down.',     [-88, -88, 115, 130,  55,  35,  50,  62, 115, 135]),
  walk_pass_a:    pose('Walk: passing, left leg swings through.',         [-90, -90,  95, 105,  85,  75,  88,  95,  70, 125]),
  walk_contact_b: pose('Walk: left leg reaches forward, heel down.',      [-88, -88,  55,  35, 115, 130, 115, 135,  50,  62]),
  walk_pass_b:    pose('Walk: passing, right leg swings through.',        [-90, -90,  85,  75,  95, 105,  70, 125,  88,  95]),
  run_a:          pose('Run: lean forward, front knee high, arms pumping.', [-75, -75, 130,  50,  40, -30,  20,  95, 120, 175]),
  run_b:          pose('Run: mirror of run_a (other leg forward).',       [-75, -75,  40, -30, 130,  50, 120, 175,  20,  95]),
  crouch:         pose('Crouch before a jump, knees bent, arms back.',    [-75, -75,  20,  40,  60,  40,  45, 125,  30, 120]),
  jump:           pose('In the air, arms up, legs tucked slightly.',      [-90, -90, -60, -80, -120, -100,  65, 100, 115,  80]),
  wave:           pose('Standing, waving with the screen-right arm.',     [-90, -90, -40, -75, 110, 100,  80,  88, 100,  92]),
  arms_up:        pose('Both arms raised overhead.',                      [-90, -90, -65, -80, -115, -100,  80,  88, 100,  92]),
  point:          pose('Pointing straight ahead with the front arm.',     [-90, -90,   0,   0, 110, 100,  80,  88, 100,  92]),
  punch_ready:    pose('Fighting stance, fists up.',                      [-82, -82,  -5, -60, 150, 110,  45,  80, 125,  95]),
  punch:          pose('Straight punch forward with the front arm.',      [-75, -75,   0,   0, 150, 110,  35,  85, 130, 120]),
  kick:           pose('Front kick, leg extended forward.',               [-100, -100, 30, 60, 150, 130, -10, -5, 100, 92]),
  sit:            pose('Sitting, thighs forward, shins down.',            [-90, -90,  70, 100, 110, 80,  0, 90, 0, 90]),
  fall:           pose('Falling back, limbs flung out.',                  [-120, -125, -150, -170, 160, 140, 40, 70, 140, 120]),
  lie:            pose('Lying flat on the back, facing up.',              [ 180, 180,  10,  10,  -10, -10,   0,   0,   0,   0]),
});

export const poseNames = () => Object.keys(POSES);

const normalize = angle => ((((angle + 180) % 360) + 360) % 360) - 180;
const swap = name => (name.startsWith('l_') ? `r_${name.slice(2)}` : name.startsWith('r_') ? `l_${name.slice(2)}` : name);

/** Mirrors joints left-right: angle -> 180 - angle, l_ and r_ limbs swap. */
export function mirror(joints) {
  const result = {};
  for (const [name, angle] of Object.entries(joints)) result[swap(name)] = normalize(180 - angle);
  return result;
}

/**
 * Resolves one figure's pose entry to plain values: `pose` names a library pose,
 * `mirror` flips it, `joints` overrides individual angles. Throws on unknown names.
 */
export function resolvePose(entry) {
  if (!entry) return entry;
  const { pose: name, mirror: flip, joints = {}, ...rest } = entry;
  let base = {};
  if (name !== undefined) {
    if (!POSES[name]) throw new Error(`Unknown pose "${name}". Poses: ${poseNames().join(', ')}`);
    base = { ...POSES[name].joints };
  }
  const merged = { ...base, ...joints };
  for (const joint of Object.keys(merged)) if (!JOINTS.includes(joint)) throw new Error(`Unknown joint "${joint}". Joints: ${JOINTS.join(', ')}`);
  const resolved = { ...rest };
  if (Object.keys(merged).length) resolved.joints = flip ? mirror(merged) : merged;
  return resolved;
}

/** Returns the spec with every figure pose in its frames resolved. */
export function resolveSpec(spec) {
  return {
    ...spec,
    frames: (spec.frames ?? []).map(frame => ({
      ...frame,
      poses: frame.poses && Object.fromEntries(Object.entries(frame.poses).map(([figure, entry]) => [figure, resolvePose(entry)])),
    })),
  };
}

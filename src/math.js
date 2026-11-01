// Shared geometry helpers. Vectors are [x,y,z].
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.sqrt(dot(a, a));
export const unit = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Source (x,y,z) to Roblox axes (x,z,-y). A proper rotation, so handedness is kept. */
export const toRbx = v => [v[0], v[2], -v[1]];

/** Source's AngleMatrix. angles = [pitch,yaw,roll] in degrees. Returns rows. */
export function angleMatrix([pitch, yaw, roll]) {
  const r = Math.PI / 180;
  const sp = Math.sin(pitch * r), cp = Math.cos(pitch * r);
  const sy = Math.sin(yaw * r), cy = Math.cos(yaw * r);
  const sr = Math.sin(roll * r), cr = Math.cos(roll * r);
  return [
    [cp * cy, sp * sr * cy - cr * sy, sp * cr * cy + sr * sy],
    [cp * sy, sp * sr * sy + cr * cy, sp * cr * sy - sr * cy],
    [-sp, sr * cp, cr * cp],
  ];
}
export const applyM = (m, v) => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

/** Direction a Source light shines, as VRAD builds it. Its pitch has the opposite sign to AngleMatrix: -60 points down. */
export function lightDir([pitch, yaw]) {
  const r = Math.PI / 180;
  const cp = Math.cos(pitch * r);
  return [cp * Math.cos(yaw * r), cp * Math.sin(yaw * r), Math.sin(pitch * r)];
}

/** Conjugate a Source rotation into Roblox axes: T R T^-1. Returns the 9 CFrame numbers, row order. */
export function rotToRbx(m) {
  const col = i => toRbx(applyM(m, invT(i)));
  const c0 = col(0), c1 = col(1), c2 = col(2);
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}
// Source direction for each Roblox basis vector (the inverse of toRbx).
function invT(i) {
  return i === 0 ? [1, 0, 0] : i === 1 ? [0, 0, 1] : [0, -1, 0];
}

/** Parse "x y z" entity values. */
export const vec3 = (s, d = [0, 0, 0]) => {
  if (typeof s !== 'string') return d;
  const p = s.trim().split(/\s+/).map(Number);
  return p.length >= 3 && p.every(n => !Number.isNaN(n)) ? p.slice(0, 3) : d;
};

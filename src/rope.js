// How far a Source rope really hangs. The Slack key isn't extra length: the engine adds -100 to it,
// so most ropes are shorter than the gap they span and sag only because gravity beats the solver.
// That can't be worked out from the keys alone, so this runs the same solver until it settles.
import { sub, add, mul, len } from './math.js';

const SLACK_FUDGE = -100;        // ROPESLACK_FUDGEFACTOR
const GRAVITY_STEP = -1500 * 0.5 / (50 * 50); // ROPE_GRAVITY at the engine's 50 Hz rope step
const ITERATIONS = 3;
const SETTLE_STEPS = 500;
const SETTLE_DAMP = 0.9;         // Only sets how fast it comes to rest, not where

/** The settled rope's length along its curve, in Source units, between two Z-up points. */
export function hangingLength(a, b, slack, nodes = 10) {
  const gap = len(sub(b, a));
  if (gap < 1e-6) return 0;
  const count = Math.max(2, nodes);
  const rest = Math.max((Math.trunc(gap) + slack + SLACK_FUDGE) / (count - 1), 0);
  const pos = Array.from({ length: count }, (_, i) => add(a, mul(sub(b, a), i / (count - 1))));
  const prev = pos.map(p => [...p]);

  for (let step = 0; step < SETTLE_STEPS; step++) {
    for (let i = 0; i < count; i++) {
      const p = pos[i], was = prev[i];
      prev[i] = [...p];
      pos[i] = [
        p[0] + (p[0] - was[0]) * SETTLE_DAMP,
        p[1] + (p[1] - was[1]) * SETTLE_DAMP,
        p[2] + (p[2] - was[2]) * SETTLE_DAMP + GRAVITY_STEP,
      ];
    }
    for (let k = 0; k < ITERATIONS; k++) {
      for (let i = 0; i + 1 < count; i++) {
        const to = sub(pos[i], pos[i + 1]);
        const dist = len(to);
        if (dist <= rest || dist === 0) continue;
        const move = mul(to, (1 - rest / dist) * 0.5);
        pos[i] = sub(pos[i], move);
        pos[i + 1] = add(pos[i + 1], move);
      }
      pos[0] = [...a];
      pos[count - 1] = [...b];
    }
  }

  let total = 0;
  for (let i = 0; i + 1 < count; i++) total += len(sub(pos[i + 1], pos[i]));
  return Math.max(total, gap);
}

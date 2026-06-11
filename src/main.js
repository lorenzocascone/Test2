/**
 * main.js — Entry point.
 *
 * Responsibilities are deliberately tiny:
 *   1. Grab the canvas and construct the Engine.
 *   2. Run the game loop with requestAnimationFrame, handing the engine a
 *      clean, clamped delta-time each frame.
 *
 * Everything game-specific lives in engine.js and ship.js.
 */

import { Engine } from "./engine.js";

/** Never simulate more than this many seconds in one step. If the tab is
 *  backgrounded, rAF pauses and the next frame could report a huge delta;
 *  clamping prevents the physics from exploding when we come back. */
const MAX_DELTA = 1 / 20; // 50 ms

const canvas = document.getElementById("game-canvas");
const engine = new Engine(canvas);

/** Timestamp of the previous frame, for delta-time calculation. */
let lastTime = performance.now();

/**
 * The game loop. requestAnimationFrame calls this once per display frame
 * (typically 60 Hz), passing a high-resolution timestamp.
 *
 * @param {DOMHighResTimeStamp} now
 */
function frame(now) {
  // Delta time in seconds, clamped so a long pause can't break physics.
  const dt = Math.min(MAX_DELTA, (now - lastTime) / 1000);
  lastTime = now;

  engine.update(dt); // advance simulation (input → physics → state)
  engine.render();   // draw the world for the new state

  requestAnimationFrame(frame); // schedule the next frame
}

// Kick everything off.
requestAnimationFrame(frame);

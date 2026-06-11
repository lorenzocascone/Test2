/**
 * enemy.js — AI-controlled ships.
 *
 * Two temperaments:
 *  - Merchants (Spanish/English/French) wander between random waypoints
 *    and mind their own business — until you fire on them.
 *  - Pirates are aggressive: if the player sails into their sight
 *    radius they turn, give chase, and fire broadsides in range.
 *
 * AI movement is a simplified version of the player's sailing model:
 * steer toward a desired heading at a capped turn rate, ease speed
 * toward a wind-modulated cruise speed. They obey the same land
 * collisions (the engine grounds them like the player), plus a simple
 * island-repulsion steer so they rarely beach themselves.
 */

import { factionColor } from "./port.js";

// --- AI tuning --------------------------------------------------------------

/** Pirates notice the player inside this range (world units). */
const AGGRO_RADIUS = 750;

/** Chasers stop closing and start broadsiding inside this range. */
const FIRE_RANGE = 330;

/** How long a sinking ship takes to slip under (seconds). */
const SINK_DURATION = 2.4;

/** AI turn rate (radians/second). A touch worse than the player's. */
const TURN_RATE = 1.0;

/** Acceleration easing toward cruise speed (1/s). */
const ACCEL = 0.6;

/** Small helper: wrap any angle into (-PI, PI]. */
function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

export class EnemyShip {
  /**
   * @param {object} opts
   * @param {number} opts.x,y       spawn position
   * @param {string} opts.faction   Spanish | English | French | Pirate
   */
  constructor({ x, y, faction }) {
    this.x = x;
    this.y = y;
    this.faction = faction;
    this.angle = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.angularVelocity = 0; // unused by the AI, read by engine grounding

    // Pirates are predators; merchants are prey (until provoked).
    this.aggressive = faction === "Pirate";
    this.provoked = false;

    this.maxSpeed = this.aggressive ? 150 : 120;
    this.maxHull = this.aggressive ? 45 : 30;
    this.hull = this.maxHull;

    // Combat plumbing read/reset by the engine each frame.
    this.reload = 2 + Math.random() * 3; // first shot isn't instant
    this.wantsToFire = false;
    this.fireSide = 1;

    // Sinking countdown; 0 = afloat. Once it hits 0 again, remove me.
    this.sinking = 0;

    this.waypoint = null;
    this.length = 44;
    this.width = 18;
  }

  /** Still a live combatant (not sunk / sinking)? */
  get alive() {
    return this.hull > 0;
  }

  /**
   * Take cannon damage. A merchant that gets shot stops being neutral.
   * @returns {boolean} true if this hit was the killing blow
   */
  takeDamage(dmg) {
    if (!this.alive) return false;
    this.hull -= dmg;
    this.provoked = true;
    if (this.hull <= 0) {
      this.hull = 0;
      this.sinking = SINK_DURATION;
      return true;
    }
    return false;
  }

  /**
   * One AI think+move step.
   *
   * @param {number} dt
   * @param {import("./ship.js").Ship} player
   * @param {{angle:number, speed:number}} wind
   * @param {import("./world.js").WorldRenderer} world for island avoidance
   */
  update(dt, player, wind, world) {
    // Sinking ships only count down; the engine removes them at 0.
    if (this.sinking > 0) {
      this.sinking -= dt;
      return;
    }

    this.reload -= dt;

    // ---------------- State: chase or wander? -------------------------
    const pdx = player.x - this.x;
    const pdy = player.y - this.y;
    const playerDist = Math.hypot(pdx, pdy);
    const hunting = (this.aggressive || this.provoked) && playerDist < AGGRO_RADIUS;

    // ---------------- Pick the point we're sailing toward -------------
    let tx, ty;
    if (hunting) {
      tx = player.x;
      ty = player.y;
    } else {
      // Wander: pick a fresh random waypoint when none, or on arrival.
      if (!this.waypoint || Math.hypot(this.waypoint.x - this.x, this.waypoint.y - this.y) < 120) {
        this.waypoint = {
          x: 300 + Math.random() * 5400,
          y: 300 + Math.random() * 5400,
        };
      }
      tx = this.waypoint.x;
      ty = this.waypoint.y;
    }

    // Desired heading toward the target...
    let dirX = tx - this.x;
    let dirY = ty - this.y;
    const dirLen = Math.hypot(dirX, dirY) || 1;
    dirX /= dirLen;
    dirY /= dirLen;

    // ...bent away from any island we're getting close to. Repulsion
    // strength ramps up as we near the coast, overpowering the goal.
    for (let i = 0; i < world.islands.length; i++) {
      const isle = world.islands[i];
      const ix = this.x - isle.x;
      const iy = this.y - isle.y;
      const d = Math.hypot(ix, iy);
      const danger = isle.r * 1.25 + 160;
      if (d < danger && d > 0.001) {
        const push = (1 - d / danger) * 2.2;
        dirX += (ix / d) * push;
        dirY += (iy / d) * push;
      }
    }
    const desired = Math.atan2(dirY, dirX);

    // ---------------- Steer + sail ------------------------------------
    const diff = normalizeAngle(desired - this.angle);
    const maxTurn = TURN_RATE * dt;
    this.angle = normalizeAngle(
      this.angle + Math.min(maxTurn, Math.max(-maxTurn, diff))
    );

    // Cruise speed: wind matters, but the AI sails a bit "cleaner" than
    // the player (no in-irons death zone) so chases stay threatening.
    const offWind = Math.abs(normalizeAngle(this.angle - wind.angle));
    const fromUpwind = Math.PI - offWind;
    const windFactor = 0.45 + 0.55 * Math.sin(Math.max(0.25, fromUpwind) / 2 + 0.4);
    let cruise = this.maxSpeed * windFactor * Math.min(1, wind.speed / 8);

    // In firing range: stop closing, hold distance and trade broadsides.
    if (hunting && playerDist < FIRE_RANGE * 0.8) cruise *= 0.35;

    this.speed += (cruise - this.speed) * ACCEL * dt;
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    // ---------------- Gunnery -----------------------------------------
    // In range and reloaded: signal the engine to fire the broadside on
    // whichever side faces the player.
    if (hunting && playerDist < FIRE_RANGE && this.reload <= 0) {
      this.reload = 3.5 + Math.random() * 2.5;
      this.wantsToFire = true;
      // Cross product of heading × bearing tells us which side they're on.
      const cross =
        Math.cos(this.angle) * pdy - Math.sin(this.angle) * pdx;
      this.fireSide = cross > 0 ? 1 : -1;
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx world-space context
   * @param {number} time seconds for bob animation
   */
  draw(ctx, time) {
    const L = this.length;
    const W = this.width;
    const color = factionColor(this.faction);

    ctx.save();
    ctx.translate(this.x, this.y);

    // Sinking: the hull tilts, shrinks and fades into a foam ring.
    if (this.sinking > 0) {
      const t = 1 - this.sinking / SINK_DURATION; // 0 → 1 as it goes down
      ctx.globalAlpha = 1 - t;
      ctx.rotate(this.angle + t * 0.7); // listing over as she goes
      ctx.scale(1 - t * 0.5, 1 - t * 0.5);
      ctx.translate(0, t * 6);
    } else {
      ctx.rotate(this.angle);
      ctx.translate(0, Math.sin(time * 1.8 + this.x * 0.01) * 1.2); // bob
    }

    // --- Hull: darker, plainer than the player's ----------------------
    ctx.fillStyle = this.aggressive ? "#3f3a35" : "#6b4a2c";
    ctx.strokeStyle = "#221710";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L / 2, 0);
    ctx.quadraticCurveTo(L / 3, -W / 2, L / 8, -W / 2);
    ctx.lineTo(-L / 2 + 5, -W / 2.4);
    ctx.quadraticCurveTo(-L / 2, 0, -L / 2 + 5, W / 2.4);
    ctx.lineTo(L / 8, W / 2);
    ctx.quadraticCurveTo(L / 3, W / 2, L / 2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // --- Sail: always set (the AI never furls) ------------------------
    if (this.sinking === 0 || this.sinking > SINK_DURATION * 0.5) {
      ctx.fillStyle = this.aggressive ? "#d8d2c2" : "#f3eedd";
      ctx.strokeStyle = "#8d8470";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(L * 0.1, -W * 0.85);
      ctx.quadraticCurveTo(-L / 4, 0, L * 0.1, W * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // --- Faction flag at the masthead ----------------------------------
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(L * 0.1, 0);
    ctx.lineTo(L * 0.1 + 13, -4);
    ctx.lineTo(L * 0.1 + 13, 4);
    ctx.closePath();
    ctx.fill();

    // Pirates fly the black: a tiny skull dot on their flag.
    if (this.aggressive) {
      ctx.fillStyle = "#f0ece2";
      ctx.beginPath();
      ctx.arc(L * 0.1 + 9, 0, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // --- Health bar, floated above a damaged (but afloat) ship ---------
    if (this.alive && this.hull < this.maxHull) {
      const frac = this.hull / this.maxHull;
      const bw = 36;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(this.x - bw / 2, this.y - 34, bw, 5);
      ctx.fillStyle = frac > 0.5 ? "#7ec96a" : frac > 0.25 ? "#e0b73f" : "#c8414f";
      ctx.fillRect(this.x - bw / 2, this.y - 34, bw * frac, 5);
    }
  }
}

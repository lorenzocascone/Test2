/**
 * combat.js — Shared combat objects: cannonballs and floating loot.
 *
 * Both the player and enemy ships fire the same Cannonball; ownership
 * ("player" | "enemy") decides what it can hit. Loot is what's left
 * bobbing on the waves after a ship goes down — sail over it to collect.
 */

/** Cannonball flight speed, world units / second. */
const BALL_SPEED = 470;

/** Cannonballs sink after this long (≈ 400 world-units of range). */
const BALL_LIFETIME = 0.85;

export class Cannonball {
  /**
   * @param {number} x,y     muzzle position
   * @param {number} angle   flight direction (radians)
   * @param {string} owner   "player" | "enemy" — what it can damage
   * @param {number} damage  hull points removed on a hit
   */
  constructor(x, y, angle, owner, damage) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * BALL_SPEED;
    this.vy = Math.sin(angle) * BALL_SPEED;
    this.owner = owner;
    this.damage = damage;
    this.age = 0;
  }

  /** True once the ball has flown its range and splashes down. */
  get expired() {
    return this.age >= BALL_LIFETIME;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.age += dt;
  }

  /** @param {CanvasRenderingContext2D} ctx world-space context */
  draw(ctx) {
    // Muzzle flash for the first instants of flight.
    if (this.age < 0.06) {
      ctx.fillStyle = `rgba(255, 200, 90, ${1 - this.age / 0.06})`;
      ctx.beginPath();
      ctx.arc(this.x, this.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Smoke trail: a short fading line opposite the flight direction.
    const fade = 1 - this.age / BALL_LIFETIME;
    ctx.strokeStyle = `rgba(220, 220, 220, ${0.35 * fade})`;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(this.x - this.vx * 0.045, this.y - this.vy * 0.045);
    ctx.stroke();

    // The ball itself.
    ctx.fillStyle = "#1c1c1c";
    ctx.beginPath();
    ctx.arc(this.x, this.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

/** Floating wreckage despawns after this many seconds, unclaimed. */
const LOOT_LIFETIME = 75;

export class Loot {
  /**
   * @param {number} x,y     spawn position (the wreck site)
   * @param {string} type    "gold" or a GOODS key (food/rum/sugar/cannons)
   * @param {number} amount  gold pieces or units of cargo
   */
  constructor(x, y, type, amount) {
    // Scatter outward from the sinking ship with a little drift.
    const a = Math.random() * Math.PI * 2;
    const v = 18 + Math.random() * 26;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(a) * v;
    this.vy = Math.sin(a) * v;
    this.type = type;
    this.amount = amount;
    this.age = 0;
    this.bobPhase = Math.random() * Math.PI * 2;
  }

  get expired() {
    return this.age >= LOOT_LIFETIME;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // Drift dies away quickly; then it just bobs in place.
    this.vx -= this.vx * 1.2 * dt;
    this.vy -= this.vy * 1.2 * dt;
    this.age += dt;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx world-space context
   * @param {number} time seconds, for bobbing
   */
  draw(ctx, time) {
    const bob = Math.sin(time * 2.2 + this.bobPhase) * 2;
    // Fade out during the final seconds before despawning.
    const fade = Math.min(1, (LOOT_LIFETIME - this.age) / 4);

    ctx.save();
    ctx.translate(this.x, this.y + bob);
    ctx.globalAlpha = fade;

    // Ripple ring so loot reads as "floating in water".
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 3, 13 + bob, 5, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (this.type === "gold") {
      // A little treasure chest: dark wood, golden lid seam.
      ctx.fillStyle = "#5a3a1e";
      ctx.fillRect(-7, -6, 14, 11);
      ctx.fillStyle = "#f0c040";
      ctx.fillRect(-7, -2, 14, 2.5);
      ctx.strokeStyle = "#2e1d10";
      ctx.lineWidth = 1;
      ctx.strokeRect(-7, -6, 14, 11);
    } else {
      // A barrel: staves + hoops, rolled on its side.
      ctx.fillStyle = "#8a5a33";
      ctx.beginPath();
      ctx.ellipse(0, 0, 8, 6, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3a2718";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, -5.5);
      ctx.lineTo(-6, 5);
      ctx.moveTo(4, -5);
      ctx.lineTo(2, 5.8);
      ctx.stroke();
    }

    ctx.restore();
  }
}

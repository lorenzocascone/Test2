/**
 * ship.js — Player ship: position, orientation, and sailing physics.
 *
 * The core idea (borrowed from real sailing and Sid Meier's Pirates!):
 * your speed depends on your heading RELATIVE to the wind.
 *
 *   - "In irons"  (bow pointed into the wind)  → almost no drive.
 *   - "Close-hauled" (~45° off the wind)        → modest speed.
 *   - "Beam reach"  (wind from the side)        → fast.
 *   - "Broad reach" (~135° off the wind)        → fastest point of sail.
 *   - "Running"     (wind dead astern)          → fast, but a bit less
 *                                                 than a broad reach.
 *
 * All angles in this file are radians. Angle 0 points to the +X axis
 * (east on screen) and increases clockwise, matching canvas coordinates.
 */

// ---------------------------------------------------------------------------
// Tuning constants — tweak these to change how the ship "feels".
// ---------------------------------------------------------------------------

/** Top speed (world units / second) with perfect wind and full sails. */
const MAX_SPEED = 220;

/** How quickly the ship accelerates toward its target speed (1/s).
 *  Higher = snappier. Lower = heavier, more momentum-laden feel. */
const ACCELERATION = 0.55;

/** Passive water drag applied every frame (1/s). This is what slows the
 *  ship when sails are furled or the wind dies. */
const WATER_DRAG = 0.35;

/** Maximum turn rate at full speed (radians / second). */
const MAX_TURN_RATE = 1.4;

/** How fast rudder input builds up angular velocity (1/s).
 *  This gives turning its "momentum": you keep swinging briefly
 *  after releasing the key. */
const TURN_ACCELERATION = 3.0;

/** How quickly angular velocity bleeds off with no rudder input (1/s). */
const TURN_DAMPING = 2.5;

/** How fast the crew can trim sails, in sail-fraction per second.
 *  0 → furled, 1 → full canvas. */
const SAIL_TRIM_RATE = 0.8;

/** Half-angle of the "no-go zone" directly upwind (radians).
 *  Inside this cone the sails luff and produce almost no power. */
const NO_GO_ZONE = Math.PI / 6; // 30° either side of dead upwind

// ---------------------------------------------------------------------------
// Small angle helper
// ---------------------------------------------------------------------------

/** Normalize any angle into the range (-PI, PI]. */
function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

// ---------------------------------------------------------------------------
// Ship class
// ---------------------------------------------------------------------------

export class Ship {
  /**
   * @param {number} x - starting world X
   * @param {number} y - starting world Y
   */
  constructor(x, y) {
    // --- Pose -------------------------------------------------------------
    this.x = x;
    this.y = y;
    this.angle = 0; // heading, radians; 0 = east, increases clockwise

    // --- Linear motion ----------------------------------------------------
    this.speed = 0; // current speed along the heading (world units / s)

    // --- Rotational motion ------------------------------------------------
    this.angularVelocity = 0; // radians / s, built up & damped for momentum

    // --- Sails ------------------------------------------------------------
    // 0 = fully furled (no canvas), 1 = full sail. The player raises and
    // lowers this with W/S; actual drive force = sail * windEfficiency.
    this.sail = 0;

    // --- Cosmetic ---------------------------------------------------------
    this.length = 48; // used by the renderer for the hull size
    this.width = 20;
  }

  /**
   * How efficiently the sails convert wind to forward drive given the
   * ship's heading relative to the wind. Returns 0..1.
   *
   * @param {{angle: number, speed: number}} wind - global wind vector.
   *        wind.angle is the direction the wind blows TOWARD.
   * @returns {number} efficiency multiplier in [0, 1]
   */
  sailEfficiency(wind) {
    // Angle between our heading and the wind's destination direction.
    // 0       → wind dead astern (running)
    // PI      → sailing straight INTO the wind (in irons)
    // PI/2    → beam reach
    const offWind = Math.abs(normalizeAngle(this.angle - wind.angle));

    // "Point of sail" measured from dead-upwind, 0..PI:
    // 0 = into the wind, PI = dead downwind.
    const fromUpwind = Math.PI - offWind;

    // Inside the no-go zone: sails flap uselessly. Tiny residual value so
    // the ship can still creep out of irons rather than being stuck forever.
    if (fromUpwind < NO_GO_ZONE) {
      return 0.05;
    }

    // Outside the no-go zone we use a smooth curve that:
    //   - ramps up from the edge of the no-go zone,
    //   - peaks around a broad reach (~135° from upwind),
    //   - dips slightly when running dead downwind.
    //
    // sin(fromUpwind) alone peaks at a beam reach (90°); blending in a
    // second harmonic shifts the peak toward the broad reach, which is
    // both realistic and rewards skillful tacking.
    const base = Math.sin(fromUpwind);                 // 0 at irons, 0 downwind
    const broadBias = Math.sin(fromUpwind / 2);        // grows toward downwind
    const efficiency = 0.55 * base + 0.45 * broadBias; // peak ≈ 135°

    return Math.min(1, Math.max(0, efficiency));
  }

  /**
   * Advance the ship simulation by one time step.
   *
   * @param {number} dt - seconds since last frame (already clamped upstream)
   * @param {{left:boolean, right:boolean, up:boolean, down:boolean}} input
   * @param {{angle: number, speed: number}} wind - global wind vector
   */
  update(dt, input, wind) {
    // -----------------------------------------------------------------
    // 1. Sail trim — W raises canvas, S lowers it, gradually.
    // -----------------------------------------------------------------
    if (input.up) this.sail += SAIL_TRIM_RATE * dt;
    if (input.down) this.sail -= SAIL_TRIM_RATE * dt;
    this.sail = Math.min(1, Math.max(0, this.sail));

    // -----------------------------------------------------------------
    // 2. Steering with momentum.
    //    Rudder input accelerates angular velocity; releasing the key
    //    lets damping bleed it off, so the bow keeps swinging briefly.
    // -----------------------------------------------------------------
    let rudder = 0;
    if (input.left) rudder -= 1;
    if (input.right) rudder += 1;

    if (rudder !== 0) {
      this.angularVelocity += rudder * TURN_ACCELERATION * dt;
    } else {
      // Exponential-style decay toward zero when the rudder is centered.
      this.angularVelocity -= this.angularVelocity * TURN_DAMPING * dt;
    }

    // A real rudder only bites when water flows past it: scale the
    // usable turn rate with current speed (with a small floor so the
    // ship is never completely unsteerable).
    const speedFactor = 0.25 + 0.75 * Math.min(1, this.speed / (MAX_SPEED * 0.5));
    const maxTurn = MAX_TURN_RATE * speedFactor;
    this.angularVelocity = Math.min(maxTurn, Math.max(-maxTurn, this.angularVelocity));

    this.angle = normalizeAngle(this.angle + this.angularVelocity * dt);

    // -----------------------------------------------------------------
    // 3. Drive force from the wind.
    //    Target speed = top speed × sail trim × wind strength × the
    //    point-of-sail efficiency curve. We then ease the current speed
    //    toward that target for smooth acceleration.
    // -----------------------------------------------------------------
    const windStrength = Math.min(1, wind.speed / 10); // 10 kn ≈ "full" wind
    const targetSpeed = MAX_SPEED * this.sail * windStrength * this.sailEfficiency(wind);

    if (targetSpeed > this.speed) {
      // Accelerate: ease toward target. The gap shrinks exponentially,
      // giving a satisfying surge that tapers off near top speed.
      this.speed += (targetSpeed - this.speed) * ACCELERATION * dt;
    } else {
      // Decelerate: water drag pulls us down toward the (lower) target.
      this.speed += (targetSpeed - this.speed) * WATER_DRAG * dt;
    }

    // Turning sheds a little speed — leaning on the rudder costs you.
    this.speed -= this.speed * Math.abs(this.angularVelocity) * 0.15 * dt;
    if (this.speed < 0.01) this.speed = 0;

    // -----------------------------------------------------------------
    // 4. Integrate position along the current heading.
    // -----------------------------------------------------------------
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
  }

  /**
   * Draw the ship. The canvas context is assumed to already be translated
   * by the camera, so we draw in world coordinates.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    const L = this.length;
    const W = this.width;

    // --- Wake: two faint trailing lines, longer the faster we go --------
    if (this.speed > 5) {
      const wakeLen = (this.speed / MAX_SPEED) * 70;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-L / 2, -W / 3);
      ctx.lineTo(-L / 2 - wakeLen, -W / 2);
      ctx.moveTo(-L / 2, W / 3);
      ctx.lineTo(-L / 2 - wakeLen, W / 2);
      ctx.stroke();
    }

    // --- Hull: a pointed-bow polygon ------------------------------------
    ctx.fillStyle = "#6b4226"; // weathered timber
    ctx.strokeStyle = "#3d2716";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L / 2, 0);            // bow tip
    ctx.lineTo(L / 6, -W / 2);       // starboard shoulder
    ctx.lineTo(-L / 2, -W / 2.6);    // starboard quarter
    ctx.lineTo(-L / 2, W / 2.6);     // port quarter
    ctx.lineTo(L / 6, W / 2);        // port shoulder
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // --- Deck line for a bit of detail -----------------------------------
    ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L / 2 - 6, 0);
    ctx.lineTo(-L / 2 + 4, 0);
    ctx.stroke();

    // --- Sail: a billowing arc whose size reflects the trim level --------
    if (this.sail > 0.02) {
      const sailH = (W * 1.6) * this.sail; // canvas spread scales with trim
      ctx.fillStyle = "rgba(245, 240, 225, 0.95)";
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(2, -sailH / 2);
      // The quadratic control point bows the sail backward, as if filled.
      ctx.quadraticCurveTo(-L / 3, 0, 2, sailH / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Mast dot
      ctx.fillStyle = "#3d2716";
      ctx.beginPath();
      ctx.arc(2, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}

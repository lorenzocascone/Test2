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
const MAX_SPEED = 255;

/** How quickly the ship accelerates toward its target speed (1/s).
 *  Higher = snappier. Lower = heavier, more momentum-laden feel. */
const ACCELERATION = 0.85;

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
const SAIL_TRIM_RATE = 1.1;

/** Half-angle of the "no-go zone" directly upwind (radians).
 *  Inside this cone the sails luff and produce almost no power. */
const NO_GO_ZONE = Math.PI / 7.2; // 25° either side of dead upwind

/** Efficiency floor outside the no-go zone. Even on a poor point of
 *  sail the ship keeps decent way — wind angle is a meaningful bonus
 *  to chase, never a wall that makes movement a chore. */
const EFFICIENCY_FLOOR = 0.35;

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

    // --- Combat -------------------------------------------------------------
    this.maxHull = 100;
    this.hull = 100;   // reaches 0 → game over (engine handles it)
    this.reload = 0;   // seconds until the next broadside is ready

    // --- Cosmetic ---------------------------------------------------------
    this.length = 48; // used by the renderer for the hull size
    this.width = 20;

    // Wake foam particles: {x, y, life} in world coordinates, spawned at
    // the stern while moving and faded out over ~1.5 seconds.
    this.wake = [];
    this._wakeTimer = 0;
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

    // Inside the no-go zone: sails luff. Still some steerage way so
    // escaping irons is quick, never a waiting game.
    if (fromUpwind < NO_GO_ZONE) {
      return 0.15;
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
    const curve = 0.55 * base + 0.45 * broadBias;      // peak ≈ 135°

    // Remap onto a generous floor: a bad angle costs you the top ~half
    // of your speed, not all of it. Fun first, simulation second.
    return EFFICIENCY_FLOOR + (1 - EFFICIENCY_FLOOR) * Math.min(1, Math.max(0, curve));
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
    const speedFactor = 0.4 + 0.6 * Math.min(1, this.speed / (MAX_SPEED * 0.5));
    const maxTurn = MAX_TURN_RATE * speedFactor;
    this.angularVelocity = Math.min(maxTurn, Math.max(-maxTurn, this.angularVelocity));

    this.angle = normalizeAngle(this.angle + this.angularVelocity * dt);

    // -----------------------------------------------------------------
    // 3. Drive force from the wind.
    //    Target speed = top speed × sail trim × wind strength × the
    //    point-of-sail efficiency curve. We then ease the current speed
    //    toward that target for smooth acceleration.
    // -----------------------------------------------------------------
    // Light air still gives nearly half power — a dying breeze slows
    // you, it doesn't park you.
    const windStrength = 0.45 + 0.55 * Math.min(1, wind.speed / 9);
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

    // -----------------------------------------------------------------
    // 5. Wake: churned-water streaks shed from BOTH quarters of the
    //    stern with outward velocity, so the trail spreads into the
    //    classic V behind the ship. Each particle is a little water
    //    streak (drawn as a line along its drift direction), not a
    //    puff — water, not smoke.
    // -----------------------------------------------------------------
    this._wakeTimer -= dt;
    if (this.speed > 25 && this._wakeTimer <= 0) {
      this._wakeTimer = 6 / this.speed; // denser trail at higher speed
      const sternX = this.x - Math.cos(this.angle) * (this.length / 2);
      const sternY = this.y - Math.sin(this.angle) * (this.length / 2);
      // Unit vector pointing to starboard (perpendicular to the keel).
      const perpX = -Math.sin(this.angle);
      const perpY = Math.cos(this.angle);

      for (const side of [-1, 1]) {
        // Outward + slightly backward drift, with a touch of randomness.
        const lateral = side * (10 + this.speed * 0.1) * (0.7 + Math.random() * 0.6);
        this.wake.push({
          x: sternX + perpX * side * this.width * 0.35,
          y: sternY + perpY * side * this.width * 0.35,
          vx: perpX * lateral - Math.cos(this.angle) * this.speed * 0.05,
          vy: perpY * lateral - Math.sin(this.angle) * this.speed * 0.05,
          life: 1,
        });
      }
      if (this.wake.length > 90) this.wake.splice(0, 2);
    }
    for (let i = this.wake.length - 1; i >= 0; i--) {
      const p = this.wake[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Water drag: the spreading slows as the streak dissipates.
      p.vx -= p.vx * 1.6 * dt;
      p.vy -= p.vy * 1.6 * dt;
      p.life -= dt * 0.8;
      if (p.life <= 0) this.wake.splice(i, 1);
    }
  }

  /**
   * Burst of spray at the bow — fired by the engine when the ship runs
   * aground at speed. Reuses the wake particle system, so the spray
   * renders as the same churned-water streaks.
   */
  splash() {
    const bowX = this.x + Math.cos(this.angle) * (this.length / 2);
    const bowY = this.y + Math.sin(this.angle) * (this.length / 2);
    for (let i = 0; i < 10; i++) {
      // Spray fans out ahead of the bow in a wide cone.
      const a = this.angle + (Math.random() - 0.5) * 2.4;
      const v = 25 + Math.random() * 45;
      this.wake.push({
        x: bowX,
        y: bowY,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 1,
      });
    }
  }

  /**
   * Draw the ship. The canvas context is assumed to already be translated
   * by the camera, so we draw in world coordinates.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} time - seconds, for bobbing/flag animation
   * @param {{angle:number, speed:number}} wind - so the pennant can stream
   */
  draw(ctx, time, wind) {
    const L = this.length;
    const W = this.width;

    // --- Wake first, in world space, under everything --------------------
    // Each particle renders as a short streak along its drift direction;
    // together the two shed lines spread into a turbulent V.
    ctx.lineCap = "round";
    for (const p of this.wake) {
      const drift = Math.hypot(p.vx, p.vy) || 1;
      const len = 3 + (1 - p.life) * 9; // streaks stretch as they dissipate
      const nx = (p.vx / drift) * len;
      const ny = (p.vy / drift) * len;

      ctx.globalAlpha = p.life * 0.55;
      ctx.strokeStyle = "#dff3ff";
      ctx.lineWidth = 1.5 + p.life * 1.5; // fat near the ship, thin far out
      ctx.beginPath();
      ctx.moveTo(p.x - nx, p.y - ny);
      ctx.lineTo(p.x + nx, p.y + ny);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    // --- Stern churn: boiling white water right behind the transom -------
    if (this.speed > 20) {
      const churn = this.speed / MAX_SPEED;
      ctx.fillStyle = "#e8f7ff";
      for (let i = 0; i < 3; i++) {
        // Three jittering froth blobs that overlap into a roiling patch.
        const jx = Math.sin(time * 11 + i * 2.1) * 2.5;
        const jy = Math.cos(time * 13 + i * 1.7) * (W * 0.18);
        ctx.globalAlpha = 0.3 * churn;
        ctx.beginPath();
        ctx.ellipse(-L / 2 - 4 + jx, jy, 7 * churn + 2, 4 * churn + 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Gentle idle bob: a touch of lateral sway and roll, purely visual.
    ctx.translate(0, Math.sin(time * 1.8) * 1.3);
    ctx.rotate(Math.sin(time * 1.4) * 0.015);

    // --- Hull shadow in the water ----------------------------------------
    ctx.fillStyle = "rgba(0, 10, 20, 0.25)";
    ctx.beginPath();
    ctx.ellipse(-2, 3, L * 0.55, W * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Hull: planked timber with a lit port side ------------------------
    // The gradient lives in local (rotated) coordinates, so it's the
    // same object every frame — build it once and cache it.
    if (!this._hullGrad) {
      this._hullGrad = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
      this._hullGrad.addColorStop(0, "#8a5a33");
      this._hullGrad.addColorStop(0.5, "#6b4226");
      this._hullGrad.addColorStop(1, "#4e3019");
    }
    ctx.fillStyle = this._hullGrad;
    ctx.strokeStyle = "#2e1d10";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(L / 2, 0);            // bow tip
    ctx.quadraticCurveTo(L / 3, -W / 2, L / 8, -W / 2);   // starboard bow curve
    ctx.lineTo(-L / 2 + 6, -W / 2.4);                     // starboard side
    ctx.quadraticCurveTo(-L / 2, -W / 4, -L / 2, 0);      // rounded stern
    ctx.quadraticCurveTo(-L / 2, W / 4, -L / 2 + 6, W / 2.4);
    ctx.lineTo(L / 8, W / 2);                             // port side
    ctx.quadraticCurveTo(L / 3, W / 2, L / 2, 0);         // port bow curve
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // --- Deck planks --------------------------------------------------------
    ctx.strokeStyle = "rgba(0, 0, 0, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const off of [-W / 5, 0, W / 5]) {
      ctx.moveTo(L / 2 - 8, off * 0.4);
      ctx.lineTo(-L / 2 + 5, off);
    }
    ctx.stroke();

    // --- Cannon ports: three black squares along each gunwale --------------
    ctx.fillStyle = "#1c120a";
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const cx = L / 6 - i * (L / 4.2);
        ctx.fillRect(cx - 2, side * (W / 2) * 0.82 - 2, 4, 4);
      }
    }

    // --- Stern castle: the raised quarterdeck at the back -------------------
    ctx.fillStyle = "#7a4e2a";
    ctx.strokeStyle = "#2e1d10";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(-L / 2 + 4, -W / 3.2, L / 5, (W / 3.2) * 2);
    ctx.fill();
    ctx.stroke();

    // --- Bowsprit: the spar jutting forward off the bow ----------------------
    ctx.strokeStyle = "#3a2718";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(L / 2 - 2, 0);
    ctx.lineTo(L / 2 + 13, 0);
    ctx.stroke();

    // --- Sails: two square sails that billow with the trim level -------------
    // Drawn top-down as curved sheets perpendicular to the keel.
    if (this.sail > 0.02) {
      const masts = [
        { x: L * 0.14, span: W * 1.9 },  // main mast — the big one
        { x: -L * 0.22, span: W * 1.4 }, // mizzen — smaller, astern
      ];
      // Sail shading gradients are cached per mast: the shading runs
      // over the sail's maximum depth in fixed local coordinates, so it
      // doesn't need rebuilding as the belly animates.
      if (!this._sailGrads) {
        this._sailGrads = masts.map((mast) => {
          const g = ctx.createLinearGradient(mast.x, 0, mast.x - L / 3.4, 0);
          g.addColorStop(0, "#f7f2e3");
          g.addColorStop(1, "#d9d0b8");
          return g;
        });
      }

      for (let m = 0; m < masts.length; m++) {
        const mast = masts[m];
        const half = (mast.span * this.sail) / 2;
        // Belly of the sail bows backward; a hint of flutter when slack.
        const belly = L / 3.4 * this.sail + Math.sin(time * 6 + mast.x) * (1 - this.sail) * 2;

        ctx.fillStyle = this._sailGrads[m];
        ctx.strokeStyle = "#8d8470";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mast.x, -half);
        ctx.quadraticCurveTo(mast.x - belly, 0, mast.x, half);
        // Yard (the cross spar): a straight line closing the shape.
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // --- Masts (dots from above) ----------------------------------------------
    ctx.fillStyle = "#2e1d10";
    for (const mx of [L * 0.14, -L * 0.22]) {
      ctx.beginPath();
      ctx.arc(mx, 0, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Rigging: shroud lines from each masthead down to the gunwales ---
    ctx.strokeStyle = "rgba(20, 12, 6, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const mx of [L * 0.14, -L * 0.22]) {
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx - L * 0.12, -W * 0.44);
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx - L * 0.12, W * 0.44);
    }
    ctx.stroke();

    // --- Pennant: a red ribbon streaming downwind from the main mast ----------
    if (wind) {
      // Convert the global wind direction into the ship's local frame.
      const localWind = wind.angle - this.angle;
      ctx.save();
      ctx.translate(L * 0.14, 0);
      ctx.rotate(localWind);
      const wave = Math.sin(time * 7) * 2.5;
      ctx.fillStyle = "#c8414f";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(9, wave, 18, wave * 0.6);
      ctx.lineTo(12, wave * 0.6 + 3);
      ctx.quadraticCurveTo(7, wave + 3, 0, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }
}

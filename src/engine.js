/**
 * engine.js — Central game engine.
 *
 * Owns:
 *   - Global game state (player resources, wind, world size, the ship).
 *   - Keyboard input (WASD + arrow keys).
 *   - The camera/viewport, so the world can be much larger than the screen.
 *   - World rendering (ocean, islands) and HUD updates.
 *
 * main.js drives this class: it calls update(dt) then render() every frame.
 */

import { Ship } from "./ship.js";

// ---------------------------------------------------------------------------
// World tuning
// ---------------------------------------------------------------------------

/** World dimensions in world units — deliberately much larger than any
 *  screen so the camera has room to roam. */
const WORLD_WIDTH = 6000;
const WORLD_HEIGHT = 6000;

/** Spacing of the faint ocean grid that gives a sense of movement. */
const OCEAN_GRID = 200;

/** How quickly the camera eases toward the ship (1/s). Lower = floatier. */
const CAMERA_LERP = 3.0;

/** Crew eat: food consumed per crew member per second (a slow trickle). */
const FOOD_PER_CREW_PER_SEC = 0.005;

/** Compass labels for the wind HUD, clockwise from East (angle 0). */
const COMPASS_POINTS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

export class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // -----------------------------------------------------------------
    // Game state — the single source of truth other modules read from.
    // -----------------------------------------------------------------
    this.state = {
      gold: 100,
      crew: 24,
      food: 80,

      // Global wind vector. `angle` is the direction the wind blows
      // TOWARD (radians, canvas convention: 0 = east, clockwise +).
      // `speed` is in knots; it also drives ship physics via ship.js.
      wind: {
        angle: Math.PI / 4, // initially blowing toward the south-east
        speed: 8,
        // Internal: target values the wind slowly drifts toward, so the
        // breeze feels alive without ever lurching.
        _targetAngle: Math.PI / 4,
        _targetSpeed: 8,
        _retargetTimer: 0,
      },
    };

    // The player's ship starts in the middle of the world.
    this.ship = new Ship(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    // -----------------------------------------------------------------
    // Camera — top-left corner of the visible viewport in world coords.
    // render() translates the canvas by (-camera.x, -camera.y), so
    // anything drawn in world coordinates lands in the right place.
    // -----------------------------------------------------------------
    this.camera = { x: 0, y: 0 };

    // -----------------------------------------------------------------
    // Input — a simple pressed-key map fed by keydown/keyup listeners.
    // WASD and arrow keys are normalized into four logical directions.
    // -----------------------------------------------------------------
    this.input = { up: false, down: false, left: false, right: false };
    this._bindInput();
    this._bindTouchControls();

    // -----------------------------------------------------------------
    // Decorative islands — fixed positions so the map feels consistent.
    // Each entry: x, y, radius. (Collision can be layered on later.)
    // -----------------------------------------------------------------
    this.islands = [
      { x: 1200, y: 900, r: 180 },
      { x: 4400, y: 1400, r: 260 },
      { x: 2300, y: 3600, r: 140 },
      { x: 5100, y: 4700, r: 220 },
      { x: 800, y: 4900, r: 190 },
      { x: 3500, y: 2200, r: 100 },
    ];

    // Cache HUD elements once — querying the DOM every frame is wasteful.
    this.hud = {
      gold: document.getElementById("stat-gold"),
      crew: document.getElementById("stat-crew"),
      food: document.getElementById("stat-food"),
      windSpeed: document.getElementById("stat-wind-speed"),
      windDir: document.getElementById("stat-wind-dir"),
      windArrow: document.getElementById("wind-arrow"),
      shipSpeed: document.getElementById("stat-ship-speed"),
      sails: document.getElementById("stat-sails"),
    };

    // Size the canvas now and keep it matched to the window.
    this._resize();
    window.addEventListener("resize", () => this._resize());

    // Snap the camera onto the ship for the very first frame so we don't
    // visibly pan in from the world origin.
    this._centerCameraOnShip(true);
  }

  // =======================================================================
  // Input handling
  // =======================================================================

  /** Map physical keys to the four logical inputs the ship consumes. */
  _bindInput() {
    // Both WASD and arrows resolve to the same logical action.
    const keyMap = {
      KeyW: "up", ArrowUp: "up",
      KeyS: "down", ArrowDown: "down",
      KeyA: "left", ArrowLeft: "left",
      KeyD: "right", ArrowRight: "right",
    };

    window.addEventListener("keydown", (e) => {
      const action = keyMap[e.code];
      if (action) {
        this.input[action] = true;
        e.preventDefault(); // stop arrows from scrolling the page
      }
    });

    window.addEventListener("keyup", (e) => {
      const action = keyMap[e.code];
      if (action) this.input[action] = false;
    });

    // If the tab loses focus mid-keypress we'd never get the keyup,
    // leaving a key "stuck down" — clear everything to be safe.
    window.addEventListener("blur", () => {
      this.input.up = this.input.down = this.input.left = this.input.right = false;
    });
  }

  /**
   * Wire the on-screen touch buttons (mobile) into the same logical input
   * map the keyboard uses. Each button's data-action attribute names the
   * input flag it drives ("up", "down", "left", "right").
   *
   * Pointer events (rather than touch events) give us mouse compatibility
   * for free, and each finger gets its own pointer stream — so steering
   * with the left thumb while trimming sails with the right "just works".
   */
  _bindTouchControls() {
    const buttons = document.querySelectorAll(".touch-btn");

    for (const btn of buttons) {
      const action = btn.dataset.action;

      const press = (e) => {
        // preventDefault stops the browser from also synthesizing mouse
        // events, scrolling, or showing selection UI for this touch.
        e.preventDefault();
        this.input[action] = true;
        btn.classList.add("active");
      };

      const release = (e) => {
        e.preventDefault();
        this.input[action] = false;
        btn.classList.remove("active");
      };

      btn.addEventListener("pointerdown", press);
      btn.addEventListener("pointerup", release);
      // pointercancel: the OS stole the gesture (e.g. notification shade).
      // pointerleave: the finger slid off the button while held.
      // Both must release the input or it would stick "on" forever.
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("pointerleave", release);

      // No long-press context menu on the controls.
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    }
  }

  // =======================================================================
  // Per-frame update
  // =======================================================================

  /**
   * Advance the whole simulation by dt seconds.
   * @param {number} dt - clamped delta time from main.js
   */
  update(dt) {
    this._updateWind(dt);

    // The ship reads input + wind and integrates its own physics.
    this.ship.update(dt, this.input, this.state.wind);

    // Keep the ship inside the world (soft clamp at the map edge).
    this.ship.x = Math.min(WORLD_WIDTH, Math.max(0, this.ship.x));
    this.ship.y = Math.min(WORLD_HEIGHT, Math.max(0, this.ship.y));

    // Hungry crew nibble away at the food stores.
    this.state.food = Math.max(
      0,
      this.state.food - this.state.crew * FOOD_PER_CREW_PER_SEC * dt
    );

    this._centerCameraOnShip(false, dt);
    this._updateHud();
  }

  /**
   * Slowly wander the wind. Every few seconds we pick a new nearby target
   * angle/speed, then ease the live values toward it — the result is a
   * breeze that shifts believably instead of jumping.
   */
  _updateWind(dt) {
    const w = this.state.wind;

    w._retargetTimer -= dt;
    if (w._retargetTimer <= 0) {
      // New goal: nudge direction up to ±35° and speed within 4–12 kn.
      w._targetAngle = w.angle + (Math.random() - 0.5) * (Math.PI / 2.5);
      w._targetSpeed = 4 + Math.random() * 8;
      w._retargetTimer = 6 + Math.random() * 8; // re-roll in 6–14 s
    }

    // Ease toward the targets (simple exponential smoothing).
    w.angle += (w._targetAngle - w.angle) * 0.15 * dt;
    w.speed += (w._targetSpeed - w.speed) * 0.2 * dt;
  }

  // =======================================================================
  // Camera
  // =======================================================================

  /**
   * Move the camera so the ship sits at the center of the screen,
   * clamped so we never show beyond the world's edges.
   *
   * @param {boolean} snap - true to jump instantly (used on startup)
   * @param {number} [dt]  - needed for smooth follow when snap is false
   */
  _centerCameraOnShip(snap, dt = 0) {
    const viewW = this.canvas.width;
    const viewH = this.canvas.height;

    // Where the camera's top-left should be for a centered ship.
    let targetX = this.ship.x - viewW / 2;
    let targetY = this.ship.y - viewH / 2;

    // Clamp to world bounds (if the world is smaller than the view on an
    // axis, just pin to 0 — Math.max guards the degenerate case).
    targetX = Math.min(Math.max(0, WORLD_WIDTH - viewW), Math.max(0, targetX));
    targetY = Math.min(Math.max(0, WORLD_HEIGHT - viewH), Math.max(0, targetY));

    if (snap) {
      this.camera.x = targetX;
      this.camera.y = targetY;
    } else {
      // Exponential ease: the camera trails the ship slightly, which both
      // smooths motion and gives a pleasing sense of weight.
      this.camera.x += (targetX - this.camera.x) * Math.min(1, CAMERA_LERP * dt);
      this.camera.y += (targetY - this.camera.y) * Math.min(1, CAMERA_LERP * dt);
    }
  }

  // =======================================================================
  // Rendering
  // =======================================================================

  /** Draw the entire frame: ocean, islands, ship. */
  render() {
    const ctx = this.ctx;
    const viewW = this.canvas.width;
    const viewH = this.canvas.height;

    // --- Ocean base color (screen space, no translation needed) ---------
    ctx.fillStyle = "#1a4a6e";
    ctx.fillRect(0, 0, viewW, viewH);

    // Everything below is drawn in WORLD coordinates: translate the
    // context by the camera offset, draw, then restore.
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    this._drawOceanGrid(ctx, viewW, viewH);
    this._drawWorldBorder(ctx);
    this._drawIslands(ctx);
    this.ship.draw(ctx);

    ctx.restore();
  }

  /**
   * Faint grid lines over the water. Without a texture, this is the
   * cheapest way to make motion across the open sea perceptible.
   * Only the lines inside the current viewport are drawn.
   */
  _drawOceanGrid(ctx, viewW, viewH) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;

    // First grid line at/after the camera's left/top edge.
    const startX = Math.floor(this.camera.x / OCEAN_GRID) * OCEAN_GRID;
    const startY = Math.floor(this.camera.y / OCEAN_GRID) * OCEAN_GRID;

    ctx.beginPath();
    for (let x = startX; x <= this.camera.x + viewW; x += OCEAN_GRID) {
      ctx.moveTo(x, this.camera.y);
      ctx.lineTo(x, this.camera.y + viewH);
    }
    for (let y = startY; y <= this.camera.y + viewH; y += OCEAN_GRID) {
      ctx.moveTo(this.camera.x, y);
      ctx.lineTo(this.camera.x + viewW, y);
    }
    ctx.stroke();
  }

  /** A visible line at the edge of the world so players know it's there. */
  _drawWorldBorder(ctx) {
    ctx.strokeStyle = "rgba(255, 220, 150, 0.35)";
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  }

  /** Sandy islands with a green interior — pure decoration for now. */
  _drawIslands(ctx) {
    for (const isle of this.islands) {
      // Quick reject: skip islands entirely off-screen.
      if (
        isle.x + isle.r < this.camera.x ||
        isle.x - isle.r > this.camera.x + this.canvas.width ||
        isle.y + isle.r < this.camera.y ||
        isle.y - isle.r > this.camera.y + this.canvas.height
      ) {
        continue;
      }

      // Sandy beach ring
      ctx.fillStyle = "#d9c98a";
      ctx.beginPath();
      ctx.arc(isle.x, isle.y, isle.r, 0, Math.PI * 2);
      ctx.fill();

      // Vegetated interior
      ctx.fillStyle = "#4a7a3a";
      ctx.beginPath();
      ctx.arc(isle.x, isle.y, isle.r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // =======================================================================
  // HUD
  // =======================================================================

  /** Push current state into the HTML overlay. */
  _updateHud() {
    const { gold, crew, food, wind } = this.state;

    this.hud.gold.textContent = Math.floor(gold);
    this.hud.crew.textContent = crew;
    this.hud.food.textContent = Math.floor(food);

    this.hud.windSpeed.textContent = `${wind.speed.toFixed(1)} kn`;

    // Report the direction the wind blows FROM, sailor-style.
    // wind.angle points where it blows TOWARD, so flip it 180°.
    const fromAngle = wind.angle + Math.PI;
    // Map the angle onto one of 8 compass points (each 45° wide).
    const sector =
      Math.round(((fromAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 4)) % 8;
    this.hud.windDir.textContent = COMPASS_POINTS[sector];

    // Rotate the HUD arrow to point where the wind is blowing toward.
    // CSS rotation is in degrees; the glyph ➤ points right (angle 0).
    this.hud.windArrow.style.transform = `rotate(${(wind.angle * 180) / Math.PI}deg)`;

    // Ship readouts. World units/s → "knots" with an arbitrary fun scale.
    this.hud.shipSpeed.textContent = `${(this.ship.speed / 18).toFixed(1)} kn`;

    // Human-friendly sail trim label.
    const trim = this.ship.sail;
    this.hud.sails.textContent =
      trim < 0.05 ? "Furled" :
      trim < 0.4 ? "Reefed" :
      trim < 0.9 ? "Half sail" : "Full sail";
  }

  // =======================================================================
  // Plumbing
  // =======================================================================

  /** Match the canvas backing store to the window size. */
  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }
}

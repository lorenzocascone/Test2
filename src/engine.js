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
import { Port, GOODS } from "./port.js";
import { PortMenu } from "./portMenu.js";
import { WORLD, WorldRenderer } from "./world.js";
import { PirateMap } from "./map.js";

// ---------------------------------------------------------------------------
// World tuning
// ---------------------------------------------------------------------------

/** World dimensions come from world.js (the single source of geography). */
const WORLD_WIDTH = WORLD.width;
const WORLD_HEIGHT = WORLD.height;

/** Number of drifting wind-streak particles visualizing the breeze. */
const WIND_STREAK_COUNT = 30;

/** How quickly the camera eases toward the ship (1/s). Lower = floatier. */
const CAMERA_LERP = 3.0;

/** Crew eat: food consumed per crew member per second (a slow trickle). */
const FOOD_PER_CREW_PER_SEC = 0.005;

/** How close (world units) the ship must be to a port to dock. */
const DOCK_RADIUS = 240;

/** Total cargo space aboard the player's ship. */
const CARGO_CAPACITY = 60;

/** Bunk limit — the tavern can't recruit past this. */
const MAX_CREW = 60;

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
      gold: 200,
      crew: 24,
      maxCrew: MAX_CREW,

      // Cargo hold. Food doubles as the crew's provisions — they eat it
      // over time — and as a tradeable good. Everything here counts
      // against maxCargo, weighted per GOODS[key].weight.
      cargo: { food: 30, rum: 0, sugar: 0, cannons: 0 },
      maxCargo: CARGO_CAPACITY,

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

    // The player's ship starts just off Santo Domingo, so the very first
    // port is in sight — no more being lost at sea on frame one.
    this.ship = new Ship(1650, 1350);
    this.ship.angle = Math.PI * 0.9; // pointed roughly at the harbor

    // -----------------------------------------------------------------
    // Pause flag — set/cleared by the port menu. While true, update()
    // skips all physics so the world freezes behind the docked UI.
    // -----------------------------------------------------------------
    this.paused = false;

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
    // World geography & environment renderer (islands, landmarks,
    // animated water) — see world.js. Precomputes all coastlines once.
    // -----------------------------------------------------------------
    this.world = new WorldRenderer();

    // -----------------------------------------------------------------
    // Ports — defined by WHICH island and WHICH stretch of coast, then
    // snapped onto the procedurally generated coastline so the pier
    // always meets its beach. Founding a port also founds its town
    // (houses, dock path, chimney smoke) on the island behind it.
    // -----------------------------------------------------------------
    const portDefs = [
      { island: 0, angle: Math.PI / 2, name: "Santo Domingo", faction: "Spanish" },
      { island: 1, angle: Math.PI / 2, name: "Havana", faction: "Spanish" },
      { island: 2, angle: Math.PI * 0.6, name: "Port Royal", faction: "English" },
      { island: 3, angle: -Math.PI / 2, name: "Nassau", faction: "Pirate" },
      { island: 4, angle: -Math.PI / 2, name: "Petit-Goave", faction: "French" },
      { island: 5, angle: -Math.PI * 0.55, name: "Martinique", faction: "French" },
      { island: 6, angle: -Math.PI / 2, name: "Tortuga", faction: "Pirate" },
    ];
    this.ports = portDefs.map((def) => {
      // Anchor the pier base right at the waterline of the real coast.
      const anchor = this.world.coastPoint(def.island, def.angle, 1.0);
      this.world.addSettlement(def.island, def.angle, anchor);
      return new Port({
        x: anchor.x,
        y: anchor.y,
        facing: def.angle, // pier points out to sea
        name: def.name,
        faction: def.faction,
      });
    });

    // The docked-at-port UI (tabs, trading, recruiting). It toggles
    // this.paused when opened/closed.
    this.portMenu = new PortMenu(this);

    // The unfurlable parchment chart (M key or the map button).
    this.pirateMap = new PirateMap(this);

    // -----------------------------------------------------------------
    // Wind streaks: faint lines drifting with the wind so you can read
    // the breeze at a glance without checking the HUD. Spawned lazily
    // into the current viewport, recycled when they drift out.
    // -----------------------------------------------------------------
    this.streaks = [];
    for (let i = 0; i < WIND_STREAK_COUNT; i++) {
      this.streaks.push({ x: 0, y: 0, dead: true });
    }

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
      cargo: document.getElementById("stat-cargo"),
      dockPrompt: document.getElementById("dock-prompt"),
      dockPortName: document.getElementById("dock-port-name"),
    };

    // Tapping/clicking the dock prompt docks too (mobile has no E key).
    this.hud.dockPrompt.addEventListener("click", () => this._tryDock());

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

      // E docks at a nearby port (or leaves, if already docked).
      if (e.code === "KeyE") this._tryDock();

      // M unfurls/furls the pirate map.
      if (e.code === "KeyM") this.pirateMap.toggle();

      // Escape closes whatever's open: port first, then the map.
      if (e.code === "Escape") {
        if (this.portMenu.isOpen) this.portMenu.close();
        else if (this.pirateMap.isOpen) this.pirateMap.close();
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
  // Docking
  // =======================================================================

  /** The port within docking range of the ship, or null. */
  nearestDockablePort() {
    for (const port of this.ports) {
      const dx = port.x - this.ship.x;
      const dy = port.y - this.ship.y;
      if (dx * dx + dy * dy <= DOCK_RADIUS * DOCK_RADIUS) return port;
    }
    return null;
  }

  /**
   * Toggle docking: if the port menu is open, leave; otherwise dock at
   * the nearest in-range port (if any). Docking drops anchor — speed and
   * sails go to zero so the resume is calm rather than mid-maneuver.
   */
  _tryDock() {
    if (this.portMenu.isOpen) {
      this.portMenu.close();
      return;
    }
    const port = this.nearestDockablePort();
    if (!port) return;

    this.ship.speed = 0;
    this.ship.sail = 0;
    this.ship.angularVelocity = 0;
    this.hud.dockPrompt.classList.add("hidden");
    this.portMenu.open(port); // sets this.paused = true
  }

  /** Total cargo space currently used, respecting per-good weights.
   *  Rounded up because the crew nibbles food in fractions — a partly
   *  eaten barrel still takes up the whole slot. */
  cargoUsed() {
    let used = 0;
    for (const [key, good] of Object.entries(GOODS)) {
      used += this.state.cargo[key] * good.weight;
    }
    return Math.ceil(used);
  }

  // =======================================================================
  // Per-frame update
  // =======================================================================

  /**
   * Advance the whole simulation by dt seconds.
   * @param {number} dt - clamped delta time from main.js
   */
  update(dt) {
    // Docked: the world holds its breath. We still refresh the HUD so
    // trades made in the port menu are reflected immediately, but no
    // physics, wind, market drift, or hunger ticks happen.
    if (this.paused) {
      this._updateHud();
      return;
    }

    this._updateWind(dt);

    // Port markets drift even while you're at sea — prices a rumor told
    // you about may have moved by the time you arrive.
    for (const port of this.ports) port.update(dt);

    // The ship reads input + wind and integrates its own physics.
    this.ship.update(dt, this.input, this.state.wind);

    // Keep the ship inside the world (soft clamp at the map edge).
    this.ship.x = Math.min(WORLD_WIDTH, Math.max(0, this.ship.x));
    this.ship.y = Math.min(WORLD_HEIGHT, Math.max(0, this.ship.y));

    // Hungry crew nibble away at the food stores (from the cargo hold).
    this.state.cargo.food = Math.max(
      0,
      this.state.cargo.food - this.state.crew * FOOD_PER_CREW_PER_SEC * dt
    );

    this._updateWindStreaks(dt);
    this._centerCameraOnShip(false, dt);
    this._updateDockPrompt();
    this._updateHud();
  }

  /**
   * Move the wind-streak particles with the breeze; recycle any that
   * leave the viewport by respawning them at a random spot inside it.
   */
  _updateWindStreaks(dt) {
    const w = this.state.wind;
    const vx = Math.cos(w.angle) * (50 + w.speed * 9);
    const vy = Math.sin(w.angle) * (50 + w.speed * 9);
    const margin = 60;

    for (const s of this.streaks) {
      s.x += vx * dt;
      s.y += vy * dt;

      const off =
        s.dead ||
        s.x < this.camera.x - margin || s.x > this.camera.x + this.canvas.width + margin ||
        s.y < this.camera.y - margin || s.y > this.camera.y + this.canvas.height + margin;
      if (off) {
        s.x = this.camera.x + Math.random() * this.canvas.width;
        s.y = this.camera.y + Math.random() * this.canvas.height;
        s.dead = false;
      }
    }
  }

  /** Show/hide the "Dock at ..." prompt depending on proximity. */
  _updateDockPrompt() {
    const port = this.nearestDockablePort();
    if (port && !this.portMenu.isOpen) {
      this.hud.dockPortName.textContent = port.name;
      this.hud.dockPrompt.classList.remove("hidden");
    } else {
      this.hud.dockPrompt.classList.add("hidden");
    }
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

  /** Draw the entire frame: sea, world, ports, ship, light, map. */
  render() {
    const ctx = this.ctx;
    const viewW = this.canvas.width;
    const viewH = this.canvas.height;

    // Visual clock — runs even while docked, so water keeps shimmering
    // behind the port menu (only PHYSICS pauses, not ambience).
    const time = performance.now() / 1000;

    // --- Deep-sea gradient base (screen space) ---------------------------
    const sea = ctx.createLinearGradient(0, 0, 0, viewH);
    sea.addColorStop(0, "#1f5b80");
    sea.addColorStop(1, "#143a55");
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, viewW, viewH);

    // Everything below is drawn in WORLD coordinates: translate the
    // context by the camera offset, draw, then restore.
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    this.world.draw(ctx, this.camera, { w: viewW, h: viewH }, time);
    for (const port of this.ports) port.draw(ctx);
    this.ship.draw(ctx, time, this.state.wind);
    this._drawWindStreaks(ctx);

    ctx.restore();

    // --- Screen-space lighting: sun glow + vignette ----------------------
    this._drawLighting(ctx, viewW, viewH);

    // --- The pirate map redraws live while unfurled ----------------------
    if (this.pirateMap.isOpen) this.pirateMap.draw(time);
  }

  /** Faint streaks sliding with the wind — the breeze made visible. */
  _drawWindStreaks(ctx) {
    const w = this.state.wind;
    const len = 14 + w.speed * 2.2;
    const dx = Math.cos(w.angle) * len;
    const dy = Math.sin(w.angle) * len;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.13)";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const s of this.streaks) {
      if (s.dead) continue;
      ctx.moveTo(s.x - dx, s.y - dy);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }

  /**
   * Cinematic finishing pass: a warm sun glow in the upper-left and a
   * cool vignette pulling the eye to the center. Cheap, transformative.
   */
  _drawLighting(ctx, viewW, viewH) {
    // Sunlight
    const sun = ctx.createRadialGradient(
      viewW * 0.18, viewH * 0.12, 0,
      viewW * 0.18, viewH * 0.12, Math.max(viewW, viewH) * 0.5
    );
    sun.addColorStop(0, "rgba(255, 235, 170, 0.14)");
    sun.addColorStop(1, "rgba(255, 235, 170, 0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, viewW, viewH);

    // Vignette
    const vig = ctx.createRadialGradient(
      viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.45,
      viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.75
    );
    vig.addColorStop(0, "rgba(4, 10, 20, 0)");
    vig.addColorStop(1, "rgba(4, 10, 20, 0.42)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // =======================================================================
  // HUD
  // =======================================================================

  /** Push current state into the HTML overlay. */
  _updateHud() {
    const { gold, crew, cargo, maxCargo, wind } = this.state;

    this.hud.gold.textContent = Math.floor(gold);
    this.hud.crew.textContent = crew;
    this.hud.food.textContent = Math.floor(cargo.food);
    this.hud.cargo.textContent = `${this.cargoUsed()}/${maxCargo}`;

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

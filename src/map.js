/**
 * map.js — The pirate map: an unfurlable parchment chart of the whole
 * world, drawn in an "old ink" style on its own canvas overlay.
 *
 * It shows island coastlines, every port (flagged with its faction
 * color), the famous landmarks, and — crucially — the player's live
 * position and heading, so you can always find your way to harbor.
 *
 * The unfurl/furl animation itself is CSS (a scaleY transition on the
 * scroll container); this class just toggles classes and redraws the
 * chart each frame while it's open.
 */

import { WORLD, LANDMARKS } from "./world.js";

// Old-ink palette for everything drawn on the parchment.
const INK = "#4a2f1b";
const INK_FADED = "rgba(74, 47, 27, 0.55)";
const SAND = "#cdb188";
const PLAYER_RED = "#a03028";

export class PirateMap {
  /**
   * @param {import("./engine.js").Engine} engine - read-only access to
   *        world geometry, ports and the ship for live position.
   */
  constructor(engine) {
    this.engine = engine;
    this.openState = false;

    this.root = document.getElementById("pirate-map");
    this.scroll = document.getElementById("pirate-map-scroll");
    this.canvas = document.getElementById("map-canvas");
    this.ctx = this.canvas.getContext("2d");

    // World → map-canvas scale factor (the chart is square, like the world).
    this.scale = this.canvas.width / WORLD.width;

    // Toggle button (HUD) — works for both mouse and touch.
    document.getElementById("map-toggle").addEventListener("click", () => this.toggle());
    // Tapping the dimmed area around the parchment also closes it.
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.close();
    });
  }

  get isOpen() {
    return this.openState;
  }

  toggle() {
    this.openState ? this.close() : this.open();
  }

  open() {
    this.openState = true;
    this.root.classList.remove("hidden");
    // Force a reflow so the transition from the furled state animates
    // even though we just unhid the element.
    void this.scroll.offsetHeight;
    this.scroll.classList.add("unfurled");
  }

  close() {
    this.openState = false;
    this.scroll.classList.remove("unfurled");
    // Keep the element around until the furl animation finishes.
    setTimeout(() => {
      if (!this.openState) this.root.classList.add("hidden");
    }, 450);
  }

  // =======================================================================
  // Drawing — called once per frame by the engine while open.
  // =======================================================================

  /** @param {number} time seconds, for the pulsing player marker */
  draw(time) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const s = this.scale;

    ctx.clearRect(0, 0, w, h); // parchment texture lives in CSS behind us

    // --- Chart frame: double ink border like an old sea chart ----------
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.setLineDash([]);

    // --- Islands: sand fill with a hand-inked coastline ----------------
    for (const isle of this.engine.world.islands) {
      ctx.beginPath();
      const pts = isle.pts;
      ctx.moveTo(
        ((pts[0].x + pts[pts.length - 1].x) / 2) * s,
        ((pts[0].y + pts[pts.length - 1].y) / 2) * s
      );
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        ctx.quadraticCurveTo(p.x * s, p.y * s, ((p.x + q.x) / 2) * s, ((p.y + q.y) / 2) * s);
      }
      ctx.closePath();
      ctx.fillStyle = SAND;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    this._drawLandmarks(ctx, s);
    this._drawShipsSighted(ctx, s);
    this._drawPorts(ctx, s);
    this._drawCompassRose(ctx, w - 64, h - 64);
    this._drawPlayer(ctx, s, time);

    // --- Title cartouche ------------------------------------------------
    ctx.fillStyle = INK;
    ctx.font = "22px 'Pirata One', 'Trebuchet MS', cursive";
    ctx.textAlign = "center";
    ctx.fillText("~ The Corsair's Chart ~", w / 2, 42);
  }

  _drawPorts(ctx, s) {
    for (const port of this.engine.ports) {
      const x = port.x * s;
      const y = port.y * s;

      // Anchor dot ringed in the faction's color.
      ctx.fillStyle = port.color;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Port name in chart lettering.
      ctx.fillStyle = INK;
      ctx.font = "13px 'Pirata One', 'Trebuchet MS', cursive";
      ctx.textAlign = "center";
      ctx.fillText(port.name, x, y - 10);
    }
  }

  /** Other sails on the horizon: black dots for pirates, ink for traders. */
  _drawShipsSighted(ctx, s) {
    for (const enemy of this.engine.enemies) {
      if (!enemy.alive) continue;
      ctx.fillStyle = enemy.aggressive ? "#1a1a1a" : INK_FADED;
      ctx.beginPath();
      ctx.arc(enemy.x * s, enemy.y * s, enemy.aggressive ? 3 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawLandmarks(ctx, s) {
    ctx.strokeStyle = INK_FADED;
    ctx.fillStyle = INK_FADED;
    ctx.lineWidth = 1.5;
    ctx.textAlign = "center";

    // Wreck: the classic X (does it mark treasure? who can say).
    const wx = LANDMARKS.wreck.x * s;
    const wy = LANDMARKS.wreck.y * s;
    ctx.strokeStyle = PLAYER_RED;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(wx - 6, wy - 6); ctx.lineTo(wx + 6, wy + 6);
    ctx.moveTo(wx + 6, wy - 6); ctx.lineTo(wx - 6, wy + 6);
    ctx.stroke();
    ctx.strokeStyle = INK_FADED;
    ctx.lineWidth = 1.5;

    // Whirlpool: a little hand-drawn spiral.
    const px = LANDMARKS.whirlpool.x * s;
    const py = LANDMARKS.whirlpool.y * s;
    ctx.beginPath();
    for (let r = 1.5; r < 8; r += 1.6) {
      ctx.arc(px, py, r, r, r + 4);
    }
    ctx.stroke();

    // Lighthouse: a tiny star burst.
    const lx = LANDMARKS.lighthouse.x * s;
    const ly = LANDMARKS.lighthouse.y * s;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI;
      ctx.moveTo(lx - Math.cos(a) * 6, ly - Math.sin(a) * 6);
      ctx.lineTo(lx + Math.cos(a) * 6, ly + Math.sin(a) * 6);
    }
    ctx.stroke();

    // The serpent's hunting ground, labelled the traditional way.
    const sx = LANDMARKS.serpent.x * s;
    const sy = LANDMARKS.serpent.y * s;
    ctx.font = "italic 12px 'Pirata One', 'Trebuchet MS', cursive";
    ctx.fillText("here be dragons", sx, sy + 4);
    // A wee doodle of humps above the warning.
    ctx.beginPath();
    ctx.arc(sx - 8, sy - 8, 4, Math.PI, 0);
    ctx.arc(sx + 2, sy - 8, 4, Math.PI, 0);
    ctx.stroke();

    // Rock clusters: small ink crosses.
    ctx.font = "10px 'Trebuchet MS', sans-serif";
    for (const rock of LANDMARKS.rocks) {
      ctx.fillText("✦", rock.x * s, rock.y * s + 3);
    }
  }

  /** A modest eight-point compass rose in the chart corner. */
  _drawCompassRose(ctx, cx, cy) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.stroke();

    // Long cardinal points, short intercardinals.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const len = i % 2 === 0 ? 20 : 11;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
      ctx.stroke();
    }

    ctx.font = "bold 13px 'Pirata One', 'Trebuchet MS', cursive";
    ctx.textAlign = "center";
    ctx.fillText("N", 0, -27);
    ctx.restore();
  }

  /** The player: a red ship triangle, heading-aligned, with a pulse ring. */
  _drawPlayer(ctx, s, time) {
    const ship = this.engine.ship;
    const x = ship.x * s;
    const y = ship.y * s;

    // Pulsing ring so the eye finds you instantly.
    const pulse = 8 + 4 * (0.5 + 0.5 * Math.sin(time * 4));
    ctx.strokeStyle = "rgba(160, 48, 40, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, pulse, 0, Math.PI * 2);
    ctx.stroke();

    // Heading triangle.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ship.angle);
    ctx.fillStyle = PLAYER_RED;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -4.5);
    ctx.lineTo(-5, 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // "You are here", because every good map says so.
    ctx.fillStyle = PLAYER_RED;
    ctx.font = "italic 11px 'Pirata One', 'Trebuchet MS', cursive";
    ctx.textAlign = "center";
    ctx.fillText("you are here", x, y + 22);
  }
}

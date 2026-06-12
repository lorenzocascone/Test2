/**
 * world.js — The game world: geography, landmarks, and all environmental
 * rendering (animated water, islands, rocks, wrecks, sea monsters...).
 *
 * Everything here is PROCEDURAL but DETERMINISTIC: island coastlines,
 * palm placement, wave phases etc. are generated from fixed seeds, so the
 * world looks identical every frame and every playthrough — no popping.
 */

// ---------------------------------------------------------------------------
// World definition
// ---------------------------------------------------------------------------

export const WORLD = { width: 6000, height: 6000 };

/**
 * Islands: x/y center, r nominal radius, seed for coastline noise.
 * `peak` adds a rocky mountain (bigger islands only).
 */
export const ISLANDS = [
  { x: 1200, y: 900,  r: 180, seed: 11, peak: false },
  { x: 2700, y: 600,  r: 170, seed: 22, peak: false },
  { x: 4400, y: 1400, r: 260, seed: 33, peak: true  },
  { x: 5400, y: 3000, r: 130, seed: 44, peak: false },
  { x: 2300, y: 3600, r: 140, seed: 55, peak: false },
  { x: 5100, y: 4700, r: 220, seed: 66, peak: true  },
  { x: 800,  y: 4900, r: 190, seed: 77, peak: false },
  { x: 3500, y: 2200, r: 100, seed: 88, peak: false },
  { x: 1500, y: 2600, r: 90,  seed: 99, peak: false },
  { x: 4200, y: 5300, r: 120, seed: 13, peak: false },
];

/** Fixed landmark positions, also drawn on the pirate map. */
export const LANDMARKS = {
  lighthouse: { x: 2050, y: 1500 },
  wreck:      { x: 3000, y: 4600 },
  whirlpool:  { x: 4700, y: 2400 },
  // The serpent endlessly patrols a circle around this point.
  serpent:    { x: 1700, y: 4150, radius: 280 },
  rocks: [
    { x: 3600, y: 4200, seed: 5 },
    { x: 1950, y: 1950, seed: 9 },
    { x: 4950, y: 3700, seed: 7 },
  ],
};

// ---------------------------------------------------------------------------
// Seeded RNG — tiny mulberry32. Same seed, same sequence, every time.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Darken a #rrggbb color by ~22% — used for the shaded roof half. */
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.round(v * 0.78));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/**
 * Generate a wobbly closed coastline around (cx, cy): N points whose
 * radius varies randomly. Drawn with smoothing, this reads as a natural
 * island instead of a sterile circle.
 */
function makeBlob(cx, cy, r, seed, points = 14) {
  const rand = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rad = r * (0.76 + rand() * 0.42);
    pts.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
  }
  return pts;
}

/**
 * Trace a smooth closed path through blob points by curving through the
 * midpoints (classic quadratic-spline trick). `scale` shrinks the shape
 * toward (cx, cy) so the same coastline can draw beach + grass layers.
 */
function traceBlob(ctx, pts, cx, cy, scale = 1) {
  const sx = (p) => cx + (p.x - cx) * scale;
  const sy = (p) => cy + (p.y - cy) * scale;

  ctx.beginPath();
  const n = pts.length;
  ctx.moveTo((sx(pts[0]) + sx(pts[n - 1])) / 2, (sy(pts[0]) + sy(pts[n - 1])) / 2);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(sx(p), sy(p), (sx(p) + sx(q)) / 2, (sy(p) + sy(q)) / 2);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// World renderer
// ---------------------------------------------------------------------------

export class WorldRenderer {
  constructor() {
    // Precompute every island's coastline, palm trees and gull flock so
    // rendering is pure drawing — zero allocation per frame.
    this.islands = ISLANDS.map((isle) => {
      const rand = mulberry32(isle.seed * 7 + 1);
      const palms = [];
      const palmCount = 2 + Math.floor(isle.r / 60);
      for (let i = 0; i < palmCount; i++) {
        const a = rand() * Math.PI * 2;
        const d = rand() * isle.r * 0.45;
        palms.push({
          x: isle.x + Math.cos(a) * d,
          y: isle.y + Math.sin(a) * d,
          lean: (rand() - 0.5) * 0.8, // each palm leans its own way
          size: 10 + rand() * 8,
        });
      }
      return { ...isle, pts: makeBlob(isle.x, isle.y, isle.r, isle.seed), palms, town: null };
    });

    // -----------------------------------------------------------------
    // Sea-depth patches: big, faint dark blotches that break up the
    // uniform blue and make the camera's motion readable everywhere.
    // Rendered from one shared pre-baked radial sprite — building a
    // fresh gradient per patch per frame was pure GC churn.
    // -----------------------------------------------------------------
    {
      const rand = mulberry32(424242);
      this.depthPatches = [];
      for (let i = 0; i < 55; i++) {
        this.depthPatches.push({
          x: rand() * WORLD.width,
          y: rand() * WORLD.height,
          r: 90 + rand() * 160,
          a: 0.05 + rand() * 0.05,
        });
      }

      const sprite = document.createElement("canvas");
      sprite.width = sprite.height = 128;
      const sc = sprite.getContext("2d");
      const g = sc.createRadialGradient(64, 64, 14, 64, 64, 64);
      g.addColorStop(0, "rgba(8, 26, 44, 1)");
      g.addColorStop(1, "rgba(8, 26, 44, 0)");
      sc.fillStyle = g;
      sc.fillRect(0, 0, 128, 128);
      this._depthSprite = sprite;
    }

    // -----------------------------------------------------------------
    // Clouds: puffy clusters of ellipses drifting on the trade wind.
    // Each casts a soft shadow on the sea far below (drawn separately
    // so ships sail UNDER the clouds but OVER the shadows).
    // -----------------------------------------------------------------
    {
      const rand = mulberry32(777);
      this.clouds = [];
      for (let i = 0; i < 9; i++) {
        const puffs = [];
        const count = 4 + Math.floor(rand() * 3);
        for (let p = 0; p < count; p++) {
          puffs.push({
            ox: (rand() - 0.5) * 150,
            oy: (rand() - 0.5) * 50,
            rx: 35 + rand() * 45,
            ry: 18 + rand() * 16,
          });
        }
        this.clouds.push({
          x: rand() * WORLD.width,
          y: rand() * WORLD.height,
          // Steady trade-wind drift, each cloud at its own pace.
          vx: 16 + rand() * 14,
          vy: 6 + rand() * 8,
          puffs,
        });
      }
    }

    // Rock clusters: 3-5 jagged little blobs each. `r` is kept for the
    // engine's collision checks (stones are solid).
    this.rocks = LANDMARKS.rocks.map((rock) => {
      const rand = mulberry32(rock.seed * 31);
      const stones = [];
      const count = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        const x = rock.x + (rand() - 0.5) * 120;
        const y = rock.y + (rand() - 0.5) * 120;
        const r = 14 + rand() * 18;
        stones.push({ x, y, r, pts: makeBlob(0, 0, r, rock.seed * 100 + i, 7) });
      }
      return { ...rock, stones };
    });
  }

  /**
   * The coastline radius of an island in a given direction, interpolated
   * between the blob's noise points. Shared by port placement and the
   * engine's land-collision checks, so ships ground on exactly the
   * coastline that gets drawn.
   *
   * @param {number} islandIndex index into this.islands
   * @param {number} angle       direction from the island center (radians)
   * @returns {number} distance from island center to the waterline
   */
  coastRadius(islandIndex, angle) {
    const isle = this.islands[islandIndex];
    const n = isle.pts.length;

    const norm = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const t = (norm / (Math.PI * 2)) * n;
    const i0 = Math.floor(t) % n;
    const i1 = (i0 + 1) % n;
    const frac = t - Math.floor(t);

    const radiusOf = (p) => Math.hypot(p.x - isle.x, p.y - isle.y);
    return radiusOf(isle.pts[i0]) * (1 - frac) + radiusOf(isle.pts[i1]) * frac;
  }

  /**
   * The actual coastline radius of an island in a given direction,
   * interpolated between the blob's noise points. Ports use this to sit
   * exactly on the generated coast instead of the nominal circle.
   *
   * @param {number} islandIndex index into this.islands
   * @param {number} angle       direction from the island center (radians)
   * @param {number} scale       1 = waterline; >1 pushes out to sea
   * @returns {{x:number, y:number}} world position on/off that coast
   */
  coastPoint(islandIndex, angle, scale = 1) {
    const isle = this.islands[islandIndex];
    const radius = this.coastRadius(islandIndex, angle);
    return {
      x: isle.x + Math.cos(angle) * radius * scale,
      y: isle.y + Math.sin(angle) * radius * scale,
    };
  }

  /**
   * Found a town on an island, inland of the pier at `coastAngle`:
   * a seeded cluster of gable-roofed houses, a dirt path down to the
   * dock, and a chimney that puffs smoke. Called by the engine for each
   * island that hosts a port — ports have to come from somewhere.
   *
   * @param {number} islandIndex which island gets the settlement
   * @param {number} coastAngle  direction from island center to the pier
   * @param {{x:number,y:number}} pier world position of the pier base
   */
  addSettlement(islandIndex, coastAngle, pier) {
    const isle = this.islands[islandIndex];
    const rand = mulberry32(isle.seed * 131 + 7);

    // Town center: pulled inland from the pier, past the beach.
    const inland = this.coastPoint(islandIndex, coastAngle, 0.55);

    // Houses scatter around the center, loosely facing the harbor.
    const houses = [];
    const count = 5 + Math.floor(rand() * 4);
    const roofColors = ["#b3502e", "#a8452a", "#c9a55a", "#8f6b3d"];
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * isle.r * 0.28;
      houses.push({
        x: inland.x + Math.cos(a) * d,
        y: inland.y + Math.sin(a) * d * 0.8,
        w: 9 + rand() * 6,
        h: 7 + rand() * 4,
        rot: coastAngle + (rand() - 0.5) * 0.7,
        roof: roofColors[Math.floor(rand() * roofColors.length)],
      });
    }

    // Clear any palms that landed inside the village footprint.
    isle.palms = isle.palms.filter(
      (p) => Math.hypot(p.x - inland.x, p.y - inland.y) > isle.r * 0.34
    );

    isle.town = { center: inland, pier, houses };
    isle.sprite = null; // invalidate any baked art so the town gets included
  }

  /**
   * Draw the whole environment. Assumes ctx is already translated by the
   * camera, so all coordinates are world-space.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number}} camera  top-left of the viewport
   * @param {{w:number,h:number}} view    viewport size in pixels
   * @param {number} time                 seconds, for animation
   */
  draw(ctx, camera, view, time) {
    this._drawDepthPatches(ctx, camera, view);
    this._drawWaveGlints(ctx, camera, view, time);
    this._drawWorldBorder(ctx);

    for (const isle of this.islands) {
      // Cull islands wholly outside the viewport (with margin for glow).
      const m = isle.r * 1.6;
      if (
        isle.x + m < camera.x || isle.x - m > camera.x + view.w ||
        isle.y + m < camera.y || isle.y - m > camera.y + view.h
      ) continue;
      this._drawIsland(ctx, isle, time);
    }

    this._drawRocks(ctx, camera, view);

    // Landmarks skip all their work (including gradient builds) when
    // they're nowhere near the viewport.
    if (this._inView(LANDMARKS.wreck.x, LANDMARKS.wreck.y, 120, camera, view)) {
      this._drawWreck(ctx, time);
    }
    if (this._inView(LANDMARKS.whirlpool.x, LANDMARKS.whirlpool.y, 120, camera, view)) {
      this._drawWhirlpool(ctx, time);
    }
    if (this._inView(LANDMARKS.serpent.x, LANDMARKS.serpent.y, LANDMARKS.serpent.radius + 80, camera, view)) {
      this._drawSerpent(ctx, time);
    }
    if (this._inView(LANDMARKS.lighthouse.x, LANDMARKS.lighthouse.y, 260, camera, view)) {
      this._drawLighthouse(ctx, time);
    }

    this._drawGulls(ctx, time);
    this._drawCloudLayer(ctx, camera, view, time, "shadow");
  }

  /** Is a point within `margin` of the visible viewport? */
  _inView(x, y, margin, camera, view) {
    return (
      x + margin >= camera.x && x - margin <= camera.x + view.w &&
      y + margin >= camera.y && y - margin <= camera.y + view.h
    );
  }

  /**
   * The clouds themselves — called by the engine AFTER ships and shot,
   * so everything at sea level passes beneath them.
   */
  drawClouds(ctx, camera, view, time) {
    this._drawCloudLayer(ctx, camera, view, time, "cloud");
  }

  /**
   * One pass over the cloud field. "shadow" draws dark smudges on the
   * sea (offset to the south-east, as if the sun sits north-west);
   * "cloud" draws the sunlit puffs high above.
   */
  _drawCloudLayer(ctx, camera, view, time, layer) {
    const span = WORLD.width + 1200; // wrap with margin so entry is off-screen
    const isShadow = layer === "shadow";

    for (const cloud of this.clouds) {
      // Steady drift, wrapped around the (padded) world.
      const cx = ((cloud.x + cloud.vx * time) % span + span) % span - 600;
      const cy = ((cloud.y + cloud.vy * time) % span + span) % span - 600;
      // Shadows land ~90 units down-sun of the cloud.
      const ox = isShadow ? 70 : 0;
      const oy = isShadow ? 90 : 0;

      // Cull: generous margin for the widest puff.
      if (
        cx + ox + 260 < camera.x || cx + ox - 260 > camera.x + view.w ||
        cy + oy + 120 < camera.y || cy + oy - 120 > camera.y + view.h
      ) continue;

      ctx.fillStyle = isShadow ? "rgba(8, 20, 34, 0.16)" : "rgba(248, 250, 252, 0.85)";
      for (const puff of cloud.puffs) {
        ctx.beginPath();
        ctx.ellipse(cx + ox + puff.ox, cy + oy + puff.oy, puff.rx, puff.ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // A brighter crown on the real cloud sells the volume.
      if (!isShadow) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        for (const puff of cloud.puffs) {
          ctx.beginPath();
          ctx.ellipse(
            cx + puff.ox, cy + puff.oy - puff.ry * 0.3,
            puff.rx * 0.6, puff.ry * 0.55, 0, 0, Math.PI * 2
          );
          ctx.fill();
        }
      }
    }
  }

  /** Faint dark blotches suggesting deeper water. Static, seeded,
   *  stamped from the pre-baked sprite (zero per-frame allocation). */
  _drawDepthPatches(ctx, camera, view) {
    for (const patch of this.depthPatches) {
      if (
        patch.x + patch.r < camera.x || patch.x - patch.r > camera.x + view.w ||
        patch.y + patch.r < camera.y || patch.y - patch.r > camera.y + view.h
      ) continue;
      ctx.globalAlpha = patch.a;
      ctx.drawImage(
        this._depthSprite,
        patch.x - patch.r, patch.y - patch.r,
        patch.r * 2, patch.r * 2
      );
    }
    ctx.globalAlpha = 1;
  }

  // =======================================================================
  // Water
  // =======================================================================

  /**
   * Animated wave glints: a sparse grid of little curved strokes whose
   * opacity breathes on a per-cell phase (hashed from the cell coords,
   * so the pattern is stable as the camera moves). Cheap and lively.
   */
  _drawWaveGlints(ctx, camera, view, time) {
    const SPACING = 130;
    const startX = Math.floor(camera.x / SPACING) * SPACING;
    const startY = Math.floor(camera.y / SPACING) * SPACING;

    ctx.strokeStyle = "#bfe8ff";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";

    for (let x = startX; x <= camera.x + view.w + SPACING; x += SPACING) {
      for (let y = startY; y <= camera.y + view.h + SPACING; y += SPACING) {
        // Stable pseudo-random per cell: offset + animation phase.
        const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const ox = (h % 97) - 48;
        const oy = ((h >> 7) % 89) - 44;
        const phase = (h % 1000) / 1000 * Math.PI * 2;

        // Each glint fades in and out on its own rhythm.
        const a = 0.04 + 0.07 * (0.5 + 0.5 * Math.sin(time * 1.4 + phase));
        ctx.globalAlpha = a;

        const gx = x + ox;
        const gy = y + oy;
        ctx.beginPath();
        // A shallow two-bump wave squiggle.
        ctx.moveTo(gx - 12, gy);
        ctx.quadraticCurveTo(gx - 6, gy - 4, gx, gy);
        ctx.quadraticCurveTo(gx + 6, gy + 4, gx + 12, gy);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Map edge: a weathered gold line plus an inner dashed "chart" line. */
  _drawWorldBorder(ctx) {
    ctx.strokeStyle = "rgba(240, 208, 128, 0.4)";
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, WORLD.width, WORLD.height);

    ctx.strokeStyle = "rgba(240, 208, 128, 0.18)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([14, 10]);
    ctx.strokeRect(40, 40, WORLD.width - 80, WORLD.height - 80);
    ctx.setLineDash([]);
  }

  // =======================================================================
  // Islands
  // =======================================================================

  /**
   * Islands are drawn in two layers:
   *  - a STATIC sprite (glow, beach, vegetation, mountain, town) baked
   *    once to an offscreen canvas the first time the island is seen —
   *    every fill, gradient and house was previously rebuilt per frame;
   *  - the ANIMATED bits (breathing surf, swaying palms, chimney smoke)
   *    drawn live on top, since they're a handful of cheap strokes.
   */
  _drawIsland(ctx, isle, time) {
    if (!isle.sprite) this._bakeIsland(isle);
    ctx.drawImage(isle.sprite, isle.spriteX, isle.spriteY);

    // Two surf lines breathing out of phase — waves rolling onto sand.
    const surfScale = 1.06 + 0.02 * Math.sin(time * 1.2 + isle.seed);
    traceBlob(ctx, isle.pts, isle.x, isle.y, surfScale);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    const surf2 = 1.13 + 0.03 * Math.sin(time * 1.2 + isle.seed + Math.PI);
    traceBlob(ctx, isle.pts, isle.x, isle.y, surf2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Palm trees, gently swaying.
    for (const palm of isle.palms) {
      this._drawPalm(ctx, palm, time);
    }

    // The town's chimney smoke (houses themselves are in the sprite).
    if (isle.town) this._drawTownSmoke(ctx, isle.town, time);
  }

  /** Render an island's static art once, into an offscreen canvas. */
  _bakeIsland(isle) {
    // The sprite must cover the widest thing we draw: the shallow-water
    // glow at 1.55 × nominal radius (blob noise peaks at ~1.18 × r).
    const reach = Math.ceil(isle.r * 1.6) + 8;
    const size = reach * 2;
    const sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    const c = sprite.getContext("2d");
    // Shift so world coordinates land inside the sprite — all the
    // existing drawing code works unchanged.
    c.translate(reach - isle.x, reach - isle.y);

    // Shallow turquoise water haloing the island — gives a depth feel.
    const glow = c.createRadialGradient(isle.x, isle.y, isle.r * 0.6, isle.x, isle.y, isle.r * 1.55);
    glow.addColorStop(0, "rgba(72, 180, 190, 0.35)");
    glow.addColorStop(1, "rgba(72, 180, 190, 0)");
    c.fillStyle = glow;
    c.beginPath();
    c.arc(isle.x, isle.y, isle.r * 1.55, 0, Math.PI * 2);
    c.fill();

    // Beach, then two bands of vegetation using the same coastline.
    traceBlob(c, isle.pts, isle.x, isle.y, 1);
    c.fillStyle = "#e3cf94";
    c.fill();

    traceBlob(c, isle.pts, isle.x, isle.y, 0.82);
    c.fillStyle = "#5d9143";
    c.fill();

    traceBlob(c, isle.pts, isle.x, isle.y, 0.55);
    c.fillStyle = "#3f7233";
    c.fill();

    // Mountain peak for the big islands.
    if (isle.peak) {
      const px = isle.x, py = isle.y;
      const s = isle.r * 0.32;
      c.fillStyle = "#6e6657";
      c.beginPath();
      c.moveTo(px - s, py + s * 0.6);
      c.lineTo(px - s * 0.2, py - s);
      c.lineTo(px + s * 0.3, py + s * 0.1);
      c.lineTo(px + s, py + s * 0.55);
      c.closePath();
      c.fill();
      // Sunlit face
      c.fillStyle = "#8a8270";
      c.beginPath();
      c.moveTo(px - s * 0.2, py - s);
      c.lineTo(px + s * 0.3, py + s * 0.1);
      c.lineTo(px + s, py + s * 0.55);
      c.lineTo(px + s * 0.15, py + s * 0.2);
      c.closePath();
      c.fill();
    }

    // The town (path + houses) is static too — bake it in.
    if (isle.town) this._drawTownStatic(c, isle.town);

    isle.sprite = sprite;
    isle.spriteX = isle.x - reach;
    isle.spriteY = isle.y - reach;
  }

  /** Houses and the path to the dock — static, baked into the sprite. */
  _drawTownStatic(ctx, town) {
    // Dirt path: a gentle curve from the village square to the pier.
    const midX = (town.center.x + town.pier.x) / 2 + 12;
    const midY = (town.center.y + town.pier.y) / 2 - 8;
    ctx.strokeStyle = "rgba(216, 192, 137, 0.85)";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(town.center.x, town.center.y);
    ctx.quadraticCurveTo(midX, midY, town.pier.x, town.pier.y);
    ctx.stroke();

    // Houses: top-down gabled roofs — two tones split along the ridge.
    for (const house of town.houses) {
      ctx.save();
      ctx.translate(house.x, house.y);
      ctx.rotate(house.rot);

      // Drop shadow grounds the building.
      ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
      ctx.fillRect(-house.w / 2 + 1.5, -house.h / 2 + 1.5, house.w, house.h);

      // Sunlit roof half / shaded roof half.
      ctx.fillStyle = house.roof;
      ctx.fillRect(-house.w / 2, -house.h / 2, house.w, house.h / 2);
      ctx.fillStyle = shade(house.roof);
      ctx.fillRect(-house.w / 2, 0, house.w, house.h / 2);

      // Ridge line.
      ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-house.w / 2, 0);
      ctx.lineTo(house.w / 2, 0);
      ctx.stroke();

      ctx.restore();
    }
  }

  /** The animated chimney smoke, drawn live over the baked town. */
  _drawTownSmoke(ctx, town, time) {
    // Three puffs on a looping cycle from the first house, drifting
    // up-left and fading as they grow.
    const h0 = town.houses[0];
    ctx.fillStyle = "#cfd8dd";
    for (let k = 0; k < 3; k++) {
      const t = (time * 0.35 + k / 3) % 1;
      ctx.globalAlpha = (1 - t) * 0.3;
      ctx.beginPath();
      ctx.arc(h0.x - t * 14, h0.y - 4 - t * 18, 2 + t * 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawPalm(ctx, palm, time) {
    const sway = Math.sin(time * 1.1 + palm.x * 0.05) * 0.08 + palm.lean;
    const topX = palm.x + Math.sin(sway) * palm.size;
    const topY = palm.y - palm.size;

    // Trunk: a slightly bowed line.
    ctx.strokeStyle = "#7a5a36";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(palm.x, palm.y);
    ctx.quadraticCurveTo(palm.x + Math.sin(sway) * palm.size * 0.4, palm.y - palm.size * 0.6, topX, topY);
    ctx.stroke();

    // Fronds: a fan of drooping arcs from the crown.
    ctx.strokeStyle = "#2e7d32";
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + sway;
      const fx = topX + Math.cos(a) * palm.size * 0.9;
      const fy = topY + Math.sin(a) * palm.size * 0.55 + palm.size * 0.18;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo((topX + fx) / 2, Math.min(topY, fy) - 4, fx, fy);
      ctx.stroke();
    }
  }

  // =======================================================================
  // Landmarks
  // =======================================================================

  _drawRocks(ctx, camera, view) {
    for (const cluster of this.rocks) {
      if (
        cluster.x + 160 < camera.x || cluster.x - 160 > camera.x + view.w ||
        cluster.y + 160 < camera.y || cluster.y - 160 > camera.y + view.h
      ) continue;

      for (const stone of cluster.stones) {
        ctx.save();
        ctx.translate(stone.x, stone.y);
        // Foam ring around each stone
        traceBlob(ctx, stone.pts, 0, 0, 1.35);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 2;
        ctx.stroke();
        // The stone itself, with a lit top
        traceBlob(ctx, stone.pts, 0, 0, 1);
        ctx.fillStyle = "#5b6066";
        ctx.fill();
        traceBlob(ctx, stone.pts, 0, -3, 0.6);
        ctx.fillStyle = "#787e85";
        ctx.fill();
        ctx.restore();
      }
    }
  }

  /** A half-sunken wreck — mast, tattered sail, hull breaking the water. */
  _drawWreck(ctx, time) {
    const { x, y } = LANDMARKS.wreck;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0.5);

    // Hull stub poking out of the sea at an angle.
    ctx.fillStyle = "#4a3322";
    ctx.beginPath();
    ctx.moveTo(-34, 6);
    ctx.lineTo(28, -2);
    ctx.lineTo(20, 12);
    ctx.lineTo(-28, 16);
    ctx.closePath();
    ctx.fill();

    // Broken mast with a ragged pennant that still flutters.
    ctx.strokeStyle = "#3a2718";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.lineTo(26, -44);
    ctx.stroke();

    const flap = Math.sin(time * 5) * 3;
    ctx.fillStyle = "rgba(220, 210, 190, 0.8)";
    ctx.beginPath();
    ctx.moveTo(26, -44);
    ctx.lineTo(48, -38 + flap);
    ctx.lineTo(30, -30);
    ctx.closePath();
    ctx.fill();

    // Foam lapping at the hull.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 10, 46, 14, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** A slowly spinning whirlpool — keep your distance, sailor. */
  _drawWhirlpool(ctx, time) {
    const { x, y } = LANDMARKS.whirlpool;
    ctx.save();
    ctx.translate(x, y);

    // Dark depression in the water. Local coordinates after the
    // translate, so the gradient is constant — build once, reuse.
    if (!this._pitGrad) {
      this._pitGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, 80);
      this._pitGrad.addColorStop(0, "rgba(6, 22, 38, 0.85)");
      this._pitGrad.addColorStop(1, "rgba(6, 22, 38, 0)");
    }
    ctx.fillStyle = this._pitGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 80, 0, Math.PI * 2);
    ctx.fill();

    // Spiral arms, rotating.
    ctx.rotate(time * 1.6);
    ctx.strokeStyle = "rgba(190, 230, 255, 0.5)";
    ctx.lineCap = "round";
    for (let arm = 0; arm < 3; arm++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      // Each arm is a series of short arcs at growing radius — a spiral.
      for (let r = 8; r < 64; r += 4) {
        const a0 = r * 0.09;
        ctx.arc(0, 0, r, a0, a0 + 0.7);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The sea serpent: humps and a head cruising an endless circle. */
  _drawSerpent(ctx, time) {
    const zone = LANDMARKS.serpent;
    const ang = time * 0.22; // patrol speed

    ctx.fillStyle = "#1d4d40";
    ctx.strokeStyle = "#0e2c24";
    ctx.lineWidth = 2;

    // Body humps trail behind the head along the circular path.
    for (let i = 3; i >= 1; i--) {
      const a = ang - i * 0.16;
      const hx = zone.x + Math.cos(a) * zone.radius;
      const hy = zone.y + Math.sin(a) * zone.radius;
      const r = 20 - i * 3;
      // A hump is the part of the coil above the waterline: a half-disc.
      ctx.beginPath();
      ctx.arc(hx, hy, r, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Head: raised neck with an eye, facing along the path.
    const hx = zone.x + Math.cos(ang) * zone.radius;
    const hy = zone.y + Math.sin(ang) * zone.radius;
    ctx.beginPath();
    ctx.arc(hx, hy - 14, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Snout
    const facing = ang + Math.PI / 2; // tangent of the circle
    ctx.beginPath();
    ctx.moveTo(hx, hy - 22);
    ctx.lineTo(hx + Math.cos(facing) * 16, hy - 14 + Math.sin(facing) * 8);
    ctx.lineTo(hx, hy - 8);
    ctx.closePath();
    ctx.fill();
    // Eye
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    ctx.arc(hx + Math.cos(facing) * 4, hy - 16, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1d4d40";
  }

  /** Striped lighthouse on a rock, with a rotating light beam at night...
   *  well, all the time — it's dramatic. */
  _drawLighthouse(ctx, time) {
    const { x, y } = LANDMARKS.lighthouse;
    ctx.save();
    ctx.translate(x, y);

    // The rock it stands on.
    ctx.fillStyle = "#5b6066";
    ctx.beginPath();
    ctx.ellipse(0, 8, 34, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // Rotating beam: two opposed translucent wedges sweeping the sea.
    const beamAngle = time * 0.7;
    for (const side of [0, Math.PI]) {
      const a = beamAngle + side;
      const grad = ctx.createLinearGradient(0, 0, Math.cos(a) * 220, Math.sin(a) * 220);
      grad.addColorStop(0, "rgba(255, 240, 170, 0.35)");
      grad.addColorStop(1, "rgba(255, 240, 170, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(Math.cos(a - 0.13) * 220, Math.sin(a - 0.13) * 220 - 14);
      ctx.lineTo(Math.cos(a + 0.13) * 220, Math.sin(a + 0.13) * 220 - 14);
      ctx.closePath();
      ctx.fill();
    }

    // Tower: red and white bands, narrowing toward the lamp room.
    const bands = [
      { w: 18, h: 8, c: "#c8414f" },
      { w: 16, h: 8, c: "#f0ece2" },
      { w: 14, h: 8, c: "#c8414f" },
      { w: 12, h: 8, c: "#f0ece2" },
    ];
    let ty = 4;
    for (const band of bands) {
      ctx.fillStyle = band.c;
      ctx.fillRect(-band.w / 2, ty - band.h, band.w, band.h);
      ty -= band.h;
    }
    // Lamp room + glow
    ctx.fillStyle = "#2b2b2b";
    ctx.fillRect(-7, ty - 7, 14, 7);
    const lampGlow = 0.6 + 0.4 * Math.sin(time * 4);
    ctx.fillStyle = `rgba(255, 230, 130, ${lampGlow})`;
    ctx.beginPath();
    ctx.arc(0, ty - 3.5, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /** A few gulls wheeling over selected islands. Pure charm. */
  _drawGulls(ctx, time) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";

    // Gulls orbit islands 0, 2 and 5 (two birds each, offset half a lap).
    for (const idx of [0, 2, 5]) {
      const isle = this.islands[idx];
      for (let b = 0; b < 2; b++) {
        const a = time * 0.4 + b * Math.PI + idx;
        const gx = isle.x + Math.cos(a) * (isle.r + 70);
        const gy = isle.y + Math.sin(a) * (isle.r + 40) * 0.7;
        const flap = Math.abs(Math.sin(time * 7 + b * 2 + idx)) * 5;

        ctx.beginPath();
        ctx.moveTo(gx - 8, gy);
        ctx.quadraticCurveTo(gx - 4, gy - flap, gx, gy);
        ctx.quadraticCurveTo(gx + 4, gy - flap, gx + 8, gy);
        ctx.stroke();
      }
    }
  }
}

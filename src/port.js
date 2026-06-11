/**
 * port.js — Ports and their market economy.
 *
 * Each port sits on the coast of an island, belongs to a faction, and runs
 * a small market whose prices drift over time. Profitable trading comes
 * from the differences between ports: every port rolls its own prices
 * around a faction-biased base, so rum bought cheap in French Martinique
 * can be sold dear in an English harbor.
 */

// ---------------------------------------------------------------------------
// Goods catalogue — shared by ports, the cargo hold, and the market UI.
// ---------------------------------------------------------------------------

/**
 * Every tradeable good in the game.
 *   base   — reference price in gold around which markets fluctuate.
 *   weight — cargo space one unit occupies (cannons are bulky!).
 */
export const GOODS = {
  food:    { label: "Food",    base: 5,  weight: 1 },
  rum:     { label: "Rum",     base: 14, weight: 1 },
  sugar:   { label: "Sugar",   base: 9,  weight: 1 },
  cannons: { label: "Cannons", base: 70, weight: 5 },
};

// ---------------------------------------------------------------------------
// Faction flavor — colors for flags and price biases for markets.
// priceMod < 1 means the faction produces/imports it cheaply;
// priceMod > 1 means it's scarce there (good place to SELL).
// ---------------------------------------------------------------------------

const FACTION_TRAITS = {
  Spanish: {
    color: "#e0b73f",
    priceMod: { sugar: 0.65, cannons: 1.25 },
    volatility: 0.08,
  },
  English: {
    color: "#c8414f",
    priceMod: { cannons: 0.75, rum: 1.3 },
    volatility: 0.08,
  },
  French: {
    color: "#4a6cd4",
    priceMod: { rum: 0.65, food: 1.2 },
    volatility: 0.08,
  },
  Pirate: {
    // Pirate havens have no trade policy at all — anything goes, and
    // prices swing much harder than in the colonial ports.
    color: "#3b3b3b",
    priceMod: {},
    volatility: 0.2,
  },
};

/** Flag/badge color for a faction — shared with enemy ships and the map. */
export function factionColor(faction) {
  return FACTION_TRAITS[faction].color;
}

/** How often (seconds) a port re-rolls its price drift. */
const PRICE_DRIFT_INTERVAL = 12;

/** Prices never stray outside this band around the faction-adjusted base. */
const PRICE_MIN_FACTOR = 0.4;
const PRICE_MAX_FACTOR = 2.5;

/** Per-unit market impact of the player's own trades: buying pushes the
 *  price up a touch, selling pushes it down. Stops infinite-money loops
 *  of buying and selling the same stack in one port. */
const TRADE_PRICE_IMPACT = 0.03;

export class Port {
  /**
   * @param {object} opts
   * @param {number} opts.x       world X of the dock (on the coastline)
   * @param {number} opts.y       world Y of the dock
   * @param {number} opts.facing  direction the pier points, out to sea
   * @param {string} opts.name    display name, e.g. "Port Royal"
   * @param {string} opts.faction one of: Spanish, English, French, Pirate
   */
  constructor({ x, y, facing = 0, name, faction }) {
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.name = name;
    this.faction = faction;

    // -----------------------------------------------------------------
    // Market: per-good price + stock. Prices start randomized around the
    // faction-adjusted base so every new game has a different landscape.
    // -----------------------------------------------------------------
    this.market = {};
    for (const [key, good] of Object.entries(GOODS)) {
      const adjustedBase = good.base * this._factionMod(key);
      this.market[key] = {
        // ±20% opening spread around the adjusted base.
        price: Math.max(1, Math.round(adjustedBase * (0.8 + Math.random() * 0.4))),
        stock: this._rollStock(key),
      };
    }

    // Stagger the first drift so all ports don't re-roll on the same frame.
    this._driftTimer = Math.random() * PRICE_DRIFT_INTERVAL;
  }

  /** Faction flag color, used by the renderer and the port menu header. */
  get color() {
    return FACTION_TRAITS[this.faction].color;
  }

  /** This faction's price multiplier for a good (1 if unbiased). */
  _factionMod(goodKey) {
    return FACTION_TRAITS[this.faction].priceMod[goodKey] ?? 1;
  }

  /** Opening stock levels — bulk goods are plentiful, cannons are rare. */
  _rollStock(goodKey) {
    if (goodKey === "cannons") return 4 + Math.floor(Math.random() * 9);  // 4–12
    return 25 + Math.floor(Math.random() * 41);                           // 25–65
  }

  // =======================================================================
  // Simulation
  // =======================================================================

  /**
   * Advance the market by dt seconds. Every PRICE_DRIFT_INTERVAL each
   * price takes a random step, clamped to a sane band so goods never
   * become free or absurdly expensive.
   *
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    this._driftTimer -= dt;
    if (this._driftTimer > 0) return;
    this._driftTimer = PRICE_DRIFT_INTERVAL;

    const volatility = FACTION_TRAITS[this.faction].volatility;

    for (const [key, good] of Object.entries(GOODS)) {
      const entry = this.market[key];
      // Random walk step: up to ±volatility of the current price.
      const step = entry.price * volatility * (Math.random() * 2 - 1);
      entry.price = this._clampPrice(key, entry.price + step);

      // Stock slowly regenerates toward a healthy level (the town keeps
      // producing/consuming whether or not the player visits).
      const target = good.base ? this._rollStockMidpoint(key) : 0;
      if (entry.stock < target && Math.random() < 0.5) entry.stock += 1;
    }
  }

  /** Midpoint of the normal stock range, used as the regeneration target. */
  _rollStockMidpoint(goodKey) {
    return goodKey === "cannons" ? 8 : 45;
  }

  /** Keep a price inside [40%, 250%] of the faction-adjusted base. */
  _clampPrice(goodKey, price) {
    const base = GOODS[goodKey].base * this._factionMod(goodKey);
    const min = Math.max(1, base * PRICE_MIN_FACTOR);
    const max = base * PRICE_MAX_FACTOR;
    return Math.round(Math.min(max, Math.max(min, price)));
  }

  // =======================================================================
  // Trade hooks — called by the port menu after a successful transaction.
  // The actual gold/cargo bookkeeping lives with the player state; the
  // port only tracks its side: stock and the price impact of the trade.
  // =======================================================================

  /** The player bought one unit: stock falls, price ticks up. */
  recordPurchase(goodKey) {
    const entry = this.market[goodKey];
    entry.stock = Math.max(0, entry.stock - 1);
    entry.price = this._clampPrice(goodKey, entry.price * (1 + TRADE_PRICE_IMPACT));
  }

  /** The player sold one unit: stock rises, price ticks down. */
  recordSale(goodKey) {
    const entry = this.market[goodKey];
    entry.stock += 1;
    entry.price = this._clampPrice(goodKey, entry.price * (1 - TRADE_PRICE_IMPACT));
  }

  // =======================================================================
  // Rendering — drawn in world coordinates (the engine has already
  // translated the canvas by the camera offset).
  // =======================================================================

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    // Pier and flag rotate to point out to sea, away from the island —
    // so the jetty always meets the beach it belongs to.
    ctx.save();
    ctx.rotate(this.facing);

    // --- Pier: a wooden jetty running from the sand into the water ------
    ctx.fillStyle = "#7a5a36";
    ctx.fillRect(-14, -8, 58, 16); // starts a little inland, juts seaward
    ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
    for (let px = -8; px <= 38; px += 9) {
      ctx.fillRect(px, -8, 2, 16); // plank seams
    }
    // Mooring posts at the seaward end.
    ctx.fillStyle = "#4a3320";
    ctx.beginPath();
    ctx.arc(42, -7, 2.5, 0, Math.PI * 2);
    ctx.arc(42, 7, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // --- A little rowboat moored alongside ------------------------------
    ctx.fillStyle = "#8a5a33";
    ctx.strokeStyle = "#3a2718";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(22, 16, 9, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.moveTo(15, 16);
    ctx.lineTo(29, 16); // thwart (the rower's bench)
    ctx.stroke();

    // --- Flag pole + faction flag at the landward end --------------------
    ctx.strokeStyle = "#3d2716";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(-10, -30);
    ctx.stroke();

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(-10, -30);
    ctx.lineTo(14, -24);
    ctx.lineTo(-10, -18);
    ctx.closePath();
    ctx.fill();

    ctx.restore(); // back to unrotated, port-centered space

    // --- Name label: floated out over open water (along the pier's
    // facing) so it never gets lost against the island detail ------------
    const lx = Math.cos(this.facing) * 86;
    const ly = Math.sin(this.facing) * 86;
    ctx.font = "17px 'Pirata One', 'Trebuchet MS', sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.strokeText(this.name, lx, ly + 6);
    ctx.fillStyle = "#e8dcc0";
    ctx.fillText(this.name, lx, ly + 6);

    ctx.restore();
  }
}

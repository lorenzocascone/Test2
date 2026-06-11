/**
 * portMenu.js — The docked-at-port UI: Tavern and Market tabs.
 *
 * This module owns all DOM interaction for the port overlay. The engine
 * calls open(port) when the player docks and close() when they leave;
 * while the menu is open the engine's physics loop is paused (the engine
 * checks `engine.paused`, which open/close toggle here).
 *
 * All transactions mutate engine.state directly and then re-render, so
 * gold/crew/cargo numbers in both the menu footer and the main HUD stay
 * in sync (the HUD keeps updating each frame even while paused).
 */

import { GOODS } from "./port.js";

// --- Tavern price list ------------------------------------------------------
const RECRUIT_COST = 25;   // one sailor
const ROUND_COST = 110;    // a round of drinks: five sailors sign on
const RUMOR_COST = 15;

// A little faction color for the tavern tab.
const TAVERN_FLAVOR = {
  Spanish: "Candle-lit and quiet; somewhere a guitar plays. Off-duty soldiers eye your cutlass.",
  English: "Smoke, dice and navy officers. The ale is warm but the gossip is fresh.",
  French:  "Wine flows freely and everyone is talking at once. Mind your purse.",
  Pirate:  "Sawdust on the floor, knives in the ceiling beams. Best tavern in the Caribbean.",
};

// Flavor rumors mixed in among the genuinely useful price tips.
const FLAVOR_RUMORS = [
  "An old salt swears the wind always turns against whoever names their ship after a saint.",
  "They say a Spanish treasure fleet was scattered by a storm last month. Wreckage everywhere.",
  "A man in the corner claims he sailed clean off the edge of the map. Nobody believes him.",
];

export class PortMenu {
  /**
   * @param {import("./engine.js").Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.port = null; // the port we're currently docked at (null = closed)

    // --- Cache every DOM node we touch ---------------------------------
    this.el = {
      root: document.getElementById("port-menu"),
      name: document.getElementById("port-name"),
      faction: document.getElementById("port-faction"),
      close: document.getElementById("port-close"),
      tabs: document.querySelectorAll(".port-tab"),
      paneTavern: document.getElementById("tab-tavern"),
      paneMarket: document.getElementById("tab-market"),
      tavernFlavor: document.getElementById("tavern-flavor"),
      btnRecruit: document.getElementById("btn-recruit"),
      btnRecruit5: document.getElementById("btn-recruit5"),
      btnRumor: document.getElementById("btn-rumor"),
      rumorBox: document.getElementById("rumor-box"),
      marketRows: document.getElementById("market-rows"),
      gold: document.getElementById("menu-gold"),
      crew: document.getElementById("menu-crew"),
      cargo: document.getElementById("menu-cargo"),
      status: document.getElementById("menu-status"),
    };

    // --- Static event wiring (done once; the menu is a singleton) ------
    this.el.close.addEventListener("click", () => this.close());

    for (const tab of this.el.tabs) {
      tab.addEventListener("click", () => this._switchTab(tab.dataset.tab));
    }

    this.el.btnRecruit.addEventListener("click", () => this._recruit(1, RECRUIT_COST));
    this.el.btnRecruit5.addEventListener("click", () => this._recruit(5, ROUND_COST));
    this.el.btnRumor.addEventListener("click", () => this._buyRumor());

    // Market buy/sell buttons are re-created on every render, so we use
    // event delegation: one listener on the container reads data-attrs.
    this.el.marketRows.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-good]");
      if (btn) this._trade(btn.dataset.good, btn.dataset.op);
    });
  }

  get isOpen() {
    return this.port !== null;
  }

  // =======================================================================
  // Open / close — these are the pause/resume seams for the whole game.
  // =======================================================================

  /** @param {import("./port.js").Port} port */
  open(port) {
    this.port = port;
    this.engine.paused = true; // engine.update() skips physics while set

    this.el.root.classList.remove("hidden");
    this.el.rumorBox.textContent = "";
    this._setStatus("");
    this._switchTab("tavern");
    this._renderAll();
  }

  close() {
    this.port = null;
    this.engine.paused = false; // physics resumes on the next frame
    this.el.root.classList.add("hidden");
  }

  // =======================================================================
  // Tabs
  // =======================================================================

  _switchTab(name) {
    for (const tab of this.el.tabs) {
      tab.classList.toggle("active", tab.dataset.tab === name);
    }
    this.el.paneTavern.classList.toggle("active", name === "tavern");
    this.el.paneMarket.classList.toggle("active", name === "market");
  }

  // =======================================================================
  // Rendering
  // =======================================================================

  _renderAll() {
    // Header: port identity, faction badge tinted with the faction color.
    this.el.name.textContent = this.port.name;
    this.el.faction.textContent = this.port.faction;
    this.el.faction.style.background = this.port.color;

    this.el.tavernFlavor.textContent = TAVERN_FLAVOR[this.port.faction];

    this._renderMarket();
    this._renderFooter();
  }

  /** Rebuild the market table from current prices/stock/cargo. */
  _renderMarket() {
    const cargo = this.engine.state.cargo;

    this.el.marketRows.innerHTML = Object.entries(GOODS)
      .map(([key, good]) => {
        const entry = this.port.market[key];
        return `
          <div class="market-row">
            <div class="market-good">
              <b>${good.label}</b>
              <span>stock ${entry.stock} &middot; you have ${cargo[key]} &middot; takes ${good.weight} space</span>
            </div>
            <div class="market-price">${entry.price}g</div>
            <button data-good="${key}" data-op="buy">Buy</button>
            <button data-good="${key}" data-op="sell">Sell</button>
          </div>`;
      })
      .join("");
  }

  /** Footer mirrors the main HUD so you never lose track mid-haggle. */
  _renderFooter() {
    const s = this.engine.state;
    this.el.gold.textContent = Math.floor(s.gold);
    this.el.crew.textContent = s.crew;
    this.el.cargo.textContent = `${this.engine.cargoUsed()}/${s.maxCargo}`;
  }

  /** One-line feedback under the footer ("Not enough gold", etc.). */
  _setStatus(text) {
    this.el.status.textContent = text;
  }

  // =======================================================================
  // Market transactions
  // =======================================================================

  /**
   * Attempt to buy or sell ONE unit of a good, enforcing gold, stock and
   * cargo-capacity constraints. On success the port records the trade
   * (adjusting its stock and price) and the UI re-renders.
   *
   * @param {string} goodKey - key into GOODS
   * @param {"buy"|"sell"} op
   */
  _trade(goodKey, op) {
    const state = this.engine.state;
    const entry = this.port.market[goodKey];
    const weight = GOODS[goodKey].weight;

    if (op === "buy") {
      if (state.gold < entry.price) {
        return this._setStatus("Not enough gold.");
      }
      if (entry.stock <= 0) {
        return this._setStatus("The merchant is sold out.");
      }
      if (this.engine.cargoUsed() + weight > state.maxCargo) {
        return this._setStatus("Your hold is full.");
      }
      state.gold -= entry.price;
      state.cargo[goodKey] += 1;
      this.port.recordPurchase(goodKey);
      this._setStatus(`Bought 1 ${GOODS[goodKey].label.toLowerCase()}.`);
    } else {
      if (state.cargo[goodKey] <= 0) {
        return this._setStatus(`You have no ${GOODS[goodKey].label.toLowerCase()} to sell.`);
      }
      state.gold += entry.price;
      state.cargo[goodKey] -= 1;
      this.port.recordSale(goodKey);
      this._setStatus(`Sold 1 ${GOODS[goodKey].label.toLowerCase()}.`);
    }

    this._renderMarket();
    this._renderFooter();
  }

  // =======================================================================
  // Tavern
  // =======================================================================

  /** Hire sailors if the player can pay and has bunk space. */
  _recruit(count, cost) {
    const state = this.engine.state;
    if (state.gold < cost) {
      return this._setStatus("Not enough gold to pay the signing bounty.");
    }
    if (state.crew + count > state.maxCrew) {
      return this._setStatus("No bunks left — the ship is fully crewed.");
    }
    state.gold -= cost;
    state.crew += count;
    this._setStatus(count === 1 ? "A sailor signs on." : `${count} sailors stagger aboard.`);
    this._renderFooter();
  }

  /**
   * Rumors are mostly genuinely useful: they reveal the live price of a
   * random good at a random OTHER port — exactly the information a
   * trader needs. Occasionally you just get bar talk.
   */
  _buyRumor() {
    const state = this.engine.state;
    if (state.gold < RUMOR_COST) {
      return this._setStatus("Nobody talks for free, and you're broke.");
    }
    state.gold -= RUMOR_COST;

    let rumor;
    const others = this.engine.ports.filter((p) => p !== this.port);
    if (others.length > 0 && Math.random() > 0.25) {
      // Useful rumor: a real price at another port.
      const target = others[Math.floor(Math.random() * others.length)];
      const keys = Object.keys(GOODS);
      const goodKey = keys[Math.floor(Math.random() * keys.length)];
      rumor = `"Heard it from a reliable mate — ${GOODS[goodKey].label.toLowerCase()} is going for ` +
        `${target.market[goodKey].price} gold in ${target.name} right now."`;
    } else {
      // Flavor rumor: entertaining, worthless.
      rumor = `"${FLAVOR_RUMORS[Math.floor(Math.random() * FLAVOR_RUMORS.length)]}"`;
    }

    this.el.rumorBox.textContent = rumor;
    this._setStatus("");
    this._renderFooter();
  }
}

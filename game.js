"use strict";

/* ============================================================================
   0. FAILING LOUDLY

   index.html ships with a static "Dealing…" placeholder, so if this script
   dies before its first render the page just sits there looking patient. The
   usual cause is a stale cached copy of one file against a fresh copy of
   another, which shows up as a missing element. Say so, in the UI.
   ============================================================================ */

function fatal(err) {
  const box = document.getElementById("status");
  if (box) {
    box.className = "status lose";
    box.innerHTML =
      '<span class="hl">The game failed to start.</span> ' +
      String((err && err.message) || err) +
      ' — if you just updated the files, force-reload with ' +
      '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.';
  }
  if (typeof console !== "undefined") console.error(err);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("error", e => fatal(e.error || e.message));
}

/* ============================================================================
   1. MODEL
   ============================================================================ */

const TARGET   = 12;   // go over this and you bust
const COPIES   = 4;    // copies of each value in a deck
const MAX_VAL  = 6;
const START_HP = 100;
const ATK      = 5;    // health lost per attack landed
const BUST_COST = 2;   // a bust falls back to its pre-bust score, minus this
const CRIT_SHARE = 3;  // landing on 12 crits one attack in this many (rounded up)
const BLOCK_ON_STAND = 1;  // attacks absorbed by choosing to stand rather than busting

/**
 * At or below this total a draw cannot take you over the target, so hitting is
 * free and standing is strictly dominated. Derived rather than hard-coded, so
 * it stays correct if TARGET or MAX_VAL are retuned.
 */
const SAFE_CEILING = TARGET - MAX_VAL;
const DECK_SIZE = COPIES * MAX_VAL;

const DONE_ACTIVE = 0, DONE_STOOD = 1, DONE_BUST = 2;

/** A fresh, shuffled 24-card deck. Each player owns one. */
function freshDeck() {
  const d = [];
  for (let v = 1; v <= MAX_VAL; v++)
    for (let c = 0; c < COPIES; c++) d.push(v);
  for (let i = d.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** Counts of each value left in a deck array: index 0 = value 1. */
function countsOf(deck) {
  const c = new Array(MAX_VAL).fill(0);
  deck.forEach(v => c[v - 1]++);
  return c;
}

/**
 * The score a round is *measured* by. A live hand counts for its total; a bust
 * falls back to whatever it held before the fatal card, minus BUST_COST, and
 * never below zero. Totals passed in here are always the pre-bust ones, so a
 * busted hand is identified by its flag rather than by being over the target.
 */
function scoreOf(t, done) {
  return done === DONE_BUST ? Math.max(0, t - BUST_COST) : t;
}

/**
 * Who won the round, and how hard.
 *
 * Busting loses outright, however good the fallback score looks. Otherwise the
 * higher total takes it. The winner then lands one attack per point of
 * difference between the two measured scores — so a narrow win barely stings
 * and a rout is devastating.
 *
 * Choosing to STAND is a defensive act: a stander absorbs BLOCK_ON_STAND of the
 * attacks aimed at them. Busting out of the round earns no such protection.
 * That is what stops the game collapsing into "always hit" — sitting on a
 * modest total concedes the margin but blunts the punishment, and a win by a
 * single point against a stander lands nothing at all.
 *
 * Landing exactly on the target turns one attack in every CRIT_SHARE (rounded
 * up) into a crit worth double — reckoned on the attacks that actually get
 * through, not the ones that were blocked.
 */
function roundOutcome(pT, pD, aT, aD) {
  const pB = pD === DONE_BUST, aB = aD === DONE_BUST;

  let winner = null;
  if (pB && aB)      winner = null;
  else if (pB)       winner = "a";
  else if (aB)       winner = "p";
  else if (pT > aT)  winner = "p";
  else if (aT > pT)  winner = "a";
  if (!winner) return { winner: null, raw: 0, blocked: 0, hits: 0, crits: 0 };

  const pS = scoreOf(pT, pD), aS = scoreOf(aT, aD);
  const raw = Math.max(0, winner === "p" ? pS - aS : aS - pS);

  // The guard never blocks the last attack: a won round always draws blood.
  // Letting it nullify a one-point win left roughly half of all rounds scoreless.
  const loserStood = (winner === "p" ? aD : pD) === DONE_STOOD;
  const blocked = loserStood ? Math.min(BLOCK_ON_STAND, Math.max(0, raw - 1)) : 0;
  const hits = raw - blocked;

  const onTarget = (winner === "p" ? pT : aT) === TARGET;
  const crits = onTarget ? Math.ceil(hits / CRIT_SHARE) : 0;
  return { winner, raw, blocked, hits, crits };
}

/** Health taken off the loser: every attack costs ATK, and a crit costs twice. */
function damageOf(o, doubled) {
  return (o.hits + o.crits) * ATK * (doubled ? 2 : 1);
}

/* ============================================================================
   2. AI — exact expectimax over both deck compositions

   Each player draws from their own deck, so the state carries two independent
   compositions. Value is expected damage swing from the PLAYER's point of
   view, each side's damage clamped by the target's remaining HP so nobody
   wastes a crit on a one-hit-point opponent.
   ============================================================================ */

const AI = (() => {
  let memo = new Map();
  let hp = { p: START_HP, a: START_HP };

  function terminal(pT, pD, aT, aD, dbl) {
    const o = roundOutcome(pT, pD, aT, aD);
    if (!o.winner) return 0;
    const dmg = damageOf(o, dbl);                // doubling cuts both ways
    return o.winner === "p" ? Math.min(dmg, hp.a) : -Math.min(dmg, hp.p);
  }

  /** Base-5 digits of one deck's counts: 0..15624. */
  function deckKey(counts) {
    let k = 0;
    for (let i = 0; i < MAX_VAL; i++) k = k * 5 + counts[i];
    return k;
  }

  /** Whole state as one integer-safe key (max ~1.7e12, well inside 2^53). */
  function keyOf(pC, aC, pT, aT, pD, aD, turn, dbl) {
    let k = deckKey(pC) * 15625 + deckKey(aC);
    k = (((((k * 14 + pT) * 14 + aT) * 3 + pD) * 3 + aD) * 2 + turn) * 2 + dbl;
    return k;
  }

  /** The deck a hit comes out of, reshuffled to full if its owner has run dry. */
  function source(counts, n) {
    return n === 0 ? { c: new Array(MAX_VAL).fill(COPIES), n: DECK_SIZE } : { c: counts, n };
  }

  /**
   * The player's "double": take exactly one card, then stop — busting or not —
   * with the round's damage doubled in both directions from here on.
   * Only the player has this; the opponent never gets a double branch.
   */
  function doubleValue(pC, pN, aC, aN, pT, aT, aD) {
    const s = source(pC, pN);
    let out = 0;
    for (let i = 0; i < MAX_VAL; i++) {
      if (!s.c[i]) continue;
      const p = s.c[i] / s.n, t = pT + (i + 1);
      s.c[i]--;
      out += p * (t > TARGET
        ? ev(s.c, s.n - 1, aC, aN, pT, aT, DONE_BUST,  aD, 1, 1)
        : ev(s.c, s.n - 1, aC, aN, t,          aT, DONE_STOOD, aD, 1, 1));
      s.c[i]++;
    }
    return out;
  }

  /**
   * Expected value of the position. `turn` is 0 for the player, 1 for the AI.
   * Totals are 0..TARGET throughout: a bust keeps the score it held before the
   * fatal card and is identified by its DONE_BUST flag, not by its number.
   * `dbl` is 1 once the player has doubled the round's stakes.
   */
  function ev(pC, pN, aC, aN, pT, aT, pD, aD, turn, dbl) {
    // normalise: a stray undefined here would poison every memo key with NaN
    dbl = dbl ? 1 : 0;
    if (pD !== DONE_ACTIVE && aD !== DONE_ACTIVE) return terminal(pT, pD, aT, aD, dbl);
    if (turn === 0 && pD !== DONE_ACTIVE) turn = 1;
    if (turn === 1 && aD !== DONE_ACTIVE) turn = 0;

    const key = keyOf(pC, aC, pT, aT, pD, aD, turn, dbl);
    const seen = memo.get(key);
    if (seen !== undefined) return seen;

    const mine = turn === 0;

    // --- stand ---
    const stand = mine
      ? ev(pC, pN, aC, aN, pT, aT, DONE_STOOD, aD, 1, dbl)
      : ev(pC, pN, aC, aN, pT, aT, pD, DONE_STOOD, 0, dbl);

    // --- hit --- the mover draws from their OWN deck, reshuffling it if empty
    const s = source(mine ? pC : aC, mine ? pN : aN);
    let hit = 0;
    for (let i = 0; i < MAX_VAL; i++) {
      if (!s.c[i]) continue;
      const p = s.c[i] / s.n, v = i + 1;
      s.c[i]--;
      if (mine) {
        const t = pT + v;
        hit += p * (t > TARGET
          ? ev(s.c, s.n - 1, aC, aN, pT, aT, DONE_BUST, aD, 1, dbl)
          : ev(s.c, s.n - 1, aC, aN, t, aT, DONE_ACTIVE, aD, 1, dbl));
      } else {
        const t = aT + v;
        hit += p * (t > TARGET
          ? ev(pC, pN, s.c, s.n - 1, pT, aT, pD, DONE_BUST, 0, dbl)
          : ev(pC, pN, s.c, s.n - 1, pT, t, pD, DONE_ACTIVE, 0, dbl));
      }
      s.c[i]++;
    }

    let out;
    if (mine) {
      // the double is a third option, and only while the stakes are still single
      out = Math.max(stand, hit);
      if (!dbl) out = Math.max(out, doubleValue(pC, pN, aC, aN, pT, aT, aD));
    } else {
      out = Math.min(stand, hit);
    }
    memo.set(key, out);
    return out;
  }

  /** Expected value of each action for whoever is to move, plus their bust risk. */
  function actionValues(pC, pN, aC, aN, pT, aT, pD, aD, turn, dbl) {
    dbl = dbl ? 1 : 0;
    const mine = turn === 0;
    const stand = mine
      ? ev(pC, pN, aC, aN, pT, aT, DONE_STOOD, aD, 1, dbl)
      : ev(pC, pN, aC, aN, pT, aT, pD, DONE_STOOD, 0, dbl);

    const s = source(mine ? pC : aC, mine ? pN : aN);
    const reshuffles = (mine ? pN : aN) === 0;

    let hit = 0, bust = 0;
    const total = mine ? pT : aT;
    for (let i = 0; i < MAX_VAL; i++) {
      if (!s.c[i]) continue;
      const p = s.c[i] / s.n, v = i + 1, t = total + v;
      if (t > TARGET) bust += p;
      s.c[i]--;
      if (mine) {
        hit += p * (t > TARGET
          ? ev(s.c, s.n - 1, aC, aN, pT, aT, DONE_BUST, aD, 1, dbl)
          : ev(s.c, s.n - 1, aC, aN, t, aT, DONE_ACTIVE, aD, 1, dbl));
      } else {
        hit += p * (t > TARGET
          ? ev(pC, pN, s.c, s.n - 1, pT, aT, pD, DONE_BUST, 0, dbl)
          : ev(pC, pN, s.c, s.n - 1, pT, t, pD, DONE_ACTIVE, 0, dbl));
      }
      s.c[i]++;
    }

    const dv = (mine && !dbl) ? doubleValue(pC, pN, aC, aN, pT, aT, aD) : null;
    return { stand, hit, bust, reshuffles, double: dv };
  }

  return {
    /** Call at the start of every round: HP is fixed for its duration. */
    reset(pHP, aHP) { hp = { p: pHP, a: aHP }; memo = new Map(); },

    actionValues,
    ev,

    /**
     * The AI's move: "hit" or "stand".
     * temp 1 always takes the better action. Below that it picks from a softmax
     * over the true expected values, so its mistakes are close calls first.
     */
    decide(pC, pN, aC, aN, pT, aT, pD, aD, temp, dbl) {
      // Two moves are dominated no matter what the rest of the board looks like,
      // and the dial never gets to make either, at any temperature. A blunder
      // this obvious reads as a broken opponent rather than an easy one.
      if (aT <= SAFE_CEILING) return "hit";    // nothing in the deck can bust you
      if (aT >= TARGET) return "stand";        // everything in the deck busts you

      const { stand, hit } = actionValues(pC, pN, aC, aN, pT, aT, pD, aD, 1, dbl ? 1 : 0);
      if (temp >= 1) return hit < stand ? "hit" : "stand";   // AI minimises
      // The 0.6 floor keeps the far-left of the dial from degenerating into a
      // coin flip — Easy should play badly, not randomly.
      //
      // SCALE matters here. These values are expected damage in *health points*,
      // so a typical decision is worth ~25 of them; feeding that straight into
      // exp() saturates the softmax and the dial stops doing anything at all.
      // Dividing by a characteristic decision size keeps the curve meaningful,
      // and keeps it meaningful if ATK or START_HP are ever retuned.
      const SPREAD = 8 * ATK;
      const sharp = (0.6 + 15 * temp * temp) / SPREAD;
      const wHit   = Math.exp(-hit   * sharp);
      const wStand = Math.exp(-stand * sharp);
      return Math.random() * (wHit + wStand) < wHit ? "hit" : "stand";
    }
  };
})();

/* ============================================================================
   3. VIEW
   ============================================================================ */

/** Look up an element, and complain precisely if the markup doesn't have it. */
const $ = id => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html has no #${id} — page and script are out of sync`);
  return node;
};
const el = {
  pHand: $("pHand"), aiHand: $("aiHand"),
  pTotal: $("pTotal"), aiTotal: $("aiTotal"),
  pHp: $("pHp"), aiHp: $("aiHp"),
  pDeckBtn: $("pDeckBtn"), aiDeckBtn: $("aiDeckBtn"),
  pDeckCount: $("pDeckCount"), aiDeckCount: $("aiDeckCount"),
  pScore: $("pScore"), aiScore: $("aiScore"),
  pScoreNum: $("pScoreNum"), aiScoreNum: $("aiScoreNum"),
  pGuard: $("pGuard"), aiGuard: $("aiGuard"),
  status: $("status"), odds: $("oddsLine"),
  deckPanel: $("deckPanel"), deckClose: $("deckClose"),
  hitBtn: $("hitBtn"), standBtn: $("standBtn"), doubleBtn: $("doubleBtn"),
  stakes: $("stakes"),
  thinking: $("thinking"), thinkingLabel: $("thinkingLabel")
};

function cardNode(value, opts = {}) {
  const d = document.createElement("div");
  d.className = "card v" + value + (opts.small ? " small" : "");
  d.dataset.slot = opts.slot !== undefined ? opts.slot : "";
  d.innerHTML =
    `<span class="corner tl">${value}</span>` +
    `<span class="value">${value}</span>` +
    `<span class="corner br">${value}</span>`;
  return d;
}

/** Fly a card from `from` to `to`: a short wind-up the opposite way, then a fast run. */
function flyCard(value, from, to, destNode, done) {
  if (!from || !to || !destNode || typeof destNode.animate !== "function") { done(); return; }

  const node = cardNode(value);
  Object.assign(node.style, {
    position: "fixed", left: from.left + "px", top: from.top + "px",
    width: from.width + "px", height: from.height + "px",
    margin: "0", zIndex: "80", pointerEvents: "none"
  });
  document.body.appendChild(node);
  destNode.style.visibility = "hidden";

  const dx = to.left - from.left, dy = to.top - from.top;
  const len = Math.hypot(dx, dy) || 1;
  const bx = -dx / len * 32, by = -dy / len * 32;
  const tilt = dx >= 0 ? 8 : -8;

  const anim = node.animate([
    { transform: "translate(0,0) rotate(0deg) scale(1)", easing: "cubic-bezier(.3,1.5,.6,1)" },
    { transform: `translate(${bx}px,${by}px) rotate(${-tilt}deg) scale(1.07)`,
      offset: 0.34, easing: "cubic-bezier(.5,0,.2,1)" },
    { transform: `translate(${dx}px,${dy}px) rotate(0deg) scale(1)` }
  ], { duration: 430, fill: "forwards" });

  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    node.remove();
    destNode.style.visibility = "";
    done();
  };
  anim.onfinish = finish;
  setTimeout(finish, 750);
}

/* ---------------------------------------------------------------------------
   Thinking indicator.

   The solver runs synchronously and blocks the thread, so a spinner shown in
   the same tick would never paint. Everything slow therefore goes through
   afterPaint(), which yields two frames first. Solve cost is measured as it
   goes, and anything that has recently been slow switches to the deferred path
   automatically — so as the search grows, the indicator starts earning its keep
   without any of this needing to be revisited.
   --------------------------------------------------------------------------- */

const SLOW_MS = 80;
let lastSolveMs = 0;

const raf = fn => (typeof requestAnimationFrame === "function")
  ? requestAnimationFrame(fn)
  : setTimeout(fn, 16);

/** Run `fn` only after the browser has had a chance to paint. */
const afterPaint = fn => raf(() => raf(fn));

function noteSolve(ms) { lastSolveMs = ms; }
const solverIsSlow = () => lastSolveMs >= SLOW_MS;

function setThinking(on, label) {
  el.thinking.className = "thinking" + (on ? " on" : "");
  if (label) el.thinkingLabel.textContent = label;
}

/** Swell and settle. Used whenever a score changes, harder when a round lands. */
function pop(node, strength = 1.4, duration = 400) {
  if (!node || typeof node.animate !== "function") return;
  node.animate([
    { transform: "scale(1)" },
    { transform: `scale(${strength})`, offset: 0.32 },
    { transform: "scale(1)" }
  ], { duration, easing: "cubic-bezier(.34,1.56,.64,1)" });
}

/** A health bar that drains, and reddens as it gets low. */
function renderHp(node, hp) {
  if (!node._fill) {
    node.innerHTML = "";
    const track = document.createElement("span");
    track.className = "hp-track";
    const fill = document.createElement("span");
    fill.className = "hp-fill";
    track.appendChild(fill);
    const num = document.createElement("span");
    num.className = "hp-num";
    node.appendChild(track);
    node.appendChild(num);
    node._fill = fill;
    node._num = num;
  }
  const pct = Math.max(0, Math.min(100, hp / START_HP * 100));
  node._fill.style.width = pct.toFixed(2).replace(/\.?0+$/, "") + "%";
  node._fill.className = "hp-fill" + (pct <= 20 ? " critical" : pct <= 50 ? " hurt" : "");
  node._num.textContent = hp;
}

/**
 * A damage number that lifts off the side that just got hit and fades.
 * Purely decorative — if the browser can't animate, nothing is missed.
 */
function floatDamage(side, dmg, crit) {
  const host = side === "p" ? el.pHp : el.aiHp;
  if (!host || typeof host.getBoundingClientRect !== "function") return;
  const r = host.getBoundingClientRect();
  const n = document.createElement("div");
  n.className = "dmg-float" + (crit ? " crit" : "");
  n.textContent = "-" + dmg;
  Object.assign(n.style, {
    position: "fixed",
    left: (r.left + r.width / 2) + "px",
    top: r.top + "px",
    zIndex: "90",
    pointerEvents: "none"
  });
  document.body.appendChild(n);

  if (typeof n.animate !== "function") { n.remove(); return; }
  const anim = n.animate([
    { transform: "translate(-50%,0) scale(.6)", opacity: 0 },
    { transform: "translate(-50%,-14px) scale(1.15)", opacity: 1, offset: 0.25 },
    { transform: "translate(-50%,-46px) scale(1)", opacity: 0 }
  ], { duration: 1100, easing: "cubic-bezier(.22,.9,.3,1)" });

  let done = false;
  const clean = () => { if (!done) { done = true; n.remove(); } };
  anim.onfinish = clean;
  setTimeout(clean, 1400);
}

function renderHand(node, hand, done) {
  node.innerHTML = "";
  if (!hand.length) { node.innerHTML = '<div class="empty">— no cards —</div>'; return; }
  hand.forEach((v, k) => node.appendChild(cardNode(v, { slot: k })));
  node.classList.toggle("busted", done === DONE_BUST);
}

function totalText(hand, done) {
  const t = hand.reduce((a, b) => a + b, 0);
  if (done === DONE_BUST)  return `${t} — bust`;
  if (done === DONE_STOOD) return `${t} — stood`;
  if (t === TARGET)        return `${t} — on target`;
  return String(t);
}

/* ============================================================================
   4. CONTROLLER
   ============================================================================ */

const G = {
  p: { hand: [], deck: [], done: DONE_ACTIVE, hp: START_HP, reshuffled: false },
  a: { hand: [], deck: [], done: DONE_ACTIVE, hp: START_HP, reshuffled: false },
  turn: 0,                 // 0 = player, 1 = AI
  doubled: false,          // player doubled this round: all damage counts twice
  playerFirst: true,
  phase: "idle",           // idle | playing | roundover | matchover
  temp: 0.5,
  showOdds: true,
  busy: false,
  tally: { w: 0, d: 0, l: 0 },
  deckOpen: false,
  deckFocus: "p"
};

/** What the hand actually adds up to — over the target once it has busted. */
const total = side => G[side].hand.reduce((a, b) => a + b, 0);

/**
 * The number the rules care about. A bust always happens on the last card
 * drawn, so the score it fell back from is simply the hand without that card.
 * Everything downstream — the solver, the scoreboard, the damage — uses this.
 */
const scoreTotal = side => {
  const h = G[side].hand;
  return G[side].done === DONE_BUST
    ? h.slice(0, -1).reduce((a, b) => a + b, 0)
    : h.reduce((a, b) => a + b, 0);
};

/** Draw from a side's OWN deck, reshuffling that deck alone if it has run out. */
function drawCard(side) {
  const s = G[side];
  if (!s.deck.length) { s.deck = freshDeck(); s.reshuffled = true; }
  return s.deck.pop();
}

/* ---- match / round ---- */

function newMatch() {
  G.p.deck = freshDeck();
  G.a.deck = freshDeck();
  G.p.hp = START_HP;
  G.a.hp = START_HP;
  G.playerFirst = true;
  G.phase = "playing";
  startRound();
}

function startRound() {
  G.p.hand = []; G.p.done = DONE_ACTIVE; G.p.reshuffled = false;
  G.a.hand = []; G.a.done = DONE_ACTIVE; G.a.reshuffled = false;
  G.turn = G.playerFirst ? 0 : 1;
  G.playerFirst = !G.playerFirst;
  G.phase = "playing";
  G.doubled = false;
  G.busy = true;
  AI.reset(G.p.hp, G.a.hp);

  // clear the scoreboard quietly, so the first card of the round is what pops
  lastScore.p = "–"; lastScore.a = "–";
  el.pScoreNum.textContent = "–";
  el.aiScoreNum.textContent = "–";

  render();

  dealTo("a", () => dealTo("p", () => {
    G.busy = false;
    render();
    if (G.turn === 1) scheduleAi();
    else setStatus("Your move — <span class='hl'>hit</span> or <span class='hl'>stand</span>?");
  }));
}

/** Draw one card into a hand, animated from that player's own deck. */
function dealTo(side, after) {
  const btn = side === "p" ? el.pDeckBtn : el.aiDeckBtn;
  const from = btn.getBoundingClientRect();
  const v = drawCard(side);
  G[side].hand.push(v);
  if (total(side) > TARGET) G[side].done = DONE_BUST;
  render();

  const container = side === "p" ? el.pHand : el.aiHand;
  const slot = G[side].hand.length - 1;
  const node = container.querySelector('[data-slot="' + slot + '"]');
  const to = node ? node.getBoundingClientRect() : null;

  flyCard(v, from, to, node, () => { render(); after && after(); });
}

/* ---- turns ---- */

function afterAction() {
  if (G.p.done !== DONE_ACTIVE && G.a.done !== DONE_ACTIVE) { resolveRound(); return; }
  const mineDone = G.turn === 0 ? G.p.done : G.a.done;
  if (mineDone !== DONE_ACTIVE) {
    G.turn = G.turn === 0 ? 1 : 0;          // I'm out; the other plays on alone
  } else {
    const other = G.turn === 0 ? 1 : 0;
    const otherDone = other === 0 ? G.p.done : G.a.done;
    if (otherDone === DONE_ACTIVE) G.turn = other;
  }
  G.busy = false;
  render();
  if (G.turn === 1) scheduleAi();
  else setStatus("Your move — <span class='hl'>hit</span> or <span class='hl'>stand</span>?");
}

function playerHit() {
  if (G.phase !== "playing" || G.busy || G.turn !== 0 || G.p.done !== DONE_ACTIVE) return;
  G.busy = true;
  setStatus(G.p.deck.length ? "You hit." : "Your deck is empty — reshuffling.");
  dealTo("p", () => {
    if (G.p.done === DONE_BUST) {
      setStatus(`You drew to ${total("p")} — <span class="hl">bust</span>.`, "lose");
    } else if (total("p") === TARGET) {
      // Every card left would bust you, so there is no decision to offer.
      // Stand automatically and collect the guard.
      G.p.done = DONE_STOOD;
      setStatus(`<span class="hl">${TARGET} exactly.</span> Standing automatically — nothing could improve it.`);
      render();
    }
    afterAction();
  });
}

/**
 * Double: one more card, then you're done either way, and every point of damage
 * this round counts twice — dealt AND taken. The opponent never gets this.
 */
function playerDouble() {
  if (G.phase !== "playing" || G.busy || G.turn !== 0 ||
      G.p.done !== DONE_ACTIVE || G.doubled) return;
  G.busy = true;
  G.doubled = true;
  setStatus("<span class='hl'>Doubled.</span> One card, then you're out — stakes are ×2 both ways.");
  render();
  dealTo("p", () => {
    if (G.p.done === DONE_BUST) {
      setStatus(`You doubled into ${total("p")} — <span class="hl">bust, at double stakes</span>.`, "lose");
    } else {
      G.p.done = DONE_STOOD;
      setStatus(`Doubled and standing on ${total("p")}.`);
    }
    afterAction();
  });
}

function playerStand() {
  if (G.phase !== "playing" || G.busy || G.turn !== 0 || G.p.done !== DONE_ACTIVE) return;
  G.busy = true;
  G.p.done = DONE_STOOD;
  setStatus(`You stand on ${total("p")}.`);
  render();
  setTimeout(afterAction, 380);
}

function scheduleAi() {
  setThinking(true, "Opponent is calculating");
  setTimeout(aiMove, 620);
}

function aiMove() {
  if (G.phase !== "playing" || G.turn !== 1 || G.a.done !== DONE_ACTIVE) {
    setThinking(false);
    return;
  }
  G.busy = true;
  // yield first: the solve blocks, and the indicator has to be on screen by then
  afterPaint(() => {
    const t0 = Date.now();
    let move;
    try {
      move = AI.decide(
        countsOf(G.p.deck), G.p.deck.length,
        countsOf(G.a.deck), G.a.deck.length,
        scoreTotal("p"), scoreTotal("a"), G.p.done, G.a.done, G.temp, G.doubled);
    } finally {
      noteSolve(Date.now() - t0);
      setThinking(false);
    }
    applyAiMove(move);
  });
}

function applyAiMove(move) {
  if (move === "stand") {
    G.a.done = DONE_STOOD;
    setStatus(`Opponent stands on ${total("a")}.`);
    render();
    setTimeout(afterAction, 380);
  } else {
    setStatus("Opponent hits.");
    dealTo("a", () => {
      if (G.a.done === DONE_BUST) {
        setStatus(`Opponent drew to ${total("a")} — <span class="hl">bust</span>, ` +
                  `falling back to ${scoreOf(scoreTotal("a"), DONE_BUST)}.`, "win");
      }
      afterAction();
    });
  }
}

/* ---- resolution ---- */

function resolveRound() {
  G.phase = "roundover";
  G.busy = true;
  const pS = scoreTotal("p"), aS = scoreTotal("a");
  const o = roundOutcome(pS, G.p.done, aS, G.a.done);
  const dmg = damageOf(o, G.doubled);

  // "3 attacks × 5" / "4 attacks −1 blocked (1 crit) × 5 ×2 doubled"
  const dmgText = () => {
    let s = `<b>${o.raw}</b> attack${o.raw === 1 ? "" : "s"}`;
    if (o.blocked) s += ` <span class="block">−${o.blocked} blocked</span>`;
    if (o.crits)   s += ` <span class="crit">${o.crits} crit</span>`;
    s += ` × ${ATK}`;
    if (G.doubled) s += " ×2 doubled";
    return `${s} = <b>${dmg}</b> damage`;
  };

  /** "8 (bust from 10)" so the fallback score is never a mystery. */
  const shownScore = side => {
    const t = total(side);
    return G[side].done === DONE_BUST
      ? `${scoreOf(scoreTotal(side), DONE_BUST)} <span class="note">(bust from ${t})</span>`
      : String(t);
  };

  let msg, cls;
  if (!o.winner) {
    msg = (G.p.done === DONE_BUST && G.a.done === DONE_BUST)
      ? "You both bust — no damage."
      : `Both on ${pS} — push, no damage.`;
    cls = "tie";
  } else if (o.winner === "p") {
    G.a.hp = Math.max(0, G.a.hp - dmg);
    msg = `${shownScore("p")} vs ${shownScore("a")} — ${dmgText()}`;
    cls = "win";
  } else {
    G.p.hp = Math.max(0, G.p.hp - dmg);
    msg = `${shownScore("a")} vs ${shownScore("p")} — ${dmgText()}`;
    cls = "lose";
  }
  if (o.winner && dmg === 0) {
    msg += o.blocked
      ? ` <span class="note">· the guard held</span>`
      : ` <span class="note">· too close to land a blow</span>`;
  }

  const shuffled = [G.p.reshuffled && "yours", G.a.reshuffled && "theirs"].filter(Boolean);
  if (shuffled.length) msg += ` <span class='note'>· reshuffled: ${shuffled.join(" & ")}</span>`;

  setStatus(msg, cls);
  render();

  // the round landing gets a bigger swell than an ordinary draw
  if (o.winner) {
    const strength = 1.6 + Math.min(0.9, dmg / 60);      // scales with the blow
    pop(o.winner === "p" ? el.pScoreNum : el.aiScoreNum, strength, 560);
    if (dmg > 0) floatDamage(o.winner === "p" ? "a" : "p", dmg, o.crits > 0);
  } else {
    pop(el.pScoreNum, 1.25, 460);
    pop(el.aiScoreNum, 1.25, 460);
  }

  setTimeout(() => {
    if (G.p.hp === 0 || G.a.hp === 0) return endMatch();
    G.busy = false;
    startRound();
  }, 1900);
}

function endMatch() {
  G.phase = "matchover";
  G.busy = false;
  let cls, text;
  if (G.a.hp === 0 && G.p.hp === 0) { cls = "tie";  text = "Both down — draw";  G.tally.d++; }
  else if (G.a.hp === 0)            { cls = "win";  text = "You win the match"; G.tally.w++; }
  else                              { cls = "lose"; text = "You lose the match"; G.tally.l++; }
  $("tw").textContent = G.tally.w;
  $("td").textContent = G.tally.d;
  $("tl").textContent = G.tally.l;
  setStatus(`<span class="hl">${text}</span> — press <b>New match</b> or <kbd>N</kbd>.`, cls);
  render();
}

/* ---- rendering ---- */

function render() {
  renderHand(el.pHand, G.p.hand, G.p.done);
  renderHand(el.aiHand, G.a.hand, G.a.done);

  el.pTotal.textContent  = G.p.hand.length ? totalText(G.p.hand, G.p.done) : "—";
  el.aiTotal.textContent = G.a.hand.length ? totalText(G.a.hand, G.a.done) : "—";
  el.pTotal.className  = "total" + (G.p.done === DONE_BUST ? " bust" : total("p") === TARGET ? " target" : "");
  el.aiTotal.className = "total" + (G.a.done === DONE_BUST ? " bust" : total("a") === TARGET ? " target" : "");

  renderHp(el.pHp, G.p.hp);
  renderHp(el.aiHp, G.a.hp);

  el.pDeckCount.textContent  = G.p.deck.length;
  el.aiDeckCount.textContent = G.a.deck.length;

  renderScores();

  const myMove = G.phase === "playing" && !G.busy && G.turn === 0 && G.p.done === DONE_ACTIVE;
  el.hitBtn.disabled = !myMove;
  el.standBtn.disabled = !myMove;
  el.doubleBtn.disabled = !myMove || G.doubled;
  el.stakes.className = "stakes" + (G.doubled ? " on" : "");

  if (G.deckOpen) renderDeckPanel();
  renderOdds();
}

/**
 * The middle scoreboard. Colour reflects who would take the round if it ended
 * right now, so the numbers swap green and red as the totals climb past each
 * other. Only a genuine change triggers the pop — render() runs far too often.
 */
const lastScore = { p: null, a: null };

function renderScores() {
  const r = roundOutcome(scoreTotal("p"), G.p.done, scoreTotal("a"), G.a.done);

  const stateOf = side => {
    if (!G[side].hand.length) return "";
    if (G[side].done === DONE_BUST) return "bust";
    if (!r.winner) return "tie";
    return r.winner === side ? "win" : "lose";
  };

  paintScore("p", el.pScore,  el.pScoreNum,  total("p"), stateOf("p"));
  paintScore("a", el.aiScore, el.aiScoreNum, total("a"), stateOf("a"));

  // a side that stood is guarding: show what that guard is worth, live
  paintGuard(el.pGuard, "p");
  paintGuard(el.aiGuard, "a");
}

function paintGuard(node, side) {
  const guarding = G[side].done === DONE_STOOD && G.phase !== "matchover";
  const on = guarding && BLOCK_ON_STAND > 0;
  if (on && !node._on) pop(node, 1.3, 340);
  node._on = on;
  node.className = "guard" + (on ? " on" : "");
  node.textContent = `−${BLOCK_ON_STAND} blocked`;
}

function paintScore(key, box, num, value, state) {
  box.className = "score" + (state ? " " + state : "");
  // a player who hasn't been dealt anything yet shows a dash, not a losing zero
  const shown = G[key].hand.length ? String(value) : "–";
  if (lastScore[key] === shown) return;
  lastScore[key] = shown;
  num.textContent = shown;
  pop(num);
}

function renderOdds() {
  if (!G.showOdds || G.phase !== "playing" || G.busy ||
      G.turn !== 0 || G.p.done !== DONE_ACTIVE) {
    el.odds.textContent = "";
    return;
  }
  // Whenever the solver has recently been slow, defer so the hint can paint;
  // while it's quick, compute inline and avoid a pointless flash.
  const gen = ++oddsGen;
  const compute = () => {
    if (gen !== oddsGen) return;                  // a newer render superseded us
    const t0 = Date.now();
    const av = AI.actionValues(
      countsOf(G.p.deck), G.p.deck.length,
      countsOf(G.a.deck), G.a.deck.length,
      scoreTotal("p"), scoreTotal("a"), G.p.done, G.a.done, 0, G.doubled ? 1 : 0);
    noteSolve(Date.now() - t0);
    if (gen !== oddsGen) return;

    const options = [["hit", av.hit], ["stand", av.stand]];
    if (av.double !== null) options.push(["double", av.double]);
    const best = options.reduce((a, b) => (b[1] > a[1] ? b : a))[0];

    el.odds.innerHTML =
      `Hitting busts <b>${Math.round(av.bust * 100)}%</b> of the time · ` +
      options.map(([n, v]) => `${n} <b>${fmt(v)}</b>`).join(" vs ") +
      ` · best: <b>${best}</b>`;
  };

  if (solverIsSlow()) {
    el.odds.innerHTML = '<span class="calc">Reading the position…</span>';
    afterPaint(compute);
  } else {
    compute();
  }
}

let oddsGen = 0;

const fmt = x => (x >= 0 ? "+" : "") + x.toFixed(2);

function setStatus(text, cls = "") {
  el.status.className = "status " + cls;
  el.status.innerHTML = text;
}

/* ---- deck viewer ---- */

/** Render one deck's six columns into `host`. */
function renderDeckColumns(host, deck) {
  const counts = countsOf(deck);
  host.innerHTML = "";
  for (let v = 1; v <= MAX_VAL; v++) {
    const col = document.createElement("div");
    col.className = "deck-col" + (counts[v - 1] === 0 ? " gone" : "");
    const stack = document.createElement("div");
    stack.className = "deck-stack";
    for (let k = 0; k < counts[v - 1]; k++) stack.appendChild(cardNode(v, { small: true }));
    for (let k = counts[v - 1]; k < COPIES; k++) {
      const g = document.createElement("div");
      g.className = "card small ghost";
      stack.appendChild(g);
    }
    const cap = document.createElement("div");
    cap.className = "deck-cap";
    cap.innerHTML = `<b>${counts[v - 1]}</b> / ${COPIES}`;
    col.appendChild(stack);
    col.appendChild(cap);
    host.appendChild(col);
  }
}

/** "N cards left · M of them keep you at or under 12". */
function deckSummary(deck, side) {
  const n = deck.length;
  let s = `${n} card${n === 1 ? "" : "s"} left`;
  const done = G[side].done;
  if (G.phase === "playing" && done === DONE_ACTIVE) {
    if (!n) return s + " · the next draw reshuffles this deck";
    const need = TARGET - total(side);
    const counts = countsOf(deck);
    const safe = counts.reduce((acc, c, i) => acc + (i + 1 <= need ? c : 0), 0);
    const who = side === "p" ? "keep you" : "keep them";
    s += ` · ${safe} of them ${who} at or under ${TARGET} (${Math.round(safe / n * 100)}%)`;
  }
  return s;
}

function renderDeckPanel() {
  renderDeckColumns($("pDeckList"), G.p.deck);
  renderDeckColumns($("aiDeckList"), G.a.deck);
  $("pDeckSummary").textContent  = deckSummary(G.p.deck, "p");
  $("aiDeckSummary").textContent = deckSummary(G.a.deck, "a");
  $("pDeckSection").classList.toggle("focus", G.deckFocus === "p");
  $("aiDeckSection").classList.toggle("focus", G.deckFocus === "a");
}

function toggleDeck(side, force) {
  const open = force !== undefined ? force : !(G.deckOpen && G.deckFocus === side);
  G.deckOpen = open;
  if (side) G.deckFocus = side;
  el.deckPanel.classList.toggle("open", open);
  el.pDeckBtn.setAttribute("aria-expanded", String(open && G.deckFocus === "p"));
  el.aiDeckBtn.setAttribute("aria-expanded", String(open && G.deckFocus === "a"));
  if (open) renderDeckPanel();
}

/* ---- controls ---- */

el.hitBtn.addEventListener("click", playerHit);
el.standBtn.addEventListener("click", playerStand);
el.doubleBtn.addEventListener("click", playerDouble);
$("newBtn").addEventListener("click", newMatch);
el.pDeckBtn.addEventListener("click", () => toggleDeck("p"));
el.aiDeckBtn.addEventListener("click", () => toggleDeck("a"));
el.deckClose.addEventListener("click", () => toggleDeck(null, false));

const ZONES = [
  { max: 33,  name: "Easy",    color: "var(--easy)" },
  { max: 66,  name: "Normal",  color: "var(--normal)" },
  { max: 99,  name: "Hard",    color: "var(--hard)" },
  { max: 100, name: "Perfect", color: "var(--perfect)" }
];

function applyTemp() {
  const raw = Number($("tempSlider").value);
  G.temp = raw / 100;
  const zone = ZONES.find(z => raw <= z.max);
  $("tempLabel").textContent = zone.name;
  document.documentElement.style.setProperty("--tempc", zone.color);
}
$("tempSlider").addEventListener("input", applyTemp);

$("oddsBtn").addEventListener("click", e => {
  G.showOdds = !G.showOdds;
  e.currentTarget.textContent = "Odds: " + (G.showOdds ? "on" : "off");
  renderOdds();
});

document.addEventListener("keydown", e => {
  const k = e.key.toLowerCase();
  if (k === "n") { newMatch(); return; }
  if (k === "d") { toggleDeck("p"); return; }
  if (k === "o") { toggleDeck("a"); return; }
  if (k === "escape") { toggleDeck(null, false); return; }
  if (k === "h") playerHit();
  if (k === "s") playerStand();
  if (k === "2" || k === "x") playerDouble();
});

try {
  applyTemp();
  newMatch();
} catch (err) {
  fatal(err);
}

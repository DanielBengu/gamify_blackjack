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
const START_HP = 5;
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
 * Who won the round and for how much.
 * Busting loses. Otherwise the higher total wins. Landing exactly on the
 * target is a crit and deals double. Equal totals, or both busting, is a push.
 */
function roundResult(pT, pD, aT, aD) {
  const pB = pD === DONE_BUST, aB = aD === DONE_BUST;
  if (pB && aB) return { winner: null, dmg: 0 };
  if (pB)       return { winner: "a", dmg: aT === TARGET ? 2 : 1 };
  if (aB)       return { winner: "p", dmg: pT === TARGET ? 2 : 1 };
  if (pT > aT)  return { winner: "p", dmg: pT === TARGET ? 2 : 1 };
  if (aT > pT)  return { winner: "a", dmg: aT === TARGET ? 2 : 1 };
  return { winner: null, dmg: 0 };
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
    const r = roundResult(pT, pD, aT, aD);
    if (!r.winner) return 0;
    const dmg = r.dmg * (dbl ? 2 : 1);           // doubling cuts both ways
    return r.winner === "p" ? Math.min(dmg, hp.a) : -Math.min(dmg, hp.p);
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
        ? ev(s.c, s.n - 1, aC, aN, TARGET + 1, aT, DONE_BUST,  aD, 1, 1)
        : ev(s.c, s.n - 1, aC, aN, t,          aT, DONE_STOOD, aD, 1, 1));
      s.c[i]++;
    }
    return out;
  }

  /**
   * Expected value of the position. `turn` is 0 for the player, 1 for the AI.
   * Totals are 0..TARGET while alive; a busted hand is stored as TARGET + 1.
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
          ? ev(s.c, s.n - 1, aC, aN, TARGET + 1, aT, DONE_BUST, aD, 1, dbl)
          : ev(s.c, s.n - 1, aC, aN, t, aT, DONE_ACTIVE, aD, 1, dbl));
      } else {
        const t = aT + v;
        hit += p * (t > TARGET
          ? ev(pC, pN, s.c, s.n - 1, pT, TARGET + 1, pD, DONE_BUST, 0, dbl)
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
          ? ev(s.c, s.n - 1, aC, aN, TARGET + 1, aT, DONE_BUST, aD, 1, dbl)
          : ev(s.c, s.n - 1, aC, aN, t, aT, DONE_ACTIVE, aD, 1, dbl));
      } else {
        hit += p * (t > TARGET
          ? ev(pC, pN, s.c, s.n - 1, pT, TARGET + 1, pD, DONE_BUST, 0, dbl)
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
      const { stand, hit } = actionValues(pC, pN, aC, aN, pT, aT, pD, aD, 1, dbl ? 1 : 0);
      if (temp >= 1) return hit < stand ? "hit" : "stand";   // AI minimises
      // The 0.6 floor keeps the far-left of the dial from degenerating into a
      // coin flip — Easy should play badly, not randomly.
      const sharp = 0.6 + 15 * temp * temp;
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
  status: $("status"), odds: $("oddsLine"),
  deckPanel: $("deckPanel"), deckClose: $("deckClose"),
  hitBtn: $("hitBtn"), standBtn: $("standBtn"), doubleBtn: $("doubleBtn"),
  stakes: $("stakes")
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

/** Swell and settle. Used whenever a score changes, harder when a round lands. */
function pop(node, strength = 1.4, duration = 400) {
  if (!node || typeof node.animate !== "function") return;
  node.animate([
    { transform: "scale(1)" },
    { transform: `scale(${strength})`, offset: 0.32 },
    { transform: "scale(1)" }
  ], { duration, easing: "cubic-bezier(.34,1.56,.64,1)" });
}

function renderHp(node, hp) {
  node.innerHTML = "";
  for (let i = 0; i < START_HP; i++) {
    const s = document.createElement("span");
    s.className = "hp-pip" + (i < hp ? " on" : "");
    node.appendChild(s);
  }
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

const total = side => G[side].hand.reduce((a, b) => a + b, 0);

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
    if (G.p.done === DONE_BUST) setStatus(`You drew to ${total("p")} — <span class="hl">bust</span>.`, "lose");
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

function scheduleAi() { setTimeout(aiMove, 620); }

function aiMove() {
  if (G.phase !== "playing" || G.turn !== 1 || G.a.done !== DONE_ACTIVE) return;
  G.busy = true;
  const move = AI.decide(
    countsOf(G.p.deck), G.p.deck.length,
    countsOf(G.a.deck), G.a.deck.length,
    total("p"), total("a"), G.p.done, G.a.done, G.temp, G.doubled);

  if (move === "stand") {
    G.a.done = DONE_STOOD;
    setStatus(`Opponent stands on ${total("a")}.`);
    render();
    setTimeout(afterAction, 380);
  } else {
    setStatus("Opponent hits.");
    dealTo("a", () => {
      if (G.a.done === DONE_BUST) setStatus(`Opponent drew to ${total("a")} — <span class="hl">bust</span>.`, "win");
      afterAction();
    });
  }
}

/* ---- resolution ---- */

function resolveRound() {
  G.phase = "roundover";
  G.busy = true;
  const pT = total("p"), aT = total("a");
  const r = roundResult(pT, G.p.done, aT, G.a.done);
  const dmg = r.dmg * (G.doubled ? 2 : 1);

  // "1" / "CRIT! 2" / "2 (doubled)" / "CRIT! 4 (doubled crit)"
  const dmgText = () => {
    if (r.dmg === 2 && G.doubled) return "CRIT ×2! 4 damage";
    if (r.dmg === 2)              return "CRIT! 2 damage";
    if (G.doubled)                return "2 damage (doubled)";
    return "1 damage";
  };

  let msg, cls;
  if (!r.winner) {
    msg = (G.p.done === DONE_BUST && G.a.done === DONE_BUST)
      ? "You both bust — no damage."
      : `Both on ${pT} — push, no damage.`;
    cls = "tie";
  } else if (r.winner === "p") {
    G.a.hp = Math.max(0, G.a.hp - dmg);
    msg = `${pT} beats ${aT}${G.a.done === DONE_BUST ? " (bust)" : ""} — ` +
          `<span class="hl">${dmgText()}</span>`;
    cls = "win";
  } else {
    G.p.hp = Math.max(0, G.p.hp - dmg);
    msg = `${aT} beats ${pT}${G.p.done === DONE_BUST ? " (bust)" : ""} — ` +
          `<span class="hl">${dmgText()}</span>`;
    cls = "lose";
  }

  const shuffled = [G.p.reshuffled && "yours", G.a.reshuffled && "theirs"].filter(Boolean);
  if (shuffled.length) msg += ` <span class='note'>· reshuffled: ${shuffled.join(" & ")}</span>`;

  setStatus(msg, cls);
  render();

  // the round landing gets a bigger swell than an ordinary draw; a crit bigger still
  if (r.winner) {
    pop(r.winner === "p" ? el.pScoreNum : el.aiScoreNum, dmg >= 4 ? 2.3 : dmg >= 2 ? 2 : 1.7, 560);
  } else {
    pop(el.pScoreNum, 1.25, 460);
    pop(el.aiScoreNum, 1.25, 460);
  }

  setTimeout(() => {
    if (G.p.hp === 0 || G.a.hp === 0) return endMatch();
    G.busy = false;
    startRound();
  }, 1700);
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
  const pT = total("p"), aT = total("a");
  const r = roundResult(pT, G.p.done, aT, G.a.done);

  const stateOf = side => {
    if (!G[side].hand.length) return "";
    if (G[side].done === DONE_BUST) return "bust";
    if (!r.winner) return "tie";
    return r.winner === side ? "win" : "lose";
  };

  paintScore("p", el.pScore,  el.pScoreNum,  pT, stateOf("p"));
  paintScore("a", el.aiScore, el.aiScoreNum, aT, stateOf("a"));
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
  const av = AI.actionValues(
    countsOf(G.p.deck), G.p.deck.length,
    countsOf(G.a.deck), G.a.deck.length,
    total("p"), total("a"), G.p.done, G.a.done, 0, G.doubled ? 1 : 0);

  const options = [["hit", av.hit], ["stand", av.stand]];
  if (av.double !== null) options.push(["double", av.double]);
  const best = options.reduce((a, b) => (b[1] > a[1] ? b : a))[0];

  el.odds.innerHTML =
    `Hitting busts <b>${Math.round(av.bust * 100)}%</b> of the time · ` +
    options.map(([n, v]) => `${n} <b>${fmt(v)}</b>`).join(" vs ") +
    ` · best: <b>${best}</b>`;
}

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

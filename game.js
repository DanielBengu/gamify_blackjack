"use strict";

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

  function terminal(pT, pD, aT, aD) {
    const r = roundResult(pT, pD, aT, aD);
    if (!r.winner) return 0;
    return r.winner === "p" ? Math.min(r.dmg, hp.a) : -Math.min(r.dmg, hp.p);
  }

  /** Base-5 digits of one deck's counts: 0..15624. */
  function deckKey(counts) {
    let k = 0;
    for (let i = 0; i < MAX_VAL; i++) k = k * 5 + counts[i];
    return k;
  }

  /** Whole state as one integer-safe key (max ~8.6e11, well inside 2^53). */
  function keyOf(pC, aC, pT, aT, pD, aD, turn) {
    let k = deckKey(pC) * 15625 + deckKey(aC);
    k = ((((k * 14 + pT) * 14 + aT) * 3 + pD) * 3 + aD) * 2 + turn;
    return k;
  }

  /**
   * Expected value of the position. `turn` is 0 for the player, 1 for the AI.
   * Totals are 0..TARGET while alive; a busted hand is stored as TARGET + 1.
   */
  function ev(pC, pN, aC, aN, pT, aT, pD, aD, turn) {
    if (pD !== DONE_ACTIVE && aD !== DONE_ACTIVE) return terminal(pT, pD, aT, aD);
    if (turn === 0 && pD !== DONE_ACTIVE) turn = 1;
    if (turn === 1 && aD !== DONE_ACTIVE) turn = 0;

    const key = keyOf(pC, aC, pT, aT, pD, aD, turn);
    const seen = memo.get(key);
    if (seen !== undefined) return seen;

    const mine = turn === 0;

    // --- stand ---
    const stand = mine
      ? ev(pC, pN, aC, aN, pT, aT, DONE_STOOD, aD, 1)
      : ev(pC, pN, aC, aN, pT, aT, pD, DONE_STOOD, 0);

    // --- hit --- the mover draws from their OWN deck, reshuffling it if empty
    let src  = mine ? pC : aC;
    let srcN = mine ? pN : aN;
    if (srcN === 0) { src = new Array(MAX_VAL).fill(COPIES); srcN = DECK_SIZE; }

    let hit = 0;
    for (let i = 0; i < MAX_VAL; i++) {
      if (!src[i]) continue;
      const p = src[i] / srcN, v = i + 1;
      src[i]--;
      if (mine) {
        const t = pT + v;
        hit += p * (t > TARGET
          ? ev(src, srcN - 1, aC, aN, TARGET + 1, aT, DONE_BUST, aD, 1)
          : ev(src, srcN - 1, aC, aN, t, aT, DONE_ACTIVE, aD, 1));
      } else {
        const t = aT + v;
        hit += p * (t > TARGET
          ? ev(pC, pN, src, srcN - 1, pT, TARGET + 1, pD, DONE_BUST, 0)
          : ev(pC, pN, src, srcN - 1, pT, t, pD, DONE_ACTIVE, 0));
      }
      src[i]++;
    }

    const out = mine ? Math.max(stand, hit) : Math.min(stand, hit);
    memo.set(key, out);
    return out;
  }

  /** Expected value of each action for whoever is to move, plus their bust risk. */
  function actionValues(pC, pN, aC, aN, pT, aT, pD, aD, turn) {
    const mine = turn === 0;
    const stand = mine
      ? ev(pC, pN, aC, aN, pT, aT, DONE_STOOD, aD, 1)
      : ev(pC, pN, aC, aN, pT, aT, pD, DONE_STOOD, 0);

    let src  = mine ? pC : aC;
    let srcN = mine ? pN : aN;
    let reshuffles = false;
    if (srcN === 0) { src = new Array(MAX_VAL).fill(COPIES); srcN = DECK_SIZE; reshuffles = true; }

    let hit = 0, bust = 0;
    const total = mine ? pT : aT;
    for (let i = 0; i < MAX_VAL; i++) {
      if (!src[i]) continue;
      const p = src[i] / srcN, v = i + 1, t = total + v;
      if (t > TARGET) bust += p;
      src[i]--;
      if (mine) {
        hit += p * (t > TARGET
          ? ev(src, srcN - 1, aC, aN, TARGET + 1, aT, DONE_BUST, aD, 1)
          : ev(src, srcN - 1, aC, aN, t, aT, DONE_ACTIVE, aD, 1));
      } else {
        hit += p * (t > TARGET
          ? ev(pC, pN, src, srcN - 1, pT, TARGET + 1, pD, DONE_BUST, 0)
          : ev(pC, pN, src, srcN - 1, pT, t, pD, DONE_ACTIVE, 0));
      }
      src[i]++;
    }
    return { stand, hit, bust, reshuffles };
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
    decide(pC, pN, aC, aN, pT, aT, pD, aD, temp) {
      const { stand, hit } = actionValues(pC, pN, aC, aN, pT, aT, pD, aD, 1);
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

const $ = id => document.getElementById(id);
const el = {
  pHand: $("pHand"), aiHand: $("aiHand"),
  pTotal: $("pTotal"), aiTotal: $("aiTotal"),
  pHp: $("pHp"), aiHp: $("aiHp"),
  pDeckBtn: $("pDeckBtn"), aiDeckBtn: $("aiDeckBtn"),
  pDeckCount: $("pDeckCount"), aiDeckCount: $("aiDeckCount"),
  status: $("status"), odds: $("oddsLine"),
  deckPanel: $("deckPanel"), deckClose: $("deckClose"),
  hitBtn: $("hitBtn"), standBtn: $("standBtn")
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
  G.busy = true;
  AI.reset(G.p.hp, G.a.hp);
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
    total("p"), total("a"), G.p.done, G.a.done, G.temp);

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

  let msg, cls;
  if (!r.winner) {
    msg = (G.p.done === DONE_BUST && G.a.done === DONE_BUST)
      ? "You both bust — no damage."
      : `Both on ${pT} — push, no damage.`;
    cls = "tie";
  } else if (r.winner === "p") {
    G.a.hp = Math.max(0, G.a.hp - r.dmg);
    msg = `${pT} beats ${aT}${G.a.done === DONE_BUST ? " (bust)" : ""} — ` +
          `<span class="hl">${r.dmg === 2 ? "CRIT! 2 damage" : "1 damage"}</span>`;
    cls = "win";
  } else {
    G.p.hp = Math.max(0, G.p.hp - r.dmg);
    msg = `${aT} beats ${pT}${G.p.done === DONE_BUST ? " (bust)" : ""} — ` +
          `<span class="hl">${r.dmg === 2 ? "CRIT! 2 damage" : "1 damage"}</span>`;
    cls = "lose";
  }

  const shuffled = [G.p.reshuffled && "yours", G.a.reshuffled && "theirs"].filter(Boolean);
  if (shuffled.length) msg += ` <span class='note'>· reshuffled: ${shuffled.join(" & ")}</span>`;

  setStatus(msg, cls);
  render();

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

  const myMove = G.phase === "playing" && !G.busy && G.turn === 0 && G.p.done === DONE_ACTIVE;
  el.hitBtn.disabled = !myMove;
  el.standBtn.disabled = !myMove;

  if (G.deckOpen) renderDeckPanel();
  renderOdds();
}

function renderOdds() {
  if (!G.showOdds || G.phase !== "playing" || G.busy ||
      G.turn !== 0 || G.p.done !== DONE_ACTIVE) {
    el.odds.textContent = "";
    return;
  }
  const { stand, hit, bust } = AI.actionValues(
    countsOf(G.p.deck), G.p.deck.length,
    countsOf(G.a.deck), G.a.deck.length,
    total("p"), total("a"), G.p.done, G.a.done, 0);
  const best = hit > stand ? "hit" : "stand";
  el.odds.innerHTML =
    `Hitting busts <b>${Math.round(bust * 100)}%</b> of the time · ` +
    `hit <b>${fmt(hit)}</b> vs stand <b>${fmt(stand)}</b> · best: <b>${best}</b>`;
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
});

applyTemp();
newMatch();

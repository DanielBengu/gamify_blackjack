/**
 * Card 12 — rules and solver tests.
 *
 *   node test.js            run the checks
 *   node test.js --balance  also simulate matches and print the damage spread
 *
 * Sections 1 and 2 of game.js have no DOM dependency, so they are sliced out
 * and evaluated directly. Nothing here touches the browser.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "game.js"), "utf8");
const CUT = "/* ============================================================================\n   3. VIEW";
if (!SRC.includes(CUT)) {
  console.error("Could not find the VIEW section marker in game.js — did the section headers change?");
  process.exit(1);
}

// `const` at the top level of a script is a lexical binding and never becomes a
// property of the global object, so the exports have to be collected from
// inside the evaluated code rather than read off the sandbox afterwards.
const EXPORTS = `
;globalThis.__api = {
  TARGET, ATK, START_HP, COPIES, MAX_VAL, BUST_COST, CRIT_SHARE, BLOCK_ON_STAND, SAFE_CEILING,
  DONE_ACTIVE, DONE_STOOD, DONE_BUST,
  freshDeck, countsOf, scoreOf, roundOutcome, damageOf, AI
};`;

const sandbox = { console, Math, Date, Number, Set, Array, Object, String, Map, isFinite };
vm.createContext(sandbox);
vm.runInContext(SRC.slice(0, SRC.indexOf(CUT)) + EXPORTS, sandbox);

const api = sandbox.__api;
if (!api || !api.AI) {
  console.error("game.js did not expose the expected model — check the section markers.");
  process.exit(1);
}
const {
  TARGET, ATK, START_HP, COPIES, MAX_VAL, BUST_COST, CRIT_SHARE, BLOCK_ON_STAND, SAFE_CEILING,
  DONE_ACTIVE: ACTIVE, DONE_STOOD: STOOD, DONE_BUST: BUST,
  freshDeck, countsOf, scoreOf, roundOutcome, damageOf, AI
} = api;

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok   " + msg);
  else { console.log("  FAIL " + msg); fails++; }
};
const group = name => console.log("\n" + name);

const full = () => new Array(MAX_VAL).fill(COPIES);
const outcome = (pT, pD, aT, aD) => roundOutcome(pT, pD, aT, aD);
const damage = (pT, pD, aT, aD, dbl) => damageOf(roundOutcome(pT, pD, aT, aD), dbl);

/* ------------------------------------------------------------------ decks */
group("Decks");
{
  const d1 = freshDeck(), d2 = freshDeck();
  ok(d1.length === COPIES * MAX_VAL, `a deck holds ${COPIES * MAX_VAL} cards`);
  ok(countsOf(d1).every(c => c === COPIES), `${COPIES} copies of every value`);
  ok(d1.join("") !== d2.join(""), "the two decks shuffle independently");
  const distinct = new Set();
  for (let i = 0; i < 200; i++) distinct.add(freshDeck().join(""));
  ok(distinct.size > 190, `shuffling actually shuffles (${distinct.size}/200 distinct)`);
}

/* --------------------------------------------------------------- measuring */
group("Measuring a hand");
{
  ok(START_HP === 100 && ATK === 5, "100 health, 5 damage per attack");
  ok(scoreOf(11, STOOD) === 11, "a standing hand measures as its total");
  ok(scoreOf(9, BUST) === 9 - BUST_COST, `a bust from 9 measures as ${9 - BUST_COST}`);
  ok(scoreOf(1, BUST) === 0, "a bust never measures below zero");

  // you need at least 7 to be able to bust at all (7 + 6 > 12), so the lowest
  // fallback score that can actually occur is 5 — never 0
  let lowest = Infinity;
  for (let held = 0; held <= TARGET; held++)
    for (let card = 1; card <= MAX_VAL; card++)
      if (held + card > TARGET) lowest = Math.min(lowest, scoreOf(held, BUST));
  ok(lowest === 5, "the lowest reachable bust score is 5");
}

/* ---------------------------------------------------------------- attacks */
group("Attacks");
{
  // margin sets the raw attack count; the loser's guard then eats one of them
  const o = outcome(11, STOOD, 8, STOOD);
  ok(o.winner === "p" && o.raw === 3, "win 11 to 8 raises 3 attacks");
  ok(o.hits === 2 && damage(11, STOOD, 8, STOOD) === 10, "...2 get past the guard, for 10");
  ok(outcome(10, STOOD, 2, STOOD).raw === 8, "winning by 8 raises eight attacks");
  ok(damage(10, STOOD, 2, STOOD) === 7 * ATK, "...7 land, for 35");
  ok(damage(9, STOOD, 8, STOOD) === ATK, "the guard never blocks the last attack: a win by 1 still lands 1");
  ok(damage(6, STOOD, 6, STOOD) === 0, "a push deals nothing");
  ok(outcome(6, STOOD, 6, STOOD).winner === null, "a push has no winner");
}

/* ------------------------------------------------------------------ guard */
group("Standing guards you");
{
  ok(BLOCK_ON_STAND === 1, "standing blocks 1 attack");

  const o = outcome(11, STOOD, 8, STOOD);
  ok(o.raw === 3 && o.blocked === 1 && o.hits === 2,
     "11 vs a stander on 8: 3 attacks, 1 blocked, 2 land");
  ok(damage(11, STOOD, 8, STOOD) === 10, "...for 10 damage rather than 15");

  const one = outcome(9, STOOD, 8, STOOD);
  ok(one.raw === 1 && one.blocked === 0 && one.hits === 1,
     "a one-point win is never fully blocked — the guard stops at margin-1");
  ok(damage(9, STOOD, 8, STOOD) === ATK, "...so a bare win still draws blood");

  // busting earns no guard at all
  const b = outcome(11, STOOD, 9, BUST);   // they fall back to 7, and get no block
  ok(b.blocked === 0 && b.hits === 4, "a buster blocks nothing: all 4 attacks land");
  ok(damage(11, STOOD, 9, BUST) === 20, "...for the full 20 damage");

  // the block never turns damage negative
  for (let w = 0; w <= TARGET; w++)
    for (let l = 0; l <= TARGET; l++)
      for (const ld of [STOOD, BUST]) {
        const x = outcome(w, STOOD, l, ld);
        if (x.hits < 0 || x.blocked > x.raw) { ok(false, "block stays within the attack count"); w = 99; break; }
      }
  ok(true, "the block never exceeds the attacks or goes negative");

  // crits are reckoned on what gets through, not on what was blocked
  const c = outcome(TARGET, STOOD, 8, STOOD);
  ok(c.raw === 4 && c.blocked === 1 && c.hits === 3 && c.crits === 1,
     "12 vs a stander on 8: 4 raw, 1 blocked, 3 land, 1 crits");
  ok(damageOf(c, 0) === 20, "...for 20 damage");

  // the guard applies before doubling, so it is worth twice as much then
  ok(damage(11, STOOD, 8, STOOD, 1) === 20, "a blocked attack is worth 10 at double stakes");
}

/* ------------------------------------------------------------------ crits */
group("Crits (landing exactly on 12)");
{
  // against a stander: raw attacks, minus the guard, then a third of the rest crit
  const cases = [[8, 4, 3, 1, 20], [9, 3, 2, 1, 15], [11, 1, 1, 1, 10], [5, 7, 6, 2, 40]];
  for (const [their, raw, hits, crits, dmg] of cases) {
    const o = outcome(TARGET, STOOD, their, STOOD);
    ok(o.raw === raw && o.hits === hits && o.crits === crits && damageOf(o, 0) === dmg,
       `12 vs a guarded ${their}: ${raw} raw, ${hits} land, ${crits} crit -> ${dmg}`);
  }
  ok(damage(TARGET, STOOD, 11, STOOD) === 10,
     "a 12-vs-11 crit still lands: one attack, critting, for 10");
  ok(outcome(11, STOOD, 5, STOOD).crits === 0, "no crits unless you land on 12 exactly");
  ok(outcome(TARGET, STOOD, TARGET, STOOD).winner === null, "both on 12 is a push, no crit");
  for (let their = 0; their < TARGET; their++) {
    const o = outcome(TARGET, STOOD, their, STOOD);
    if (o.crits !== Math.ceil(o.hits / CRIT_SHARE)) { ok(false, "crit share holds for 12 vs " + their); break; }
    if (their === TARGET - 1) ok(true, `crits are always ceil(attacks / ${CRIT_SHARE})`);
  }
}

/* ------------------------------------------------------------------ busts */
group("Busting");
{
  ok(outcome(10, STOOD, 9, BUST).hits === 3, "beating a bust-from-9 with 10 lands 3 attacks");
  ok(damage(TARGET, STOOD, 9, BUST) === 35, "12 against a bust-from-9 deals 35");
  ok(outcome(5, STOOD, 11, BUST).winner === "p", "busting loses however strong the fallback");
  ok(damage(5, STOOD, 11, BUST) === 0, "...but a fallback above your total lands nothing");
  ok(outcome(10, BUST, 9, BUST).winner === null, "both busting is a push");
  ok(damage(10, BUST, 9, BUST) === 0, "...and deals nothing");
}

/* ----------------------------------------------------------------- double */
group("Double");
{
  ok(damage(11, STOOD, 8, STOOD, 1) === 20, "doubling doubles a plain win (10 -> 20)");
  ok(damage(TARGET, STOOD, 8, STOOD, 1) === 40, "doubling doubles a crit round (20 -> 40)");
  ok(damage(8, STOOD, 11, STOOD, 1) === 20, "doubling doubles what you take too");
  ok(damage(6, STOOD, 6, STOOD, 1) === 0, "a push is still free at double stakes");

  AI.reset(100, 100);
  ok(AI.actionValues(full(), 24, full(), 24, 7, 7, ACTIVE, ACTIVE, 0, 0).double !== null,
     "the player is offered a double");
  ok(AI.actionValues(full(), 24, full(), 24, 7, 7, ACTIVE, ACTIVE, 1, 0).double === null,
     "the opponent never is");
  ok(AI.actionValues(full(), 24, full(), 24, 7, 7, ACTIVE, ACTIVE, 0, 1).double === null,
     "and there is no second double once the stakes are up");
}

/* ----------------------------------------------------------------- solver */
group("Solver");
{
  AI.reset(100, 100);
  ok(AI.ev(full(), 24, full(), 24, 11, 8, STOOD, STOOD, 0, 0) === 10, "terminal value matches the model");
  AI.reset(100, 100);
  ok(AI.ev(full(), 24, full(), 24, 8, 11, STOOD, STOOD, 0, 0) === -10, "...and is signed from the player's view");
  AI.reset(100, 4);
  ok(AI.ev(full(), 24, full(), 24, 11, 8, STOOD, STOOD, 0, 0) === 4, "damage clamps to remaining health");

  // with the double spent, neither side has an exclusive option and the game is symmetric
  AI.reset(100, 100); const a = AI.ev(full(), 24, full(), 24, 6, 6, ACTIVE, ACTIVE, 0, 1);
  AI.reset(100, 100); const b = AI.ev(full(), 24, full(), 24, 6, 6, ACTIVE, ACTIVE, 1, 1);
  ok(Math.abs(a + b) < 1e-9, `settled stakes are antisymmetric (${a.toFixed(3)} / ${b.toFixed(3)})`);

  AI.reset(100, 100); const held = AI.ev(full(), 24, full(), 24, 6, 6, ACTIVE, ACTIVE, 0, 0);
  AI.reset(100, 100); const spent = AI.ev(full(), 24, full(), 24, 6, 6, ACTIVE, ACTIVE, 0, 1);
  ok(held >= spent - 1e-9, "holding the double is never worse than having spent it");

  // a missing dbl argument must not poison the memo with a NaN key
  AI.reset(100, 100); const lazy = AI.ev(full(), 24, full(), 24, 6, 6, ACTIVE, ACTIVE, 0);
  ok(Math.abs(lazy - held) < 1e-12, "omitting the double flag behaves as zero");

  // the two decks are independent
  const small = [4, 4, 0, 0, 0, 0], big = [0, 0, 0, 0, 0, 4];
  AI.reset(100, 100); const mineSafe = AI.ev(small, 8, full(), 24, 9, 9, ACTIVE, ACTIVE, 0, 0);
  AI.reset(100, 100); const mineRisky = AI.ev(big, 4, full(), 24, 9, 9, ACTIVE, ACTIVE, 0, 0);
  ok(mineSafe > mineRisky, "a safe deck of mine beats a dangerous one");
  AI.reset(100, 100); const theirsSafe = AI.ev(full(), 24, small, 8, 9, 9, ACTIVE, ACTIVE, 0, 0);
  AI.reset(100, 100); const theirsRisky = AI.ev(full(), 24, big, 4, 9, 9, ACTIVE, ACTIVE, 0, 0);
  ok(theirsSafe < theirsRisky, "a safe deck of theirs is bad for me");

  // obvious decisions
  AI.reset(100, 100); ok(AI.decide(full(), 24, full(), 24, 5, TARGET, ACTIVE, ACTIVE, 1, 0) === "stand",
     "the opponent stands on 12");
  AI.reset(100, 100); ok(AI.decide(full(), 24, full(), 24, 11, 2, STOOD, ACTIVE, 1, 0) === "hit",
     "the opponent on 2 facing a stood 11 must hit");
}

/* ------------------------------------------------------- dominated blunders */
group("The opponent never makes a dominated blunder");
{
  ok(SAFE_CEILING === TARGET - MAX_VAL, `a draw cannot bust at or below ${SAFE_CEILING}`);

  // standing below the ceiling is dominated in every position — check the model agrees
  AI.reset(100, 100);
  let dominated = 0;
  for (let a = 1; a <= SAFE_CEILING; a++)
    for (let p = 1; p <= TARGET; p++)
      for (const pd of [ACTIVE, STOOD]) {
        const v = AI.actionValues(full(), 24, full(), 24, p, a, pd, ACTIVE, 1, 0);
        if (v.stand < v.hit - 1e-9) dominated++;
      }
  ok(dominated === 0, "standing below the ceiling is never better than hitting");

  // ...and that no temperature can talk it into doing so anyway
  let blunders = 0, trials = 0;
  for (const t of [0, 0.25, 0.5, 0.75, 1])
    for (let a = 1; a <= SAFE_CEILING; a++)
      for (let p = 1; p <= TARGET; p++)
        for (let k = 0; k < 6; k++) {
          trials++;
          if (AI.decide(full(), 24, full(), 24, p, a, ACTIVE, ACTIVE, t, 0) !== "hit") blunders++;
        }
  ok(blunders === 0, `never stands below the ceiling at any difficulty (${trials} trials)`);

  // the floor must not turn into "always hit" — it still stands when it should
  let stands = 0, n = 0;
  for (let a = SAFE_CEILING + 1; a <= 11; a++)
    for (let p = 1; p <= TARGET; p++)
      for (let k = 0; k < 6; k++) {
        n++;
        if (AI.decide(full(), 24, full(), 24, p, a, ACTIVE, ACTIVE, 0.5, 0) === "stand") stands++;
      }
  ok(stands > 0 && stands < n, `still a real choice above the ceiling (stands ${(stands / n * 100).toFixed(0)}%)`);
}

/* --------------------------------------------------------------- balance */
if (process.argv.includes("--balance")) {
  group("Balance (simulated)");
  const N = Number(process.env.SIMS || 150);
  const rounds = [], dmgs = [];
  for (let i = 0; i < N; i++) {
    let pDeck = freshDeck(), aDeck = freshDeck();
    let pHP = START_HP, aHP = START_HP, first = true, n = 0, guard = 0;
    while (pHP > 0 && aHP > 0 && guard++ < 400) {
      n++;
      let pT = 0, aT = 0, pD = ACTIVE, aD = ACTIVE, pPre = 0, aPre = 0;
      AI.reset(pHP, aHP);
      const dp = () => { if (!pDeck.length) pDeck = freshDeck(); return pDeck.pop(); };
      const da = () => { if (!aDeck.length) aDeck = freshDeck(); return aDeck.pop(); };
      aT += da(); pT += dp();
      let turn = first ? 0 : 1; first = !first;
      let g2 = 0;
      while ((pD === ACTIVE || aD === ACTIVE) && g2++ < 60) {
        if (turn === 0 && pD !== ACTIVE) turn = 1;
        if (turn === 1 && aD !== ACTIVE) turn = 0;
        if (pD !== ACTIVE && aD !== ACTIVE) break;
        if (turn === 0) {
          if (pT >= 9) pD = STOOD;
          else { pPre = pT; const c = dp(); if (pT + c > TARGET) pD = BUST; else pT += c; }
          if (aD === ACTIVE) turn = 1;
        } else {
          const mv = AI.decide(countsOf(pDeck), pDeck.length, countsOf(aDeck), aDeck.length,
                               pD === BUST ? pPre : pT, aD === BUST ? aPre : aT, pD, aD, 0.66, 0);
          if (mv === "stand") aD = STOOD;
          else { aPre = aT; const c = da(); if (aT + c > TARGET) aD = BUST; else aT += c; }
          if (pD === ACTIVE) turn = 0;
        }
      }
      const o = roundOutcome(pD === BUST ? pPre : pT, pD, aD === BUST ? aPre : aT, aD);
      const d = damageOf(o, 0);
      dmgs.push(d);
      if (o.winner === "p") aHP = Math.max(0, aHP - d);
      else if (o.winner === "a") pHP = Math.max(0, pHP - d);
    }
    rounds.push(n);
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const at = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  console.log(`  rounds per match : mean ${mean(rounds).toFixed(1)}  median ${at(rounds, .5)}  ` +
              `range ${Math.min(...rounds)}-${Math.max(...rounds)}`);
  console.log(`  damage per round : mean ${mean(dmgs).toFixed(1)}  median ${at(dmgs, .5)}  ` +
              `90th ${at(dmgs, .9)}  max ${Math.max(...dmgs)}`);
  const zero = dmgs.filter(d => d === 0).length / dmgs.length * 100;
  console.log(`  rounds dealing nothing: ${zero.toFixed(0)}%`);
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);

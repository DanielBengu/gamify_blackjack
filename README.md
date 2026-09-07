# Card 12

Blackjack for two, played to twelve, with a deck small enough to count and attacks that scale
with how hard you win. Static files, no build step, no dependencies, no backend.

**[Play it](https://danielbengu.github.io/gamify_blackjack/)**

---

## Rules

**The decks.** You each have **your own** 24-card deck: values 1 through 6, four copies of each,
shuffled separately. You only ever draw from yours, they only ever draw from theirs. When one runs
dry it is rebuilt and reshuffled on the spot — independently of the other, which keeps running down.
So the two decks drift apart, and late in a match you can be drawing from a nearly full deck while
they are scraping the bottom of theirs.

**The goal.** Get closer to **12** than your opponent without going over. Going over busts you.

**The turn.** You each start with one card, dealt face up — everything in this game is face up.
Then you alternate: **hit** or **stand**. Standing takes you out of the round; the other player
keeps drawing alone until they stand or bust. Who moves first alternates each round.

**Attacks.** Winning isn't binary — you win *by* something, and every point of that margin raises
one attack worth **5 damage**. Take a round 11 to 8 and that's 3 attacks. Take it 10 to 2 and
that's 8. Win by a single point and it barely stings.

**Busting.** Going over loses the round outright, however good you were looking. For measuring the
margin, a bust falls back to the score it held *before* the fatal card, **minus 2** — so busting
from 9 counts as 7. Because you need at least 7 to be able to bust at all, that fallback is never
worse than 5. A near-miss bust therefore concedes very little, and can even concede nothing: bust
from 11 (falling back to 9) against someone standing on 8 and they land no attacks at all,
though they still take the round.

**Guarding.** Choosing to **stand** is a defensive act: a stander absorbs **1 attack** aimed at
them. Busting out of the round earns no such protection. This is what stops the game collapsing
into "always hit" — sitting on a modest total concedes the margin but blunts the punishment.

The guard never blocks the *last* attack, so a won round always draws blood. Without that cap,
winning by a single point landed nothing at all and roughly half of every match was scoreless.

**Crits.** Land on **exactly 12** and one attack in every three, rounded up, becomes a crit worth
double — reckoned on the attacks that actually get through, not the ones that were blocked. Win 12
to 8 against a guard and that's 4 raised, 1 blocked, 3 landing with 1 critting: 20 damage.

**Double.** Only you have this. Press it and you draw exactly one card, then you're out of the
round either way — busting or not. In exchange the whole round counts **twice, in both
directions**. It is the only way to land a blow above 60.

**The match.** You start on **100 health**. First to zero loses. In practice that runs about
**15 rounds**, with a big round costing 25 and roughly one in six landing nothing at all.

**The deck viewer.** Each player has a deck chip next to their name showing how many cards they
have left. Click either one — or press <kbd>D</kbd> for yours, <kbd>O</kbd> for theirs — to open a
panel showing **both** decks card by card, with the count of each value still in them and what
fraction keeps that player at or under 12. Since every card on the table is face up and both deck
contents are public, this is complete information: the game is a counting exercise, not a guessing
one. Knowing that their deck is out of small cards is often worth more than knowing your own.

---

## The opponent

Difficulty is one continuous dial. The slider sets a **temperature** `t` from 0 to 1, and the
label names the zone: **Easy** (green), **Normal** (dark yellow), **Hard** (dark orange),
**Perfect** (red).

There is no simultaneous choice in this game — every decision is made with full information about
both boards and both decks. That makes it a solved game, so at `t = 1` the opponent simply plays
the best move available, every time.

**How it's solved.** The round is a finite game of chance and choice, so it's solved by
**expectimax** with memoisation. State is `(my deck composition, their deck composition, your
score, my score, who has stopped, whose move, stakes doubled)` — all of it packed into a single
integer key peaking around 1.7e12, comfortably inside `Number.MAX_SAFE_INTEGER`. Choice nodes take
the max (you) or min (the opponent); a hit is a chance node weighted by the exact composition of
**the mover's own deck**. An empty deck reshuffles inside the search too, so the model never
diverges from the real game.

A busted hand keeps the score it held before the fatal card and is identified by its flag rather
than by being over the target — which is exactly what the fallback rule needs, and costs the
search nothing.

The player's choice nodes get a third branch the opponent's never do: draw one, stop, multiply.

**What it optimises.** The value is **expected damage swing** in health points, clamped by each
side's remaining health — so the opponent doesn't over-invest against someone already nearly dead,
and knows when it needs a big swing rather than a safe one.

Note what the attack system does to its play. Because damage scales with the *margin*, winning by
one point is no longer as good as winning by five, so it pushes for separation instead of settling
for a bare win — noticeably more aggressive than a flat-damage version of the same game.

The guard pulls the other way. Measured against an opponent who has already committed, the lowest
total at which standing beats hitting:

| their final total | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| you stand at, no guard | 10 | 10 | 10 | 10 | 11 | 11 | 11 | 11 | 10 | 10 | 10 | 9 |
| you stand at, with guard | 10 | 10 | 10 | 11 | 11 | 11 | 11 | 11 | **9** | 10 | **9** | 9 |

The guard makes you settle a point earlier against the strong committed totals — 9, 11 and 12 —
which are exactly the ones you cannot out-margin anyway, so blunting the blow beats chasing it.

**A hard floor on blunders.** At 6 or below a draw cannot bust you, so standing there is strictly
dominated — verified across every position in `test.js`. The opponent is never allowed to make that
move, at any difficulty. A mistake that obvious reads as a broken opponent rather than an easy one,
and the softmax was picking it about 10% of the time at Normal before the floor went in.

**What it costs.** Two deck compositions plus the double branch make this the expensive part: the
worst case — start of a round, both decks full — takes about 120 ms cold, and typical mid-round
solves land near 35 ms. The memo is kept for the whole round, so every decision after the first is
effectively free.

**Below `t = 1`** the opponent samples between hit and stand from a softmax over their true
expected values, so its mistakes are the close calls first and the blunders last. There's a small
floor on the sharpness: even at zero it plays badly rather than randomly.

The softmax is scaled by `8 * ATK`, and that scaling is load-bearing. These values are expected
damage in *health points*, so a typical decision is worth around 25 of them; feeding numbers that
size straight into `exp()` saturates the curve and the dial silently stops doing anything — the
opponent plays perfectly at every setting. If you retune `ATK` or `START_HP`, that divisor is what
keeps the dial honest.

Measured directly — how often the opponent takes its own best move, and what its mistakes cost it
in health, over the positions where it genuinely has a choice:

| Slider | 0 | 17 | 33 | 50 | 66 | 83 | 100 |
|---|---|---|---|---|---|---|---|
| Picks its best move | 53% | 56% | 62% | 70% | 78% | 84% | **100%** |
| Average regret (health) | 3.8 | 3.5 | 2.8 | 1.8 | 1.1 | 0.6 | **0** |

Measured only on the positions where it genuinely has a choice — the dominated ones below the
blunder floor are excluded, since counting forced-correct moves flatters every setting equally.

This is a far better yardstick than match win rate, which turns out to be almost useless here: the
naive "hit until 9" heuristic is very nearly the solved strategy for the opening, so it holds its
own against perfect play, while a coin-flipping player loses every match at every setting. The
dial's real effect lives in the quality of individual decisions, and there it is clean and
monotone.

Turn on **Odds** to see your bust chance and the exact value of every move before you commit.

### When doubling is actually correct

Under the old flat-damage rules the double was nearly a trap: it only paid off when you were one
hit from dying. The attack system changed that completely, because doubling multiplies a *margin*
rather than a fixed 1 or 2 — and forcing one extra card from a low total builds margin cheaply.

Against an opponent who has already committed, doubling is now the best move across a wide band:

| you hold | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|
| double is best when they stood on | 1–3 | 1–9 | 1–8 | 1–8 | 1–8 |

The sweet spot is holding 6–8 against a modest total. You cannot bust from 6 or less, so the forced
card is free margin that then gets doubled; from 7 or 8 you are taking a real risk for a big payoff.
It stays wrong when you already hold 10 or more — the forced card is likely to bust you and there is
little margin left to multiply.

### Running the tests

```bash
node test.js            # rules, crits, busts, doubling, solver sanity
node test.js --balance  # also simulates 300 matches and prints the damage spread
```

`test.js` slices sections 1 and 2 out of `game.js` and evaluates them in a bare context, so the
model is tested exactly as shipped — no browser, and no second copy of the rules to drift.

---

## Deploying on GitHub Pages

```bash
git add -A && git commit -m "Attacks, health bars, thinking indicator"
git push
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save.**

A minute later it's live. GitHub Pages serves
`index.html` at the root automatically, so there is nothing else to configure. Every push to
`main` redeploys.

To work on it locally just open `index.html` in a browser — `file://` is fine, there are no
fetches. Keep the files side by side; `index.html` loads `style.css` and `game.js` by relative path.
Both carry a `?v=` cache buster — bump it whenever you change either, or browsers will happily
serve a stale pair against fresh markup.

---

## Code map

```
index.html   markup only — the table, the deck chips, the deck panel
style.css    theme, layout, cards, health bars, the difficulty slider
game.js      all the logic
test.js      rules and solver tests (node test.js)
```

`game.js` is split into four labelled sections:

| Section | What's in it |
|---|---|
| 1. Model | the decks, `scoreOf` (bust fallback), `roundOutcome` and `damageOf` (the whole attack table) |
| 2. AI | `ev` (memoised expectimax over both decks), `actionValues`, `decide` |
| 3. View | `cardNode`, `flyCard`, `floatDamage`, the health bars, the thinking indicator — zero assets |
| 4. Controller | match and round flow, per-side draws and reshuffles, resolution |

Sections 1–2 have no DOM dependency, so they can be pulled into Node and tested directly.

Tuning knobs, all at the top of `game.js`: `TARGET`, `COPIES`, `MAX_VAL`, `START_HP`, `ATK`,
`BUST_COST`, `CRIT_SHARE` and `BLOCK_ON_STAND`. The last four are the balance dials — attack
damage, how far a bust falls back, how often landing on 12 crits, and how much standing absorbs. Raising `TARGET` or `MAX_VAL` widens the state
space but the solver doesn't care; it's memoised on whatever composition you give it.

### The thinking indicator

The solver runs synchronously and blocks the thread, so an indicator shown in the same tick would
never paint. Anything slow therefore goes through `afterPaint()`, which yields two animation frames
first. Solve cost is measured as it goes and stored in `lastSolveMs`; once that crosses `SLOW_MS`
(80 ms) the odds hint switches to the deferred path on its own. So as the search grows — a wider
target, a bigger deck, a second double — the indicator starts earning its keep without this code
needing to be revisited.

---

## Ideas if you want to extend it

- **A shared deck.** Both players drawing from one deck makes every card you take a card they
  can't have. It's a smaller state space and a meaner game — see the `card-rps` sibling's history
  or just merge `G.p.deck` and `G.a.deck` back into one and drop a composition from the AI's key.
- **Discard-pile reshuffle.** Right now an empty deck is rebuilt as a fresh full 24, which is
  simple but means a value can appear more than four times across one long round. Reshuffling
  only the discard pile instead would make the count exact end to end — change `drawCard` and the
  reshuffle branch in `ev` together, or the AI's model will drift from the real deck.
- **Asymmetric decks.** Nothing in the solver assumes the two decks start the same. Give each
  player a different composition — more high cards, fewer copies — and it still plays exactly.
- **A hole card.** Deal each player one face-down card. That breaks perfect information and turns
  the solver into a belief problem — much closer to real blackjack.
- **Widen the double.** It only pays off when you're low on health (see above). Dropping the
  auto-stand, or letting you keep hitting after the mandatory card, would make it a live decision
  at any health — both are a couple of lines in `doubleValue` and `playerDouble`.
- **Tune the attack curve.** `ATK`, `BUST_COST` and `CRIT_SHARE` are one-line dials. Raising `ATK`
  shortens matches; raising `BUST_COST` makes busting hurt more; lowering `CRIT_SHARE` to 2 makes
  landing on 12 dramatically stronger. `node test.js --balance` prints the resulting spread.
- **Give the opponent a double.** The solver already has the branch; it's simply never offered on
  the minimising side. Wiring it up means adding a second flag so each side's stakes track
  separately.
- **Deck counting off.** Hide the deck viewer above a certain difficulty as a handicap, or make it
  cost something to open.
- **Best-of-N with escalating stakes.** Damage rises each round, so late rounds decide matches.

# Card 12

Blackjack for two, played to twelve, with a deck small enough to count.
Three static files, no build step, no dependencies, no backend.

**[Play it](https://YOUR-USERNAME.github.io/card-12/)** ← replace once deployed

A sibling of [Card RPS](https://github.com/YOUR-USERNAME/card-rps) — same shell, same
difficulty dial, completely different decision.

---

## Rules

**The deck.** 24 cards: values 1 through 6, four copies of each. If it runs dry mid-round it is
rebuilt and reshuffled immediately, and play continues.

**The goal.** Get closer to **12** than your opponent without going over. Going over busts you.

**The turn.** You each start with one card, dealt face up — everything in this game is face up.
Then you alternate: **hit** or **stand**. Standing takes you out of the round; the other player
keeps drawing alone until they stand or bust. Who moves first alternates each round.

**Damage.** The winner of a round deals **1 damage**. But if the winner landed on **exactly 12**,
that's a **crit** for **2 damage** — including when they win because the other player busted.
Busting loses to any surviving total, however low. Equal totals, or both busting, is a push.

**The match.** You start on **5 HP**. First to zero loses.

**The deck viewer.** Click the deck (or press <kbd>D</kbd>) to see exactly which cards are still
in it, and what fraction of them keep you at or under 12. Since every card on the table is face
up, this is complete information — the game is a counting exercise, not a guessing one.

---

## The opponent

Difficulty is one continuous dial. The slider sets a **temperature** `t` from 0 to 1, and the
label names the zone: **Easy** (green), **Normal** (dark yellow), **Hard** (dark orange),
**Perfect** (red).

Unlike Card RPS there is no simultaneous choice here — every decision is made with full
information about the board and the deck. That makes the game a solved one, so at `t = 1` the
opponent simply plays the best move available, every time.

**How it's solved.** The round is a finite game of chance and choice, so it's solved by
**expectimax** with memoisation. State is `(deck composition, your total, my total, who has
stopped, whose move)` — all of it packed into a single integer key. Choice nodes take the max
(you) or min (the opponent); a hit is a chance node weighted by the exact deck composition. An
empty deck reshuffles inside the search too, so the model never diverges from the real game.

The value is **expected damage swing**, clamped by each side's remaining HP — so the opponent
knows not to waste a crit on someone sitting at 1 HP, and knows when it needs one. A full solve
takes about 6 ms.

**Below `t = 1`** the opponent samples between hit and stand from a softmax over their true
expected values, so its mistakes are the close calls first and the blunders last. There's a small
floor on the sharpness: even at zero it plays badly rather than randomly.

Measured against a scripted player who hits until reaching 9, over 900 matches per setting:

| Slider | 0 | 17 | 33 | 50 | 66 | 83 | 100 |
|---|---|---|---|---|---|---|---|
| Opponent wins | 11% | 20% | 46% | 62% | 67% | 66% | 66% |

The top of the dial flattens because perfect play only beats that baseline about two thirds of
the time — there isn't much room above competent play in this game. Most of the dial's range
lives between Easy and Normal.

Turn on **Odds** to see your bust chance and the exact value of each move before you commit.

---

## Deploying on GitHub Pages

```bash
mkdir card-12 && cd card-12
git init
# copy index.html, style.css, game.js and README.md in here
git add .
git commit -m "Card 12"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/card-12.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save.**

A minute later it's live at `https://YOUR-USERNAME.github.io/card-12/`. GitHub Pages serves
`index.html` at the root automatically, so there is nothing else to configure. Every push to
`main` redeploys.

To work on it locally just open `index.html` in a browser — `file://` is fine, there are no
fetches. Keep the three files side by side; `index.html` loads the other two by relative path.

---

## Code map

```
index.html   markup only — the table, the deck button, the deck panel
style.css    theme variables, layout, the numbered cards, the difficulty slider
game.js      all the logic
```

`game.js` is split into four labelled sections:

| Section | What's in it |
|---|---|
| 1. Model | the deck, `roundResult` (the whole win/crit/push table) |
| 2. AI | `ev` (memoised expectimax), `actionValues`, `decide` |
| 3. View | `cardNode`, `flyCard` (the draw animation), the deck panel — zero assets |
| 4. Controller | match and round flow, turn passing, resolution |

Sections 1–2 have no DOM dependency, so they can be pulled into Node and tested directly.

Tuning knobs, all at the top of `game.js`: `TARGET`, `COPIES`, `MAX_VAL`, `START_HP`. Raising
`TARGET` or `MAX_VAL` widens the state space but the solver doesn't care — it's memoised on
whatever composition you give it.

---

## Ideas if you want to extend it

- **Discard-pile reshuffle.** Right now an empty deck is rebuilt as a fresh full 24, which is
  simple but means a value can appear more than four times across one long round. Reshuffling
  only the discard pile instead would make the count exact end to end — change `drawCard` and the
  reshuffle branch in `ev` together, or the AI's model will drift from the real deck.
- **A hole card.** Deal each player one face-down card. That breaks perfect information and turns
  the solver into a belief problem — much closer to real blackjack.
- **Doubling down.** Let a player declare, before hitting, that this round is worth double damage
  to whoever wins it. One extra branch at each choice node.
- **Deck counting off.** Hide the deck viewer above a certain difficulty as a handicap, or make it
  cost something to open.
- **Best-of-N with escalating stakes.** Damage rises each round, so late rounds decide matches.

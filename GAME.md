# Tomagachi: The Game

The care layer on top of the creature. The core contract is the metabolism —
feed, starve, farm, earn. `TomagachiGame.sol` is the reason you open the page
every day.

Everything in the game is **free except gas**, awards only **virtual XP**, and
holds no funds beyond passing a feed through to the creature. XP is a score,
not a token: not transferable, not redeemable, no claim on anything. NOM stays
what it always was — feeding through the game mints it 1:1 exactly like
feeding directly.

## The loop

```
        care actions (free)                 feeding (USDC)
   ┌────────────────────────┐        ┌──────────────────────────┐
   │ pet    4h    +5 hp  5xp│        │ any mood      1x   10xp/$│
   │ play   8h   +15 hp 15xp│        │ STARVING      3x  + 🩹   │
   │ groom  24h  +10 hp 10xp│        │ HIBERNATING   5x  + ⚡   │
   └───────────┬────────────┘        └────────────┬─────────────┘
               │  × streak bonus                  │  × mood bonus
               ▼                                  ▼
        ┌──────────────────────────────────────────────┐
        │        every XP point levels THE CREATURE     │
        │        level n costs 500·n² total XP          │
        └──────────────────────────────────────────────┘
```

## Care actions

| action | cooldown | happiness | base XP | notes |
|---|---|---|---|---|
| `pet()` | 4 hours | +5 | 5 | works in any mood but EGG; petting a **hibernating** creature is keeping it company — **2x XP** |
| `play()` | 8 hours | +15 | 15 | needs an awake creature (reverts while hibernating) |
| `groom()` | 24 hours | +10 | 10 | once a day, deeply appreciated |

**Happiness** is a 0–100 stat, separate from satiety. It decays **10 points a
day**: a whale-fed creature that nobody pets is a sad creature. Feeding also
comforts it a little (+1 happiness per USDC).

## Streaks

Care for it on **consecutive UTC days** and your streak climbs. Every streak
day adds **+10% care XP**, capped at **+140%** (day 14). Miss a day and the
streak resets to 1. Multiple actions on the same day keep the streak, they
don't extend it.

Day 7 of a streak earns 📅 *Week Streak*; day 30 earns 🌙 *Moon Streak*.

**Streak freeze.** Missing exactly one day spends a banked grace charge
instead of resetting you to day 1 — the streak keeps climbing. Charges are
earned automatically every 7th streak day (so day 7 gives you both the Week
Streak badge and your first charge), capped at 2 held at once. Miss two days
in a row, or miss one with no charge banked, and the streak really does
reset. This exists because a bare streak counter is fragile — see the
citation in Design Notes below.

## Feeding is part of the game

Two ways to score feeding XP (both mint NOM 1:1 as always):

- **`gameFeed(amount)`** — approve USDC to the game and feed through it. The
  game checks the creature's mood *at that moment*:

  | mood when you feed | XP | badge |
  |---|---|---|
  | EGG / HAPPY / PECKISH | 10 XP per USDC | — |
  | STARVING | **30 XP per USDC** | 🩹 Clutch |
  | HIBERNATING | **50 XP per USDC** | ⚡ Reviver — your feed *wakes it up* |

- **`claimFeedXp()`** — fed it directly (or the brain swept your token
  donation)? Claim 10 XP per USDC here, at 1x. The game reads `fedBy()` and
  credits only what it hasn't counted before — feeding through `gameFeed`
  can never be claimed twice.

The strategy tension is intentional: a healthy community keeps the creature
HAPPY (low XP, safe training), while XP hunters *want* it near death for the
3–5x windows. Every rescue is somebody's payday.

## Levels

All XP from all players accrues to **the creature**. Level `n` costs
`500·n²` total XP:

| level | total XP | flavor |
|---|---|---|
| 1 | 500 | an afternoon |
| 3 | 4,500 | a good week |
| 5 | 12,500 | a real community |
| 10 | 50,000 | a village raised it |
| 20 | 200,000 | leviathan |

`LevelUp` events fire on-chain; the vitals page shows `LV n · XP / next`.

## Badges

One-time achievements, an on-chain bitmask per player (`playerState().badges`):

| bit | badge | how |
|---|---|---|
| 0 | 🐾 First Touch | your first care action |
| 1 | 🩹 Clutch | fed it while STARVING |
| 2 | ⚡ Reviver | fed it out of HIBERNATION |
| 3 | 📅 Week Streak | 7 consecutive care days |
| 4 | 🌙 Moon Streak | 30 consecutive care days |
| 5 | 💯 Centurion | 100 USDC fed via the game |
| 6 | 🐋 Whale | 1,000 USDC fed via the game |
| 7 | 💞 Bestie | 100 care actions |

## The Tank — the playable client

[`web/game.html`](web/game.html) is the actual game: a full-screen animated
tank with a living creature in it, not a dapp form.

- **A creature that acts alive** — procedurally animated tentacles, eyes that
  track your pointer, blinking, blushing when petted, mood-driven body
  language and palettes: it droops when peckish, twitches gray when starving,
  and sinks to the sea floor with drifting z's when hibernating. Tap it
  anywhere for a free wiggle (no gas, no XP — just affection).
- **Actions with juice** — PET throws hearts, FEED drops shrimp it swims to
  and munches, GROOM showers sparkles and bubbles, PLAY starts the **shrimp
  chase**: a real minigame where the shrimp follows your pointer and you
  steer the creature into catches before the timer runs out.
- **Game feel** — synthesized sound (bloops, munches, level-up fanfares — no
  audio files), confetti on level-ups, toasts for badges and streaks,
  cooldown timers on the buttons, a live hibernation countdown, and dramatic
  wake-up celebration when a feed revives it.
- **Demo mode by default** — open the page with no wallet and no deployment
  and the whole tamagotchi runs as a fast local simulation (minutes, not
  days) so it's immediately playable. Drop `deployment.json` next to it (or
  pass `?contract=…&game=…`) and it becomes the on-chain client: connect a
  wallet and PET/PLAY/GROOM/FEED are real transactions against
  `TomagachiGame`, with cooldowns, XP, level and badges read from Base, and
  the creature's actual on-chain `lastWords` in its speech bubble.

## How to play (no front-end required)

Everything is a plain contract call — BaseScan's *Write Contract* tab works:

```bash
# with cast (foundry), against the address in agent/deployment.json:
cast send $GAME "pet()"                          # scratch the fins
cast send $GAME "play()"                         # chase through the reef
cast send $GAME "groom()"                        # scrub the algae

# feed through the game for mood-bonus XP:
cast send $USDC "approve(address,uint256)" $GAME 10000000
cast send $GAME "gameFeed(uint256)" 10000000     # 10 USDC

# fed directly before? claim it:
cast send $GAME "claimFeedXp()"

# read everything:
cast call $GAME "gameState()"                    # happiness, level, xp, players
cast call $GAME "playerState(address)" $YOU      # your xp, streak, badges, cooldowns
```

The [vitals page](web/index.html) shows the happiness bar, the creature's
level, and the top-players leaderboard; the Telegram bot's `/vitals` includes
happiness once the game is deployed.

## Design notes (why it's shaped like this)

- **Zero admin.** No owner, no tuning knobs, no pause. The rules you read are
  the rules forever; a bad constant means a redeploy, not a governance fight.
- **Zero custody.** `gameFeed` moves USDC straight through to the creature in
  one transaction. The game's balance is always zero.
- **XP is not money.** Nothing in the game mints NOM, pays out, or can be
  sold. That is what keeps a tamagotchi a tamagotchi instead of a casino —
  see the economics section of the [README](README.md).
- **Pull, not push.** The game never hooks the core contract; it reads
  `mood()` and `fedBy()`. The creature doesn't know the game exists, so the
  metabolism can never be broken by a game bug.
- **The streak freeze is grounded in real product research, not vibes.**
  Skinner's operant-conditioning work (*Schedules of Reinforcement*, 1957)
  established that a strict, all-or-nothing schedule is also the one that
  breaks fastest under a single miss; Duolingo's own streak-freeze mechanic
  (verified from their blog — see [`research/technical-references.md`](research/technical-references.md))
  is the field-tested version of "forgive one miss." True variable-ratio
  rewards (the strongest schedule per that same research) were considered
  and rejected — on-chain randomness cheap enough for a zero-admin contract
  is gameable by simulate-then-broadcast-if-profitable, and a real fix needs
  an oracle this project doesn't carry. See the technical-references doc for
  the full citation list and what didn't survive verification.

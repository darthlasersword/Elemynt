# Elemynt

Hackable Chess Engine.

Elemynt is a pure JavaScript chess engine built without neural networks or opaque weight files. Every evaluation term is a named, readable number in plain JavaScript, and every playing style parameter can be changed live in the web interface or directly in the source files.

## How Elemynt Works

Elemynt separates board representation, evaluation, and search so each part can be read, modified, or replaced on its own.

The main engine lives in grandmaster/:

- grandmaster/board.js: Flat 64-square board with incremental 64-bit Zobrist position and pawn hashing, pseudo-legal move generation, and Static Exchange Evaluation (SEE) with X-ray support for captures.
- grandmaster/eval.js: Handcrafted evaluation decomposed into named chess concepts: material and piece-square tables, pawn structure (isolated, doubled, backward, connected, phalanx) cached in a Zobrist pawn hash table, passed pawns, safe mobility excluding enemy pawn attacks, pawn-supported outposts, bishop pair, rooks on open files and the 7th rank, and king safety (pawn shield, pawn storms, and weighted attackers on the king zone).
- grandmaster/engine.js: Iterative deepening negamax with Principal Variation Search, a typed-array transposition table, aspiration windows, quiescence search with SEE pruning, killer moves, countermove table, history heuristic with malus, null move pruning, reverse futility pruning, razoring, late move pruning, logarithmic late move reductions, singular extensions, and a Chaos move sampler.
- grandmaster/weights.js: Single source of truth for all evaluation constants, slider definitions, and presets.

Earlier engine versions are also included and playable from the same UI:

- engine.js and elemynt_engine.js: Original 1-ply intuition engine (~1280 Elo).
- engine_5ply.js: 5-ply search engine (~1550 Elo).
- planner/: 4-ply idea-driven engine that scores and commits to plans (~1420 Elo).
- master/: 10-ply alpha-beta engine (~2150 Elo).

## How Hackable It Is

All evaluation weights and search settings are plain numbers in grandmaster/weights.js. You can edit any constant directly (for example, changing the value of an isolated pawn, an outpost, or a king-zone attacker) and restart the server, or adjust multipliers live from the Style & Lab tab in the browser.

Setting any evaluation concept to 0% turns that concept off completely, creating targeted strategic handicaps (such as a pawn-blind bot or an exposed-king bot) for training or experimentation.

## Running in the Web

Requires Node.js 18 or newer. No npm install is needed.

```bash
node grandmaster/server.js
```

Or using npm:

```bash
npm start
```

Open http://localhost:8082 in your browser. To use a different port:

```bash
PORT=3000 node grandmaster/server.js
```

## Running in the Terminal

You can run Elemynt over UCI (Universal Chess Interface) directly in the terminal or connect it to any UCI-compatible chess GUI:

```bash
node uci.js
```

Example UCI session:

```text
uci
isready
position startpos moves e2e4 e7e5
go movetime 300
quit
```

## Features

- White-Box Evaluation: Shows the live centipawn breakdown of the current position across Material, Pawns, Passed pawns, Mobility, Outposts, and King safety, along with plain-text positional notes and the engine's principal variation.
- Style & Lab: Lets you pick White and Black players (Human, Elemynt Grandmaster, Master 10-ply, Planner, Classic 1-ply, or Stockfish 19), switch profiles and handicap presets, adjust all 11 live sliders (Max ply, Time, Pawn structure, Passed pawns, Safe mobility, Outposts & rooks, King safety, Attack bias, Safety caution, Contempt, and Chaos), and load any FEN.
- Chaos Meter: Controls move randomness from 0% (deterministic best move) to 100% (wild move selection using temperature-weighted sampling).
- Approximate Bot Ratings: Displays an estimated Elo rating for each bot and updates Elemynt Grandmaster's rating estimate as you change depth, time, handicaps, or Chaos.
- Stockfish 19 Tab: Runs Stockfish 19 Lite locally in the browser as an optional opponent or second opinion. Includes sliders for Stockfish bot rating (~1350 to 3200+) and think time, a toggle for the live analyzer and evaluation bar, a toggle for the high-contrast best-move arrow, and controls for MultiPV lines and depth.
- Saved Settings: Automatically saves your sliders, player selections, and Stockfish preferences in localStorage and shows a Saved confirmation indicator.
- Game Playback and Export: Step forward or backward through moves with animated piece transitions, undo and redo moves, flip the board, and copy the current FEN or full PGN.

// Experimental 5-ply copy of Elemynt: keeps the exact same rules, exports, and
// intuition-inspired evaluation concepts (stage phase, center proximity, passed
// pawns, king shelter/activity), but replaces the 1-ply shortlist with a 5-ply
// iterative-deepening alpha-beta search, transposition table, and capture quiescence.

export {
  parseFen, toFen, legalMoves, status, moveText, exchangeGain, mateInOne, analyze,
} from "./engine.js";

import { legalMoves, moveText, status } from "./engine.js";

const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const TYPE = { P: "p", N: "n", B: "b", R: "r", Q: "q", K: "k", p: "p", n: "n", b: "b", r: "r", q: "q", k: "k" };
const SYMBOL = {
  w: { p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K" },
  b: { p: "p", n: "n", b: "b", r: "r", q: "q", k: "k" },
};
const DEFAULT_DEPTH = 5;
const MATE_SCORE = 30000;
const INF = 100000;

const colorOf = piece => piece < "a" ? "w" : "b";
const opposite = color => color === "w" ? "b" : "w";
const rankOf = sq => sq >> 3;
const fileOf = sq => sq & 7;
const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;

// Precomputed square bonuses mirroring Elemynt's center proximity, development,
// pawn advancement, and king shelter/activity geometry.
const PROXIMITY = Float64Array.from({ length: 64 }, (_, sq) => {
  const df = Math.min(Math.abs(fileOf(sq) - 3), Math.abs(fileOf(sq) - 4));
  const dr = Math.min(Math.abs(rankOf(sq) - 3), Math.abs(rankOf(sq) - 4));
  return 1 - (df + dr) / 6;
});
const CENTER_BONUS = Int16Array.from({ length: 64 }, (_, sq) => Math.round(PROXIMITY[sq] * 32));
const PASSED_SPAN = {
  w: Array.from({ length: 64 }, (_, sq) => {
    const out = [];
    const f0 = fileOf(sq);
    for (let r = rankOf(sq) + 1; r < 8; r++) {
      for (let df = -1; df <= 1; df++) {
        const f = f0 + df;
        if (f >= 0 && f < 8) out.push(r * 8 + f);
      }
    }
    return out;
  }),
  b: Array.from({ length: 64 }, (_, sq) => {
    const out = [];
    const f0 = fileOf(sq);
    for (let r = rankOf(sq) - 1; r >= 0; r--) {
      for (let df = -1; df <= 1; df++) {
        const f = f0 + df;
        if (f >= 0 && f < 8) out.push(r * 8 + f);
      }
    }
    return out;
  }),
};

// Fast static evaluation from the side-to-move's perspective, preserving
// Elemynt's material, game-phase, center, passed-pawn, and king-safety model.
function evaluate(position) {
  const { board, turn } = position;
  let phasePoints = 0;
  let queens = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p) continue;
    const t = TYPE[p];
    if (t === "n" || t === "b") phasePoints += 1;
    else if (t === "r") phasePoints += 2;
    else if (t === "q") { phasePoints += 4; queens++; }
  }
  const materialPhase = clamp(phasePoints / 24);
  const kingShelterW = clamp(0.1 + 0.55 * materialPhase + 0.3 * clamp(queens / 2));
  const kingActivityW = 1 - kingShelterW;
  const pawnAdvW = 1.15 - 0.65 * materialPhase;

  let whiteScore = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece) continue;
    const color = colorOf(piece);
    const type = TYPE[piece];
    const sign = color === "w" ? 1 : -1;
    const r = rankOf(sq);
    const f = fileOf(sq);

    let val = VALUES[type];
    if (type === "p") {
      const adv = color === "w" ? r - 1 : 6 - r;
      let passed = true;
      const enemyPawn = SYMBOL[opposite(color)].p;
      for (const s of PASSED_SPAN[color][sq]) {
        if (board[s] === enemyPawn) { passed = false; break; }
      }
      val += adv * (passed ? 14 : 4.5) * pawnAdvW + (PROXIMITY[sq] * 14 * materialPhase);
    } else if (type === "n" || type === "b") {
      const homeRank = color === "w" ? 0 : 7;
      val += CENTER_BONUS[sq] * (0.6 + 0.6 * materialPhase) - (r === homeRank ? 12 * materialPhase : 0);
    } else if (type === "r") {
      const seventh = color === "w" ? 6 : 1;
      val += (r === seventh ? 18 : 0) + (f >= 2 && f <= 5 ? 6 : 0);
    } else if (type === "q") {
      val += CENTER_BONUS[sq] * 0.35;
    } else if (type === "k") {
      const homeRank = color === "w" ? 0 : 7;
      const flank = (f <= 2 || f >= 6) && r === homeRank ? 1 : 0;
      const ahead = color === "w" ? 1 : -1;
      const shieldRank = r + ahead;
      let shield = 0;
      if (shieldRank >= 0 && shieldRank < 8) {
        const ownPawn = SYMBOL[color].p;
        for (let df = -1; df <= 1; df++) {
          const sf = f + df;
          if (sf >= 0 && sf < 8 && board[shieldRank * 8 + sf] === ownPawn) shield++;
        }
      }
      const shelter = (0.6 * (shield / 3) + 0.4 * flank) * 55;
      const activity = PROXIMITY[sq] * 48;
      val += kingShelterW * shelter + kingActivityW * activity;
    }
    whiteScore += sign * val;
  }
  return Math.round(turn === "w" ? whiteScore : -whiteScore);
}

function posKey({ board, turn, rights, ep }) {
  let k = turn + rights + "," + ep + ",";
  for (let i = 0; i < 64; i++) k += board[i] ?? ".";
  return k;
}

function isCaptureOrPromo(position, move) {
  return Boolean(position.board[move.to] || move.special === "ep" || move.promotion);
}

function movePriority(position, move, ttBest, killers) {
  if (ttBest && move.from === ttBest.from && move.to === ttBest.to && move.promotion === ttBest.promotion) {
    return 100000;
  }
  let score = 0;
  const victim = move.special === "ep" ? "p" : position.board[move.to];
  if (victim) {
    const attacker = position.board[move.from];
    score += 10000 + VALUES[TYPE[victim]] * 10 - VALUES[TYPE[attacker]];
  }
  if (move.promotion) score += 9000 + VALUES[move.promotion];
  if (!victim && killers) {
    if (killers[0] && killers[0].from === move.from && killers[0].to === move.to) score += 8000;
    else if (killers[1] && killers[1].from === move.from && killers[1].to === move.to) score += 7000;
  }
  if (move.special === "castle") score += 400;
  score += CENTER_BONUS[move.to];
  return score;
}

function orderMoves(position, entries, ttBest, killers) {
  if (entries.length <= 1) return entries;
  const scored = entries.map(entry => ({ entry, p: movePriority(position, entry.move, ttBest, killers) }));
  scored.sort((a, b) => b.p - a.p);
  return scored.map(s => s.entry);
}

export function chooseMove(position, { depth = DEFAULT_DEPTH } = {}, moves = [...legalMoves(position)]) {
  if (!moves.length) return null;

  const tt = new Map(); // key -> { depth, flag: 0 exact | 1 lower | 2 upper, score, bestMove }
  const killers = Array.from({ length: 32 }, () => [null, null]);
  let nodes = 0;

  function quiesce(pos, alpha, beta, qply) {
    nodes++;
    const standPat = evaluate(pos);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (qply >= 2) return alpha;

    const tactical = [];
    for (const entry of legalMoves(pos)) {
      if (!isCaptureOrPromo(pos, entry.move)) continue;
      const victim = entry.move.special === "ep" ? "p" : pos.board[entry.move.to];
      const gain = (victim ? VALUES[TYPE[victim]] : 0) + (entry.move.promotion ? VALUES[entry.move.promotion] : 0);
      if (standPat + gain + 150 < alpha) continue;
      tactical.push(entry);
    }
    if (!tactical.length) return alpha;

    for (const { after } of orderMoves(pos, tactical, null, null)) {
      const score = -quiesce(after, -beta, -alpha, qply + 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(pos, d, alpha, beta, ply) {
    nodes++;
    const alphaOrig = alpha;
    const key = posKey(pos);
    const cached = tt.get(key);
    if (cached && cached.depth >= d) {
      if (cached.flag === 0) return cached.score;
      if (cached.flag === 1) alpha = Math.max(alpha, cached.score);
      else if (cached.flag === 2) beta = Math.min(beta, cached.score);
      if (alpha >= beta) return cached.score;
    }

    if (d === 0) return quiesce(pos, alpha, beta, 0);

    const legal = [...legalMoves(pos)];
    if (!legal.length) {
      return status(pos, legal) === "checkmate" ? -MATE_SCORE + ply : 0;
    }

    const ordered = orderMoves(pos, legal, cached?.bestMove, killers[ply]);
    let bestScore = -INF;
    let bestMove = ordered[0].move;

    for (let i = 0; i < ordered.length; i++) {
      const { move, after } = ordered[i];
      let score;
      if (i === 0) {
        score = -negamax(after, d - 1, -beta, -alpha, ply + 1);
      } else {
        score = -negamax(after, d - 1, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && score < beta) {
          score = -negamax(after, d - 1, -beta, -alpha, ply + 1);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!isCaptureOrPromo(pos, move)) {
          killers[ply][1] = killers[ply][0];
          killers[ply][0] = move;
        }
        break;
      }
    }

    const flag = bestScore <= alphaOrig ? 2 : bestScore >= beta ? 1 : 0;
    if (tt.size < 200000) tt.set(key, { depth: d, flag, score: bestScore, bestMove });
    return bestScore;
  }

  let bestEntry = moves[0];
  let bestScore = 0;

  // Iterative deepening from 1 to target depth so each pass orders the next.
  for (let d = 1; d <= depth; d++) {
    let alpha = -INF;
    const beta = INF;
    const ordered = orderMoves(position, moves, bestEntry.move, killers[0]);
    let iterBest = ordered[0];
    let iterScore = -INF;

    for (const entry of ordered) {
      const score = -negamax(entry.after, d - 1, -beta, -alpha, 1);
      if (score > iterScore) {
        iterScore = score;
        iterBest = entry;
      }
      if (score > alpha) alpha = score;
    }
    bestEntry = iterBest;
    bestScore = iterScore;
    if (Math.abs(bestScore) >= MATE_SCORE - 100) break;
  }

  const replies = [...legalMoves(bestEntry.after)];
  const scoreText = Math.abs(bestScore) >= MATE_SCORE - 100
    ? `mate in ${Math.ceil((MATE_SCORE - Math.abs(bestScore)) / 2)}`
    : `score ${bestScore}`;
  return {
    ...bestEntry,
    replies,
    score: bestScore,
    detail: `5-ply search, ${scoreText}, ${nodes} nodes.`,
  };
}

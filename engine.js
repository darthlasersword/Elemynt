// Elemynt engine core: rules, position analysis, and the intuition-based move choice.
// This module has no runtime dependencies. The terminal front end (elemynt_engine.js)
// and the web server (server.js) both import it.

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = "abcdefgh";
const COLORS = ["w", "b"];
const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MOBILITY = { p: 4, n: 8, b: 13, r: 14, q: 27, k: 8 };
const DEFENSE = { p: 1, n: 0.8, b: 0.8, r: 0.65, q: 0.45, k: 0.5 };
const DEFAULT_CANDIDATES = 14;

// Pieces are single letters and uppercase is White. Table lookups replace
// case conversion, which used to dominate the hot loops.
const TYPE = { P: "p", N: "n", B: "b", R: "r", Q: "q", K: "k", p: "p", n: "n", b: "b", r: "r", q: "q", k: "k" };
const SYMBOL = {
  w: { p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K" },
  b: { p: "p", n: "n", b: "b", r: "r", q: "q", k: "k" },
};

const opposite = color => color === "w" ? "b" : "w";
const colorOf = piece => piece < "a" ? "w" : "b";
const symbol = (type, color) => SYMBOL[color][type];
const rankOf = index => index >> 3;
const fileOf = index => index & 7;
const squareName = index => FILES[fileOf(index)] + (rankOf(index) + 1);
const squareIndex = name => FILES.indexOf(name[0]) + 8 * (Number(name[1]) - 1);
const forward = color => color === "w" ? 8 : -8;
const clamp = value => Math.max(0, Math.min(1, value));

function offset(index, df, dr) {
  const file = fileOf(index) + df;
  const rank = rankOf(index) + dr;
  return file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : -1;
}

// Fixed geometry is shared across positions. The board is the sole record of
// where pieces are. Every trial move copies it, and analysis stays separate.
const STRAIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
const DIRECTIONS = [...STRAIGHT, ...DIAGONAL];
const KNIGHT_STEPS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const GEOMETRY = Array.from({ length: 64 }, (_, from) => {
  const steps = directions => directions.map(([df, dr]) => offset(from, df, dr)).filter(to => to !== -1);
  const ray = (df, dr) => {
    const squares = [];
    for (let to = offset(from, df, dr); to !== -1; to = offset(to, df, dr)) squares.push(to);
    return squares;
  };
  // Squares an enemy pawn would have to occupy to stop a pawn on this square.
  const span = dr => [-1, 0, 1].flatMap(df => {
    const squares = [];
    for (let to = offset(from, df, dr); to !== -1; to = offset(to, 0, dr)) squares.push(to);
    return squares;
  });
  return {
    rays: DIRECTIONS.map(([df, dr]) => ray(df, dr)), n: steps(KNIGHT_STEPS), k: steps(DIRECTIONS),
    w: steps([[-1, 1], [1, 1]]), b: steps([[-1, -1], [1, -1]]),
    span: { w: span(1), b: span(-1) },
  };
});
const SLIDER_RAYS = { r: [0, 1, 2, 3], b: [4, 5, 6, 7], q: [0, 1, 2, 3, 4, 5, 6, 7] };
const CASTLES = Object.fromEntries(COLORS.map(color => {
  const base = color === "w" ? 0 : 56;
  return [color, [
    {
      right: symbol("k", color), king: base + 4, rook: base + 7,
      through: base + 5, to: base + 6, empty: [base + 5, base + 6]
    },
    {
      right: symbol("q", color), king: base + 4, rook: base,
      through: base + 3, to: base + 2, empty: [base + 1, base + 2, base + 3]
    },
  ]];
}));
const ALL_CASTLES = [...CASTLES.w, ...CASTLES.b];

// Read and write a complete FEN, including the rights and move counters.
export function parseFen(fen = START_FEN) {
  const [layout, turn, rights, epText, halfText, fullText, ...extra] = fen.trim().split(/\s+/);
  const ranks = layout.split("/");
  const board = Array(64).fill(null);
  const require = (valid, reason) => {
    if (!valid) throw new Error("Invalid FEN. " + reason);
  };
  require(ranks.length === 8 && !extra.length && fullText !== undefined, "Expected eight ranks and six fields.");
  ranks.forEach((row, rowIndex) => {
    let file = 0;
    for (const char of row) {
      if (/^[1-8]$/.test(char)) file += Number(char);
      else {
        require(/^[PNBRQKpnbrqk]$/.test(char) && file < 8, "Invalid piece or rank width.");
        require(!/^[Pp]$/.test(char) || (rowIndex > 0 && rowIndex < 7), "Pawn on the first or eighth rank.");
        board[8 * (7 - rowIndex) + file++] = char;
      }
    }
    require(file === 8, "Every rank must cover eight squares.");
  });
  require(board.filter(piece => piece === "K").length === 1 &&
    board.filter(piece => piece === "k").length === 1, "Each side needs exactly one king.");
  require(COLORS.includes(turn), "Side to move must be w or b.");
  require(rights === "-" || (rights && /^K?Q?k?q?$/.test(rights)), "Invalid castling rights.");
  for (const route of ALL_CASTLES) {
    const color = colorOf(route.right);
    require(!rights.includes(route.right) ||
      (board[route.king] === symbol("k", color) && board[route.rook] === symbol("r", color)),
      "Castling right requires the king and rook on their home squares.");
  }

  let ep = -1;
  if (epText !== "-") {
    require(new RegExp(turn === "w" ? "^[a-h]6$" : "^[a-h]3$").test(epText), "Invalid en passant square.");
    ep = squareIndex(epText);
    const step = forward(turn);
    require(!board[ep] && !board[ep + step] && board[ep - step] === symbol("p", opposite(turn)),
      "En passant target requires a pawn that just advanced two squares.");
  }
  const halfmove = Number(halfText);
  const fullmove = Number(fullText);
  require(/^\d+$/.test(halfText) && /^\d+$/.test(fullText) &&
    Number.isSafeInteger(halfmove) && Number.isSafeInteger(fullmove) && fullmove >= 1, "Invalid move counters.");
  require(!kingInCheck(board, opposite(turn)), "The side that just moved is in check.");
  return { board, turn, rights: rights === "-" ? "" : rights, ep, halfmove, fullmove };
}

export function toFen({ board, turn, rights, ep, halfmove, fullmove }) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    const row = board.slice(rank * 8, rank * 8 + 8).map(piece => piece ?? ".").join("");
    rows.push(row.replace(/\.+/g, empty => String(empty.length)));
  }
  return [rows.join("/"), turn, rights || "-", ep === -1 ? "-" : squareName(ep), halfmove, fullmove].join(" ");
}

// Geometric attacks include pinned pieces and the first occupied square on a ray.
// Leaper and pawn lists are shared geometry, so callers must not modify the result.
function attacksFrom(board, from) {
  const piece = board[from];
  const type = TYPE[piece];
  const geometry = GEOMETRY[from];
  if (type === "p") return geometry[colorOf(piece)];
  if (type === "n" || type === "k") return geometry[type];
  const targets = [];
  for (const direction of SLIDER_RAYS[type]) {
    for (const to of geometry.rays[direction]) {
      targets.push(to);
      if (board[to]) break;
    }
  }
  return targets;
}

// Look outward from a target when only a yes/no attack answer is needed.
function isAttacked(board, target, color) {
  const geometry = GEOMETRY[target];
  const own = SYMBOL[color];
  for (const from of geometry[opposite(color)]) if (board[from] === own.p) return true;
  for (const from of geometry.n) if (board[from] === own.n) return true;
  for (const from of geometry.k) if (board[from] === own.k) return true;
  for (let direction = 0; direction < 8; direction++) {
    const slider = direction < 4 ? own.r : own.b;
    for (const square of geometry.rays[direction]) {
      const piece = board[square];
      if (!piece) continue;
      if (piece === own.q || piece === slider) return true;
      break;
    }
  }
  return false;
}

function kingInCheck(board, color) {
  return isAttacked(board, board.indexOf(SYMBOL[color].k), opposite(color));
}

// Would color's king be safe after moving the piece on from to to? The board
// is changed in place and restored before returning, which avoids a copy.
function staysSafe(board, from, to, color) {
  const moved = board[from];
  const captured = board[to];
  board[to] = moved;
  board[from] = null;
  const safe = !kingInCheck(board, color);
  board[from] = moved;
  board[to] = captured;
  return safe;
}

function addPawnMove(moves, from, to, special) {
  const rank = rankOf(to);
  if (rank === 0 || rank === 7) {
    for (const promotion of "qrbn") moves.push({ from, to, promotion });
  } else moves.push({ from, to, special });
}

// Append movement candidates. The final king-safety test is shared by all pieces.
function pseudoMoves(position, from, target, moves) {
  const { board, turn, ep, rights } = position;
  const type = TYPE[board[from]];
  if (type === "p") {
    const step = forward(turn);
    if (target === -1 && !board[from + step]) {
      addPawnMove(moves, from, from + step);
      if (rankOf(from) === (turn === "w" ? 1 : 6) && !board[from + 2 * step]) {
        moves.push({ from, to: from + 2 * step });
      }
    }
    for (const to of GEOMETRY[from][turn]) {
      if (target !== -1 && to !== target) continue;
      const victim = board[to];
      if (victim && colorOf(victim) !== turn && TYPE[victim] !== "k") addPawnMove(moves, from, to);
      else if (to === ep) addPawnMove(moves, from, to, "ep");
    }
    return;
  }

  for (const to of attacksFrom(board, from)) {
    if (target !== -1 && to !== target) continue;
    const victim = board[to];
    if (!victim || (colorOf(victim) !== turn && TYPE[victim] !== "k")) moves.push({ from, to });
  }
  if (type !== "k" || target !== -1 || !rights) return;
  for (const route of CASTLES[turn]) {
    if (from !== route.king || !rights.includes(route.right) || route.empty.some(to => board[to])) continue;
    if (kingInCheck(board, turn)) continue;
    if (!staysSafe(board, from, route.through, turn)) continue;
    moves.push({ from, to: route.to, special: "castle" });
  }
}

function capturedSquare(position, move) {
  return move.special === "ep" ? move.to - forward(position.turn) : move.to;
}

function applyMove(position, move) {
  const { from, to, promotion, special } = move;
  const { turn, board } = position;
  const type = TYPE[board[from]];
  const captured = capturedSquare(position, move);
  const victim = board[captured];
  const nextBoard = board.slice();
  nextBoard[to] = nextBoard[from];
  nextBoard[from] = null;
  let rights = position.rights;
  if (special === "ep") nextBoard[captured] = null;
  if (special === "castle") {
    const route = CASTLES[turn].find(route => route.to === to);
    nextBoard[route.through] = nextBoard[route.rook];
    nextBoard[route.rook] = null;
  }
  if (promotion) nextBoard[to] = symbol(promotion, turn);
  if (rights) {
    for (const route of ALL_CASTLES) {
      if ((type === "k" && from === route.king) || from === route.rook || to === route.rook) {
        rights = rights.replace(route.right, "");
      }
    }
  }
  return {
    board: nextBoard, rights, turn: opposite(turn),
    ep: type === "p" && Math.abs(from - to) === 16 ? (from + to) / 2 : -1,
    halfmove: type === "p" || victim ? 0 : position.halfmove + 1,
    fullmove: position.fullmove + Number(turn === "b"),
  };
}

// All legal moves as { move, after } entries. The optional target limits the
// list to captures on that square, which the exchange search uses.
function legalMoveList(position, target = -1) {
  const { board, turn } = position;
  const pseudo = [];
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece && colorOf(piece) === turn) pseudoMoves(position, from, target, pseudo);
  }
  const entries = [];
  for (const move of pseudo) {
    if (target !== -1 && !board[capturedSquare(position, move)]) continue;
    const after = applyMove(position, move);
    if (!kingInCheck(after.board, turn)) entries.push({ move, after });
  }
  return entries;
}

// Stops at the first legal move, optionally only counting moves accepted by the filter.
function hasLegalMove(position, accept = null) {
  const { board, turn } = position;
  const pseudo = [];
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== turn) continue;
    pseudo.length = 0;
    pseudoMoves(position, from, -1, pseudo);
    for (const move of pseudo) {
      if ((!accept || accept(move)) && !kingInCheck(applyMove(position, move).board, turn)) return true;
    }
  }
  return false;
}

// Returns an iterator, so callers can spread it or read entries one at a time.
export function legalMoves(position, target = -1) {
  return legalMoveList(position, target).values();
}

export function status(position, moves = null) {
  const inCheck = kingInCheck(position.board, position.turn);
  const canMove = moves === null ? hasLegalMove(position) : moves.length > 0;
  if (!canMove) return inCheck ? "checkmate" : "stalemate";
  return inCheck ? "check" : "normal";
}

export function moveText({ from, to, promotion }) {
  return squareName(from) + squareName(to) + (promotion ?? "");
}

// Tactics. Every recursive edge removes a piece and lands on the same square.
// A checked player can decline only if a different legal evasion exists.
function materialGain(position, move) {
  const victim = position.board[capturedSquare(position, move)];
  return (victim ? VALUES[TYPE[victim]] : 0) +
    (move.promotion ? VALUES[move.promotion] - VALUES.p : 0);
}

function positionKey({ board, turn, rights, ep }) {
  let key = turn + rights + "," + ep + ",";
  for (let square = 0; square < 64; square++) key += board[square] ?? ".";
  return key;
}

export function exchangeGain(position, target) {
  const memo = new Map();
  function resolve(current) {
    const occupant = current.board[target];
    if (!occupant && current.ep !== target) return 0;
    if (occupant && TYPE[occupant] === "k") return 0;
    const key = positionKey(current);
    const known = memo.get(key);
    if (known !== undefined) return known;

    const captures = legalMoveList(current, target);
    if (!captures.length) return 0;
    let best = 0;
    if (kingInCheck(current.board, current.turn)) {
      const declines = hasLegalMove(current, move =>
        move.to !== target || !current.board[capturedSquare(current, move)]);
      best = declines ? 0 : -Infinity;
    }
    for (const { move, after } of captures) {
      best = Math.max(best, materialGain(current, move) - resolve(after));
    }
    memo.set(key, best);
    return best;
  }
  return resolve(position);
}

export function mateInOne(position, moves = legalMoveList(position)) {
  // Only checking replies can mate. Finding any legal defense ends that probe.
  for (const entry of moves) {
    const { after } = entry;
    if (kingInCheck(after.board, after.turn) && !hasLegalMove(after)) return entry;
  }
  return null;
}

// Stage depends on material, home squares, and current tactical contact.
const CENTER = ["d4", "e4", "d5", "e5"].map(squareIndex);
const HOME_MINORS = Object.entries({
  b1: "N", g1: "N", c1: "B", f1: "B",
  b8: "n", g8: "n", c8: "b", f8: "b"
}).map(([square, piece]) => [squareIndex(square), piece]);
const CENTER_WEIGHT = GEOMETRY.map((_, to) => {
  if (CENTER.includes(to)) return 1;
  return fileOf(to) >= 2 && fileOf(to) <= 5 && rankOf(to) >= 2 && rankOf(to) <= 5 ? 0.4 : 0;
});

function detectStage(position, attacks, contact) {
  const { board, fullmove } = position;
  const count = types => board.filter(piece => piece && types.includes(TYPE[piece])).length;
  const minors = count("bn");
  const rooks = count("r");
  const queens = count("q");
  const homeMinors = HOME_MINORS.filter(([square, piece]) => board[square] === piece).length;
  const homePawns = board.slice(8, 16).filter(piece => piece === "P").length +
    board.slice(48, 56).filter(piece => piece === "p").length;
  const phasePoints = minors + 2 * rooks + 4 * queens;
  const materialPhase = clamp(phasePoints / 24);
  const openingProgress = 0.7 * (1 - homeMinors / 8) + 0.3 * (1 - homePawns / 16);
  const contested = CENTER.filter(to => attacks.w[to].length && attacks.b[to].length).length;
  const complexity = clamp(0.5 * clamp(contact / 6) + 0.3 * contested / 4 +
    0.2 * Number(kingInCheck(board, position.turn)));

  let kind = "opening";
  if (phasePoints <= 5 || (minors <= 1 && 500 * rooks + 900 * queens <= 2200)) kind = "late endgame";
  else if (phasePoints <= 8 || (queens === 0 && (materialPhase <= 0.65 || minors <= 3)) ||
    (minors <= 3 && materialPhase <= 0.65)) kind = "early endgame";
  else if (materialPhase < 0.78 || openingProgress >= 0.58 ||
    (complexity >= 0.6 && openingProgress >= 0.25) || (fullmove >= 18 && openingProgress >= 0.2)) {
    kind = "middlegame";
  }

  const kingShelter = clamp(0.1 + 0.55 * materialPhase + 0.3 * clamp(queens / 2));
  return {
    kind, materialPhase, openingProgress, complexity, weights: {
      kingShelter, kingActivity: 1 - kingShelter,
      development: clamp(0.2 + 0.8 * materialPhase - 0.15 * openingProgress),
      pawnAdvance: 1.15 - 0.65 * materialPhase, centerControl: 0.45 + 0.55 * materialPhase,
      tacticalCaution: 0.85 + 0.4 * complexity,
    }
  };
}

function hypotheticalTurn(position, color) {
  // En passant belongs only to the actual side to move.
  return color === position.turn ? position : { ...position, turn: color, ep: -1 };
}

function passedPawn(board, from, color) {
  const enemy = symbol("p", opposite(color));
  for (const to of GEOMETRY[from].span[color]) if (board[to] === enemy) return false;
  return true;
}

// Build fresh measurements per piece. A defender only counts if a recapture
// on its ally's square would leave its own king safe.
export function analyze(position, moves = legalMoveList(position), scoreWeights = null) {
  const { board, turn } = position;
  const records = board.map(piece => piece && {
    destinations: new Set(), attackers: new Set(), defenders: [], risk: 0, opportunity: 0,
    activity: 0, shelter: 0, advancement: 0, proximity: 0, mobility: 0, defense: 0,
  });
  const attacks = { w: GEOMETRY.map(() => []), b: GEOMETRY.map(() => []) };
  for (let from = 0; from < 64; from++) {
    if (!board[from]) continue;
    const own = attacks[colorOf(board[from])];
    for (const to of attacksFrom(board, from)) own[to].push(from);
  }

  const threat = { w: 0, b: 0 };
  const contestedPieces = new Set();
  for (const color of COLORS) {
    const snapshot = hypotheticalTurn(position, color);
    const entries = color === turn ? moves : legalMoveList(snapshot);
    for (const { move, after } of entries) {
      const { from, to } = move;
      records[from].destinations.add(to);
      const victim = capturedSquare(snapshot, move);
      if (!board[victim]) continue;
      const gain = materialGain(snapshot, move) - exchangeGain(after, to);
      records[victim].attackers.add(from);
      records[victim].risk = Math.max(records[victim].risk, gain);
      records[from].opportunity = Math.max(records[from].opportunity, gain);
      threat[color] = Math.max(threat[color], gain);
      contestedPieces.add(victim);
    }
  }

  const stage = detectStage(position, attacks, contestedPieces.size);
  const weights = scoreWeights ?? stage.weights;
  for (let from = 0; from < 64; from++) {
    const record = records[from];
    if (!record) continue;
    const piece = board[from];
    const color = colorOf(piece);
    const type = TYPE[piece];
    record.mobility = clamp(record.destinations.size / MOBILITY[type]);
    record.proximity = 1 - (Math.min(Math.abs(fileOf(from) - 3), Math.abs(fileOf(from) - 4)) +
      Math.min(Math.abs(rankOf(from) - 3), Math.abs(rankOf(from) - 4))) / 6;

    if (type === "k") {
      const ahead = color === "w" ? 1 : -1;
      const shield = [-1, 0, 1].filter(df => board[offset(from, df, ahead)] === symbol("p", color)).length;
      const enemy = attacks[opposite(color)];
      const underPressure = GEOMETRY[from].k.filter(to => enemy[to].length).length;
      const flank = (fileOf(from) <= 2 || fileOf(from) >= 6) && rankOf(from) === (color === "w" ? 0 : 7);
      record.shelter = clamp(0.55 * shield / 3 + 0.2 * Number(flank) +
        0.25 * (1 - underPressure / 8));
      record.activity = 0.65 * record.proximity + 0.35 * record.mobility;
      continue;
    }

    record.defenders = attacks[color][from].filter(ally => staysSafe(board, ally, from, color));
    record.defense = clamp(record.defenders.reduce((sum, ally) =>
      sum + DEFENSE[TYPE[board[ally]]], 0) / 2.5);
    let influence = 0;
    for (const to of attacksFrom(board, from)) {
      if (!CENTER_WEIGHT[to] || TYPE[board[to]] === "k") continue;
      if (staysSafe(board, from, to, color)) influence += CENTER_WEIGHT[to];
    }
    let access = 0;
    for (const to of record.destinations) access += CENTER_WEIGHT[to];
    record.activity = weights.centerControl * (0.4 * clamp(influence / 3) +
      0.2 * clamp(access / 2) + 0.15 * record.proximity) + 0.25 * record.mobility;
    if (type === "p") {
      const ranks = color === "w" ? rankOf(from) - 1 : 6 - rankOf(from);
      record.advancement = clamp(ranks / 6) * (passedPawn(board, from, color) ? 1 : 0.35);
    }
  }
  return { records, stage, threat, attacks };
}

// Match each move to a few piece needs, then score changes across all pieces.
function shortlist(position, moves, analysis, limit) {
  const { board } = position;
  const { weights } = analysis.stage;
  const ranked = moves.map(entry => {
    const { move, after } = entry;
    const { from, to } = move;
    const type = TYPE[board[from]];
    const tags = new Set();
    let priority = materialGain(position, move);
    const risk = analysis.records[from].risk;
    const movedPieceRisk = (priority > 0 || risk > 0) ? exchangeGain(after, to) : 0;
    if (priority > 0) {
      tags.add("capture or promotion");
      priority -= movedPieceRisk;
    }
    if (risk > movedPieceRisk) {
      tags.add("rescue");
      priority += (risk - movedPieceRisk) * weights.tacticalCaution;
    }
    if (move.special === "castle") {
      tags.add("castle");
      priority += 35 * weights.kingShelter;
    }
    if (kingInCheck(after.board, after.turn)) {
      tags.add("check");
      priority += 12;
    }
    if (type === "n" || type === "b") {
      tags.add("develop");
      priority += 10 * weights.development * (1 - analysis.records[from].activity);
    }
    if (type === "p" && weights.pawnAdvance > 0.8) {
      tags.add("advance pawn");
      priority += 12 * weights.pawnAdvance * (1 + analysis.records[from].advancement);
    }
    if (type === "k" && weights.kingActivity > 0.55) {
      tags.add("activate king");
      priority += 10 * weights.kingActivity;
    }
    priority += 14 * weights.centerControl * CENTER_WEIGHT[to];
    return { entry, tags, priority };
  }).sort((a, b) => b.priority - a.priority);

  const chosen = new Set(ranked.slice(0, Math.ceil(limit / 2)));
  for (const tag of ["capture or promotion", "rescue", "check", "castle", "develop", "advance pawn", "activate king"]) {
    if (chosen.size >= limit) break;
    if ([...chosen].some(candidate => candidate.tags.has(tag))) continue;
    const option = ranked.find(candidate => candidate.tags.has(tag));
    if (option) chosen.add(option);
  }
  for (const candidate of ranked) {
    if (chosen.size >= limit) break;
    chosen.add(candidate);
  }
  return [...chosen].map(candidate => candidate.entry);
}

function pieceScore(position, analysis, side, weights) {
  const { board } = position;
  let score = 0;
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (!piece) continue;
    const data = analysis.records[square];
    const type = TYPE[piece];
    let contribution;
    if (type === "k") {
      contribution = 70 * weights.kingShelter * data.shelter + 45 * weights.kingActivity * data.activity;
    } else {
      contribution = Math.min(VALUES[type], 330) * 0.22 * weights.development * data.activity +
        45 * weights.pawnAdvance * data.advancement;
      if (data.attackers.size) contribution += 0.04 * VALUES[type] * data.defense - 0.07 * data.risk;
    }
    score += colorOf(piece) === side ? contribution : -contribution;
  }
  return score;
}

// A reply list and its analysis depend only on the position and the weights.
// Reruns with a filtered move list (the temperature option) reuse them.
const replyCache = new WeakMap();
function repliesFor(after, weights) {
  let cached = replyCache.get(after);
  if (!cached) replyCache.set(after, cached = { replies: legalMoveList(after), analyses: new Map() });
  const key = Object.values(weights).join(",");
  let analysis = cached.analyses.get(key);
  if (!analysis && cached.replies.length) {
    analysis = analyze(after, cached.replies, weights);
    cached.analyses.set(key, analysis);
  }
  return { replies: cached.replies, next: analysis };
}

export function chooseMove(position, { candidates = DEFAULT_CANDIDATES } = {}, moves = legalMoveList(position)) {
  if (!moves.length) return null;
  const mate = mateInOne(position, moves);
  if (mate) return { ...mate, detail: "Immediate checkmate." };

  const side = position.turn;
  const opponent = opposite(side);
  const before = analyze(position, moves);
  const { weights } = before.stage;
  const baseline = pieceScore(position, before, side, weights);
  const materialBalance = position.board.reduce((sum, piece) => !piece ? sum :
    sum + (colorOf(piece) === side ? 1 : -1) * VALUES[TYPE[piece]], 0);

  function evaluate(entry) {
    const { move, after } = entry;
    // Use the starting weights for both snapshots so a stage boundary alone
    // cannot make a move seem profitable.
    const { replies, next } = repliesFor(after, weights);
    if (!replies.length) {
      return { ...entry, replies, score: -materialBalance, detail: "Immediate stalemate." };
    }
    const material = materialGain(position, move);
    const danger = next.threat[opponent] * weights.tacticalCaution;
    const positional = pieceScore(after, next, side, weights) - baseline;
    const pressure = Math.min(100, 0.2 * Math.max(0, next.threat[side] - before.threat[side]));
    const check = kingInCheck(after.board, opponent) ? 8 : 0;
    const score = material - danger + positional + pressure + check;
    const detail = [
      `${before.stage.kind}, score ${Math.round(score)}`,
      `material gained ${material}`,
      `opponent capture risk ${Math.round(danger)}`,
      `piece activity and safety change ${Math.round(positional)}`,
      `new threats ${Math.round(pressure)}`,
    ].join(". ") + ".";
    return { ...entry, replies, score, detail };
  }

  const selected = shortlist(position, moves, before, candidates);
  const ranked = selected.map(evaluate).sort((a, b) => b.score - a.score);
  for (const entry of ranked) {
    if (!mateInOne(entry.after, entry.replies)) return entry;
  }
  // If every shortlisted move loses to mate in one, find any legal escape.
  const seen = new Set(selected);
  let escape = null;
  for (const entry of moves) {
    if (seen.has(entry) || mateInOne(entry.after)) continue;
    const scored = evaluate(entry);
    if (!escape || scored.score > escape.score) escape = scored;
  }
  return escape ?? { ...ranked[0], detail: "Every legal move allows mate in one. " + ranked[0].detail };
}

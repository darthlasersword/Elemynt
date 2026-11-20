#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { chooseMove, legalMoves, mateInOne, moveText, parseFen, status, toFen } from "./engine.js";

export * from "./engine.js";

const DEFAULT_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 10;
const HELP = `Run with bun engine_v2-beta.js.
  --bot white|black            Choose the bot's color (default black)
  --side white|black           Choose your color
  --temperature 0-${MAX_TEMPERATURE}           Move variety (default ${DEFAULT_TEMPERATURE})
  --pieces letters|icons       Choose how pieces are displayed
  --board, --no-board          Show or hide the board
  --thinking, --no-thinking    Show or hide the bot's scoring
  --explain                    Alias for --thinking
  --fen "FEN"                  Starting position (default standard setup)
  --candidates N               Moves to score in detail (default 14)
  --help                       Show these options and exit

Supply the bot color, temperature, and display options to skip setup.
bun engine_v2-beta.js --bot white --temperature 5 --pieces icons --board --thinking

Enter moves like e2e4, e1g1, or e7e8q.
The commands are moves, fen, undo, redo, resign, new, and quit.
Undo and redo restore a player turn and its bot reply.
Resign asks for confirmation. Use new after a game ends to play again with the same settings.`;

const FILES = [..."abcdefgh"];
const COLOR_NAMES = { w: "White", b: "Black" };
const SPACED_BOARD_WIDTH = 18;
const COMPACT_BOARD_WIDTH = 9;
const TEXT_PRESENTATION = "\uFE0E";
const PIECE_ICONS = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: `♟${TEXT_PRESENTATION}`,
};
const SMALL_NUMBERS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function pieceText(piece, icons) {
  if (!piece) return ".";
  return icons ? PIECE_ICONS[piece] : piece;
}

function displayWidth(line) {
  // Chess text glyphs occupy one cell. The black pawn's text selector adds no width.
  return line.replaceAll(TEXT_PRESENTATION, "").length;
}

function boardLines({ board }, icons, columns) {
  const spaced = columns >= SPACED_BOARD_WIDTH;
  const separator = spaced ? " " : "";
  const indent = spaced ? "  " : "";
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    const row = board.slice(rank * 8, rank * 8 + 8).map(piece => pieceText(piece, icons));
    rows.push(`${rank + 1}${indent}${row.join(separator)}`);
  }
  rows.push(` ${indent}${FILES.join(separator)}`);
  return rows;
}

function showBoard(position, display) {
  if (display.board) {
    console.log(boardLines(position, display.icons, process.stdout.columns || 80).join("\n"));
  }
}

function numberInWords(number) {
  if (number < 0) return `minus ${numberInWords(-number)}`;
  if (number < SMALL_NUMBERS.length) return SMALL_NUMBERS[number];
  if (number < 100) {
    const tens = TENS[Math.floor(number / 10) - 2];
    const ones = number % 10;
    return ones ? `${tens} ${SMALL_NUMBERS[ones]}` : tens;
  }
  const scale = number < 1000 ? 100 : 1000;
  const unit = scale === 100 ? "hundred" : "thousand";
  const leading = `${numberInWords(Math.floor(number / scale))} ${unit}`;
  const remainder = number % scale;
  return remainder ? `${leading} ${numberInWords(remainder)}` : leading;
}

function wrapWords(text, width) {
  const rows = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && displayWidth(next) > width) {
      rows.push(line);
      line = word;
    } else line = next;
  }
  rows.push(line);
  return rows;
}

function thinkingLines(bot, icons, width) {
  const detail = bot.detail.replace(/-?\d+/g, number => numberInWords(Number(number)));
  const sentences = detail.split(/(?<=\.) /).map(sentence => sentence[0].toUpperCase() + sentence.slice(1));
  const piece = pieceText(bot.piece, icons);
  const movingPiece = `Moving piece, ${COLOR_NAMES[bot.color]} ${piece}.`;
  return ["Bot thinking.", movingPiece, ...sentences].flatMap(line => wrapWords(line, width));
}

function showTurn({ position, bot }, display) {
  if (!bot) {
    showBoard(position, display);
    return;
  }
  const move = moveText(bot.move);
  if (!display.thinking) {
    console.log(move);
    showBoard(position, display);
    return;
  }

  const columns = process.stdout.columns || 80;
  const gap = 4;
  const minLeftWidth = 14;
  const right = ["Bot move.", move];
  const minRightWidth = Math.max(right[0].length, move.length, display.board ? COMPACT_BOARD_WIDTH : 0);
  const rightBudget = columns - minLeftWidth - gap;
  const split = rightBudget >= minRightWidth;
  if (display.board) right.push("", ...boardLines(position, display.icons, split ? rightBudget : columns));

  if (!split) {
    console.log([...thinkingLines(bot, display.icons, columns), "", ...right].join("\n"));
    return;
  }
  const leftWidth = Math.min(44, columns - gap - Math.max(...right.map(displayWidth)));
  const left = thinkingLines(bot, display.icons, leftWidth);
  const rows = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const line = left[index] ?? "";
    const output = right[index];
    if (!output) return line;
    return line + " ".repeat(leftWidth + gap - displayWidth(line)) + output;
  });
  console.log(rows.join("\n"));
}

async function askInput(lines, prompt, parse, fallback, hint) {
  while (true) {
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(`${prompt} `);
    else console.log(prompt);
    const line = await lines.next();
    if (line.done) return null;
    const answer = line.value.trim().toLowerCase();
    if (!answer) return fallback;
    const choice = parse(answer);
    if (choice !== undefined) return choice;
    console.log(hint);
  }
}

function askChoice(lines, prompt, choices, fallback, hint) {
  const parse = answer => Object.hasOwn(choices, answer) ? choices[answer] : undefined;
  return askInput(lines, prompt, parse, fallback, hint);
}

function askPieceStyle(lines) {
  console.log(`How should the pieces look?
  1. Letters  White K, Black k
  2. Icons    White ${PIECE_ICONS.K}, Black ${PIECE_ICONS.k}`);
  const choices = { 1: "letters", 2: "icons", letters: "letters", icons: "icons", l: "letters", i: "icons" };
  return askChoice(lines, "Choose 1 or 2 (Enter for letters) >", choices, "letters", "Type 1 for letters or 2 for icons.");
}

function askBotColor(lines) {
  console.log(`Which color should the bot play?
  1. Black (you play White)
  2. White (you play Black)`);
  const choices = { 1: "black", 2: "white", b: "black", w: "white", black: "black", white: "white" };
  return askChoice(lines, "Choose 1 or 2 (Enter for Black) >", choices, "black", "Type 1 for Black or 2 for White.");
}

function askYesNo(lines, question, fallback) {
  const options = fallback ? "[Y/n] (Enter for yes)" : "[y/N] (Enter for no)";
  const choices = { y: true, yes: true, n: false, no: false };
  return askChoice(lines, `${question} ${options} >`, choices, fallback, "Type y or n, then press Enter.");
}

function parseTemperature(input) {
  const temperature = Number(input);
  if (!input.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > MAX_TEMPERATURE) return undefined;
  return temperature;
}

function askTemperature(lines) {
  console.log("Zero uses the engine's usual move. Higher temperatures add variety.");
  const prompt = `Bot temperature (0 to ${MAX_TEMPERATURE}, Enter for ${DEFAULT_TEMPERATURE}) >`;
  return askInput(lines, prompt, parseTemperature, DEFAULT_TEMPERATURE, `Enter a number from 0 to ${MAX_TEMPERATURE}.`);
}

export function chooseBotMove(position, options) {
  const { temperature } = options;
  if (temperature === 0) return chooseMove(position, options);

  let moves = [...legalMoves(position)];
  let reply = chooseMove(position, options, moves);
  const rank = Math.floor(Math.random() * (1 + temperature / 2));
  if (!rank || !reply?.replies?.length || mateInOne(reply.after, reply.replies)) return reply;

  // Rerun the engine with earlier choices removed. At maximum temperature,
  // allow a score drop of up to sixty points, where a pawn is worth a hundred.
  const minimumScore = reply.score - 6 * temperature;
  for (let index = 0; index < rank; index++) {
    moves = moves.filter(({ move }) => move !== reply.move);
    const alternative = chooseMove(position, options, moves);
    if (!alternative?.replies?.length || alternative.score < minimumScore ||
      mateInOne(alternative.after, alternative.replies)) break;
    reply = alternative;
  }
  return reply;
}

function playBot(position, options) {
  const reply = chooseBotMove(position, options);
  if (!reply) return { position, bot: null };
  return {
    position: reply.after,
    bot: { move: reply.move, detail: reply.detail, piece: position.board[reply.move.from], color: position.turn },
  };
}

async function play() {
  const { values } = parseArgs({ args: process.argv.slice(2), allowNegative: true, options: {
    pieces: { type: "string" },
    board: { type: "boolean" },
    thinking: { type: "boolean" },
    bot: { type: "string" },
    side: { type: "string" },
    temperature: { type: "string" },
    fen: { type: "string" },
    candidates: { type: "string" },
    explain: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const style = values.pieces?.toLowerCase();
  if (style !== undefined && style !== "letters" && style !== "icons") {
    throw new Error("--pieces must be letters or icons.");
  }
  for (const option of ["bot", "side"]) {
    if (values[option] !== undefined && !["white", "black"].includes(values[option])) {
      throw new Error(`--${option} must be white or black.`);
    }
  }
  if (values.bot !== undefined && values.bot === values.side) {
    throw new Error("--bot and --side must choose different colors.");
  }
  const configuredTemperature = values.temperature === undefined ? undefined : parseTemperature(values.temperature);
  if (values.temperature !== undefined && configuredTemperature === undefined) {
    throw new Error(`--temperature must be a number from 0 to ${MAX_TEMPERATURE}.`);
  }
  const candidates = values.candidates === undefined ? undefined : Number(values.candidates);
  if (candidates !== undefined &&
    (!/^\d+$/.test(values.candidates) || !Number.isSafeInteger(candidates) || candidates < 1)) {
    throw new Error("--candidates must be a positive integer.");
  }
  const start = parseFen(values.fen);
  const configuredBot = values.bot ?? { white: "black", black: "white" }[values.side];
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  try {
    const botColor = configuredBot ?? (interactive ? await askBotColor(lines) : "black");
    if (botColor === null) return;
    const human = botColor === "black" ? "w" : "b";
    const playerName = COLOR_NAMES[human];
    const botName = COLOR_NAMES[botColor[0]];
    const pieces = style ?? await askPieceStyle(lines);
    if (pieces === null) return;
    const board = values.board ?? await askYesNo(lines, "Show the board during play?", true);
    if (board === null) return;
    const thinking = values.thinking ?? values.explain ?? await askYesNo(lines, "Show the bot's scoring beside its move?", false);
    if (thinking === null) return;
    const temperature = configuredTemperature ?? (interactive ? await askTemperature(lines) : DEFAULT_TEMPERATURE);
    if (temperature === null) return;
    const botOptions = { candidates, temperature };
    const display = { icons: pieces === "icons", board, thinking };
    if (interactive) {
      console.log(`You play ${playerName}. The bot plays ${botName}. ${COLOR_NAMES[start.turn]} to move.`);
      console.log("Enter a move like e2e4. Type moves to see legal moves.");
      console.log("Other commands are fen, undo, redo, resign, new, and quit.");
    }
    if (display.icons && display.board) {
      const key = `White ${PIECE_ICONS.P}, Black ${PIECE_ICONS.p}.`;
      console.log(wrapWords(key, process.stdout.columns || 80).join("\n"));
    }

    // Each snapshot is a point where the player can make a decision.
    const firstTurn = () => start.turn === human ? { position: start, bot: null } : playBot(start, botOptions);
    let turns = [firstTurn()];
    let turnIndex = 0;
    let resigned = false;
    showTurn(turns[0], display);

    while (true) {
      const { position } = turns[turnIndex];
      const moves = resigned ? [] : [...legalMoves(position)];
      const state = resigned ? "resigned" : status(position, moves);
      const finished = resigned || state === "checkmate" || state === "stalemate";
      if (resigned) {
        console.log(`${playerName} resigns. ${botName} wins.`);
        if (!interactive) console.log("Enter new to play again.");
      } else if (state === "checkmate") console.log(`Checkmate. ${position.turn === human ? botName : playerName} wins.`);
      else if (state === "stalemate") console.log("Stalemate. Draw.");
      else if (state === "check" && (display.board || display.thinking)) {
        console.log(`${COLOR_NAMES[position.turn]} is in check.`);
      }

      let prompt = `${playerName}, your move > `;
      if (resigned) prompt = "Enter new or quit > ";
      else if (finished) prompt = "Enter undo, new, or quit > ";
      while (true) {
        if (interactive) process.stdout.write(prompt);
        const line = await lines.next();
        if (line.done) return;
        const command = line.value.trim().toLowerCase();
        if (command === "quit") return;
        if (command === "fen") {
          console.log(toFen(position));
          continue;
        }
        if (command === "new") {
          if (!finished) {
            console.log("Enter resign to end this game first.");
            continue;
          }
          turns = [firstTurn()];
          turnIndex = 0;
          resigned = false;
          if (interactive) console.log(`New game. ${COLOR_NAMES[start.turn]} to move.`);
          showTurn(turns[0], display);
          break;
        }
        if (resigned) {
          if (command) console.log("Game over. Enter new or quit.");
          continue;
        }
        if (command === "resign" && !finished) {
          const confirmed = await askYesNo(lines, `Resign and give the win to ${botName}?`, false);
          if (confirmed === null) return;
          if (!confirmed) {
            console.log("Resignation canceled.");
            continue;
          }
          resigned = true;
          break;
        }
        if (command === "undo" || command === "redo") {
          const nextIndex = turnIndex + (command === "undo" ? -1 : 1);
          if (nextIndex < 0 || nextIndex >= turns.length) {
            console.log(`Nothing to ${command}.`);
            continue;
          }
          turnIndex = nextIndex;
          if (command === "undo") {
            console.log("Turn undone.");
            showBoard(turns[turnIndex].position, display);
          } else {
            console.log("Turn redone.");
            showTurn(turns[turnIndex], display);
          }
          break;
        }
        if (command === "moves") console.log(moves.map(({ move }) => moveText(move)).join(" ") || "No legal moves.");
        else if (command) {
          const choice = moves.find(({ move }) => moveText(move) === command);
          if (!choice) {
            console.log(finished ? "Game over. Enter undo, new, or quit." : "Illegal move. Enter moves to see your options.");
            continue;
          }
          const turn = playBot(choice.after, botOptions);
          turns.splice(turnIndex + 1, turns.length - turnIndex - 1, turn);
          turnIndex++;
          showTurn(turn, display);
          break;
        }
      }
    }
  } finally {
    input.close();
  }
}

if (import.meta.main) {
  try {
    await play();
  } catch (error) {
    console.error(error.message);
    console.error("Run bun engine_v2-beta.js --help for options.");
    process.exitCode = 1;
  }
}

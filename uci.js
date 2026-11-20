#!/usr/bin/env node
// Minimal UCI adapter for Elemynt, for use with fastchess, cutechess-cli,
// lichess-bot, or any UCI chess GUI.
import { createInterface } from "node:readline";
import { legalMoves, moveText, parseFen } from "./engine.js";
import { chooseBotMove, MAX_TEMPERATURE } from "./elemynt_engine.js";

let position = parseFen();
let temperature = 0;
let candidates = 14;

function applyPosition(tokens) {
  let i = 1;
  if (tokens[i] === "startpos") {
    position = parseFen();
    i++;
  } else if (tokens[i] === "fen") {
    const movesIdx = tokens.indexOf("moves", i + 1);
    const fen = tokens.slice(i + 1, movesIdx === -1 ? tokens.length : movesIdx).join(" ");
    position = parseFen(fen);
    i = movesIdx === -1 ? tokens.length : movesIdx;
  }
  if (tokens[i] === "moves") {
    for (let j = i + 1; j < tokens.length; j++) {
      const uci = tokens[j];
      const match = [...legalMoves(position)].find(({ move }) => moveText(move) === uci);
      if (!match) break;
      position = match.after;
    }
  }
}

function handleOption(line) {
  const match = /^setoption\s+name\s+(.+?)\s+value\s+(.+)$/i.exec(line);
  if (!match) return;
  const name = match[1].trim().toLowerCase();
  const value = Number(match[2].trim());
  if (name === "temperature" && Number.isFinite(value) && value >= 0 && value <= MAX_TEMPERATURE) {
    temperature = value;
  } else if (name === "candidates" && Number.isSafeInteger(value) && value >= 1) {
    candidates = value;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", raw => {
  const line = raw.trim();
  if (!line) return;
  const tokens = line.split(/\s+/);
  switch (tokens[0]) {
    case "uci":
      console.log("id name Elemynt");
      console.log("id author Elemynt");
      console.log(`option name Temperature type string default ${temperature}`);
      console.log(`option name Candidates type spin default ${candidates} min 1 max 99`);
      console.log("uciok");
      break;
    case "isready":
      console.log("readyok");
      break;
    case "ucinewgame":
      position = parseFen();
      break;
    case "setoption":
      handleOption(line);
      break;
    case "position":
      applyPosition(tokens);
      break;
    case "go": {
      const reply = chooseBotMove(position, { temperature, candidates });
      console.log(`bestmove ${reply ? moveText(reply.move) : "0000"}`);
      break;
    }
    case "quit":
      rl.close();
      break;
  }
});

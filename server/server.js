const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const WORDS = require("./words");

const PORT = process.env.PORT || 3001;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const CATEGORIES = Object.keys(WORDS);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In production we serve the built React app from the same server.
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
app.use(express.static(CLIENT_DIST));

// ---------------------------------------------------------------------------
// State: all rooms live in memory. Restarting the server clears every game.
// rooms[code] = {
//   code, hostPid, phase, category, spyCount, durationSec, endsAt,
//   word, spyPids:Set, votes:{voterPid->targetPid}, timer,
//   players: [{ pid, name, socketId|null, connected }]
// }
// `pid` is a persistent player id stored in the browser's localStorage. It
// survives a page refresh; socketId does not. Everything keys off pid.
// ---------------------------------------------------------------------------
const rooms = {};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — easy to read aloud
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms[code]);
  return code;
}

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const maxSpies = (n) => (n >= 6 ? 2 : 1);

// What every client is allowed to know. Note: never includes `word` or `spyPids`.
function publicRoom(room) {
  return {
    code: room.code,
    hostPid: room.hostPid,
    phase: room.phase,
    category: room.category,
    spyCount: room.spyCount,
    durationSec: room.durationSec,
    endsAt: room.endsAt,
    categories: CATEGORIES,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    votes: room.phase === "voting" ? room.votes : {},
    players: room.players.map((p) => ({
      pid: p.pid,
      name: p.name,
      connected: p.connected,
    })),
  };
}

const sync = (room) => io.to(room.code).emit("room:update", publicRoom(room));

// Re-send each player their own secret role. Used on start AND on reconnect.
function sendRole(room, player) {
  if (room.phase !== "playing" && room.phase !== "voting") return;
  if (!player.socketId) return;
  const isSpy = room.spyPids.has(player.pid);
  io.to(player.socketId).emit("game:role", {
    role: isSpy ? "spy" : "player",
    category: room.category,
    // The spy's browser NEVER receives the word. Hiding it in the UI would be
    // trivially defeated by opening DevTools.
    word: isSpy ? null : room.word,
  });
}

function endRound(room, reason) {
  // Idempotent: the 60s voting timer and the all-votes-in path can both call
  // this. Whichever lands first wins; the second call is a no-op.
  if (room.phase === "reveal") return;

  clearTimeout(room.timer);
  room.timer = null;
  room.phase = "reveal";
  room.endsAt = null;

  // Tally votes. Highest count wins; a tie means nobody is caught.
  const tally = {};
  for (const target of Object.values(room.votes)) {
    tally[target] = (tally[target] || 0) + 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const tie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  const accusedPid = ranked.length && !tie ? ranked[0][0] : null;

  const nameOf = (pid) => room.players.find((p) => p.pid === pid)?.name ?? "(left)";
  const spyNames = [...room.spyPids].map(nameOf);
  const caught = accusedPid ? room.spyPids.has(accusedPid) : false;

  io.to(room.code).emit("game:reveal", {
    word: room.word,
    spies: spyNames,
    accused: accusedPid ? nameOf(accusedPid) : null,
    caught,
    tie,
    reason, // "timeout" | "votes"
    tally: Object.entries(tally).map(([pid, n]) => ({ name: nameOf(pid), votes: n })),
  });
  sync(room);
}

io.on("connection", (socket) => {
  // ---- create ----
  socket.on("room:create", ({ name, pid }, cb) => {
    if (!pid) return cb?.({ ok: false, error: "Missing player id." });
    const code = makeCode();
    const room = {
      code,
      hostPid: pid,
      phase: "lobby",
      category: CATEGORIES[0],
      spyCount: 1,
      durationSec: 180,
      endsAt: null,
      word: null,
      spyPids: new Set(),
      votes: {},
      timer: null,
      players: [
        { pid, name: (name || "Host").slice(0, 16), socketId: socket.id, connected: true },
      ],
    };
    rooms[code] = room;
    socket.join(code);
    socket.data.pid = pid;
    socket.data.code = code;
    cb?.({ ok: true, room: publicRoom(room) });
  });

  // ---- join (also handles rejoin after refresh) ----
  socket.on("room:join", ({ code, name, pid }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (!pid) return cb?.({ ok: false, error: "Missing player id." });

    const existing = room.players.find((p) => p.pid === pid);

    if (existing) {
      // Reconnect: same person, new socket.
      existing.socketId = socket.id;
      existing.connected = true;
      if (name) existing.name = name.slice(0, 16);
    } else {
      if (room.phase !== "lobby") {
        return cb?.({ ok: false, error: "That game has already started." });
      }
      if (room.players.length >= MAX_PLAYERS) {
        return cb?.({ ok: false, error: `Room is full (${MAX_PLAYERS} max).` });
      }
      room.players.push({
        pid,
        name: (name || "Player").slice(0, 16),
        socketId: socket.id,
        connected: true,
      });
    }

    socket.join(code);
    socket.data.pid = pid;
    socket.data.code = code;

    cb?.({ ok: true, room: publicRoom(room) });
    // If they refreshed mid-round, hand back their secret role.
    sendRole(room, room.players.find((p) => p.pid === pid));
    sync(room);
  });

  // ---- host changes settings ----
  socket.on("room:settings", ({ category, spyCount, durationSec }) => {
    const room = rooms[socket.data.code];
    if (!room || room.hostPid !== socket.data.pid || room.phase !== "lobby") return;

    if (category && CATEGORIES.includes(category)) room.category = category;
    if ([120, 180, 300, 480].includes(durationSec)) room.durationSec = durationSec;
    if ([1, 2].includes(spyCount)) room.spyCount = spyCount;

    // Keep spy count legal if players left.
    room.spyCount = Math.min(room.spyCount, maxSpies(room.players.length));
    sync(room);
  });

  // ---- start ----
  socket.on("game:start", (_payload, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.hostPid !== socket.data.pid) return;
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Already started." });
    if (room.players.length < MIN_PLAYERS) {
      return cb?.({ ok: false, error: `Need at least ${MIN_PLAYERS} players.` });
    }
    if (room.spyCount >= room.players.length) {
      return cb?.({ ok: false, error: "Too many spies for this player count." });
    }

    const pool = WORDS[room.category];
    room.word = pool[Math.floor(Math.random() * pool.length)];
    room.spyPids = new Set(shuffle(room.players).slice(0, room.spyCount).map((p) => p.pid));
    room.votes = {};
    room.phase = "playing";
    room.endsAt = Date.now() + room.durationSec * 1000;

    for (const p of room.players) sendRole(room, p);
    sync(room);

    // When the discussion clock runs out, move to voting (60s to lock in).
    room.timer = setTimeout(() => {
      room.phase = "voting";
      room.endsAt = Date.now() + 60_000;
      sync(room);
      room.timer = setTimeout(() => endRound(room, "timeout"), 60_000);
    }, room.durationSec * 1000);

    cb?.({ ok: true });
  });

  // ---- host can cut discussion short ----
  socket.on("game:callVote", () => {
    const room = rooms[socket.data.code];
    if (!room || room.hostPid !== socket.data.pid || room.phase !== "playing") return;
    clearTimeout(room.timer);
    room.phase = "voting";
    room.endsAt = Date.now() + 60_000;
    sync(room);
    room.timer = setTimeout(() => endRound(room, "timeout"), 60_000);
  });

  // ---- voting ----
  socket.on("game:vote", ({ targetPid }) => {
    const room = rooms[socket.data.code];
    if (!room || room.phase !== "voting") return;
    const voter = room.players.find((p) => p.pid === socket.data.pid);
    if (!voter) return;
    if (!room.players.some((p) => p.pid === targetPid)) return;
    if (targetPid === voter.pid) return; // no self-votes

    room.votes[voter.pid] = targetPid;
    sync(room);

    // Everyone still connected has voted — end early. The length check matters:
    // [].every() is true, so an empty room would otherwise end instantly.
    const active = room.players.filter((p) => p.connected);
    if (active.length > 0 && active.every((p) => room.votes[p.pid])) {
      endRound(room, "votes");
    }
  });

  // ---- back to lobby ----
  socket.on("game:reset", () => {
    const room = rooms[socket.data.code];
    if (!room || room.hostPid !== socket.data.pid) return;
    clearTimeout(room.timer);
    Object.assign(room, {
      phase: "lobby",
      word: null,
      spyPids: new Set(),
      votes: {},
      endsAt: null,
      timer: null,
    });
    room.spyCount = Math.min(room.spyCount, maxSpies(room.players.length));
    io.to(room.code).emit("game:cleared");
    sync(room);
  });

  // ---- disconnect ----
  socket.on("disconnect", () => {
    const room = rooms[socket.data.code];
    if (!room) return;
    const player = room.players.find((p) => p.pid === socket.data.pid);
    if (!player) return;

    player.connected = false;
    player.socketId = null;

    if (room.phase === "lobby") {
      // In the lobby, leaving means leaving. Mid-round we keep the seat warm
      // so a refresh doesn't wipe someone out of the game.
      room.players = room.players.filter((p) => p.pid !== player.pid);
    }

    if (room.players.length === 0) {
      clearTimeout(room.timer);
      delete rooms[room.code];
      return;
    }

    // Promote a new host if the old one vanished.
    if (room.hostPid === player.pid) {
      const heir = room.players.find((p) => p.connected) || room.players[0];
      room.hostPid = heir.pid;
    }
    room.spyCount = Math.min(room.spyCount, maxSpies(room.players.length));
    sync(room);
  });
});

// SPA fallback so /?code=ABC123 and any refresh serve index.html.
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"), (err) => {
    if (err) res.status(200).send("Server running. Build the client with: npm run build");
  });
});

server.listen(PORT, () => console.log(`Spy game server on http://localhost:${PORT}`));

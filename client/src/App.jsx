import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// Same origin. In dev, Vite proxies /socket.io to :3001 (see vite.config.js).
// reconnectionAttempts defaults to 5 — far too few. A phone that sleeps for ten
// minutes must still find its way back into the lobby, so we retry forever.
const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

// A persistent id that survives page refreshes. This is what lets someone
// reload mid-round and get their word back instead of being kicked out.
function getPid() {
  let pid = localStorage.getItem("spy_pid");
  if (!pid) {
    pid = crypto.randomUUID();
    localStorage.setItem("spy_pid", pid);
  }
  return pid;
}
const PID = getPid();

const mmss = (s) =>
  `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const titled = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// --- sound ---------------------------------------------------------------
// Synthesised with WebAudio so there are no audio files to host or preload.
// Browsers block audio until the user interacts with the page; by the time a
// countdown runs, everyone has clicked something, so the context will unlock.
let audioCtx = null;
function beep(freq = 660, ms = 120, volume = 0.25) {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;

    // Ramp the gain instead of starting/stopping abruptly — a hard cut
    // produces an audible click.
    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    // Audio is a nicety. If it fails, the game still works silently.
  }
}

export default function App() {
  const [room, setRoom] = useState(null);
  const [me, setMe] = useState(null);       // { role, word, category }
  const [reveal, setReveal] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(() => localStorage.getItem("spy_name") || "");
  const [code, setCode] = useState(
    () => new URLSearchParams(location.search).get("code")?.toUpperCase() || ""
  );
  const [now, setNow] = useState(Date.now());
  const [revealed, setRevealed] = useState(false); // tap-to-see-your-word gate
  const [copied, setCopied] = useState(false);

  const roomRef = useRef(null);
  roomRef.current = room;

  useEffect(() => {
    socket.on("room:update", setRoom);
    socket.on("game:role", (r) => {
      setMe(r);
      setRevealed(false);
    });
    socket.on("game:reveal", setReveal);
    socket.on("game:cleared", () => {
      setMe(null);
      setReveal(null);
      setRevealed(false);
    });
    socket.on("game:startCancelled", () => {
      setError("The host cancelled the start.");
      setTimeout(() => setError(""), 3000);
    });

    // On reconnect (server restart, wifi blip, refresh), silently rejoin.
    socket.on("connect", () => {
      const r = roomRef.current;
      if (!r) return;
      socket.emit("room:join", { code: r.code, name, pid: PID }, (res) => {
        if (!res?.ok) {
          // The room really is gone — almost always because the server
          // restarted. Say so plainly instead of leaving a dead lobby on screen.
          setRoom(null);
          setMe(null);
          setReveal(null);
          setError("That lobby ended (the server restarted). Make a new one.");
        }
      });
    });

    // A locked phone kills the websocket without the page ever knowing. When the
    // tab comes back to the foreground, nudge it to reconnect immediately rather
    // than waiting for a heartbeat to time out.
    const onWake = () => {
      if (document.visibilityState === "visible" && !socket.connected) {
        socket.connect();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    return () => {
      socket.off("room:update");
      socket.off("game:role");
      socket.off("game:reveal");
      socket.off("game:cleared");
      socket.off("game:startCancelled");
      socket.off("connect");
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [name]);

  // One ticker drives every countdown. The server sends an absolute `endsAt`
  // timestamp and clients count down locally — smooth, and no per-second traffic.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const secondsLeft = room?.endsAt ? Math.ceil((room.endsAt - now) / 1000) : 0;
  const isHost = room && room.hostPid === PID;

  // Beeps. The ticker fires 4x/sec, so we track the last second we sounded on
  // and only beep when the integer actually changes — otherwise every tone
  // would play four times.
  const lastBeep = useRef(null);
  useEffect(() => {
    const phase = room?.phase;
    if (phase !== "countdown" && phase !== "playing") {
      lastBeep.current = null;
      return;
    }

    const key = `${phase}:${secondsLeft}`;
    if (lastBeep.current === key) return;
    lastBeep.current = key;

    if (phase === "countdown") {
      if (secondsLeft > 0 && secondsLeft <= 5) beep(660, 120);   // tick
      if (secondsLeft === 0) beep(990, 300, 0.3);                // GO
    } else if (phase === "playing") {
      // Final ten seconds: one blip a second, then a low tone at zero.
      if (secondsLeft > 0 && secondsLeft <= 10) beep(880, 90, 0.2);
      if (secondsLeft === 0) beep(300, 500, 0.3);
    }
  }, [room?.phase, secondsLeft]);

  const saveName = (v) => {
    setName(v);
    localStorage.setItem("spy_name", v);
  };

  // Browsers only allow audio to start from a user gesture. Non-hosts never
  // click anything once the countdown begins, so we unlock the context on the
  // create/join tap — the one press every player is guaranteed to make.
  const unlockAudio = () => beep(0, 1, 0);

  const create = () => {
    if (!name.trim()) return setError("Enter a name first.");
    setError("");
    unlockAudio();
    socket.emit("room:create", { name: name.trim(), pid: PID }, (res) => {
      if (res.ok) setRoom(res.room);
      else setError(res.error);
    });
  };

  const join = () => {
    if (!name.trim()) return setError("Enter a name first.");
    if (!code.trim()) return setError("Enter a room code.");
    setError("");
    unlockAudio();
    socket.emit(
      "room:join",
      { code: code.trim(), name: name.trim(), pid: PID },
      (res) => {
        if (res.ok) setRoom(res.room);
        else setError(res.error);
      }
    );
  };

  const settings = (patch) => socket.emit("room:settings", patch);

  const start = () =>
    socket.emit("game:start", null, (res) => {
      if (!res?.ok) setError(res?.error || "Could not start.");
    });

  const shareUrl = room ? `${location.origin}/?code=${room.code}` : "";
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed — select the link manually.");
    }
  };

  // ------------------------------------------------------------------ HOME
  if (!room) {
    return (
      <div className="wrap">
        <div className="card">
          <h1 className="logo">SPY</h1>
          <p className="sub">Everyone gets the word. Except one of you.</p>

          <label>Your name</label>
          <input
            value={name}
            maxLength={16}
            placeholder="e.g. Sam"
            onChange={(e) => saveName(e.target.value)}
          />

          <button className="primary" onClick={create}>
            Create a lobby
          </button>

          <div className="or"><span>or</span></div>

          <label>Room code</label>
          <input
            value={code}
            maxLength={6}
            placeholder="ABC123"
            className="codeinput"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && join()}
          />
          <button onClick={join}>Join lobby</button>

          {error && <p className="err">{error}</p>}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- REVEAL
  if (reveal) {
    return (
      <div className="wrap">
        <div className="card center">
          <p className="sub">The word was</p>
          <h1 className="word">{reveal.word}</h1>

          <div className="verdict">
            {reveal.tie ? (
              <p>The vote was tied — nobody was caught.</p>
            ) : !reveal.accused ? (
              <p>Nobody voted. The spy walks free.</p>
            ) : reveal.caught ? (
              <p className="good">
                <b>{reveal.accused}</b> was voted out — and was a spy. Caught!
              </p>
            ) : (
              <p className="bad">
                <b>{reveal.accused}</b> was voted out — and was innocent. The spy wins.
              </p>
            )}
          </div>

          <p className="sub">
            {reveal.spies.length > 1 ? "The spies were" : "The spy was"}{" "}
            <b>{reveal.spies.join(" & ")}</b>
          </p>

          {reveal.tally.length > 0 && (
            <ul className="tally">
              {reveal.tally.map((t) => (
                <li key={t.name}>
                  <span>{t.name}</span>
                  <span className="dots" />
                  <span>{t.votes}</span>
                </li>
              ))}
            </ul>
          )}

          {isHost ? (
            <button className="primary" onClick={() => socket.emit("game:reset")}>
              Back to lobby
            </button>
          ) : (
            <p className="muted">Waiting for the host to start a new round…</p>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- VOTING
  if (room.phase === "voting") {
    const myVote = room.votes[PID];
    const voteCount = (pid) =>
      Object.values(room.votes).filter((t) => t === pid).length;

    return (
      <div className="wrap">
        <div className="card">
          <div className="clock small">{mmss(secondsLeft)}</div>
          <h2 className="center">Who is the spy?</h2>
          <p className="sub center">Tap a name. You can change your mind.</p>

          <div className="votelist">
            {room.players
              .filter((p) => p.pid !== PID)
              .map((p) => (
                <button
                  key={p.pid}
                  className={`voterow ${myVote === p.pid ? "chosen" : ""}`}
                  onClick={() => socket.emit("game:vote", { targetPid: p.pid })}
                >
                  <span>{p.name}</span>
                  {voteCount(p.pid) > 0 && (
                    <span className="badge">{voteCount(p.pid)}</span>
                  )}
                </button>
              ))}
          </div>

          <p className="muted center">
            {Object.keys(room.votes).length} of {room.players.length} voted
          </p>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------- COUNTDOWN
  if (room.phase === "countdown") {
    // secondsLeft is derived from the server's endsAt, so every device shows
    // the same number — nobody's countdown is ahead of anyone else's.
    const n = Math.max(0, Math.min(5, secondsLeft));
    return (
      <div className="wrap">
        <div className="card center">
          <p className="sub">Game starting</p>
          <div key={n} className="countdown">{n === 0 ? "GO" : n}</div>

          {isHost ? (
            <button
              className="ghost cancel"
              onClick={() => socket.emit("game:cancelStart")}
            >
              Cancel
            </button>
          ) : (
            <p className="muted">Get ready…</p>
          )}
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------- PLAYING
  if (room.phase === "playing" && me) {
    const urgent = secondsLeft <= 10 && secondsLeft > 0;
    return (
      <div className="wrap">
        <div className="card center">
          <div className={`clock ${urgent ? "urgent" : ""}`}>{mmss(secondsLeft)}</div>
          <p className="sub">Category · {titled(me.category)}</p>

          {!revealed ? (
            <button className="cover" onClick={() => setRevealed(true)}>
              <span className="eye">👁</span>
              <span>Tap to see your card</span>
              <small>Make sure nobody is looking</small>
            </button>
          ) : me.role === "spy" ? (
            <div className="spycard">
              <h1>YOU ARE THE SPY</h1>
              <p>
                You don't know the word. Ask questions, blend in, and figure out
                what everyone else is talking about — before they catch you.
              </p>
            </div>
          ) : (
            <div className="wordcard">
              <h1 className="word">{me.word}</h1>
              <p>
                Everyone but the spy sees this. Describe it — but not so clearly
                that the spy can guess it.
              </p>
            </div>
          )}

          {isHost && (
            <button className="ghost" onClick={() => socket.emit("game:callVote")}>
              Call the vote now
            </button>
          )}
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------------- LOBBY
  const canStart = room.players.length >= room.minPlayers;

  // Mirror the server's maxSpies ladder: 1 spy up to 5 players, 2 at 6, 3 at 7+.
  const maxSpiesFor = (n) => (n >= 7 ? 3 : n >= 6 ? 2 : 1);
  const allowedSpies = maxSpiesFor(room.players.length);
  const spyOptions = Array.from({ length: allowedSpies }, (_, i) => i + 1);
  const nextSpyUnlock = allowedSpies < 3
    ? (allowedSpies === 1 ? 6 : 7)
    : null;

  return (
    <div className="wrap">
      <div className="card">
        <p className="sub center">Room code</p>
        <div className="code center">{room.code}</div>

        <button className="ghost" onClick={copyLink}>
          {copied ? "Link copied ✓" : "Copy invite link"}
        </button>

        <label>
          Players {room.players.length}/{room.maxPlayers}
        </label>
        <ul className="players">
          {room.players.map((p) => (
            <li key={p.pid} className={p.connected ? "" : "gone"}>
              <span>
                {p.name}
                {p.pid === PID && <em> (you)</em>}
              </span>
              {p.pid === room.hostPid && <span className="crown">HOST</span>}
            </li>
          ))}
        </ul>

        {isHost ? (
          <>
            <label>Category</label>
            <select
              value={room.category}
              onChange={(e) => settings({ category: e.target.value })}
            >
              {room.categories.map((c) => (
                <option key={c} value={c}>
                  {titled(c)}
                </option>
              ))}
            </select>

            <label>Discussion time</label>
            <select
              value={room.durationSec}
              onChange={(e) => settings({ durationSec: +e.target.value })}
            >
              <option value={120}>2 minutes</option>
              <option value={180}>3 minutes</option>
              <option value={300}>5 minutes</option>
              <option value={480}>8 minutes</option>
            </select>

            <label>Spies</label>
            <select
              value={room.spyCount}
              onChange={(e) => settings({ spyCount: +e.target.value })}
            >
              {spyOptions.map((n) => (
                <option key={n} value={n}>
                  {n} spy{n > 1 ? "s" : ""}
                </option>
              ))}
            </select>
            {nextSpyUnlock && (
              <p className="muted">
                {allowedSpies + 1} spies unlocks at {nextSpyUnlock} players.
              </p>
            )}

            <button className="primary" disabled={!canStart} onClick={start}>
              {canStart
                ? "Start game"
                : `Need ${room.minPlayers - room.players.length} more player${
                    room.minPlayers - room.players.length > 1 ? "s" : ""
                  }`}
            </button>
          </>
        ) : (
          <>
            <div className="readonly">
              <div>
                <span>Category</span>
                <b>{titled(room.category)}</b>
              </div>
              <div>
                <span>Time</span>
                <b>{room.durationSec / 60} min</b>
              </div>
              <div>
                <span>Spies</span>
                <b>{room.spyCount}</b>
              </div>
            </div>
            <p className="muted center">Waiting for the host to start…</p>
          </>
        )}

        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}

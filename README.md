# Spy Game

A 3–6 player online social deduction game. Everyone sees the same word — except
the spy, who sees nothing and has to blend in.

## Requirements

- **Node.js 18 or newer.** Check with `node -v`. If you don't have it, get it
  from https://nodejs.org (take the LTS version).

## Running it locally

You need **two terminals** open at the same time.

**Terminal 1 — the server:**
```bash
cd server
npm install
npm start
```
You should see `Spy game server on http://localhost:3001`. Leave it running.

**Terminal 2 — the client:**
```bash
cd client
npm install
npm run dev
```
You should see a `http://localhost:5173` link. Open it in your browser.

### Testing on your own

Open `http://localhost:5173` in three separate browser windows. Use one normal
window and two **incognito/private** windows — each one needs its own storage to
count as a different player. Create a lobby in the first, then join with the code
from the other two.

## Playing

1. One person creates a lobby and shares the 6-letter code (or the invite link).
2. Once 3–6 people have joined, the host picks a category, a discussion time,
   and how many spies (2 spies unlocks at 6 players).
3. Host hits Start. Everyone taps their card to see their word — except the spy,
   who is told they're the spy.
4. Talk. Ask each other questions about the word without saying it outright.
   The spy is trying to work out what the word is; everyone else is trying to
   work out who has no idea what they're talking about.
5. When the timer ends (or the host calls the vote early), everyone votes.
6. Reveal: was the spy caught?

## Deploying to your website

The server serves the built client, so you deploy **one** thing.

```bash
cd client
npm run build     # outputs client/dist/
cd ../server
npm start         # serves the app + websockets on one port
```

Push to any host that runs a persistent Node process — Railway, Render, Fly.io,
or a VPS. **Vercel and Netlify will not work for the server**: they're serverless
and can't hold open websocket connections.

Set the port via the `PORT` environment variable if your host requires it.

## Notes

- **Game state is in memory.** Restarting the server ends every game in progress.
  That's fine for a game with rounds this short — if you later need games to
  survive a restart, move `rooms` in `server/server.js` into Redis.
- **The spy's browser never receives the word.** Role assignment happens on the
  server and each player gets a different payload. Don't "fix" this by sending
  the word to everyone and hiding it in the UI — anyone can open DevTools.
- **Refreshing is safe.** Each browser stores a persistent player id, so a reload
  mid-round puts you back in with your word intact.
- **Adding words:** edit `server/words.js`. New categories appear in the dropdown
  automatically — no other changes needed.

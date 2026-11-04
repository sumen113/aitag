# Tag Rush

A free, real-time multiplayer game of tag that runs in the browser. Eight characters with one power each, five arenas,
up to 15 players per lobby. The Node server serves the website **and** the WebSocket game server, so it is one service to host.

- **Play online**: type your name, pick a fighter, press *Play online*. Everyone shares one public pool: lobbies hold
  up to **15 players**; when they are all full a new lobby opens automatically. No codes, no lobby browser.
- **Practice vs bots**: its own button on the home page (Easy / Normal / Hard). Bots only ever appear here, never in public lobbies.
- **Names are required** (2-14 letters, numbers, spaces, `. _ -`). No random names. Two players with the same name are put in different lobbies.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` sets everything up
   (or create a **Web Service** by hand: runtime Node, build `npm ci --omit=dev`, start `npm start`, health check path `/health`).
3. Open the `onrender.com` URL. That is it; WebSockets work on Render web services out of the box and the client
   connects to the same host (`wss://` automatically on https).

Notes
- **Free plan sleeps** after ~15 min without traffic and takes up to a minute to wake. The game shows a "waking the server" message
  while it connects. Use the Starter plan (or an uptime pinger on `/health`) for always-on.
- Game state lives in memory in one process, so run **one instance** (don't scale horizontally).
- A 512 MB instance comfortably handles many lobbies; a lobby of 15 is roughly 20 snapshots/s of ~1 KB each per player.
- `GET /api/stats` returns `{players, rooms, uptime}` (the home page uses it for the "playing now" badge).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # integration test: matchmaking, 15-cap rollover, name rules, garbage input, prediction vs server
npm run balance    # bot-vs-bot balance simulation (node tools/balance.js [rounds] [map|all] [perChar])
```

## How it works

- `public/shared.js` is loaded by both server and browser: movement, collision, abilities, maps. Because both run the same
  fixed 60 Hz step, the client predicts its own movement instantly and the server's authoritative state only nudges it.
- Server (`server.js`, `src/room.js`) simulates at 60 Hz, sends 20 Hz snapshots; other players are interpolated 100 ms in the past.
- Anti-abuse: per-socket rate limit, 4 KB message cap, server-side name validation, AFK players are un-ITed after 5 s and kicked after 20 s.
- The site layer (`public/site.js`) uses GSAP (ScrollTrigger, SplitText, Flip, all vendored in `public/vendor`) and self-hosted fonts,
  so there are no third-party requests at runtime.

## Characters

| Character | Power | Cooldown | Notes |
|---|---|---|---|
| Fox | Dash | 7 s | short, very fast burst |
| Frog | Leap | 13 s | untouchable in the air, jumps walls |
| Ghost | Phase | 11 s | walk through walls for 2 s |
| Cat | Cloak | 14 s | near-invisible, 8% faster for 3 s |
| Bear | Stomp | 12 s | knockback + stun in a radius; biggest body |
| Octopus | Goo Trap | 8 s | puddle that slows everyone but you |
| Owl | Decoy | 10 s | clone runs off; IT is stunned if they catch it |
| Robot | Shield | 10 s | blocks one tag and stuns the tagger; slower while up. As IT: speed surge |

Tuning lives in the `CHARS` table in `public/shared.js` (and the constants at the top of it).
`npm run balance` prints per-character results after any change.

## Layout

```
server.js          static files + WebSocket + matchmaking
src/room.js        a lobby: rounds, tagging, ability world effects, snapshots
src/bots.js        bot AI (grid pathfinding, chase/flee, ability use)
public/            website + game client (index.html, style.css, site.js, game.js, render.js, chars.js, audio.js, shared.js)
tools/             balance.js, fuzz.js
```

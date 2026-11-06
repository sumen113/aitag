# Tag Rush

A free, real-time multiplayer game of tag that runs in the browser. Eleven characters with one power each, five arenas,
up to 15 players per lobby, accounts, a wins-based shop and in-game chat. One Node server serves the website, the
account API **and** the WebSocket game server, so it is a single service to host (plus a free Postgres for accounts).

- **Play online**: pick a fighter, press *Play online*. Everyone shares one public pool; lobbies hold up to **15 players**
  and a new one opens when all are full. No codes, no lobby browser.
- **Practice vs bots**: its own button (Easy / Normal / Hard). Bots only appear here. You may try *any* character in practice.
- **Guests** type a name and play the three starter characters (Fox, Ghost, Bear). Wins are not saved.
- **Accounts** (username + password, no email) save your name, wins and owned characters. Your username is your in-game name
  and a ✓ is shown next to it in chat and on the scoreboard. A registered name cannot be used by guests.
- **Shop**: 1 win = 1 ★. Winning a round in an **online** lobby with **3+ humans** (as a logged-in, non-AFK player with a real score)
  earns a ★. Spend ★ on new characters. The shop is data-driven (`SHOP` in `public/shared.js`) so new item types can be added later.
- **Chat**: press **Enter** (or the chat button on phones). Messages show in a log and as speech bubbles for 5 s. Links are masked,
  bad words starred, 1 message per 0.6 s / 5 per 8 s. Click a name in the log to mute that player for the game.

## Deploy on Render (Singapore) with a free database

Accounts need a Postgres database because Render's disk is wiped on every deploy.

1. **Database**: create a free project at [neon.tech](https://neon.tech) (or Supabase). Copy the connection string,
   e.g. `postgres://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`. Pick the **Singapore** region for it
   so queries stay close to the game server. Tables are created automatically on first start.
2. Push this folder to a GitHub repo.
3. Render → **New → Blueprint** → pick the repo (`render.yaml` already selects the `singapore` region), or create a Web Service by hand
   (runtime Node, build `npm ci --omit=dev`, start `npm start`, health check `/health`).
4. In the service's **Environment** tab add `DATABASE_URL` = the string from step 1. Deploy.

Without `DATABASE_URL` the server falls back to a JSON file in `data/` (**development only**, it is lost on redeploy) and prints a warning.
If the database cannot be reached, the game still starts and guests can play; logins are disabled until it is back.

Notes
- **Free plan sleeps** after ~15 min idle and takes up to a minute to wake (the game shows a message). Starter plan = always on.
- Game state lives in memory in one process: run **one instance**.
- Bandwidth: each player receives ~30 snapshots/s. A full 15-player lobby is roughly **1.7 GB per hour**. Set `SNAP_HZ=20` to cut that by a third.
- `GET /health` and `/api/stats` return `{players, rooms, uptime, accounts}`.

Environment variables: `PORT` (set by Render), `DATABASE_URL`, `MIN_WIN_PLAYERS` (default 3), `SNAP_HZ` (default 30, range 10-60),
`PGSSL_STRICT=1` (verify the database certificate; off by default because several hosts use private CAs), `PGSSLMODE=disable` (local Postgres).

## Playing from far away (Adelaide to Singapore, ~100-130 ms)

The server is authoritative but hides latency in four ways:
- **Client prediction** (shared deterministic movement in `public/shared.js`): your own character reacts instantly.
- **Bigger hitboxes**: tag reach is `TAG_REACH = 10` px on top of both body radii (`public/shared.js`).
- **Lag compensation**: when IT touches someone, the server also checks where that player was up to `LAG_COMP_MAX` = 0.16 s ago
  (scaled by the tagger's measured ping), so a tag that looked good on the tagger's screen counts. Players who just used an escape ability are not rewound through it.
- **Adaptive interpolation**: other players are drawn ~70-190 ms in the past depending on measured network jitter; inputs are sent ~60 times/s with `TCP_NODELAY`.

The ping chip in the HUD is the real measured round trip. If you want more headroom, raise `TAG_REACH` or `LAG_COMP_MAX`.

## Run locally

```bash
npm install
npm start          # http://localhost:3000  (accounts use data/dev-db.json)
npm test           # database test (Postgres via pg-mem + file store) and a full integration test
npm run balance    # bot-vs-bot balance simulation (node tools/balance.js [rounds] [map|all] [perChar])
```
To use a real local Postgres: `DATABASE_URL=postgres://localhost/tagrush PGSSLMODE=disable npm start`.

## Security notes

Passwords are hashed with scrypt; sessions are random 256-bit tokens stored hashed (HttpOnly, SameSite=Lax, Secure on https cookie, 30 days).
Sign-up/login/buy are rate limited, POSTs must be same-origin JSON, the WebSocket checks `Origin`, a Content-Security-Policy is sent, and a purchase
is one database transaction (charge + grant) so wins can never be double-spent. There is no password reset (no email), so a forgotten password means a new account.

## Characters

| Character | Power | Cooldown | Unlock | Notes |
|---|---|---|---|---|
| Fox | Dash | 7 s | start | short, very fast burst |
| Ghost | Phase | 11 s | start | walk through walls for 2 s |
| Bear | Stomp | 12 s | start | knockback + stun in a radius; biggest body |
| Frog | Leap | 15 s | 3 ★ | untouchable in the air, jumps walls, lands with a slowing splash |
| Cat | Cloak | 14 s | 3 ★ | near invisible and faster; press again to **pounce** |
| Octopus | Goo Trap | 8 s | 4 ★ | puddle that slows everyone but you |
| Owl | Decoy | 9 s | 4 ★ | clone runs off; IT is stunned if they catch it |
| Robot | Shield | 10 s | 5 ★ | blocks one tag and stuns the tagger; slower while up. As IT: speed surge |
| Penguin | Belly Slide | 10 s | 5 ★ | slide fast and bowl players over (stun + shove) |
| Raccoon | Swap | 12 s | 6 ★ | trade places with the nearest player; they are dizzy for a moment |
| Bat | Echo Beacon | 10 s | 6 ★ | drop a beacon, press again within 4 s to snap back to it |

Tuning lives in the `CHARS` table in `public/shared.js`. To add a character: add an entry (set `starter: true` or a `price`),
a `DRAW` function + icon in `public/chars.js`, and its behaviour in `useAbility` / `stepPlayer` (and `botAbility` in `src/bots.js` if bots should use it).
To add a different shop item type: add it to `SHOP` and teach `shopCard()` in `public/site.js` how to display and apply it.

## Layout

```
server.js          static files + account API routing + WebSocket + matchmaking
src/room.js        a lobby: rounds, tagging + lag compensation, ability world effects, chat, snapshots
src/bots.js        bot AI (grid pathfinding, chase/flee, ability use)
src/db.js          accounts storage: Postgres or dev JSON file behind one API
src/auth.js        register / login / logout / shop-buy HTTP endpoints, scrypt, sessions, rate limits
public/            website + game client (index.html, style.css, site.js, game.js, render.js, chars.js, audio.js, shared.js)
tools/             balance.js, fuzz.js (integration), dbtest.js (database)
```

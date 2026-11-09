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

Environment variables: `PORT` (set by Render), `DATABASE_URL`, `ADMIN_USERS`, `ADMIN_PASSCODE`, `MIN_WIN_PLAYERS` (default 3), `SNAP_HZ` (default 30, range 10-60),
`PGSSL_STRICT=1` (verify the database certificate; off by default because several hosts use private CAs), `PGSSLMODE=disable` (local Postgres).

## Servers

Pressing **Play online** opens a server picker.

- **Regular server**: always listed, never goes away, standard 90 s games, up to 15 per lobby (extra lobbies open automatically). It is the only place that awards wins.
- **Custom servers**: anyone can create one with a name (3-22 chars), game length (**60-600 s, never under 60**), max players (2-15), an arena (or random), optional **bots** and an optional **password**. They show in the list live (🔒 = password) and vanish when the last player leaves.
- **Bots**: you choose how many (up to max-1) and their difficulty. They use player slots and step aside as humans join.
- **Passwords**: stored only as a salted scrypt hash in memory; wrong tries are limited to 8 per minute per IP.
- **Wins in custom servers**: they count, but only with **no bots** and at least `CUSTOM_MIN_WIN_PLAYERS` humans (default 3, never below `MIN_WIN_PLAYERS`), and the winner still needs a registered account, a score of 30+ and not be AFK. This keeps solo/2-account farming in private rooms from working.
- Limits: 40 custom servers at once, 3 creations per person/IP per 10 minutes, names unique and filtered. Limits live in `SERVER_LIMITS` (`public/shared.js`).
- Servers live in memory, so a Render restart or free-tier sleep clears them (Regular comes straight back).

## Admin panel (`/admin`)

For you and one other person. Two things decide who gets in, both set as environment variables on Render:

1. `ADMIN_USERS`: the two usernames, comma separated (e.g. `alice,bob`; not case sensitive). You can also list them in `ADMIN_USERNAMES` at the top of `src/admin.js`.
   **Register those two accounts on the site first, before you share the link**, so nobody else can claim the names.
2. `ADMIN_PASSCODE`: a long secret phrase you make up. You type it once into the panel (it is kept for that browser tab only).
   Without it the panel refuses to work, so a guessed or stolen admin password alone is not enough.

Then log in with an admin username and open `/admin` (an **Admin** link also appears in the menu and your account window).
What it does:
- **Live**: who is online (guest / account / ping / room), rooms and their state; **Kick**, **Mute** (chat) or **Ban** a player.
- **Accounts**: search players; give or take **wins**, give or remove a **character**, **reset a password** (the fix for "I forgot mine", since there is no email reset),
  ban or unban. Takes effect next time they join; a banned account is signed out immediately and cannot log in.
- **Broadcast & bans**: **announce** a message that pops up in every open game, set a **banner** on the home page ("Maintenance at 5pm"), see and undo bans and mutes.
- **Log**: the last 100 admin actions (also printed in the server log).
Admin messages in chat carry an **ADMIN** tag. Bans, mutes (accounts) and the banner are stored in the database; guest mutes last until the server restarts.
The rest of the safety is the same as the main site: same-origin JSON only, passcode attempts are rate limited, and admin accounts cannot be banned.

## Leaderboard, quick chat, news

- **Leaderboard**: top 10 accounts by lifetime wins (menu, footer or account window). Banned accounts are hidden. Cached for 20 s.
- **Chat**: a big **Chat** button (round on phones) with an unread badge, plus quick-chat phrases (`QUICK` in `public/game.js`) for one-tap replies.
- **What's new**: edit the `NEWS` list and bump `NEWS_VERSION` in `public/site.js` to show the update card again to everyone.

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
| Fox | Dash | 8 s | start | short, very fast burst |
| Ghost | Phase | 11 s | start | walk through walls for 2 s |
| Bear | Stomp | 12 s | start | knockback + stun in a radius; biggest body |
| Frog | Leap | 20 s | 1 ★ | untouchable in the air, jumps walls, lands with a slowing splash |
| Cat | Cloak | 14 s | 1 ★ | fully invisible to other players (you see a faint outline) and faster; press again to **pounce** |
| Octopus | Goo Trap | 7 s | 2 ★ | puddle that slows everyone but you |
| Owl | Decoy | 9 s | 2 ★ | clone runs off; IT is stunned if they catch it |
| Robot | Shield | 10 s | 2 ★ | blocks one tag and stuns the tagger; slower while up. As IT: speed surge |
| Penguin | Belly Slide | 10 s | 3 ★ | slide fast and bowl players over (stun + shove) |
| Raccoon | Swap | 12 s | 3 ★ | trade places with the nearest player; they are dizzy for a moment |
| Bat | Echo Beacon | 10 s | 3 ★ | drop a beacon, press again within 4 s to snap back to it |
| Starfish | Ricochet | 13 s | 3 ★ | steerable 1.5 s roll that bounces off walls |
| Bird | Gale | 12 s | 2 ★ | stun-free blast (270 px) that shoves everyone away, then a short glide boost |

### Customisation and animation

- **Colours:** `COLORS` (only ever append). Every character keeps its own colour (`ks`, one entry per character, saved in account settings). The colour row is always one row: default (original colour), presets 1-6 and a custom swatch (index `100 + tone*360 + hue`, see `colorFor` / `customK` in `public/shared.js`). Older saved colours outside that row fall back to default; the server only validates the range.
- **Hats:** `HATS` in `shared.js`, drawn in `drawHat` (`public/chars.js`) at each character's `HEAD` anchor. Free for everyone.
- **Walk styles:** the `GAIT` table in `chars.js` (step rate, hop height, squash, waddle, lean, crouch).
- **Poses:** `POSES` in `chars.js`, GSAP timelines on a small `{up, rot, sq}` object that `draw()` reads. Triggered by ability events and tags in `game.js`, and by clicking the character on the home page. Skipped when the OS asks for reduced motion.
- **Fitting:** `Chars.fit()` measures what a character really covers (wings, tails, hats), so portraits and the showcase never clip.

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
src/admin.js       admin API: moderation, wins/items, password reset, announcements, banner
public/            website + game client (index.html, style.css, site.js, game.js, render.js, chars.js, audio.js, shared.js), admin.html/admin.js/admin.css
tools/             balance.js, fuzz.js (integration), dbtest.js (database), admintest.js (admin API)
```

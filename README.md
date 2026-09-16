# 金曲猜歌王 現場版 (Song Guesser Live)

The live version of `pm_songguesser`, played Kahoot-style: one computer hosts
and plays the music through the speakers, and the audience scans a QR code and
answers on their phones. It's built for about 200 people in one room.

The song bank, the nine-option grid, the decoy rules and the scoring
(300 + up to 700 for speed) are all the same as the solo game. One difference:
every game is guaranteed at least one Korean, Japanese, Taiwanese and English
song (so the minimum is 4 questions; at 20+ questions it's two of each). The
rule lives at the top of `lib/questions.js`.

## Running it

```
npm install          # first time only
npm start
```

The terminal prints:

```
主持人畫面   http://localhost:3000/host?key=a1b2c3
玩家加入     http://192.168.0.107:3000/
```

Open the host URL on the computer connected to the projector and speakers. The
key changes every time the server starts; to keep a fixed one, set
`HOST_KEY=xxx npm start`.

## How the game runs

1. **Lobby**: the big screen shows the QR code and names appear as people
   join. You can set the question count and seconds per question here.
   "音樂 10/10 首已就緒" means every clip has been downloaded. Clicking a name
   twice removes that player (for nicknames that shouldn't be on a big
   screen).
2. **Start**: each question gets a 3-second countdown, then the music plays.
   The big screen shows the nine options and how many people have answered.
   Phones show the same nine options, and faster answers score more.
3. **Time's up, or everyone has answered**: the answer is revealed, with the
   number of people who picked each option. Each phone shows its points for
   the question, total score, current rank, and the gap to the player ahead.
4. **Leaderboard**: the top 10, animated. It starts in the previous order,
   counts each score up, then slides rows to their new places; players pushed
   out of the top 10 slide off the bottom, and ▲▼ show places moved.
5. **After the last question**: the awards ceremony. Each click plays a
   drumroll, then reveals: 4th and 5th together, then 3rd, 2nd and 1st
   (1st gets confetti). The podium is laid out 4 · 2 · 1 · 3 · 5.
   Phones only show final ranks once 1st place is revealed, so nobody sees
   the result early.

Press Space, → or Enter for the next step. "再玩一局" (play again) keeps every
player and resets scores to zero.

## Deploy to Render (players use a fixed web address)

GitHub Pages only serves static files and can't run this server, so the game
itself runs on [Render](https://render.com)'s free plan. The repo includes a
`render.yaml`.

1. Sign in to Render with GitHub, then choose **New → Blueprint** and select
   this repo.
2. Once it deploys you get `https://ntupm-songguesser-live.onrender.com` (or
   similar).
3. Under **Environment** in the Render dashboard, look up `HOST_KEY`. The host
   screen is `https://<your-address>/host?key=<HOST_KEY>`.
4. Every push to `main` redeploys automatically.

Notes on the free plan:
- **It sleeps after 15 minutes with no traffic.** The first visit wakes it,
  which takes about a minute. **Open the host screen 5–10 minutes before the
  event**; while the host screen stays open the server stays awake.
- Game state lives in memory. A sleep, redeploy or restart clears the game
  (players have to rejoin), so **don't push new code during the event**.
- If it's unstable on the day, fall back to option B below (run it on your own
  computer + tunnel). The code is identical.

## Network (running on your own computer)

Phones must be able to reach this computer. There are two ways:

**A. Same Wi-Fi.** It's simplest, but campus and venue Wi-Fi often block
devices from reaching each other (client isolation). Also, 200 phones on
one access point is a gamble.

**B. A tunnel (recommended).** Players can use mobile data, and you don't
need to know how the venue network is set up:

```
# install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:3000
```

It gives you an `https://xxxx.trycloudflare.com` address. **Open the host
screen at that address** (`https://xxxx.trycloudflare.com/host?key=...`) and
the QR code will point to it automatically. You can also set
`PUBLIC_URL=https://xxxx.trycloudflare.com npm start` to pin the QR code to
that address.

Players only exchange small messages with the server, and audio plays only on
the host computer, so traffic is very low.

## Rehearsal

```
npm run loadtest                       # 200 bots join localhost:3000
node tools/loadtest.js 50 http://192.168.0.107:3000
```

The bots answer at random. Run the whole flow from the host screen to check
the leaderboard and awards.

## Design notes

- **The server keeps time and scores.** Phones only receive the nine titles
  and don't learn the correct answer until the reveal. Each phone reports how
  long it took to answer, and the server accepts that figure only within 1
  second of what it measured itself. That offsets slow mobile data without
  letting anyone fake a faster time.
- **Ties**: equal scores are ranked by the total time spent on correct
  answers (faster ranks higher), so the podium never has a tie. The phone's
  "gap to the player ahead" skips anyone on the same score and shows the
  nearest higher score instead.
- **Disconnects and locked screens**: the phone keeps its seat in
  localStorage. Refreshing, locking the screen or losing signal and
  reconnecting returns the player to the game with their score. Refreshing the
  host screen also restores its state.
- **Audio**: the host downloads every clip in full before the game (one at a
  time) and plays them with the Web Audio API, so nothing buffers on stage. A
  clip that can't be downloaded is automatically replaced with another song of
  the same genre.
- A browser won't play sound until the page has been clicked, which is why the
  host screen starts with a "進入主持人畫面" (enter host screen) button. If
  sound is blocked, it shows "點一下恢復聲音" (click to restore sound).
- There is one game per server. State lives in memory, so restarting the
  server clears it.

## Files

```
server.js            HTTP + WebSocket, game flow, scoring
lib/questions.js     question building (ported from the solo game's buildQuestions)
data/                songs.js / decoys.js / previews.js, copied from pm_songguesser
public/index.html    player (phone)
public/host.html     host (projector)
public/base.css      shared visual system
tools/loadtest.js    rehearsal bots
```

To update the song bank, edit it in `pm_songguesser` first, then copy the three
files into `data/`.

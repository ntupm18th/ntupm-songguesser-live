/* 金曲猜歌王 現場版 — live server.
 *
 * One process, one game. The host screen (/host) drives it and plays the
 * audio through the venue speakers; phones (/) only ever get the nine titles.
 * All timing and scoring happen here, so a phone cannot score itself.
 *
 * Phases:  lobby → countdown → question → reveal → board → … → podium → final
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Q = require('./lib/questions');

const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');

const RULES = {
  questionCount: 10,
  timeLimit: 12,          // seconds per question
  baseScore: 300,         // same scoring as the solo game: 300 + up to 700 for speed
  speedScore: 700,
  countdownMs: 3000,      // "第 N 題" card before the clip starts
  graceMs: 1000,          // late answers still in flight when the clock hits zero
  maxLatencyCredit: 1000  // how much of a phone's network delay we refund, at most
};

/* ═══════════ static files ═══════════ */

const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };

function lanAddress(){
  const found = [];
  for(const list of Object.values(os.networkInterfaces())){
    for(const a of list || []){
      if(a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push(a.address);
    }
  }
  // real home/venue ranges first; VPN adapters (e.g. 26.x) last
  const score = ip => /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return found.sort((a, b) => score(a) - score(b))[0] || 'localhost';
}

function joinUrlFor(req){
  if(PUBLIC_URL) return PUBLIC_URL + '/';
  // Opened through a tunnel or a real hostname: that is what phones should use too.
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const hostname = host.replace(/:\d+$/, '');
  if(hostname && !/^(localhost|127\.|\[::1\]|::1)/.test(hostname)){
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${host}/`;
  }
  return `http://${lanAddress()}:${PORT}/`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;

  if(p === '/join-info'){
    const joinUrl = joinUrlFor(req);
    const svg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#0B0C18', light: '#CFCAF0' } });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ url: joinUrl, svg }));
  }

  if(p === '/') p = '/index.html';
  if(p === '/host') p = '/host.html';
  const file = path.normalize(path.join(PUB, p));
  if(!file.startsWith(PUB)){ res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if(err){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': p.endsWith('.html') ? 'no-store' : 'public, max-age=3600'
    });
    res.end(buf);
  });
});

/* ═══════════ game state ═══════════ */

const G = {
  phase: 'lobby',
  questions: Q.buildQuestions(RULES.questionCount),
  index: -1,          // current question
  qStart: 0,          // server time the clip started
  timer: null,
  podiumStep: 0,      // 0 = nothing revealed, 1 = third, 2 = second, 3 = first
  lastBoard: []       // ranks before the latest question, for the ↑↓ arrows
};

const players = new Map();   // pid -> player
const kicked = new Set();
let host = null;             // the host socket

function newPlayer(name){
  return {
    pid: crypto.randomBytes(8).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    name, score: 0, time: 0, correct: 0,
    answers: {},     // qIndex -> { choice, ms, gained, correct }
    sockets: new Set(),
    joinedAt: Date.now()
  };
}

/* Ranking: score, then total time spent on correct answers (faster wins),
   then who joined first. Always a strict order, so the podium never ties. */
function ranking(){
  return [...players.values()].sort((a, b) =>
    b.score - a.score || a.time - b.time || a.joinedAt - b.joinedAt);
}

/* ═══════════ views ═══════════ */

function questionPublic(){
  const q = G.questions[G.index];
  return { qIndex: G.index, qTotal: G.questions.length, options: q.options };
}

function standing(p, order){
  const i = order.indexOf(p);
  const behind = order[i + 1] || null;
  /* "Who to chase" is the nearest player with a strictly higher score — the
     row directly above is often a tie (everyone on 0 after a hard question),
     and "0 points behind" says nothing. Ties only surface when you are tied
     with the very top. */
  let j = i - 1;
  while(j >= 0 && order[j].score === p.score) j--;
  const ahead = j >= 0 ? order[j] : (i > 0 ? order[i - 1] : null);
  return {
    score: p.score, rank: i + 1, total: order.length, correctCount: p.correct,
    ahead: ahead ? { name: ahead.name, gap: ahead.score - p.score, rank: order.indexOf(ahead) + 1 } : null,
    lead: !ahead && behind ? p.score - behind.score : null
  };
}

function playerView(p, order){
  const v = { t: 'state', phase: G.phase, name: p.name, pid: p.pid };
  if(G.phase === 'lobby') return Object.assign(v, { count: players.size });

  if(G.phase === 'countdown'){
    return Object.assign(v, { qIndex: G.index, qTotal: G.questions.length, remaining: G.qStart - Date.now() });
  }
  if(G.phase === 'question'){
    const a = p.answers[G.index];
    return Object.assign(v, questionPublic(), {
      timeLimit: RULES.timeLimit,
      remaining: Math.max(0, RULES.timeLimit * 1000 - (Date.now() - G.qStart)),
      choice: a ? a.choice : null
    });
  }
  if(G.phase === 'reveal' || G.phase === 'board'){
    const q = G.questions[G.index];
    const a = p.answers[G.index];
    return Object.assign(v, questionPublic(), {
      answer: q.answer, title: q.title, artist: q.artist,
      choice: a ? a.choice : null, correct: !!(a && a.correct), gained: a ? a.gained : 0,
      last: G.index === G.questions.length - 1
    }, standing(p, order));
  }
  if(G.phase === 'podium') return v;   // no spoilers until the host has revealed first place
  if(G.phase === 'final') return Object.assign(v, { qTotal: G.questions.length }, standing(p, order));
  return v;
}

function boardRows(order, n){
  // before the first question the order is just join order: no arrows yet
  const prev = new Map(G.index > 0 ? G.lastBoard.map((pid, i) => [pid, i + 1]) : []);
  return order.slice(0, n).map((p, i) => ({
    pid: p.pid, name: p.name, score: p.score, rank: i + 1,
    prevRank: prev.get(p.pid) || null,
    gained: G.index >= 0 && p.answers[G.index] ? p.answers[G.index].gained : 0
  }));
}

function hostView(){
  const order = ranking();
  const v = {
    t: 'state', phase: G.phase, rules: RULES,
    questions: G.questions, index: G.index,
    playerCount: players.size,
    online: [...players.values()].filter(p => p.sockets.size).length
  };
  if(G.phase === 'lobby'){
    v.players = [...players.values()].sort((a, b) => b.joinedAt - a.joinedAt)
      .map(p => ({ pid: p.pid, name: p.name, online: p.sockets.size > 0 }));
  }
  if(G.phase === 'countdown') v.remaining = G.qStart - Date.now();
  if(G.phase === 'question'){
    v.remaining = Math.max(0, RULES.timeLimit * 1000 - (Date.now() - G.qStart));
    v.answered = [...players.values()].filter(p => p.answers[G.index]).length;
    v.elapsed = Date.now() - G.qStart;
  }
  if(G.phase === 'reveal' || G.phase === 'board'){
    const counts = Array(9).fill(0);
    let answered = 0, right = 0;
    for(const p of players.values()){
      const a = p.answers[G.index];
      if(!a) continue;
      answered++; counts[a.choice]++;
      if(a.correct) right++;
    }
    Object.assign(v, { counts, answered, right, board: boardRows(order, 10),
      last: G.index === G.questions.length - 1 });
  }
  if(G.phase === 'podium' || G.phase === 'final'){
    v.podiumStep = G.podiumStep;
    v.board = boardRows(order, 10);
  }
  return v;
}

/* ═══════════ broadcasting ═══════════ */

function send(ws, msg){
  if(ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function pushHost(){ if(host) send(host, hostView()); }

function pushPlayer(p, order){
  if(!p.sockets.size) return;
  const msg = JSON.stringify(playerView(p, order || ranking()));
  for(const ws of p.sockets) send(ws, msg);
}

function pushAll(){
  const order = ranking();
  for(const p of players.values()) pushPlayer(p, order);
  pushHost();
}

// Lobby joins arrive in bursts of dozens a second; one host update per 300ms is plenty.
let hostPending = null;
function pushHostSoon(){
  if(hostPending) return;
  hostPending = setTimeout(() => { hostPending = null; pushHost(); }, 300);
}

/* ═══════════ game flow ═══════════ */

function clearTimer(){ clearTimeout(G.timer); G.timer = null; }

function startCountdown(){
  clearTimer();
  G.index++;
  G.lastBoard = ranking().map(p => p.pid);
  G.phase = 'countdown';
  G.qStart = Date.now() + RULES.countdownMs;
  pushAll();
  G.timer = setTimeout(startQuestion, RULES.countdownMs);
}

function startQuestion(){
  clearTimer();
  G.phase = 'question';
  G.qStart = Date.now();
  pushAll();
  G.timer = setTimeout(endQuestion, RULES.timeLimit * 1000 + RULES.graceMs);
}

function endQuestion(){
  if(G.phase !== 'question') return;
  clearTimer();
  G.phase = 'reveal';
  pushAll();
}

function everyoneAnswered(){
  let online = 0;
  for(const p of players.values()){
    if(!p.sockets.size) continue;
    online++;
    if(!p.answers[G.index]) return false;
  }
  return online > 0;
}

function onAnswer(p, msg){
  if(G.phase !== 'question' || msg.q !== G.index || p.answers[G.index]) return;
  const choice = msg.choice | 0;
  if(choice < 0 || choice > 8) return;

  const limit = RULES.timeLimit * 1000;
  const serverMs = Date.now() - G.qStart;
  if(serverMs > limit + RULES.graceMs) return;

  /* The phone reports how long it took from when the options appeared on it.
     Trusted only within maxLatencyCredit of what the server saw — enough to
     refund a slow 4G link, not enough to fake a fast answer. */
  const clientMs = Number(msg.elapsed);
  let ms = Number.isFinite(clientMs)
    ? Math.min(serverMs, Math.max(serverMs - RULES.maxLatencyCredit, clientMs))
    : serverMs;
  ms = Math.max(0, ms);
  if(ms > limit) return;

  const q = G.questions[G.index];
  const correct = choice === q.answer;
  const gained = correct ? Math.round(RULES.baseScore + RULES.speedScore * (1 - ms / limit)) : 0;
  p.answers[G.index] = { choice, ms, gained, correct };
  if(correct){ p.score += gained; p.time += ms; p.correct++; }

  pushPlayer(p);
  pushHostSoon();
  if(everyoneAnswered()){
    // a beat so the last tap registers on screen before everything flips
    clearTimer();
    G.timer = setTimeout(endQuestion, 600);
  }
}

function hostNext(){
  switch(G.phase){
    case 'lobby':
      if(!players.size) return;
      G.index = -1;
      return startCountdown();
    case 'question': return endQuestion();           // host skips the rest of the clock
    case 'reveal':  G.phase = 'board'; return pushAll();
    case 'board':
      if(G.index < G.questions.length - 1) return startCountdown();
      G.phase = 'podium'; G.podiumStep = 0; return pushAll();
    case 'podium':
      G.podiumStep++;
      if(G.podiumStep >= Math.min(3, players.size)){ G.podiumStep = 3; G.phase = 'final'; }
      return pushAll();
  }
}

function resetGame(keepPlayers){
  clearTimer();
  G.phase = 'lobby';
  G.index = -1;
  G.podiumStep = 0;
  G.lastBoard = [];
  G.questions = Q.buildQuestions(RULES.questionCount);
  if(keepPlayers){
    for(const p of players.values()) Object.assign(p, { score: 0, time: 0, correct: 0, answers: {} });
  }else{
    for(const p of players.values()){
      for(const ws of p.sockets) send(ws, { t: 'reset' });
    }
    players.clear();
  }
  pushAll();
}

/* ═══════════ names ═══════════ */

const BANNED = ['幹','靠北','靠杯','白痴','白癡','智障','媽的','雞掰','機掰','三小','屁眼','懶叫','lp','fuck','shit','bitch','dick'];
function nameError(raw){
  const n = String(raw || '').trim();
  if([...n].length < 1) return '請輸入暱稱';
  if([...n].length > 8) return '暱稱最多 8 個字';
  const low = n.toLowerCase().replace(/\s+/g, '');
  if(BANNED.some(w => low.includes(w))) return '這個暱稱會出現在大螢幕上,換一個吧';
  for(const p of players.values()) if(p.name.toLowerCase() === n.toLowerCase()) return '這個暱稱有人用了,換一個吧';
  return null;
}

/* ═══════════ sockets ═══════════ */

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', raw => {
    let msg;
    try{ msg = JSON.parse(raw); }catch(e){ return; }
    if(!msg || typeof msg.t !== 'string') return;

    /* ---- host ---- */
    if(msg.t === 'host'){
      if(msg.key !== HOST_KEY) return send(ws, { t: 'denied' });
      if(host && host !== ws){ send(host, { t: 'replaced' }); host.close(); }
      host = ws; ws.isHost = true;
      return pushHost();
    }
    if(ws.isHost){
      if(ws !== host) return;
      switch(msg.t){
        case 'next': return hostNext();
        case 'rules':
          if(G.phase !== 'lobby') return;
          RULES.questionCount = Math.min(30, Math.max(3, msg.questionCount | 0));
          RULES.timeLimit = Math.min(30, Math.max(5, msg.timeLimit | 0));
          G.questions = Q.buildQuestions(RULES.questionCount);
          return pushHost();
        case 'reroll':          // host could not load this clip
          if(G.phase !== 'lobby' && msg.index <= G.index) return;
          if(!G.questions[msg.index] || G.questions[msg.index].id !== msg.id) return;
          G.questions[msg.index] = Q.replaceQuestion(G.questions, msg.index);
          return pushHost();
        case 'kick': {
          const p = players.get(msg.pid);
          if(!p) return;
          kicked.add(p.pid);
          for(const s of p.sockets) send(s, { t: 'kicked' });
          players.delete(p.pid);
          return pushAll();
        }
        case 'restart': return resetGame(true);
        case 'reset':   return resetGame(false);
      }
      return;
    }

    /* ---- players ---- */
    if(msg.t === 'resume'){
      const p = players.get(msg.pid);
      if(!p || p.token !== msg.token){
        return send(ws, { t: kicked.has(msg.pid) ? 'kicked' : 'unknown' });
      }
      ws.player = p; p.sockets.add(ws);
      pushPlayer(p);
      return pushHostSoon();
    }
    if(msg.t === 'join'){
      if(ws.player) return;
      const err = nameError(msg.name);
      if(err) return send(ws, { t: 'joinError', msg: err });
      const p = newPlayer(String(msg.name).trim());
      players.set(p.pid, p);
      ws.player = p; p.sockets.add(ws);
      send(ws, { t: 'joined', pid: p.pid, token: p.token });
      pushPlayer(p);
      return pushHostSoon();
    }
    if(msg.t === 'answer' && ws.player) return onAnswer(ws.player, msg);
    if(msg.t === 'ping') return send(ws, { t: 'pong' });
  });

  ws.on('close', () => {
    if(ws === host) host = null;
    if(ws.player){
      ws.player.sockets.delete(ws);
      pushHostSoon();
    }
  });
});

// Keeps tunnels and NATs from dropping idle phones, and reaps dead sockets.
setInterval(() => {
  for(const ws of wss.clients){
    if(!ws.alive){ ws.terminate(); continue; }
    ws.alive = false;
    try{ ws.ping(); }catch(e){}
  }
}, 15000);

server.listen(PORT, () => {
  const lan = `http://${lanAddress()}:${PORT}`;
  console.log('');
  console.log('  金曲猜歌王 現場版');
  console.log(`  題庫 ${Q.stats.askable} 首 · 干擾選項 ${Q.stats.decoys} 首`);
  console.log('');
  console.log(`  主持人畫面   http://localhost:${PORT}/host?key=${HOST_KEY}`);
  console.log(`  玩家加入     ${PUBLIC_URL || lan}/`);
  if(!PUBLIC_URL) console.log('  (用 tunnel 對外開放時,請設定 PUBLIC_URL 或直接從 tunnel 網址開主持人畫面)');
  console.log('');
});

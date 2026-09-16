/* Rehearsal bots: fills the lobby with fake players who answer at random.
 *
 *   node tools/loadtest.js                      200 bots on localhost:3000
 *   node tools/loadtest.js 50 http://192.168.0.107:3000
 *
 * Then drive the game from /host as usual. Each bot answers somewhere in the
 * first 70% of the clock with a random pick — phones never learn the answer
 * before the reveal, so neither do bots (about 1 in 9 is right). Ctrl+C to stop.
 */
const WebSocket = require('ws');

const N = +process.argv[2] || 200;
const BASE = (process.argv[3] || 'http://localhost:3000').replace(/^http/, 'ws');

let answered = 0, joined = 0, errors = 0;

function bot(i){
  const ws = new WebSocket(BASE);
  let lastQ = -1;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: `bot${String(i).padStart(3, '0')}` })));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if(m.t === 'joined') joined++;
    if(m.t === 'joinError'){ errors++; console.log(`bot${i}: ${m.msg}`); }
    if(m.t !== 'state' || m.phase !== 'question' || m.qIndex === lastQ || m.choice != null) return;
    lastQ = m.qIndex;
    const limit = m.timeLimit * 1000;
    const delay = 800 + Math.random() * limit * 0.7;
    const started = Date.now() - (limit - m.remaining);
    setTimeout(() => {
      const choice = Math.floor(Math.random() * 9);
      ws.send(JSON.stringify({ t: 'answer', q: m.qIndex, choice, elapsed: Date.now() - started }));
      answered++;
    }, delay);
  });
  ws.on('error', () => errors++);
}

for(let i = 0; i < N; i++) setTimeout(() => bot(i), i * 15);
setInterval(() => console.log(`joined ${joined}/${N} · answers sent ${answered} · errors ${errors}`), 5000);

/* Song bank + question building, server side.
 *
 * The data files in data/ are the same browser scripts the solo game ships
 * (they assign to window.*), so they are evaluated in a sandbox with a fake
 * window instead of being rewritten as modules — copy them over from
 * pm_songguesser whenever the bank changes.
 *
 * Questions are built here, not on the phones: players only ever receive the
 * nine titles, never which one is right, until the reveal.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadData(dir){
  const window = {};
  const ctx = vm.createContext({ window });
  for(const f of ['songs.js', 'decoys.js', 'previews.js']){
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return {
    songs: window.SONGS || [],
    decoys: window.DECOYS || [],
    previews: window.SONG_PREVIEWS || {}
  };
}

const DATA = loadData(path.join(__dirname, '..', 'data'));

// Only songs with a streamable preview can be asked: the host has no synth
// fallback, a placeholder melody on a 200-person PA is not a question.
const ASKABLE = DATA.songs.filter(s => DATA.previews[s.id] && DATA.previews[s.id].url);
const OPTION_POOL = DATA.songs.concat(DATA.decoys);

const OPTION_COUNT = 9;
const MAX_SAME_ARTIST = 2;
// same spread as speed mode in the solo game
const FLOOR = { mando: 5, classic: 1, tw: 1, 'kpop+west+jp': 1 };

const shuffle = arr => {
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// Same rules as cleanTitle in the solo game: decoys carry Apple's subtitles,
// and an unstripped subtitle gives the answer away.
function cleanTitle(t){
  const s = String(t || '')
    .replace(/\s*[（(【\[].*$/, '')
    .replace(/\s+[-–—]\s+.*$/, '')
    .trim();
  return s || String(t || '');
}
const titleKey = t => cleanTitle(t).toLowerCase();

// Floors scale with the question count, so a 20-question game still gets its
// spread instead of 5 Mandarin songs and 15 random ones.
function pickSongs(count, exclude){
  const picked = [];
  const avoid = new Set(exclude || []);
  const take = (list, n) => {
    if(n <= 0) return;
    picked.push(...shuffle(list.filter(s => !picked.includes(s) && !avoid.has(s.id))).slice(0, n));
  };
  const scale = count / 10;
  for(const [key, n] of Object.entries(FLOOR)){
    const want = key.split('+');
    take(ASKABLE.filter(s => want.includes(s.genre)), Math.max(1, Math.round(n * scale)));
  }
  take(ASKABLE, count - picked.length);
  return shuffle(picked.slice(0, count));
}

function buildOptions(answer){
  const options = [answer];
  const usedTitle = new Set([titleKey(answer.title)]);
  const byArtist = { [answer.artist]: 1 };
  const passes = [
    { list: OPTION_POOL.filter(o => o.genre === answer.genre), max: MAX_SAME_ARTIST },
    { list: OPTION_POOL, max: MAX_SAME_ARTIST },
    { list: OPTION_POOL, max: Infinity }
  ];
  for(const pass of passes){
    if(options.length >= OPTION_COUNT) break;
    for(const o of shuffle(pass.list)){
      if(options.length >= OPTION_COUNT) break;
      const key = titleKey(o.title);
      if(usedTitle.has(key)) continue;
      if((byArtist[o.artist] || 0) >= pass.max) continue;
      usedTitle.add(key);
      byArtist[o.artist] = (byArtist[o.artist] || 0) + 1;
      options.push(o);
    }
  }
  return shuffle(options);
}

function makeQuestion(song, avoidIndex){
  let grid = buildOptions(song);
  let idx = grid.indexOf(song);
  // never the same cell twice running
  if(idx === avoidIndex && grid.length > 1){
    const swap = (idx + 1 + Math.floor(Math.random() * (grid.length - 1))) % grid.length;
    [grid[idx], grid[swap]] = [grid[swap], grid[idx]];
    idx = swap;
  }
  const p = DATA.previews[song.id];
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    genre: song.genre,
    url: p.url,
    offset: p.offset || 0,
    options: grid.map(o => cleanTitle(o.title)),
    answer: idx
  };
}

function buildQuestions(count){
  let last = -1;
  return pickSongs(count).map(song => {
    const q = makeQuestion(song, last);
    last = q.answer;
    return q;
  });
}

// Swap one question for a fresh song, e.g. when its preview will not load.
function replaceQuestion(questions, index){
  const used = new Set(questions.map(q => q.id));
  const fresh = ASKABLE.filter(s => !used.has(s.id));
  // same genre if possible, so the round keeps its spread
  const sameGenre = fresh.filter(s => s.genre === questions[index].genre);
  const song = shuffle(sameGenre.length ? sameGenre : fresh)[0];
  if(!song) return questions[index];
  const prev = index > 0 ? questions[index - 1].answer : -1;
  return makeQuestion(song, prev);
}

module.exports = { buildQuestions, replaceQuestion, stats: { songs: DATA.songs.length, askable: ASKABLE.length, decoys: DATA.decoys.length } };

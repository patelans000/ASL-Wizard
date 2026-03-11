/* ============================================================
   ASL SPELL CASTER  ·  game.js
   ml5 HandPose + heuristic fingerspell classifier
   ============================================================

   ██████████████████████████████████████████████████████
   QUICK-START ASSET GUIDE
   ██████████████████████████████████████████████████████

   ① WIZARD SPRITES
      Put two PNG files next to index.html:
        wizard_idle.png   – default standing pose
        wizard_cast.png   – casting / raising wand pose
      Then set the two lines below:
        const WIZARD_IDLE_SRC = 'wizard_idle.png';
        const WIZARD_CAST_SRC = 'wizard_cast.png';
      Recommended size: ~90 × 120 px, transparent PNG.
      Leave as '' to keep the emoji placeholder.

   ② ENEMY SPRITE
      Put one file next to index.html, e.g.:
        enemy.png
      Then set:
        const ENEMY_IMG_SRC = 'enemy.png';
      For per-letter enemies, leave ENEMY_IMG_SRC = ''
      and fill the ENEMY_TYPES map below.

   ③ ASL REFERENCE IMAGES
      Name files  ref_A.png … ref_Z.png  and place them
      in the same folder. The game auto-loads them.

   ④ BACKGROUND
      See style.css → #sky-layer / #hills-layer / #ground-layer.
      Each has a one-line comment showing where to swap.

   ████████████████████████████████████████████████████
*/

'use strict';

/* ── ASSET CONFIG ─────────────────────────────────────── */
const WIZARD_IDLE_SRC = '';   // e.g. 'wizard_idle.png'
const WIZARD_CAST_SRC = '';   // e.g. 'wizard_cast.png'
const ENEMY_IMG_SRC   = '';   // e.g. 'enemy.png'

// Per-letter enemy images (only needed if you want different monsters per letter)
// Leave empty to use ENEMY_IMG_SRC for all enemies.
// Example:  { A: 'goblin.png', B: 'skeleton.png', C: 'slime.png' }
const ENEMY_TYPES = {};

// Placeholder emojis used when no sprite is set (rotates randomly per enemy)
const ENEMY_EMOJIS = ['👾','🐉','👹','🦇','🧟','🐺','🕷️','🐸'];

/* ── GAME TUNING ──────────────────────────────────────── */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const MAX_HP   = 5;
const DETECT_HOLD_MS = 700;   // ms hand must hold pose before firing
const CONFIDENCE_MIN = 0.75;  // ml5 hand confidence threshold

const WAVES = [
  { wave:1, pool:'ABCDE',                          count:3, speed:30, interval:5500, emoji:'🌱', sub:'Letters A – E' },
  { wave:2, pool:'ABCDEFGHIJ',                     count:4, speed:26, interval:4800, emoji:'⚡', sub:'Letters A – J' },
  { wave:3, pool:'ABCDEFGHIJKLMNOP',               count:5, speed:23, interval:4200, emoji:'🔥', sub:'Letters A – P' },
  { wave:4, pool:'ABCDEFGHIJKLMNOPQRSTUVWXYZ',     count:6, speed:20, interval:3800, emoji:'💀', sub:'Full alphabet!' },
  { wave:5, pool:'ABCDEFGHIJKLMNOPQRSTUVWXYZ',     count:8, speed:17, interval:3200, emoji:'🌪️', sub:'SPEED ROUND!' },
];

/* ── DOM REFS ─────────────────────────────────────────── */
const wizardZone   = document.getElementById('wizard-zone');
const wizardSprite = document.getElementById('wizard-sprite');
const enemyLane    = document.getElementById('enemy-lane');
const promptLetter = document.getElementById('prompt-letter');
const scoreValEl   = document.getElementById('score-val');
const waveNumEl    = document.getElementById('wave-num');
const heartsRow    = document.getElementById('hearts-row');
const comboBadge   = document.getElementById('combo-badge');
const comboNumEl   = document.getElementById('combo-num');
const feedbackEl   = document.getElementById('feedback');
const camCanvas    = document.getElementById('cam-canvas');
const camDetected  = document.getElementById('cam-detected');
const refGrid      = document.getElementById('ref-grid');
const screenStart  = document.getElementById('screen-start');
const screenOver   = document.getElementById('screen-gameover');
const screenWave   = document.getElementById('screen-wave');
const waveTitle    = document.getElementById('wave-title');
const waveSub      = document.getElementById('wave-sub');
const waveBannerEmoji = document.getElementById('wave-banner-emoji');
const goScore      = document.getElementById('go-score');
const btnStart     = document.getElementById('btn-start');
const btnRestart   = document.getElementById('btn-restart');
const refBtn       = document.getElementById('ref-btn');
const refSheet     = document.getElementById('ref-sheet');
const refClose     = document.getElementById('ref-close');

/* ── STATE ────────────────────────────────────────────── */
let G = {
  running: false, hp: MAX_HP, score: 0,
  combo: 0, waveIdx: 0, enemiesLeft: 0,
  enemies: [], spawnTimer: null, clearing: false,
};

/* ── ML5 ──────────────────────────────────────────────── */
let handpose = null, videoEl = null, camCtx = null;
let lastSeen = null, holdStart = null;

/* ── WIZARD INIT ─────────────────────────────────────── */
function initWizard() {
  if (!WIZARD_IDLE_SRC) return;
  wizardSprite.innerHTML = '';
  wizardSprite.classList.remove('ph-box');
  const img = document.createElement('img');
  img.src = WIZARD_IDLE_SRC; img.alt = 'wizard';
  wizardSprite.appendChild(img);
}
function setWizardPose(casting) {
  const img = wizardSprite.querySelector('img');
  if (!img) return;
  img.src = (casting && WIZARD_CAST_SRC) ? WIZARD_CAST_SRC : WIZARD_IDLE_SRC;
}

/* ── HEARTS HUD ──────────────────────────────────────── */
function buildHearts() {
  heartsRow.innerHTML = '';
  for (let i = 0; i < MAX_HP; i++) {
    const h = document.createElement('span');
    h.className = 'heart-icon';
    h.textContent = '❤️';
    h.dataset.idx = i;
    heartsRow.appendChild(h);
  }
}
function updateHearts() {
  document.querySelectorAll('.heart-icon').forEach((h, i) => {
    h.classList.toggle('lost', i >= G.hp);
  });
}

/* ── REF SHEET ───────────────────────────────────────── */
function buildRefSheet() {
  ALPHABET.forEach(l => {
    const cell = document.createElement('div');
    cell.className = 'ref-cell';
    const lbl = document.createElement('div');
    lbl.className = 'ref-cell-letter';
    lbl.textContent = l;
    cell.appendChild(lbl);
    const img = document.createElement('img');
    img.className = 'ref-cell-img';
    img.alt = `ASL ${l}`;
    img.onerror = () => {
      const ph = document.createElement('div');
      ph.className = 'ref-cell-ph';
      ph.textContent = `ref_${l}.png`;
      cell.replaceChild(ph, img);
    };
    img.src = `ref_${l}.png`;
    cell.appendChild(img);
    refGrid.appendChild(cell);
  });
}

/* ── CAMERA ──────────────────────────────────────────── */
async function initCamera() {
  videoEl = document.createElement('video');
  videoEl.setAttribute('playsinline',''); videoEl.muted = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      { video:{width:320,height:240,facingMode:'user'}, audio:false }
    );
    videoEl.srcObject = stream;
    await videoEl.play();
  } catch(e) { console.warn('Camera unavailable:', e); return; }

  camCanvas.width = 180; camCanvas.height = 135;
  camCtx = camCanvas.getContext('2d');
  (function draw() {
    if (!camCtx) return;
    camCtx.save();
    camCtx.scale(-1,1); camCtx.translate(-180,0);
    camCtx.drawImage(videoEl,0,0,180,135);
    camCtx.restore();
    requestAnimationFrame(draw);
  })();
  initHandpose();
}

function initHandpose() {
  handpose = ml5.handpose(videoEl, {flipHorizontal:true}, () => {
    console.log('ml5 HandPose ready ✅');
    handpose.on('predict', onPredict);
  });
}

function onPredict(results) {
  if (!results || !results.length) {
    lastSeen = null; holdStart = null;
    camDetected.textContent = '';
    return;
  }
  const conf = results[0].handInViewConfidence || 1;
  if (conf < CONFIDENCE_MIN) { camDetected.textContent='?'; return; }
  const letter = classifyFingers(results[0].landmarks);
  camDetected.textContent = letter || '?';
  if (!G.running) return;
  if (letter && letter === lastSeen) {
    if (Date.now() - holdStart >= DETECT_HOLD_MS) {
      handleInput(letter);
      lastSeen = null; holdStart = null;
    }
  } else { lastSeen = letter; holdStart = Date.now(); }
}

/* ── HEURISTIC CLASSIFIER ────────────────────────────── */
/*
  21 landmarks from ml5 HandPose.
  Tip indices: thumb=4, index=8, middle=12, ring=16, pinky=20
  MCP (knuckle): index=5, middle=9, ring=13, pinky=17
  y-axis: smaller value = higher on screen
*/
function classifyFingers(lm) {
  const ext = (tip, mcp) => lm[tip][1] < lm[mcp][1];
  const dst = (a,b) => Math.hypot(lm[a][0]-lm[b][0], lm[a][1]-lm[b][1]);
  const pinch = tip => dst(tip,4) < dst(5,17)*0.35;
  const span  = dst(5,17);   // palm width reference

  const T  = ext(4,2),  I  = ext(8,5),
        M  = ext(12,9), R  = ext(16,13), P = ext(20,17);
  const iP = pinch(8),  mP = pinch(12),
        rP = pinch(16), pP = pinch(20);

  // A – fist, thumb beside
  if (!I&&!M&&!R&&!P&&!T)                                return 'A';
  // B – 4 fingers up, thumb tucked
  if (I&&M&&R&&P&&!T)                                    return 'B';
  // C – curved C shape (all semi-out, tips close to thumb but not pinching)
  if (I&&M&&R&&P&&T && dst(8,4)<span*0.9&&dst(8,4)>span*0.3) return 'C';
  // D – index up, touching thumb
  if (I&&!M&&!R&&!P&&iP)                                return 'D';
  // E – all curled, fingertips on palm
  if (!I&&!M&&!R&&!P&&iP&&mP)                           return 'E';
  // F – index+thumb pinch, others extended
  if (!I&&M&&R&&P&&iP)                                   return 'F';
  // G – index horizontal, thumb parallel
  if (I&&!M&&!R&&!P&&T && Math.abs(lm[8][1]-lm[5][1])<Math.abs(lm[8][0]-lm[5][0])) return 'G';
  // H – index+middle extended horizontally
  if (I&&M&&!R&&!P&&!T && dst(8,12)<span*0.55)          return 'H';
  // I – pinky only
  if (!I&&!M&&!R&&P&&!T)                                return 'I';
  // J – pinky + thumb
  if (!I&&!M&&!R&&P&&T)                                 return 'J';
  // K – index+middle+thumb up
  if (I&&M&&!R&&!P&&T)                                  return 'K';
  // L – index+thumb L-shape
  if (I&&!M&&!R&&!P&&T)                                 return 'L';
  // M – 3 fingers over thumb
  if (!I&&!M&&!R&&!P&&!T && dst(8,4)<span*0.5&&dst(12,4)<span*0.5) return 'M';
  // N – 2 fingers over thumb (subset of M check)
  if (!I&&!M&&!R&&!P&&!T && dst(8,4)<span*0.5)          return 'N';
  // O – all tips meet thumb
  if (iP&&mP&&rP&&pP)                                   return 'O';
  // P – like K pointing down
  if (I&&M&&!R&&!P&&T && lm[8][1]>lm[5][1])            return 'P';
  // Q – like G pointing down
  if (I&&!M&&!R&&!P&&T && lm[8][1]>lm[5][1])           return 'Q';
  // R – index+middle crossed
  if (I&&M&&!R&&!P&&!T && dst(8,12)<span*0.22)          return 'R';
  // S – fist, thumb over fingers
  if (!I&&!M&&!R&&!P&&T && lm[4][1]<lm[8][1])          return 'S';
  // T – thumb between index+middle
  if (!I&&!M&&!R&&!P&&T && dst(4,8)<span*0.35)          return 'T';
  // U – index+middle together up
  if (I&&M&&!R&&!P&&!T && dst(8,12)<span*0.3)           return 'U';
  // V – index+middle spread (V)
  if (I&&M&&!R&&!P&&!T && dst(8,12)>span*0.35)          return 'V';
  // W – three fingers spread
  if (I&&M&&R&&!P&&!T)                                  return 'W';
  // X – index hooked
  if (!I&&!M&&!R&&!P&&!T && dst(8,7)<span*0.2)          return 'X';
  // Y – thumb+pinky out
  if (!I&&!M&&!R&&P&&T)                                 return 'Y';
  // Z – index extended alone (static)
  if (I&&!M&&!R&&!P&&!T)                                return 'Z';
  return null;
}

/* ═══════════════════════════════════════════════════════
   UPGRADING THE MODEL
   ═══════════════════════════════════════════════════════
   The heuristic classifier above works well for most
   letters but may struggle with B/E/N/M look-alikes.

   Option A – ml5 NeuralNetwork:
     Collect lm.flat() + label pairs, train a classifier,
     replace classifyFingers() call with nn.classify().

   Option B – third-party fingerspell model:
     Import its weights JSON, feed it lm.flat(),
     replace the classifyFingers() call with its predict().
   ═══════════════════════════════════════════════════════ */

/* ── GAME ────────────────────────────────────────────── */
function startGame() {
  Object.assign(G, {
    running:true, hp:MAX_HP, score:0,
    combo:0, waveIdx:0, enemies:[], clearing:false,
  });
  buildHearts(); updateHearts(); updateScoreHUD();
  screenStart.classList.add('hidden');
  screenOver.classList.add('hidden');
  startWave();
}

function startWave() {
  const cfg = WAVES[Math.min(G.waveIdx, WAVES.length-1)];
  G.clearing = false;
  G.enemiesLeft = cfg.count;
  waveNumEl.textContent = G.waveIdx + 1;
  showWaveBanner(cfg);

  let spawned = 0;
  function spawnNext() {
    if (!G.running) return;
    if (spawned >= cfg.count) return;
    const pool = cfg.pool.split('');
    spawnEnemy(pool[Math.floor(Math.random()*pool.length)], cfg.speed);
    spawned++;
    if (spawned < cfg.count)
      G.spawnTimer = setTimeout(spawnNext, cfg.interval);
  }
  setTimeout(spawnNext, 2000);
  refreshPrompt();
}

function showWaveBanner(cfg) {
  waveBannerEmoji.textContent = cfg.emoji;
  waveTitle.textContent = `Wave ${G.waveIdx+1}`;
  waveSub.textContent = cfg.sub;
  screenWave.classList.remove('hidden');
  setTimeout(() => screenWave.classList.add('hidden'), 2000);
}

/* ── ENEMY SPAWN ─────────────────────────────────────── */
let eid = 0;
function spawnEnemy(letter, speedSec) {
  const id  = ++eid;
  const el  = document.createElement('div');
  el.className = 'enemy';

  // HP bar
  const hp = document.createElement('div'); hp.className='enemy-hp';
  const hpf= document.createElement('div'); hpf.className='enemy-hp-fill';
  hp.appendChild(hpf); el.appendChild(hp);

  // Letter tag
  const tag = document.createElement('div'); tag.className='enemy-tag';
  tag.textContent = letter; el.appendChild(tag);

  // Sprite
  const imgWrap = document.createElement('div'); imgWrap.className='enemy-img';
  const src = ENEMY_TYPES[letter] || ENEMY_IMG_SRC;
  if (src) {
    const img = document.createElement('img'); img.src=src; img.alt='enemy';
    imgWrap.appendChild(img);
  } else {
    const ph = document.createElement('div'); ph.className='enemy-ph';
    ph.textContent = ENEMY_EMOJIS[Math.floor(Math.random()*ENEMY_EMOJIS.length)];
    imgWrap.appendChild(ph);
  }
  el.appendChild(imgWrap);
  enemyLane.appendChild(el);

  const dur = speedSec + Math.random()*3;
  el.style.animationDuration = `${dur}s`;

  const entry = { id, letter, el, dead:false,
    arrivalTimer: setTimeout(() => {
      if (!entry.dead && G.running) reachWizard(entry);
    }, dur * 880)   // fire at ~88% of animation = just before arrival
  };
  G.enemies.push(entry);
  refreshPrompt();
}

function reachWizard(entry) {
  if (entry.dead) return;
  entry.dead = true;
  entry.el.classList.add('reaching');
  damagePlayer();
  setTimeout(() => cleanEnemy(entry), 500);
}

function cleanEnemy(entry) {
  clearTimeout(entry.arrivalTimer);
  if (entry.el?.parentNode) entry.el.remove();
  G.enemies = G.enemies.filter(e => e.id !== entry.id);
  checkWaveDone();
  refreshPrompt();
}

/* ── INPUT ───────────────────────────────────────────── */
function handleInput(letter) {
  if (!G.running) return;
  // find the closest living enemy with that letter
  const target = G.enemies
    .filter(e => !e.dead && e.letter === letter)
    .sort((a,b) => b.id - a.id)[0];   // oldest (furthest along) first

  if (target) { defeatEnemy(target); }
  else        { wrongSign(); }
}

function defeatEnemy(entry) {
  if (entry.dead) return;
  entry.dead = true;
  clearTimeout(entry.arrivalTimer);
  G.score += 10 * (G.combo + 1);
  G.combo++;
  updateScoreHUD();
  doCastAnim(entry.el);
  showFeedback(G.combo>=3 ? '🌟 PERFECT!' : '✨ YES!', true);
  entry.el.classList.add('dying');
  G.enemiesLeft--;
  setTimeout(() => cleanEnemy(entry), 460);
}

function wrongSign() {
  G.combo = 0;
  updateScoreHUD();
  showFeedback('💨 Nope!', false);
}

function damagePlayer() {
  G.hp = Math.max(0, G.hp-1);
  G.combo = 0;
  updateHearts(); updateScoreHUD();
  document.body.classList.add('shake');
  setTimeout(()=>document.body.classList.remove('shake'),320);
  if (G.hp <= 0) gameOver();
}

/* ── CAST ANIMATION ──────────────────────────────────── */
function doCastAnim(enemyEl) {
  // bounce wizard
  wizardZone.classList.remove('casting');
  void wizardZone.offsetWidth;
  wizardZone.classList.add('casting');
  setWizardPose(true);
  setTimeout(()=>{ wizardZone.classList.remove('casting'); setWizardPose(false); }, 420);

  // shoot star particles from wizard toward enemy
  const wRect = wizardZone.getBoundingClientRect();
  const cx = wRect.left + wRect.width/2;
  const cy = wRect.top  + wRect.height/2;
  const eRect = enemyEl ? enemyEl.getBoundingClientRect() : {left:cx+200,top:cy};
  const dx = eRect.left - cx, dy = eRect.top - cy;
  const stars = ['⭐','✨','💫','🌟','⚡'];
  for (let i=0;i<6;i++) {
    const s = document.createElement('div');
    s.className = 'burst-star';
    s.textContent = stars[Math.floor(Math.random()*stars.length)];
    s.style.left = cx+'px'; s.style.top = cy+'px';
    s.style.position='fixed'; s.style.zIndex=30;
    const spread = (Math.random()-0.5)*60;
    s.style.setProperty('--tx',`translate(${dx+spread}px,${dy+(Math.random()-0.5)*60}px)`);
    s.style.animationDelay = (i*0.05)+'s';
    document.body.appendChild(s);
    setTimeout(()=>s.remove(), 700);
  }
}

/* ── HUD ─────────────────────────────────────────────── */
function updateScoreHUD() {
  scoreValEl.textContent = G.score;
  if (G.combo >= 3) {
    comboBadge.classList.remove('hidden');
    comboNumEl.textContent = G.combo;
  } else {
    comboBadge.classList.add('hidden');
  }
}

function refreshPrompt() {
  const alive = G.enemies.filter(e=>!e.dead);
  promptLetter.textContent = alive.length
    ? alive.sort((a,b)=>a.id-b.id)[0].letter
    : '–';
}

/* ── FEEDBACK ────────────────────────────────────────── */
function showFeedback(txt, ok) {
  feedbackEl.textContent = txt;
  feedbackEl.className = '';
  void feedbackEl.offsetWidth;
  feedbackEl.className = ok ? 'ok' : 'nope';
}

/* ── WAVE COMPLETE ───────────────────────────────────── */
function checkWaveDone() {
  if (G.clearing) return;
  if (G.enemies.filter(e=>!e.dead).length) return;
  if (G.enemiesLeft > 0) return;
  G.clearing = true;
  clearTimeout(G.spawnTimer);
  G.waveIdx = Math.min(G.waveIdx+1, WAVES.length-1);
  setTimeout(startWave, 2200);
}

/* ── GAME OVER ───────────────────────────────────────── */
function gameOver() {
  G.running = false;
  clearTimeout(G.spawnTimer);
  promptLetter.textContent = '–';
  G.enemies.forEach(e => e.el?.remove());
  G.enemies = [];
  goScore.textContent = `Score: ${G.score}  ·  Wave ${G.waveIdx+1}`;
  screenOver.classList.remove('hidden');
}

/* ── KEYBOARD FALLBACK ───────────────────────────────── */
/*
  Press any letter key on your keyboard to simulate a signed
  letter while developing without a working camera.
  Remove or comment out in your final build.
*/
document.addEventListener('keydown', e => {
  const k = e.key.toUpperCase();
  if (ALPHABET.includes(k) && G.running) handleInput(k);
});

/* ── UI EVENTS ───────────────────────────────────────── */
btnStart.addEventListener('click',   startGame);
btnRestart.addEventListener('click', startGame);
refBtn.addEventListener('click',  () => refSheet.classList.toggle('hidden'));
refClose.addEventListener('click',() => refSheet.classList.add('hidden'));

/* ── BOOT ────────────────────────────────────────────── */
(async function boot() {
  initWizard();
  buildRefSheet();
  buildHearts();
  await initCamera();
})();
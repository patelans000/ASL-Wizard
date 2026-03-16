/*  ============================================================
    ASL SPELL CASTER — game.js

    IMPORTANT: Uses var throughout (not const/let at top level)
    so the script works reliably as a separate file loaded via
    <script src="game.js"> without module semantics.

    Hand tracking:  @mediapipe/hands  (same as fingerspelling.xyz)
    Skeleton style: white lines + depth-shaded dots (like the site)

    ── ASSET DIMENSIONS ────────────────────────────────────────
    wizard_idle.png ........  90 × 130 px  (idle / standing)
    wizard_cast.png ........  90 × 130 px  (casting pose)
    enemy.png ..............  72 ×  88 px  (all enemies same)
      OR per-letter in ENEMY_TYPES below
    heart.png ..............  28 ×  28 px  (full heart)
    sky.png ................ 1280 × 720 px
    sun.png ................  120 × 120 px
    cloud.png ..............  160 ×  70 px
    hills.png .............. 1280 × 300 px
    ground.png ............. 1280 × 140 px
    ref_A.png … ref_Y.png ..   80 ×  80 px (ASL reference images)

    ── HOW TO REPLACE PLACEHOLDERS ─────────────────────────────
    Wizard:     set WIZARD_IDLE / WIZARD_CAST below
    Enemy:      set ENEMY_IMG (single) or ENEMY_TYPES (per letter)
    Hearts:     set HEART_IMG below
    Background: in style.css find each ID and add
                  background-image: url('yourfile.png');
                  background-size: cover;
    Clouds:     add background-image to .cloud in style.css
    Ref images: place ref_A.png … ref_Y.png next to index.html
    ============================================================ */

/* ── ASSET CONFIG ── */
var WIZARD_IDLE = '';   // e.g. 'wizard_idle.png'  90×130 px
var WIZARD_CAST = '';   // e.g. 'wizard_cast.png'  90×130 px
var ENEMY_IMG   = '';   // e.g. 'enemy.png'        72×88 px
var ENEMY_TYPES = {};   // e.g. { A:'goblin.png', B:'slime.png' }  72×88 px each
var HEART_IMG   = '';   // e.g. 'heart.png'        28×28 px

/* ── GAME CONFIG ── */
var LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split(''); // no J / Z (motion)
var MAX_HP   = 5;

/* ── DETECTION TUNING ──────────────────────────────────────────
   Tweak these if signs are too hard or too sensitive:
   MP_DETECT  — MediaPipe minDetectionConfidence (0–1)
   MP_TRACK   — MediaPipe minTrackingConfidence  (0–1)
   VOTE_SIZE  — rolling window of recent frames
   VOTE_NEED  — frames that must agree before confirming
   HOLD_MS    — ms you must hold the confirmed pose to fire
   COOLDOWN   — ms lock-out after a successful fire               */
var MP_DETECT  = 0.75;
var MP_TRACK   = 0.60;
var VOTE_SIZE  = 8;
var VOTE_NEED  = 5;
var HOLD_MS    = 900;
var COOLDOWN   = 700;

/* ── LEVELS ── */
var LEVELS = [
  {n:1,name:'Beginner',   nl:'A B C D E',  pool:'ABCDE',                     waves:[{c:3,s:32,g:6000},{c:4,s:29,g:5400},{c:5,s:26,g:4900}]},
  {n:2,name:'Apprentice', nl:'F G H I K',  pool:'ABCDEFGHIK',                waves:[{c:4,s:28,g:5200},{c:5,s:25,g:4600},{c:6,s:22,g:4100}]},
  {n:3,name:'Adept',      nl:'L M N O P',  pool:'ABCDEFGHIKLMNOP',            waves:[{c:5,s:25,g:4700},{c:6,s:22,g:4200},{c:7,s:20,g:3700}]},
  {n:4,name:'Expert',     nl:'Q R S T U',  pool:'ABCDEFGHIKLMNOPQRSTU',       waves:[{c:5,s:23,g:4400},{c:6,s:20,g:3800},{c:7,s:18,g:3400}]},
  {n:5,name:'Master',     nl:'V W X Y',    pool:'ABCDEFGHIKLMNOPQRSTUVWXY',   waves:[{c:6,s:21,g:4100},{c:7,s:18,g:3500},{c:8,s:16,g:3100}]},
];

/* ── DOM helper ── */
function gid(id) { return document.getElementById(id); }

/* ── GAME STATE ── */
var G;
function resetG() {
  G = {on:false, hp:MAX_HP, score:0, combo:0,
       lvl:0, wv:0, left:0,
       enemies:[], timer:null, clearing:false};
}
resetG();

/* ── DETECTION STATE ── */
var mpHands  = null;
var mpCamera = null;
var vidCtx   = null;
var skelCtx  = null;
var voteBuf  = [];
var confirmed  = null;
var holdStart  = null;
var isCooldown = false;

/* ══════════════════════════════════════════════════════════════
   BOOT
   Everything here is synchronous — no async/await at top level.
   Buttons are wired immediately. Camera starts after MediaPipe
   is confirmed loaded via a polling check.
══════════════════════════════════════════════════════════════ */
buildHearts();
buildRef();
initWizard();

gid('btn-start').onclick      = startGame;
gid('btn-restart').onclick    = startGame;
gid('btn-next-level').onclick = nextLevel;
gid('ref-btn').onclick   = function() {
  var s = gid('ref-sheet');
  s.style.display = (s.style.display === 'block') ? 'none' : 'block';
};
gid('ref-close').onclick = function() { gid('ref-sheet').style.display = 'none'; };

document.addEventListener('keydown', function(e) {
  var k = e.key.toUpperCase();
  if (LETTERS.indexOf(k) >= 0 && G.on) handleInput(k);
});

// Poll every 100 ms until MediaPipe globals are present, then start camera.
// This is more reliable than a fixed setTimeout.
var _mpPollCount = 0;
var _mpPoll = setInterval(function() {
  _mpPollCount++;
  if (typeof Hands !== 'undefined' && typeof Camera !== 'undefined') {
    clearInterval(_mpPoll);
    startCamera();
  } else if (_mpPollCount > 100) { // 10 s timeout
    clearInterval(_mpPoll);
    gid('cam-status').textContent = 'Hand tracking unavailable — use keyboard';
  }
}, 100);

/* ══════════════════════════════════════════════════════════════
   CAMERA + MEDIAPIPE
══════════════════════════════════════════════════════════════ */
function startCamera() {
  try {
    var vc = gid('cam-video');
    var sc = gid('cam-skeleton');
    vc.width = sc.width  = 280;
    vc.height = sc.height = 210;
    vidCtx  = vc.getContext('2d');
    skelCtx = sc.getContext('2d');

    var vid = document.createElement('video');
    vid.setAttribute('playsinline', '');
    vid.muted = true;
    vid.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:0;left:0';
    document.body.appendChild(vid);

    mpHands = new Hands({
      locateFile: function(f) {
        return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + f;
      }
    });
    mpHands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: MP_DETECT,
      minTrackingConfidence:  MP_TRACK
    });
    mpHands.onResults(onResults);

    mpCamera = new Camera(vid, {
      onFrame: function() { return mpHands.send({ image: vid }); },
      width: 640, height: 480
    });

    mpCamera.start()
      .then(function() {
        gid('cam-status').textContent = 'Camera ready!';
        setTimeout(function() { gid('cam-status').textContent = ''; }, 2500);
      })
      .catch(function(err) {
        console.warn('Camera error:', err);
        gid('cam-status').textContent = 'No camera — use keyboard';
      });

  } catch (err) {
    console.warn('MediaPipe setup error:', err);
    gid('cam-status').textContent = 'Hand tracking error — use keyboard';
  }
}

/* ══════════════════════════════════════════════════════════════
   ON HAND RESULTS  — called every frame
   Draws video + skeleton like fingerspelling.xyz,
   classifies pose, runs vote buffer + hold-to-fire.
══════════════════════════════════════════════════════════════ */
function onResults(results) {
  var W = 280, H = 210;

  // Draw mirrored video
  vidCtx.save();
  vidCtx.clearRect(0, 0, W, H);
  vidCtx.scale(-1, 1);
  vidCtx.translate(-W, 0);
  if (results.image) vidCtx.drawImage(results.image, 0, 0, W, H);
  vidCtx.restore();

  // Clear skeleton overlay
  skelCtx.clearRect(0, 0, W, H);

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    var lm = results.multiHandLandmarks[0];

    // Draw skeleton (fingerspelling.xyz style)
    drawSkeleton(lm, W, H);

    // Classify
    var raw = classifyASL(lm);
    gid('cam-letter').textContent = raw || '?';

    // Vote buffer
    voteBuf.push(raw);
    if (voteBuf.length > VOTE_SIZE) voteBuf.shift();

    var counts = {};
    for (var i = 0; i < voteBuf.length; i++) {
      var l = voteBuf[i];
      if (l) counts[l] = (counts[l] || 0) + 1;
    }
    var voted = null, best = 0;
    for (var k in counts) {
      if (counts[k] > best) { best = counts[k]; voted = k; }
    }
    if (best < VOTE_NEED) voted = null;

    // Hold-to-fire
    if (G.on && voted && !isCooldown) {
      if (voted === confirmed) {
        var pct = Math.min(100, (Date.now() - holdStart) / HOLD_MS * 100);
        gid('hold-fill').style.width = pct + '%';
        if (Date.now() - holdStart >= HOLD_MS) {
          isCooldown = true;
          handleInput(voted);
          confirmed = null; holdStart = null;
          gid('hold-fill').style.width = '0%';
          setTimeout(function() { isCooldown = false; }, COOLDOWN);
        }
      } else {
        confirmed = voted; holdStart = Date.now();
        gid('hold-fill').style.width = '0%';
      }
    } else if (!voted) {
      confirmed = null; holdStart = null;
      gid('hold-fill').style.width = '0%';
    }

  } else {
    voteBuf = []; confirmed = null; holdStart = null;
    gid('cam-letter').textContent = '';
    gid('hold-fill').style.width = '0%';
  }
}

/* ══════════════════════════════════════════════════════════════
   SKELETON DRAWING  — fingerspelling.xyz style
   White semi-transparent connector lines between joints.
   Depth-shaded dots: red-toned (far) → white (close).
══════════════════════════════════════════════════════════════ */
function drawSkeleton(lm, W, H) {
  // Scale + mirror to match the flipped video
  function px(p) { return W - p.x * W; }
  function py(p) { return p.y * H; }

  var BONES = [
    [0,1],[1,2],[2,3],[3,4],          // thumb
    [0,5],[5,6],[6,7],[7,8],          // index
    [0,9],[9,10],[10,11],[11,12],     // middle
    [0,13],[13,14],[14,15],[15,16],   // ring
    [0,17],[17,18],[19,20],[19,20],   // pinky (typo-safe duplicate removed below)
    [0,17],[17,18],[18,19],[19,20],   // pinky correct
    [5,9],[9,13],[13,17]              // palm
  ];
  // Deduplicate
  var seen = {};
  var cleanBones = [];
  for (var i = 0; i < BONES.length; i++) {
    var key = BONES[i][0] + '-' + BONES[i][1];
    if (!seen[key]) { seen[key] = true; cleanBones.push(BONES[i]); }
  }

  // Lines — white, semi-transparent
  skelCtx.lineWidth   = 3;
  skelCtx.strokeStyle = 'rgba(255,255,255,0.75)';
  skelCtx.lineCap     = 'round';
  for (var j = 0; j < cleanBones.length; j++) {
    var a = cleanBones[j][0], b = cleanBones[j][1];
    skelCtx.beginPath();
    skelCtx.moveTo(px(lm[a]), py(lm[a]));
    skelCtx.lineTo(px(lm[b]), py(lm[b]));
    skelCtx.stroke();
  }

  // Dots — depth-shaded
  for (var d = 0; d < lm.length; d++) {
    var p = lm[d];
    var x = px(p), y = py(p);
    var depth = Math.max(0, Math.min(1, 1 - ((p.z || 0) + 0.1) * 3));
    var g = Math.round(depth * 180);
    var bv = Math.round(depth * 80);
    var radius = (d === 0) ? 6 : (d % 4 === 0 ? 5 : 4);

    // White outer ring
    skelCtx.beginPath();
    skelCtx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
    skelCtx.fillStyle = 'rgba(255,255,255,0.9)';
    skelCtx.fill();

    // Coloured inner dot
    skelCtx.beginPath();
    skelCtx.arc(x, y, radius, 0, Math.PI * 2);
    skelCtx.fillStyle = 'rgb(255,' + g + ',' + bv + ')';
    skelCtx.fill();
  }
}

/* ══════════════════════════════════════════════════════════════
   ASL CLASSIFIER
   21 normalised landmarks from MediaPipe Hands.
   J and Z excluded — they require motion.

   Landmark indices:
     0 = WRIST
     1–4  THUMB  (tip=4, mcp=2)
     5–8  INDEX  (tip=8, pip=6, mcp=5)
     9–12 MIDDLE (tip=12,pip=10,mcp=9)
    13–16 RING   (tip=16,pip=14,mcp=13)
    17–20 PINKY  (tip=20,pip=18,mcp=17)
══════════════════════════════════════════════════════════════ */
function classifyASL(lm) {
  var wx = lm[0].x, wy = lm[0].y, wz = lm[0].z || 0;
  var n = lm.map(function(p) {
    return { x: p.x-wx, y: p.y-wy, z:(p.z||0)-wz };
  });

  var palm = Math.hypot(n[9].x - n[0].x, n[9].y - n[0].y);

  function d(a, b) { return Math.hypot(n[a].x-n[b].x, n[a].y-n[b].y); }
  function ext(tip, mcp) { return n[mcp].y - n[tip].y > palm * 0.12; }
  function curled(tip, pip) { return n[tip].y > n[pip].y; }
  function near(a, b, frac) { return d(a,b) < palm * (frac||0.38); }

  var TH = ext(4,2), IX = ext(8,5), MD = ext(12,9), RG = ext(16,13), PK = ext(20,17);
  var IXc = curled(8,6), MDc = curled(12,10);

  /* ALL FINGERS DOWN */
  if (!IX && !MD && !RG && !PK) {
    if (near(8,4,.44) && near(12,4,.44) && near(16,4,.50) && near(20,4,.55)) return 'O';
    if (IXc && MDc && curled(16,14) && near(8,4,.60) && near(12,4,.60))      return 'E';
    if (TH && near(8,4,.50) && near(12,4,.50) && near(16,4,.55))             return 'M';
    if (TH && near(8,4,.50) && near(12,4,.50) && !near(16,4,.48))            return 'N';
    if (TH && d(4,6) < palm*.42 && d(4,10) < palm*.52)                       return 'T';
    if (!TH && IXc && !MDc && d(8,6) < palm*.28)                             return 'X';
    if (TH && n[4].y < n[8].y - palm*.04)                                    return 'S';
    return 'A';
  }

  /* ONE FINGER UP */
  if (IX && !MD && !RG && !PK) {
    if (near(12,4,.46) && near(16,4,.52)) return 'D';
    if (TH) {
      var hx = Math.abs(n[8].x - n[5].x), hy = Math.abs(n[8].y - n[5].y);
      if (hx > hy*0.7 && n[8].y > -palm*0.22) return 'G';
      if (n[8].y > n[5].y + palm*0.06) return 'Q';
      return 'L';
    }
    return 'D';
  }

  /* PINKY ONLY UP */
  if (!IX && !MD && !RG && PK) { return TH ? 'Y' : 'I'; }

  /* TWO FINGERS UP */
  if (IX && MD && !RG && !PK) {
    var tc = near(8,12,.30);
    if (TH) {
      if (n[8].y > n[5].y + palm*.06) return 'P';
      return 'K';
    }
    var hdx = Math.abs(n[8].x - n[12].x);
    var vav = (Math.abs(n[8].y - n[5].y) + Math.abs(n[12].y - n[9].y)) / 2;
    if (hdx > vav*.60 && tc) return 'H';
    if (tc && !near(5,9,.28)) return 'R';
    if (tc) return 'U';
    return 'V';
  }

  /* THREE FINGERS UP */
  if (IX && MD && RG && !PK) { return 'W'; }

  /* C — before four-fingers-up (fingers semi-curled) */
  if (TH && (IX || MD || RG || PK)) {
    var gap = d(8,4);
    if (gap > palm*.42 && gap < palm*1.45 && d(12,4) > palm*.32) return 'C';
  }

  /* FOUR FINGERS UP */
  if (IX && MD && RG && PK) { return 'B'; }

  /* F — index+thumb pinch, middle+ring+pinky up */
  if (!IX && MD && RG && PK && near(8,4,.44)) return 'F';

  return null;
}

/* ══════════════════════════════════════════════════════════════
   WIZARD SPRITE
══════════════════════════════════════════════════════════════ */
function initWizard() {
  if (!WIZARD_IDLE) return;
  var ws = gid('wiz-sprite');
  ws.innerHTML = '';
  ws.classList.remove('ph');
  ws.style.background = 'none';
  ws.style.border     = 'none';
  var img = document.createElement('img');
  img.src = WIZARD_IDLE; img.alt = 'wizard';
  ws.appendChild(img);
}
function wizPose(cast) {
  var img = gid('wiz-sprite').querySelector('img');
  if (!img) return;
  img.src = (cast && WIZARD_CAST) ? WIZARD_CAST : WIZARD_IDLE;
}

/* ── Hearts ── */
function buildHearts() {
  var r = gid('hearts-row');
  r.innerHTML = '';
  for (var i = 0; i < MAX_HP; i++) {
    var h = document.createElement('div');
    h.className = 'heart';
    h.dataset.i = i;
    if (HEART_IMG) {
      h.style.backgroundImage = 'url(' + HEART_IMG + ')';
      h.style.backgroundSize  = 'cover';
      h.style.border          = 'none';
    }
    r.appendChild(h);
  }
}
function renderHearts() {
  var hs = document.querySelectorAll('.heart');
  for (var i = 0; i < hs.length; i++) {
    hs[i].classList.toggle('lost', i >= G.hp);
  }
}

/* ── Ref sheet ── */
function buildRef() {
  var g = gid('ref-grid');
  for (var i = 0; i < LETTERS.length; i++) {
    var l = LETTERS[i];
    var cell = document.createElement('div'); cell.className = 'rcell';
    var lbl  = document.createElement('div'); lbl.className  = 'rl'; lbl.textContent = l;
    cell.appendChild(lbl);
    var img  = document.createElement('img');  img.className  = 'ri'; img.alt = 'ASL '+l;
    (function(letter, imgEl, cellEl) {
      imgEl.onerror = function() {
        var ph = document.createElement('div'); ph.className = 'rph';
        ph.textContent = 'ref_'+letter+'.png\n80×80 px';
        cellEl.replaceChild(ph, imgEl);
      };
    })(l, img, cell);
    img.src = 'ref_' + l + '.png';
    cell.appendChild(img);
    g.appendChild(cell);
  }
}

/* ══════════════════════════════════════════════════════════════
   GAME LOGIC
══════════════════════════════════════════════════════════════ */
function startGame() {
  resetG(); G.on = true;
  buildHearts(); renderHearts();
  gid('score-val').textContent = '0';
  gid('combo-badge').style.display = 'none';
  gid('screen-start').classList.add('hidden');
  gid('screen-over').classList.add('hidden');
  gid('screen-lc').classList.add('hidden');
  voteBuf = []; confirmed = null; holdStart = null;
  beginWave();
}

function curLvl()  { return LEVELS[Math.min(G.lvl, LEVELS.length-1)]; }
function curWave() { var L = curLvl(); return L.waves[Math.min(G.wv, L.waves.length-1)]; }

function beginWave() {
  var L = curLvl(), W = curWave(), pool = L.pool.split('');
  G.clearing = false; G.left = W.c;
  gid('lvlnum').textContent = L.n;
  gid('wvnum').textContent  = G.wv + 1;
  gid('wvtitle').textContent = 'Level ' + L.n + ' — Wave ' + (G.wv+1) + ' / ' + L.waves.length;
  gid('wvsub').textContent   = L.name + ' · Letters: ' + L.pool.split('').join(' ');
  var sw = gid('screen-wave'); sw.classList.remove('hidden');
  setTimeout(function() { sw.classList.add('hidden'); }, 2200);
  var done = 0;
  function nextSpawn() {
    if (!G.on) return;
    if (done >= W.c) return;
    spawnEnemy(pool[Math.floor(Math.random() * pool.length)], W.s);
    done++;
    if (done < W.c) G.timer = setTimeout(nextSpawn, W.g);
  }
  setTimeout(nextSpawn, 2300);
  refreshPrompt();
}

function showLevelComplete() {
  var L = curLvl(), isLast = G.lvl >= LEVELS.length - 1;
  gid('lctitle').textContent = isLast ? 'You Win!' : 'Level ' + L.n + ' Complete!';
  gid('lcsub').textContent   = isLast ? 'You mastered the full ASL alphabet!'
                                       : 'Ready for Level ' + (L.n+1) + ': ' + LEVELS[G.lvl+1].name;
  gid('lcnew').textContent   = isLast ? '' : 'New letters: ' + LEVELS[G.lvl+1].nl;
  gid('lcscore').textContent = 'Score: ' + G.score;
  gid('btn-next-level').textContent = isLast ? 'Play Again' : 'Start Level ' + (L.n+1);
  gid('screen-lc').classList.remove('hidden');
}

function nextLevel() {
  gid('screen-lc').classList.add('hidden');
  if (G.lvl >= LEVELS.length - 1) {
    G.lvl = 0; G.wv = 0; G.hp = MAX_HP;
    buildHearts(); renderHearts();
  } else { G.lvl++; G.wv = 0; }
  voteBuf = []; confirmed = null; holdStart = null;
  beginWave();
}

/* ── Enemy spawn ── */
var eid = 0;
function spawnEnemy(letter, sec) {
  var id  = ++eid;
  var el  = document.createElement('div'); el.className = 'enemy';
  var dur = sec + Math.random() * 3;
  el.style.animationDuration = dur + 's';

  var hw = document.createElement('div'); hw.className = 'ehp';
  var hf = document.createElement('div'); hf.className = 'ehpf';
  hw.appendChild(hf); el.appendChild(hw);

  var tag = document.createElement('div'); tag.className = 'etag'; tag.textContent = letter;
  el.appendChild(tag);

  var iw  = document.createElement('div'); iw.className = 'ei';
  var src = ENEMY_TYPES[letter] || ENEMY_IMG;
  if (src) {
    var img = document.createElement('img'); img.src = src; img.alt = 'enemy';
    iw.appendChild(img);
  } else {
    iw.classList.add('ph');
    var t = document.createElement('div'); t.className = 'ph-label'; t.textContent = 'ENEMY';
    var sz = document.createElement('div'); sz.className = 'ph-dim'; sz.textContent = '72 × 88 px';
    iw.appendChild(t); iw.appendChild(sz);
  }
  el.appendChild(iw);
  gid('enemy-lane').appendChild(el);

  var entry = { id:id, letter:letter, el:el, dead:false, tm:null };
  entry.tm = setTimeout(function() {
    if (!entry.dead && G.on) reachWizard(entry);
  }, dur * 880);
  G.enemies.push(entry);
  refreshPrompt();
}

function reachWizard(entry) {
  if (entry.dead) return;
  entry.dead = true;
  entry.el.classList.add('reaching');
  G.left = Math.max(0, G.left - 1);
  takeDamage();
  setTimeout(function() { removeEnemy(entry); }, 500);
}

function removeEnemy(entry) {
  clearTimeout(entry.tm);
  if (entry.el && entry.el.parentNode) entry.el.remove();
  G.enemies = G.enemies.filter(function(e) { return e.id !== entry.id; });
  checkWaveDone();
  refreshPrompt();
}

/* ── Input ── */
function handleInput(letter) {
  if (!G.on) return;
  var target = null;
  for (var i = 0; i < G.enemies.length; i++) {
    var e = G.enemies[i];
    if (!e.dead && e.letter === letter) {
      if (!target || e.id < target.id) target = e;
    }
  }
  if (target) { defeatEnemy(target); }
  else {
    var live = G.enemies.filter(function(e) { return !e.dead; });
    if (live.length > 0) wrongSign();
  }
}

function defeatEnemy(entry) {
  if (entry.dead) return;
  entry.dead = true; clearTimeout(entry.tm);
  G.score += 10 * (G.combo + 1); G.combo++;
  G.left = Math.max(0, G.left - 1);
  renderHUD(); castSpell(entry.el);
  showFb(G.combo >= 3 ? 'COMBO!' : 'YES!', true);
  entry.el.classList.add('dying');
  setTimeout(function() { removeEnemy(entry); }, 460);
}

function wrongSign()  { G.combo = 0; renderHUD(); showFb('Nope', false); }

function takeDamage() {
  G.hp = Math.max(0, G.hp - 1); G.combo = 0;
  renderHearts(); renderHUD();
  document.body.classList.add('shake');
  setTimeout(function() { document.body.classList.remove('shake'); }, 320);
  if (G.hp <= 0) gameOver();
}

function castSpell(eEl) {
  var wz = gid('wiz-zone');
  wz.classList.remove('casting'); void wz.offsetWidth; wz.classList.add('casting');
  wizPose(true);
  setTimeout(function() { wz.classList.remove('casting'); wizPose(false); }, 420);
  var wr = wz.getBoundingClientRect();
  var cx = wr.left + wr.width / 2, cy = wr.top + wr.height / 2;
  var er = eEl && eEl.getBoundingClientRect ? eEl.getBoundingClientRect() : {left:cx+200,top:cy};
  for (var i = 0; i < 6; i++) {
    var dot = document.createElement('div'); dot.className = 'burst bdot';
    dot.style.cssText = 'left:'+cx+'px;top:'+cy+'px;animation-delay:'+(i*.05)+'s;';
    var tx = (er.left-cx) + (Math.random()-.5)*80;
    var ty = (er.top-cy)  + (Math.random()-.5)*80;
    dot.style.setProperty('--t', 'translate('+tx+'px,'+ty+'px)');
    document.body.appendChild(dot);
    setTimeout(function(d){return function(){d.remove();};}(dot), 700);
  }
}

function renderHUD() {
  gid('score-val').textContent = G.score;
  if (G.combo >= 3) {
    gid('combo-badge').style.display = '';
    gid('cnum').textContent = G.combo;
  } else { gid('combo-badge').style.display = 'none'; }
}

function refreshPrompt() {
  var alive = G.enemies.filter(function(e) { return !e.dead; });
  alive.sort(function(a,b) { return a.id - b.id; });
  gid('plet').textContent = alive.length ? alive[0].letter : '-';
}

function showFb(txt, ok) {
  var fb = gid('feedback');
  fb.textContent = txt; fb.className = '';
  void fb.offsetWidth; fb.className = ok ? 'ok' : 'nope';
}

function checkWaveDone() {
  if (G.clearing || !G.on) return;
  var live = G.enemies.filter(function(e) { return !e.dead; });
  if (live.length > 0 || G.left > 0) return;
  G.clearing = true; clearTimeout(G.timer);
  if (G.wv >= curLvl().waves.length - 1) setTimeout(showLevelComplete, 1200);
  else { G.wv++; setTimeout(beginWave, 2200); }
}

function gameOver() {
  G.on = false; clearTimeout(G.timer);
  gid('plet').textContent = '-';
  G.enemies.forEach(function(e) { if (e.el && e.el.parentNode) e.el.remove(); });
  G.enemies = [];
  gid('goscore').textContent = 'Score: ' + G.score + '  |  Level ' + curLvl().n + '  Wave ' + (G.wv+1);
  gid('screen-over').classList.remove('hidden');
}
'use strict';

/* 북스캔: 촬영 가이드 → 모서리 맞추기(자동) → 두 쪽 분리 → 평평하게 펴기 → 연속 스캔 → PDF/JPG
 * app.js 의 전역(canvas, region, applyScanFilter, canvasToJpeg, makePdf, saveOrShare …)과
 * features.js 의 전역(openForm, pendingAct, goHome …)을 그대로 쓴다. 외부 라이브러리는 쓰지 않는다. */

const bookPages = []; // 찍어 둔 쪽: { jpeg, w, h, thumb }
let bookFormat = 'pdf';

function resetBook() {
  bookPages.length = 0;
  updateBookBar();
}

function updateBookBar() {
  const n = bookPages.length;
  $('book-done').hidden = !n;
  $('book-count').textContent = n;
}

$('book-done').addEventListener('click', () => openBookFinish());

// 사진 화면의 저장 버튼도 같은 편집 화면으로 이어진다
$('btn-scan').addEventListener('click', () => {
  if (!hasPhoto) return;
  pendingAct = 'scan';
  openBookEditor();
});

/* ---------- 이미지 계산 (모서리 찾기 · 평평하게 펴기) ---------- */

const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 점 4개로 이루어진 사각형의 넓이
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

// 평평하게 펼 때 쓸 출력 크기: 위·아래 변, 좌·우 변의 평균 길이
function outSize(q, maxSide) {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Math.min(1, maxSide / Math.max(w, h, 1));
  return [Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k))];
}

// 출력 사각형 (0,0)(w,0)(w,h)(0,h) → 원본 사각형 q 로 가는 투영 변환 계수 (8개)
function solveHomography(w, h, q) {
  const dst = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i];
    const { x: u, y: v } = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // 가우스 소거법 (부분 피벗)
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row) => row[8]);
}

let srcDataFor = null; // 마지막으로 읽은 원본 픽셀 (같은 캔버스면 다시 읽지 않음)
function pixelsOf(src) {
  if (srcDataFor?.canvas !== src || srcDataFor.w !== src.width || srcDataFor.h !== src.height || srcDataFor.stamp !== (src._stamp || 0)) {
    srcDataFor = {
      canvas: src, w: src.width, h: src.height, stamp: src._stamp || 0,
      data: src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data,
    };
  }
  return srcDataFor;
}

// 사각형 q 안쪽을 w×h 반듯한 사각형으로 편다 (양선형 보간)
function warpQuad(src, q, w, h) {
  const { data: sd, w: sw, h: sh } = pixelsOf(src);
  const [a, b, c, d, e, f, g, hh] = solveHomography(w, h, q);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const od = img.data;
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      const px = x + 0.5, py = y + 0.5;
      const den = g * px + hh * py + 1;
      let sx = (a * px + b * py + c) / den - 0.5;
      let sy = (d * px + e * py + f) / den - 0.5;
      sx = sx < 0 ? 0 : sx > sw - 1.001 ? sw - 1.001 : sx;
      sy = sy < 0 ? 0 : sy > sh - 1.001 ? sh - 1.001 : sy;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      od[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// 평평하게 펴지 않을 때: 사각형을 감싸는 직사각형만 잘라 낸다
function cropBounds(src, q, maxSide) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(src.width, Math.ceil(Math.max(...xs))), y1 = Math.min(src.height, Math.ceil(Math.max(...ys)));
  const w = Math.max(8, x1 - x0), h = Math.max(8, y1 - y0);
  const k = Math.min(1, maxSide / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(8, Math.round(w * k)); out.height = Math.max(8, Math.round(h * k));
  out.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, out.width, out.height);
  return out;
}

// 상자 평균(적분 이미지)으로 팽창·침식. 종이 덩어리의 틈(책 가운데 그림자 등)을 메운다
function closeMask(mask, w, h, r) {
  const iw = w + 1;
  const run = (src, wantAll) => {
    const sum = new Int32Array(iw * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += src[y * w + x];
        sum[(y + 1) * iw + x + 1] = sum[y * iw + x + 1] + row;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const total = sum[y1 * iw + x1] - sum[y0 * iw + x1] - sum[y1 * iw + x0] + sum[y0 * iw + x0];
        out[y * w + x] = wantAll ? (total === (x1 - x0) * (y1 - y0) ? 1 : 0) : (total > 0 ? 1 : 0);
      }
    }
    return out;
  };
  return run(run(mask, false), true);
}

// 책·문서(밝은 종이)의 네 모서리를 찾는다. 못 찾으면 null
function detectQuad(src) {
  const S = 320 / Math.max(src.width, src.height);
  const w = Math.max(16, Math.round(src.width * S)), h = Math.max(16, Math.round(src.height * S));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  const hist = new Float64Array(256);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    hist[gray[j]]++;
  }
  // 오츠 방법으로 밝은 쪽/어두운 쪽 가르기
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * ((sumB / wB) - ((sumAll - sumB) / wF)) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  let mask = new Uint8Array(w * h);
  let centerBright = 0, centerN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x] > thr ? 1 : 0;
      mask[y * w + x] = v;
      if (x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7) { centerBright += v; centerN++; }
    }
  }
  // 가운데가 어두우면 어두운 쪽이 대상 (검은 배경 위의 흰 종이가 아닌 경우)
  if (centerBright / centerN < 0.5) mask = mask.map((v) => 1 - v);
  mask = closeMask(mask, w, h, Math.max(3, Math.round(Math.max(w, h) / 50)));

  // 가장 큰 덩어리
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0, bestSize = 0, next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let sp = 0, size = 0;
    stack[sp++] = i; label[i] = next;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  if (!bestLabel || bestSize < total * 0.12) return null;

  // 네 모서리 = 덩어리에서 가장 바깥쪽 점 (x+y, x−y 의 극값)
  let tl = null, tr = null, br = null, bl = null;
  let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % w, y = (i / w) | 0;
    const s = x + y, df = x - y;
    if (s < sMin) { sMin = s; tl = { x, y }; }
    if (s > sMax) { sMax = s; br = { x, y }; }
    if (df > dMax) { dMax = df; tr = { x, y }; }
    if (df < dMin) { dMin = df; bl = { x, y }; }
  }
  const q = [tl, tr, br, bl].map((p) => ({ x: (p.x + 0.5) / S, y: (p.y + 0.5) / S }));
  const area = quadArea(q);
  const imgArea = src.width * src.height;
  // 덩어리가 사각형에 가까워야 믿는다 (배경과 섞여 번졌으면 실패)
  if (area < imgArea * 0.15 || bestSize / S / S < area * 0.62) return null;
  return q;
}

// 두 쪽 책: 반듯하게 편 그림에서 가운데 근처의 가장 어두운 세로줄(책 가운데 그림자)을 찾는다. 0~1
function detectSpine(src, q) {
  const [w, h] = outSize(q, 480);
  const flat = warpQuad(src, q, w, h);
  const d = flat.getContext('2d').getImageData(0, 0, w, h).data;
  const col = new Float64Array(w);
  const y0 = Math.round(h * 0.12), y1 = Math.round(h * 0.88);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) { const i = (y * w + x) * 4; sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; }
    col[x] = sum / Math.max(1, y1 - y0);
  }
  const win = Math.max(3, Math.round(w * 0.05));
  let bestX = Math.round(w / 2), bestV = Infinity;
  for (let x = Math.round(w * 0.33); x <= Math.round(w * 0.67); x++) {
    let s = 0, n = 0;
    for (let k = -win; k <= win; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += col[xx]; n++; } }
    // 가운데에서 멀수록 조금 불리하게
    const v = s / n + Math.abs(x - w / 2) * 0.08;
    if (v < bestV) { bestV = v; bestX = x; }
  }
  return Math.min(0.8, Math.max(0.2, bestX / w));
}

/* ---------- 편집 화면 ---------- */

const bs = {
  src: null, quad: null, spine: [0.5, 0.5], split: false, flatten: true, filter: 'clean',
  k: 1, ox: 0, view: 'edit', dom: null, drag: null,
};

function bsEnsureDom() {
  if (bs.dom) return bs.dom;
  document.body.insertAdjacentHTML('beforeend', `
  <div id="bs" class="bs" hidden>
    <div class="bs-head">
      <button id="bs-close" class="icon-btn" type="button" title="닫기" aria-label="닫기"><svg class="ic"><use href="#i-close"/></svg></button>
      <b>스캔 편집</b><small id="bs-count"></small>
    </div>
    <div class="bs-stage" id="bs-stage">
      <div id="bs-wrap" style="position:absolute">
        <canvas id="bs-canvas"></canvas>
        <svg id="bs-svg" class="bs-svg"></svg>
        <canvas id="bs-loupe" width="104" height="104" style="position:absolute;display:none;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.5);pointer-events:none"></canvas>
      </div>
      <div id="bs-preview" class="bs-preview" hidden></div>
      <p id="bs-hint" class="bs-hint"></p>
      <div id="bs-busy" class="bs-busy" hidden>처리하는 중…</div>
    </div>
    <div class="bs-opts">
      <div class="bs-row" style="flex-wrap:wrap">
        <button id="bs-split" class="btn" type="button">두 쪽으로 나누기</button>
        <button id="bs-flat" class="btn" type="button">평평하게 펴기</button>
        <button id="bs-auto" class="btn" type="button">자동 맞추기</button>
        <button id="bs-rot" class="btn" type="button">돌리기</button>
      </div>
      <div class="seg" id="bs-filter" role="radiogroup" aria-label="보정">
        <label><input type="radio" name="bs-filter" value="clean" checked><span>선명(컬러)</span></label>
        <label><input type="radio" name="bs-filter" value="bw"><span>문서(흑백)</span></label>
        <label><input type="radio" name="bs-filter" value="gray"><span>그레이</span></label>
        <label><input type="radio" name="bs-filter" value="color"><span>원본</span></label>
      </div>
    </div>
    <div class="bs-actions">
      <button id="bs-view" class="btn" type="button">결과 보기</button>
      <button id="bs-next" class="btn" type="button">다음 쪽 촬영</button>
      <button id="bs-done" class="btn primary" type="button">완료</button>
    </div>
  </div>`);
  const d = {};
  for (const id of ['bs', 'bs-close', 'bs-count', 'bs-stage', 'bs-wrap', 'bs-canvas', 'bs-svg', 'bs-loupe', 'bs-preview', 'bs-hint', 'bs-busy', 'bs-split', 'bs-flat', 'bs-auto', 'bs-rot', 'bs-view', 'bs-next', 'bs-done']) d[id] = $(id);
  bs.dom = d;

  d['bs-close'].addEventListener('click', bsClose);
  d['bs-split'].addEventListener('click', async () => {
    bs.split = !bs.split;
    if (bs.split) { const t = await bsSpineGuess(); bs.spine = [t, t]; }
    bsRefresh();
  });
  d['bs-flat'].addEventListener('click', () => { bs.flatten = !bs.flatten; bsRefresh(); });
  d['bs-auto'].addEventListener('click', () => bsAutoFit(true));
  d['bs-rot'].addEventListener('click', () => {
    bs.src = rotateCanvas(bs.src, 90);
    bsAutoFit(false);
  });
  d['bs-view'].addEventListener('click', () => { bs.view = bs.view === 'edit' ? 'preview' : 'edit'; bsRefresh(); });
  d['bs-next'].addEventListener('click', () => bsCommit('next'));
  d['bs-done'].addEventListener('click', () => bsCommit('done'));
  document.querySelectorAll('input[name="bs-filter"]').forEach((el) => el.addEventListener('change', () => {
    bs.filter = el.value;
    if (bs.view === 'preview') bsRenderPreview();
  }));

  // 점 끌기 (모서리 4개 + 두 쪽 경계 2개)
  const stage = d['bs-stage'];
  stage.addEventListener('pointerdown', (e) => {
    if (bs.view !== 'edit' || !bs.quad) return;
    const r = d['bs-wrap'].getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bestD = 44;
    for (const h of bsHandles()) {
      const dd = Math.hypot(h.x * bs.k - px, h.y * bs.k - py);
      if (dd < bestD) { bestD = dd; best = h; }
    }
    if (!best) return;
    stage.setPointerCapture(e.pointerId);
    bs.drag = best;
    bsMove(e);
  });
  stage.addEventListener('pointermove', (e) => { if (bs.drag) bsMove(e); });
  const end = () => { bs.drag = null; d['bs-loupe'].style.display = 'none'; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (!d.bs.hidden) bsRefresh(); });
  return d;
}

// 자동으로 찾은 가운데 위치 (모서리를 먼저 맞춘 뒤의 값)
async function bsSpineGuess() {
  try { return detectSpine(bs.src, bs.quad); } catch { return 0.5; }
}

// 끌 수 있는 점들 (원본 사진 좌표)
function bsHandles() {
  const h = bs.quad.map((p, i) => ({ id: `c${i}`, x: p.x, y: p.y, kind: 'corner', i }));
  if (bs.split) {
    const [TL, TR, BR, BL] = bs.quad;
    const top = lerpPt(TL, TR, bs.spine[0]), bot = lerpPt(BL, BR, bs.spine[1]);
    h.push({ id: 's0', x: top.x, y: top.y, kind: 'spine', i: 0 }, { id: 's1', x: bot.x, y: bot.y, kind: 'spine', i: 1 });
  }
  return h;
}

function bsMove(e) {
  const d = bs.dom;
  const r = d['bs-wrap'].getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const x = Math.min(bs.src.width, Math.max(0, px / bs.k)), y = Math.min(bs.src.height, Math.max(0, py / bs.k));
  const h = bs.drag;
  if (h.kind === 'corner') {
    bs.quad[h.i] = { x, y };
  } else {
    const [TL, TR, BR, BL] = bs.quad;
    const A = h.i === 0 ? TL : BL, B = h.i === 0 ? TR : BR;
    const vx = B.x - A.x, vy = B.y - A.y;
    const t = ((x - A.x) * vx + (y - A.y) * vy) / (vx * vx + vy * vy || 1);
    bs.spine[h.i] = Math.min(0.9, Math.max(0.1, t));
  }
  // 손가락에 가려지는 부분을 보여 주는 돋보기
  const L = d['bs-loupe'];
  const cur = bsHandles().find((q) => q.id === h.id) || { x, y };
  const span = 56 / bs.k; // 화면 56px 범위를 2배로
  const lx = cur.x * bs.k < r.width / 2 ? r.width - 116 : 12;
  L.style.display = 'block';
  L.style.left = `${lx}px`; L.style.top = '12px';
  const lc = L.getContext('2d');
  lc.clearRect(0, 0, 104, 104);
  lc.drawImage(bs.src, cur.x - span / 2, cur.y - span / 2, span, span, 0, 0, 104, 104);
  lc.strokeStyle = '#fff'; lc.lineWidth = 1.5;
  lc.beginPath(); lc.moveTo(52, 40); lc.lineTo(52, 64); lc.moveTo(40, 52); lc.lineTo(64, 52); lc.stroke();
  bsDrawOverlay();
}

function bsLayout() {
  const d = bs.dom;
  const sw = d['bs-stage'].clientWidth, sh = d['bs-stage'].clientHeight - 30;
  bs.k = Math.min(sw / bs.src.width, sh / bs.src.height);
  const w = Math.round(bs.src.width * bs.k), h = Math.round(bs.src.height * bs.k);
  const wrap = d['bs-wrap'];
  wrap.style.width = `${w}px`; wrap.style.height = `${h}px`;
  wrap.style.left = `${Math.round((sw - w) / 2)}px`; wrap.style.top = `${Math.round((sh - h) / 2) + 4}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = d['bs-canvas'];
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  c.getContext('2d').drawImage(bs.src, 0, 0, c.width, c.height);
  const svg = d['bs-svg'];
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
}

function bsDrawOverlay() {
  const k = bs.k;
  const q = bs.quad.map((p) => `${p.x * k},${p.y * k}`).join(' ');
  let html = `<polygon points="${q}" fill="rgba(79,139,255,.16)" stroke="#6ea0ff" stroke-width="2" stroke-linejoin="round"/>`;
  if (bs.split) {
    const [TL, TR, BR, BL] = bs.quad;
    const a = lerpPt(TL, TR, bs.spine[0]), b = lerpPt(BL, BR, bs.spine[1]);
    html += `<line x1="${a.x * k}" y1="${a.y * k}" x2="${b.x * k}" y2="${b.y * k}" stroke="#ffe078" stroke-width="2.5" stroke-dasharray="7 5"/>`;
  }
  for (const h of bsHandles()) {
    const col = h.kind === 'spine' ? '#ffd24a' : '#fff';
    html += `<circle cx="${h.x * k}" cy="${h.y * k}" r="11" fill="${col}" fill-opacity=".92" stroke="#2f4fd1" stroke-width="2.5"/>`;
  }
  bs.dom['bs-svg'].innerHTML = html;
}

function bsPageQuads() {
  if (!bs.split) return [bs.quad];
  const [TL, TR, BR, BL] = bs.quad;
  const st = lerpPt(TL, TR, bs.spine[0]), sb = lerpPt(BL, BR, bs.spine[1]);
  return [[TL, st, sb, BL], [st, TR, BR, sb]];
}

function bsRenderPage(q, maxSide) {
  const flat = bs.flatten ? warpQuad(bs.src, q, ...outSize(q, maxSide)) : cropBounds(bs.src, q, maxSide);
  return applyScanFilter(flat, bs.filter);
}

async function bsRenderPreview() {
  const box = bs.dom['bs-preview'];
  bsBusy(true);
  await sleep(30);
  box.replaceChildren();
  for (const q of bsPageQuads()) {
    const c = bsRenderPage(q, 760);
    box.append(c);
    await sleep(0);
  }
  bsBusy(false);
}

function bsBusy(on) { bs.dom['bs-busy'].hidden = !on; }

// 버튼 모양·안내 문구·화면 전환을 지금 상태에 맞춤
function bsRefresh() {
  const d = bs.dom;
  d['bs-split'].classList.toggle('on', bs.split);
  d['bs-flat'].classList.toggle('on', bs.flatten);
  d['bs-count'].textContent = bookPages.length ? `찍어 둔 ${bookPages.length}쪽` : '';
  const preview = bs.view === 'preview';
  d['bs-wrap'].hidden = preview;
  d['bs-preview'].hidden = !preview;
  d['bs-view'].textContent = preview ? '모서리 맞추기' : '결과 보기';
  d['bs-hint'].textContent = preview
    ? '이렇게 저장됩니다 · 모서리 맞추기로 돌아가 고칠 수 있어요'
    : bs.split ? '흰 점은 책 모서리, 노란 점은 두 쪽 경계(제본선)에 맞게 끌어 주세요' : '흰 점 네 개를 책·문서 모서리에 맞게 끌어 주세요';
  if (preview) bsRenderPreview();
  else { bsLayout(); bsDrawOverlay(); }
}

// 모서리를 자동으로 찾는다. 못 찾으면 안쪽 여백만 둔 기본 사각형
async function bsAutoFit(announce) {
  bsBusy(true);
  await sleep(30);
  const { src } = bs;
  let q = null;
  try { q = detectQuad(src); } catch (err) { console.warn('모서리 찾기 실패', err); }
  const found = !!q;
  if (!q) {
    const mx = src.width * 0.06, my = src.height * 0.08;
    q = [{ x: mx, y: my }, { x: src.width - mx, y: my }, { x: src.width - mx, y: src.height - my }, { x: mx, y: src.height - my }];
  }
  bs.quad = q;
  if (bs.split) { const t = await bsSpineGuess(); bs.spine = [t, t]; }
  bsBusy(false);
  bsRefresh();
  if (announce) bs.dom['bs-hint'].textContent = found ? '자동으로 맞췄어요. 어긋난 점은 끌어서 고치세요' : '자동으로 찾지 못했어요. 점을 직접 끌어 맞춰 주세요';
}

async function openBookEditor() {
  if (!hasPhoto) return;
  const d = bsEnsureDom();
  bs.src = canvas; // 사진 화면의 캔버스 (읽기만 함)
  bs.src._stamp = (bs.src._stamp || 0) + 1;
  srcDataFor = null;
  bs.view = 'edit';
  bs.split = bookMode() === 'spread';
  bs.flatten = true;
  bs.filter = document.querySelector('input[name="bs-filter"]:checked').value;
  d.bs.hidden = false;
  if (region) {
    bs.quad = [
      { x: region.left, y: region.top }, { x: region.left + region.width, y: region.top },
      { x: region.left + region.width, y: region.top + region.height }, { x: region.left, y: region.top + region.height },
    ];
    bs.spine = [0.5, 0.5];
    bsRefresh();
  } else {
    bs.quad = [{ x: 0, y: 0 }, { x: bs.src.width, y: 0 }, { x: bs.src.width, y: bs.src.height }, { x: 0, y: bs.src.height }];
    bsRefresh();
    await bsAutoFit(true);
  }
}

function bsClose() {
  bs.dom.bs.hidden = true;
  bs.drag = null;
}

// 지금 사진을 쪽(들)로 만들어 쌓는다
async function bsCommit(then) {
  bsBusy(true);
  await sleep(30);
  try {
    for (const q of bsPageQuads()) {
      const c = bsRenderPage(q, 2200);
      const jpeg = await canvasToJpeg(c, 0.88);
      const t = document.createElement('canvas');
      const k = 160 / Math.max(c.width, c.height);
      t.width = Math.max(1, Math.round(c.width * k)); t.height = Math.max(1, Math.round(c.height * k));
      t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
      bookPages.push({ jpeg, w: c.width, h: c.height, thumb: t.toDataURL('image/jpeg', 0.7) });
      await sleep(0);
    }
  } catch (err) {
    console.error(err);
    bsBusy(false);
    bs.dom['bs-hint'].textContent = `오류: ${err.message || err}`;
    return;
  }
  bsBusy(false);
  bsClose();
  updateBookBar();
  if (then === 'next') setMode('camera');
  else openBookFinish();
}

/* ---------- 저장 ---------- */

function openBookFinish() {
  if (!bookPages.length) return;
  const thumbs = bookPages.map((p, i) => `<div class="thumb"><img src="${p.thumb}" alt="${i + 1}쪽"><em>${i + 1}</em>`
    + `${i ? `<button class="mv" data-mv="${i}" title="앞으로" aria-label="앞으로">‹</button>` : ''}<button data-del="${i}" title="삭제" aria-label="삭제">✕</button></div>`).join('');
  const fmt = (v, label) => `<label><input type="radio" name="bf-format" value="${v}"${bookFormat === v ? ' checked' : ''}><span>${label}</span></label>`;
  openForm(`스캔 저장 · ${bookPages.length}쪽`, [], [
    { label: '저장', primary: true, keep: true, async run() {
      setStatus(formStatus, '만드는 중…');
      if (bookFormat === 'pdf') {
        await saveOrShare(makePdf(bookPages), timestampName('pdf'), 'application/pdf', '스캔 PDF 저장');
      } else {
        const pad = (n) => String(n).padStart(2, '0');
        await saveOrShareMany(bookPages.map((p, i) => ({ bytes: p.jpeg, filename: timestampName('jpg', `_${pad(i + 1)}`), mime: 'image/jpeg' })), '스캔 이미지 저장');
      }
      setStatus(formStatus, '완료');
      return 'keep';
    } },
    { label: '더 촬영', run() { if (!inCameraMode()) setMode('camera'); } },
    { label: '모두 지우기', run() { resetBook(); } },
  ], `<div class="thumbs">${thumbs}</div><div class="seg" style="margin:0 0 12px">${fmt('pdf', 'PDF 한 파일')}${fmt('jpg', 'JPG 여러 장')}</div>`);
  formOverlay.querySelectorAll('input[name="bf-format"]').forEach((el) => el.addEventListener('change', () => { bookFormat = el.value; }));
  formOverlay.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => {
    bookPages.splice(Number(el.dataset.del), 1);
    updateBookBar();
    if (bookPages.length) openBookFinish(); else closeForm();
  }));
  formOverlay.querySelectorAll('[data-mv]').forEach((el) => el.addEventListener('click', () => {
    const i = Number(el.dataset.mv);
    [bookPages[i - 1], bookPages[i]] = [bookPages[i], bookPages[i - 1]];
    openBookFinish();
  }));
}

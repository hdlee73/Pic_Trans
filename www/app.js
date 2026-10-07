'use strict';

const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('canvas');
const selection = $('selection');
const cameraMsg = $('camera-msg');
const photoHint = $('photo-hint');
const ocrText = $('ocr-text');
const transText = $('trans-text');
const ocrStatus = $('ocr-status');
const transStatus = $('trans-status');
const ocrLang = $('ocr-lang');
const media = $('media');
const popup = $('popup');
const btnFull = $('btn-full');
const btnTranslate = $('btn-translate');
const autoRun = $('auto-run');

// Tesseract 언어 코드 → MyMemory 언어 코드 (예비 번역 서버용)
const LANG_MAP = {
  eng: 'en', jpn: 'ja', chi_sim: 'zh-CN', chi_tra: 'zh-TW', fra: 'fr',
  deu: 'de', spa: 'es', rus: 'ru', vie: 'vi', tha: 'th',
  // 세로쓰기 전용 모델
  jpn_vert: 'ja', chi_sim_vert: 'zh-CN', chi_tra_vert: 'zh-TW',
};

// 앱 안에 포함된 OCR 파일 (npm run vendor). 없으면 CDN에서 받는다
const VENDOR = 'vendor/tesseract/';
const BUNDLED_LANGS = ['eng'];

// 사진 긴 변의 최대 크기. 너무 크면 휴대폰에서 인식이 느려짐
const MAX_SIDE = 3000;

// 상태 글자. "오류:" 로 시작하면 오류 색으로 표시
function setStatus(el, text) {
  el.textContent = text;
  el.classList.toggle('error', text.startsWith('오류'));
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 저장 못 해도 동작에는 지장 없음 */ } },
};

let stream = null;
let cameraRun = 0;
let facingMode = 'environment';
let hasPhoto = false;
let region = null; // 인식할 영역 (사진 좌표). null 이면 사진 전체

/* ---------- 화면 모드: 카메라 ↔ 사진 ---------- */

function setMode(mode) {
  document.body.classList.toggle('mode-camera', mode === 'camera');
  document.body.classList.toggle('mode-photo', mode === 'photo');
  const photo = mode === 'photo';
  video.hidden = photo;
  canvas.hidden = !photo;
  photoHint.hidden = !photo;
  if (!photo) closePopup();
  $('camera-controls').hidden = photo;
  $('photo-controls').hidden = !photo;
  if (photo) {
    stopCamera();
    cameraMsg.hidden = true;
  } else {
    clearRegion();
    resetView();
    startCamera();
  }
}

/* ---------- 카메라 ---------- */

async function startCamera() {
  stopCamera();
  const run = ++cameraRun;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraMsg.hidden = false;
    cameraMsg.textContent = '이 기기는 카메라를 지원하지 않습니다. 갤러리 버튼으로 사진을 선택하세요.';
    return;
  }
  cameraMsg.hidden = false;
  cameraMsg.textContent = '카메라를 시작하는 중…';
  try {
    // 글자 인식을 위해 가능한 한 높은 해상도로 요청
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false,
    });
    // 카메라가 켜지는 사이에 다시 요청됐거나 사진 화면으로 바뀌었으면 이 스트림은 버린다
    if (run !== cameraRun || !document.body.classList.contains('mode-camera')) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    video.srcObject = stream;
    cameraMsg.hidden = true;
  } catch (err) {
    if (run !== cameraRun) return;
    cameraMsg.hidden = false;
    cameraMsg.textContent = `카메라를 열 수 없습니다 (${err.name}). 카메라 권한을 허용했는지 확인하세요.`;
  }
}

function stopCamera() {
  cameraRun++; // 켜지는 중인 카메라도 취소
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

$('btn-switch').addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
});

$('btn-capture').addEventListener('click', () => {
  if (!stream || !video.videoWidth) {
    alert('카메라가 준비되지 않았습니다.');
    return;
  }
  // 화면에 보이는 부분(꽉 채움)만 사진으로 저장
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.max(video.clientWidth / vw, video.clientHeight / vh);
  const sw = Math.min(vw, video.clientWidth / k), sh = Math.min(vh, video.clientHeight / k);
  drawToCanvas(video, sw, sh, { x: (vw - sw) / 2, y: (vh - sh) / 2 });
});

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});

$('btn-retake').addEventListener('click', () => setMode('camera'));

// 자동으로 방향을 못 맞출 때를 위한 수동 회전
$('btn-rotate').addEventListener('click', () => {
  if (!hasPhoto) return;
  const rotated = rotateCanvas(canvas, 90);
  canvas.width = rotated.width;
  canvas.height = rotated.height;
  canvas.getContext('2d').drawImage(rotated, 0, 0);
  lastTranslated = null;
  clearRegion();
  resetView();
  if (autoRun.checked) runOcr();
});

/* ---------- 찍은 사진 ---------- */

function drawToCanvas(source, w, h, crop = { x: 0, y: 0 }) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, crop.x, crop.y, w, h, 0, 0, canvas.width, canvas.height);
  hasPhoto = true;
  lastTranslated = null;
  clearRegion();
  resetView();
  setMode('photo');
  if (autoRun.checked) runOcr();
}

/* ---------- 인식 영역 선택 (사진 위를 드래그) ---------- */

// 화면에 보이는 사진의 위치·크기 (object-fit: contain 으로 생긴 여백 제외)
function imageBox() {
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, scale };
}

function toImage(e, box) {
  return {
    x: Math.max(0, Math.min(canvas.width, (e.clientX - box.left) / box.scale)),
    y: Math.max(0, Math.min(canvas.height, (e.clientY - box.top) / box.scale)),
  };
}

function showSelection(rect) {
  if (!rect) { selection.hidden = true; return; }
  const box = imageBox();
  const parent = zoomer.getBoundingClientRect();
  const k = box.scale / view.scale; // 확대된 상태의 화면 좌표 → 확대 전 좌표
  selection.hidden = false;
  selection.style.left = `${(box.left - parent.left) / view.scale + rect.left * k}px`;
  selection.style.top = `${(box.top - parent.top) / view.scale + rect.top * k}px`;
  selection.style.width = `${rect.width * k}px`;
  selection.style.height = `${rect.height * k}px`;
}

function clearRegion() {
  region = null;
  showSelection(null);
  btnFull.hidden = true;
}

/* ---------- 사진 확대·이동 ---------- */

// 사진과 선택 영역을 함께 확대하기 위해 한 덩어리로 묶는다
const zoomer = document.createElement('div');
zoomer.className = 'zoomer';
canvas.before(zoomer);
zoomer.append(canvas, selection);

const MAX_ZOOM = 8;
const view = { scale: 1, x: 0, y: 0 };

function applyView() {
  const r = media.getBoundingClientRect();
  view.scale = Math.max(1, Math.min(MAX_ZOOM, view.scale));
  // 사진이 화면 밖으로 벗어나지 않게
  view.x = Math.min(0, Math.max(r.width * (1 - view.scale), view.x));
  view.y = Math.min(0, Math.max(r.height * (1 - view.scale), view.y));
  zoomer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomer.style.setProperty('--z', view.scale);
}

function resetView() {
  view.scale = 1; view.x = 0; view.y = 0;
  applyView();
}

// (cx, cy: 화면 좌표) 지점이 제자리에 있도록 scale 로 확대·축소
function zoomAt(cx, cy, scale, from = view) {
  const r = media.getBoundingClientRect();
  const next = Math.max(1, Math.min(MAX_ZOOM, scale));
  const px = (cx - r.left - from.x) / from.scale;
  const py = (cy - r.top - from.y) / from.scale;
  view.scale = next;
  view.x = cx - r.left - px * next;
  view.y = cy - r.top - py * next;
  applyView();
}

media.addEventListener('wheel', (e) => {
  if (!hasPhoto || !document.body.classList.contains('mode-photo')) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.002));
}, { passive: false });

/* ---------- 인식 영역 선택 (한 손가락 드래그) · 확대 (두 손가락) ---------- */

let drag = null;
const pointers = new Map();
let pinch = null;
let gestureActive = false; // 두 손가락을 쓴 동안에는 남은 손가락이 영역 선택을 시작하지 않게
let lastTap = 0;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!hasPhoto) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2) {
    // 두 번째 손가락: 영역 선택을 취소하고 확대 시작
    drag = null;
    showSelection(region);
    gestureActive = true;
    pinch = { ...pinchState(), from: { ...view } };
    return;
  }
  if (gestureActive) return;
  const box = imageBox();
  drag = { box, start: toImage(e, box), rect: null };
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const now = pinchState();
    const r = media.getBoundingClientRect();
    // 처음 두 손가락 가운데 지점의 사진 위치가 지금 가운데 지점에 오도록
    const px = (pinch.cx - r.left - pinch.from.x) / pinch.from.scale;
    const py = (pinch.cy - r.top - pinch.from.y) / pinch.from.scale;
    view.scale = Math.max(1, Math.min(MAX_ZOOM, pinch.from.scale * now.dist / pinch.dist));
    view.x = now.cx - r.left - px * view.scale;
    view.y = now.cy - r.top - py * view.scale;
    applyView();
    return;
  }
  if (!drag) return;
  const p = toImage(e, drag.box);
  const s = drag.start;
  drag.rect = {
    left: Math.round(Math.min(s.x, p.x)),
    top: Math.round(Math.min(s.y, p.y)),
    width: Math.round(Math.abs(p.x - s.x)),
    height: Math.round(Math.abs(p.y - s.y)),
  };
  showSelection(drag.rect);
});

function endDrag(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) gestureActive = false;
  if (!drag) return;
  const { rect, box } = drag;
  drag = null;
  // 화면에서 20px 보다 작은 드래그는 단순 터치로 보고 무시
  if (!rect || rect.width * box.scale < 20 || rect.height * box.scale < 20) {
    showSelection(region);
    // 빠르게 두 번 누르면 확대 ↔ 원래 크기
    if (e.type === 'pointerup' && Date.now() - lastTap < 300) {
      lastTap = 0;
      if (view.scale > 1) resetView(); else zoomAt(e.clientX, e.clientY, 2.5);
    } else {
      lastTap = Date.now();
    }
    return;
  }
  region = rect;
  btnFull.hidden = false;
  photoHint.hidden = true;
  runOcr();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

btnFull.addEventListener('click', () => {
  clearRegion();
  runOcr();
});

// 접기·펼치기·회전으로 화면 크기가 바뀌면 선택 영역 표시 위치를 다시 계산
window.addEventListener('resize', () => { applyView(); showSelection(region); });

/* ---------- 문자 추출 (OCR) ---------- */

// vendor 폴더의 Tesseract 가 로드됐는지 (실패해서 CDN 으로 대체했으면 false)
const vendorLoaded = !document.querySelector('script[src*="cdn.jsdelivr.net"]');

const OCR_STAGES = {
  'loading tesseract core': 'OCR 엔진 불러오는 중…',
  'initializing tesseract': 'OCR 엔진 시작 중…',
  'loading language traineddata': '언어 데이터 불러오는 중…',
  'initializing api': 'OCR 엔진 시작 중…',
};

// local: 앱에 포함된 파일 사용, false 면 CDN 에서 받음
function workerOptions(lang, local) {
  const opts = {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        setStatus(ocrStatus, `${passLabel}인식 중… ${Math.round(m.progress * 100)}%`);
      } else if (OCR_STAGES[m.status]) {
        setStatus(ocrStatus, OCR_STAGES[m.status]);
      }
    },
  };
  if (local) {
    opts.workerPath = `${VENDOR}worker.min.js`;
    opts.corePath = `${VENDOR}core`;
    if (BUNDLED_LANGS.includes(lang)) {
      // 안드로이드 빌드가 .gz 파일을 풀어서 넣으므로 압축하지 않은 파일을 쓴다
      opts.langPath = `${VENDOR}lang`;
      opts.gzip = false;
    }
  }
  return opts;
}

// Tesseract 는 언어 데이터를 못 받으면 오류 없이 영원히 기다리므로
// 오류 콜백과 시간 제한으로 실패를 알아챈다
function startWorker(lang, local) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => fail(new Error('시간 초과')), local ? 45000 : 120000);
    Tesseract.createWorker(lang, 1, { ...workerOptions(lang, local), errorHandler: fail })
      .then((w) => {
        if (done) { w.terminate().catch(() => {}); return; }
        done = true;
        clearTimeout(timer);
        resolve(w);
      }, fail);
  });
}

async function createOcrWorker(lang) {
  if (vendorLoaded) {
    try {
      return await startWorker(lang, true);
    } catch (err) {
      console.warn('앱에 포함된 OCR 엔진을 쓰지 못해 CDN 으로 재시도', err);
    }
  }
  try {
    return await startWorker(lang, false);
  } catch (err) {
    console.error(err);
    throw new Error('OCR 엔진을 준비하지 못했습니다. 인터넷 연결을 확인하고 "번역"을 다시 눌러 주세요');
  }
}

let worker = null;
let workerLang = null;
let workerChain = Promise.resolve();

// 엔진 생성·교체를 한 번에 하나씩 처리
function getWorker(lang) {
  workerChain = workerChain.catch(() => {}).then(async () => {
    if (worker && workerLang === lang) return worker;
    if (worker) {
      await worker.terminate().catch(() => {});
      worker = null;
      workerLang = null;
    }
    const w = await createOcrWorker(lang);
    await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    worker = w;
    workerLang = lang;
    return w;
  });
  return workerChain;
}

let wantTranslate = false; // 번역 버튼을 눌러서 결과를 기다리는 중
let ocrBusy = false;
let ocrPending = false;

async function runOcr() {
  if (!hasPhoto) return;
  // 인식 중에 새 사진·영역·언어 변경이 들어오면 끝난 뒤 다시 실행
  if (ocrBusy) { ocrPending = true; return; }
  ocrBusy = true;
  btnTranslate.disabled = true;
  ocrText.value = '';
  transText.value = '';
  setStatus(transStatus, '');
  setStatus(ocrStatus, '준비 중…');
  try {
    const lang = ocrLang.value;
    const w = await getWorker(lang);
    const data = await recognizeBest(w, region ? cropRegion(region) : canvas, lang);
    const text = extractText(data, lang);
    ocrText.value = text;
    setStatus(ocrStatus, text ? '완료' : '문자를 찾지 못했습니다. 글자 부분을 드래그해 보세요');
    btnTranslate.disabled = !text;
    // 번역 버튼을 눌러 기다리는 중이었다면 이어서 번역
    if (text && wantTranslate && !ocrPending) runTranslate();
  } catch (err) {
    console.error(err);
    setStatus(ocrStatus, `오류: ${err.message || err}`);
  } finally {
    ocrBusy = false;
    if (ocrPending) { ocrPending = false; runOcr(); }
  }
}

// 사진을 시계 방향으로 degrees(90·180·270)만큼 돌린 새 캔버스
function rotateCanvas(source, degrees) {
  const quarter = degrees % 180 !== 0;
  const out = document.createElement('canvas');
  out.width = quarter ? source.height : source.width;
  out.height = quarter ? source.width : source.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return out;
}

// 글자가 옆으로 누워 있거나 거꾸로여도 읽도록, 결과가 시원찮으면 사진을 돌려서 다시 인식한다
const ROTATIONS = [0, 90, 270, 180];
const GOOD_AVERAGE = 80;
const GOOD_CHARS = 3;

let passLabel = '';

async function recognizeBest(w, source, lang) {
  let best = null;
  for (let i = 0; i < ROTATIONS.length; i++) {
    const degrees = ROTATIONS[i];
    passLabel = i === 0 ? '' : `방향 바꿔 재시도 ${i}/${ROTATIONS.length - 1} · `;
    if (i > 0) setStatus(ocrStatus, `${passLabel}인식 중…`);
    const { data } = await w.recognize(degrees ? rotateCanvas(source, degrees) : source);
    const result = scoreResult(data, lang);
    if (!best || result.score > best.result.score) best = { data, result };
    if (result.average >= GOOD_AVERAGE && result.chars >= GOOD_CHARS) break;
    if (ocrPending) break; // 새 요청이 들어왔으면 더 시도하지 않음
  }
  passLabel = '';
  return best.data;
}

// 선택 영역을 잘라 확대한다. 작은 글자는 크게 키워야 잘 인식됨
function cropRegion(r) {
  const scale = Math.max(1, Math.min(3, 1600 / r.width));
  const pad = 20; // 가장자리 글자가 잘리지 않도록 여백
  const out = document.createElement('canvas');
  out.width = Math.round(r.width * scale) + pad * 2;
  out.height = Math.round(r.height * scale) + pad * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, r.left, r.top, r.width, r.height,
    pad, pad, out.width - pad * 2, out.height - pad * 2);
  return out;
}

// 신뢰도가 낮은 줄(아이콘·그림을 글자로 잘못 읽은 것)은 버린다.
// 한자·가나는 정상적으로 읽어도 줄 신뢰도가 낮게 나오므로 기준을 낮춘다
const MIN_LINE_CONFIDENCE = 55;
const MIN_LINE_CONFIDENCE_CJK = 40;

// 한 글자로도 뜻이 있는 언어 (한자·가나·태국 문자)
const SINGLE_CHAR_LANGS = ['jpn', 'chi_sim', 'chi_tra', 'tha', 'jpn_vert', 'chi_sim_vert', 'chi_tra_vert'];

// 인식 결과에서 쓸 만한 줄만 고른다
function minConfidenceFor(lang) {
  return SINGLE_CHAR_LANGS.includes(lang) ? MIN_LINE_CONFIDENCE_CJK : MIN_LINE_CONFIDENCE;
}

function readLines(data, lang, minConfidence) {
  const minChars = SINGLE_CHAR_LANGS.includes(lang) ? 1 : 2;
  return (data.lines || [])
    .map((l) => ({
      text: fixCommonErrors(l.text.trim(), lang),
      confidence: l.confidence,
      chars: (l.text.match(/[\p{L}\p{N}]/gu) || []).length,
    }))
    .filter((l) => l.confidence >= minConfidence && l.chars >= minChars);
}

function extractText(data, lang) {
  if (!(data.lines || []).length) return cleanText(data.text || '');
  let lines = readLines(data, lang, minConfidenceFor(lang));
  if (!lines.length) lines = readLines(data, lang, 30);
  return cleanText(lines.map((l) => l.text).join('\n'));
}

// 인식이 잘 됐는지 점수 매기기: 읽은 글자 수 × 신뢰도
function scoreResult(data, lang) {
  const lines = readLines(data, lang, minConfidenceFor(lang));
  const chars = lines.reduce((n, l) => n + l.chars, 0);
  const weighted = lines.reduce((n, l) => n + l.chars * l.confidence, 0);
  return { chars, score: weighted / 100, average: chars ? weighted / chars : 0 };
}

// 영어에서 자주 틀리는 글자 보정: 단독으로 쓰인 "|" 는 대문자 I
function fixCommonErrors(text, lang) {
  if (lang !== 'eng') return text;
  return text.replace(/(^|\s)\|(?=\s|'|’)/g, '$1I');
}

function cleanText(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()))
    .join('\n')
    .trim();
}


const savedLang = store.get('ocrLang');
if (savedLang && LANG_MAP[savedLang]) ocrLang.value = savedLang;
else ocrLang.value = 'eng';

ocrLang.addEventListener('change', () => {
  store.set('ocrLang', ocrLang.value);
  if (hasPhoto) runOcr();
  else getWorker(ocrLang.value).catch(() => {});
});
ocrText.addEventListener('input', () => { btnTranslate.disabled = !ocrText.value.trim(); });

/* ---------- 한국어 번역 ---------- */

// 앱(Capacitor)에서는 fetch 가 네이티브 HTTP 로 처리되어 CORS 제약이 없음 (capacitor.config.json)
async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('번역 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요');
  }
  if (!res.ok) throw new Error(`번역 서버 응답 오류 (HTTP ${res.status})`);
  return res.json();
}

// 줄 단위로 묶어서 요청 수를 줄인다 (요청이 많으면 무료 서버가 차단함)
function splitChunks(text, limit) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    const next = cur ? `${cur}\n${rest}` : rest;
    if (next.length > limit) { chunks.push(cur); cur = rest; } else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// 1순위: Google 번역 (언어 자동 감지)
async function translateGoogle(text) {
  const out = [];
  for (const chunk of splitChunks(text, 1500)) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q='
      + encodeURIComponent(chunk);
    const json = await getJson(url);
    if (!Array.isArray(json?.[0])) throw new Error('번역 결과를 읽지 못했습니다');
    out.push(json[0].map((s) => s?.[0] ?? '').join(''));
  }
  return out.join('\n');
}

// 2순위: MyMemory (선택한 언어 기준)
async function translateMyMemory(text, source) {
  const out = [];
  for (const chunk of splitChunks(text, 450)) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${source}|ko`;
    const json = await getJson(url);
    if (json.responseStatus !== 200 && json.responseStatus !== '200') {
      throw new Error(json.responseDetails || '번역 실패');
    }
    out.push(json.responseData.translatedText);
  }
  return out.join('\n');
}

let transRun = 0;
let lastTranslated = null; // 마지막으로 번역한 원문

async function runTranslate() {
  const text = ocrText.value.trim();
  if (!text) return;
  const run = ++transRun; // 새 번역이 시작되면 이전 번역 결과는 버림
  btnTranslate.disabled = true;
  transText.value = '';
  lastTranslated = null;
  wantTranslate = false;
  setStatus(transStatus, '번역 중…');
  try {
    let result;
    try {
      result = await translateGoogle(text);
    } catch (err) {
      console.warn('Google 번역 실패, MyMemory 로 재시도', err);
      result = await translateMyMemory(text, LANG_MAP[ocrLang.value] || 'en');
    }
    if (run !== transRun) return;
    transText.value = result;
    lastTranslated = text;
    setStatus(transStatus, '완료');
  } catch (err) {
    console.error(err);
    if (run === transRun) setStatus(transStatus, `오류: ${err.message}`);
  } finally {
    if (run === transRun) btnTranslate.disabled = false;
  }
}

btnTranslate.addEventListener('click', runTranslate);

/* ---------- 번역 결과 팝업 ---------- */

function closePopup() {
  popup.hidden = true;
  wantTranslate = false;
}

// 번역 버튼: 팝업을 열고, 아직 추출·번역 전이면 이어서 진행
$('btn-open-result').addEventListener('click', () => {
  if (!hasPhoto) return;
  popup.hidden = false;
  const text = ocrText.value.trim();
  if (ocrBusy) {
    wantTranslate = true; // 인식이 끝나면 바로 번역
  } else if (!text) {
    wantTranslate = true;
    runOcr();
  } else if (lastTranslated !== text) {
    runTranslate();
  }
});

$('btn-close-result').addEventListener('click', closePopup);
popup.addEventListener('click', (e) => { if (e.target === popup) closePopup(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !popup.hidden) closePopup(); });

$('btn-copy').addEventListener('click', async () => {
  if (!transText.value) return;
  try {
    await navigator.clipboard.writeText(transText.value);
    setStatus(transStatus, '복사됨');
  } catch {
    transText.select();
    document.execCommand('copy');
  }
});

/* ---------- 시작 ---------- */

setMode('camera');
// 첫 촬영 때 기다리지 않도록 OCR 엔진을 미리 준비
getWorker(ocrLang.value).catch((err) => console.warn('OCR 준비 실패', err));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (!document.body.classList.contains('mode-photo')) startCamera();
});

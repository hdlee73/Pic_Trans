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
const btnOcr = $('btn-ocr');
const btnFull = $('btn-full');
const btnTranslate = $('btn-translate');
const autoRun = $('auto-run');

// Tesseract 언어 코드 → MyMemory 언어 코드 (예비 번역 서버용)
const LANG_MAP = {
  eng: 'en', jpn: 'ja', chi_sim: 'zh-CN', chi_tra: 'zh-TW', fra: 'fr',
  deu: 'de', spa: 'es', rus: 'ru', vie: 'vi', tha: 'th',
};

// 앱 안에 포함된 OCR 파일 (npm run vendor). 없으면 CDN에서 받는다
const VENDOR = 'vendor/tesseract/';
const BUNDLED_LANGS = ['eng'];

// 사진 긴 변의 최대 크기. 너무 크면 휴대폰에서 인식이 느려짐
const MAX_SIDE = 3000;

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
  $('camera-controls').hidden = photo;
  $('photo-controls').hidden = !photo;
  if (photo) {
    stopCamera();
    cameraMsg.hidden = true;
  } else {
    clearRegion();
    startCamera();
  }
}

/* ---------- 카메라 ---------- */

async function startCamera() {
  stopCamera();
  const run = ++cameraRun;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraMsg.hidden = false;
    cameraMsg.textContent = '이 기기는 카메라를 지원하지 않습니다. 🖼️ 버튼으로 사진을 선택하세요.';
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
  drawToCanvas(video, video.videoWidth, video.videoHeight);
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

/* ---------- 찍은 사진 ---------- */

function drawToCanvas(source, w, h) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  hasPhoto = true;
  clearRegion();
  setMode('photo');
  btnOcr.disabled = false;
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
  const parent = selection.parentElement.getBoundingClientRect();
  selection.hidden = false;
  selection.style.left = `${box.left - parent.left + rect.left * box.scale}px`;
  selection.style.top = `${box.top - parent.top + rect.top * box.scale}px`;
  selection.style.width = `${rect.width * box.scale}px`;
  selection.style.height = `${rect.height * box.scale}px`;
}

function clearRegion() {
  region = null;
  showSelection(null);
  btnFull.hidden = true;
}

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!hasPhoto) return;
  canvas.setPointerCapture(e.pointerId);
  const box = imageBox();
  drag = { box, start: toImage(e, box), rect: null };
});

canvas.addEventListener('pointermove', (e) => {
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

function endDrag() {
  if (!drag) return;
  const { rect, box } = drag;
  drag = null;
  // 화면에서 20px 보다 작은 드래그는 단순 터치로 보고 무시
  if (!rect || rect.width * box.scale < 20 || rect.height * box.scale < 20) {
    showSelection(region);
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
window.addEventListener('resize', () => showSelection(region));

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
        ocrStatus.textContent = `인식 중… ${Math.round(m.progress * 100)}%`;
      } else if (OCR_STAGES[m.status]) {
        ocrStatus.textContent = OCR_STAGES[m.status];
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
    throw new Error('OCR 엔진을 준비하지 못했습니다. 인터넷 연결을 확인하고 🔍 문자 추출을 다시 눌러 주세요');
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

let ocrBusy = false;
let ocrPending = false;

async function runOcr() {
  if (!hasPhoto) return;
  // 인식 중에 새 사진·영역·언어 변경이 들어오면 끝난 뒤 다시 실행
  if (ocrBusy) { ocrPending = true; return; }
  ocrBusy = true;
  btnOcr.disabled = true;
  btnTranslate.disabled = true;
  ocrText.value = '';
  transText.value = '';
  transStatus.textContent = '';
  ocrStatus.textContent = '준비 중…';
  try {
    const lang = ocrLang.value;
    const w = await getWorker(lang);
    const { data } = await w.recognize(region ? cropRegion(region) : canvas);
    const text = extractText(data, lang);
    ocrText.value = text;
    ocrStatus.textContent = text ? '완료' : '문자를 찾지 못했습니다. 글자 부분을 드래그해 보세요';
    btnTranslate.disabled = !text;
    if (text && autoRun.checked && !ocrPending) runTranslate();
  } catch (err) {
    console.error(err);
    ocrStatus.textContent = `오류: ${err.message || err}`;
  } finally {
    ocrBusy = false;
    btnOcr.disabled = false;
    if (ocrPending) { ocrPending = false; runOcr(); }
  }
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

// 신뢰도가 낮은 줄(아이콘·그림을 글자로 잘못 읽은 것)은 버린다
const MIN_LINE_CONFIDENCE = 55;

// 한 글자로도 뜻이 있는 언어 (한자·가나·태국 문자)
const SINGLE_CHAR_LANGS = ['jpn', 'chi_sim', 'chi_tra', 'tha'];

function extractText(data, lang) {
  const lines = data.lines || [];
  if (!lines.length) return cleanText(data.text || '');
  const minChars = SINGLE_CHAR_LANGS.includes(lang) ? 1 : 2;
  const good = (min) => lines
    .filter((l) => l.confidence >= min
      && (l.text.match(/[\p{L}\p{N}]/gu) || []).length >= minChars)
    .map((l) => fixCommonErrors(l.text.trim(), lang));
  let kept = good(MIN_LINE_CONFIDENCE);
  if (!kept.length) kept = good(30);
  return cleanText(kept.join('\n'));
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

btnOcr.addEventListener('click', runOcr);

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

async function runTranslate() {
  const text = ocrText.value.trim();
  if (!text) return;
  const run = ++transRun; // 새 번역이 시작되면 이전 번역 결과는 버림
  btnTranslate.disabled = true;
  transText.value = '';
  transStatus.textContent = '번역 중…';
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
    transStatus.textContent = '완료';
  } catch (err) {
    console.error(err);
    if (run === transRun) transStatus.textContent = `오류: ${err.message}`;
  } finally {
    if (run === transRun) btnTranslate.disabled = false;
  }
}

btnTranslate.addEventListener('click', runTranslate);

$('btn-copy').addEventListener('click', async () => {
  if (!transText.value) return;
  try {
    await navigator.clipboard.writeText(transText.value);
    transStatus.textContent = '복사됨';
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

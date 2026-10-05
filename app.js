'use strict';

const $ = (id) => document.getElementById(id);

const video = $('video');
const canvas = $('canvas');
const cameraMsg = $('camera-msg');
const photoMsg = $('photo-msg');
const ocrText = $('ocr-text');
const transText = $('trans-text');
const ocrStatus = $('ocr-status');
const transStatus = $('trans-status');
const ocrLang = $('ocr-lang');
const btnOcr = $('btn-ocr');
const btnTranslate = $('btn-translate');
const autoRun = $('auto-run');

// Tesseract 언어 코드 → 번역 API(MyMemory) 언어 코드
const LANG_MAP = {
  eng: 'en', jpn: 'ja', chi_sim: 'zh-CN', chi_tra: 'zh-TW', fra: 'fr',
  deu: 'de', spa: 'es', rus: 'ru', vie: 'vi', tha: 'th',
};

let stream = null;
let facingMode = 'environment';
let hasPhoto = false;

/* ---------- ① 카메라 ---------- */

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraMsg.textContent = '이 브라우저는 카메라를 지원하지 않습니다. "사진 선택"을 이용하세요.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    cameraMsg.hidden = true;
  } catch (err) {
    cameraMsg.hidden = false;
    cameraMsg.textContent = `카메라를 열 수 없습니다 (${err.name}). HTTPS 또는 localhost에서 실행하고 권한을 허용하세요.`;
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
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

/* ---------- ② 찍은 사진 ---------- */

function drawToCanvas(source, w, h) {
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  canvas.hidden = false;
  photoMsg.hidden = true;
  hasPhoto = true;
  btnOcr.disabled = false;
  if (autoRun.checked) runOcr();
}

/* ---------- ③ 문자 추출 (OCR) ---------- */

let worker = null;
let workerLang = null;

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) await worker.terminate();
  worker = await Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        ocrStatus.textContent = `인식 중… ${Math.round(m.progress * 100)}%`;
      } else if (m.status) {
        ocrStatus.textContent = '언어 데이터 준비 중…';
      }
    },
  });
  workerLang = lang;
  return worker;
}

let ocrBusy = false;
let ocrPending = false;

async function runOcr() {
  if (!hasPhoto) return;
  // 인식 중에 새 사진/언어 변경이 들어오면 끝난 뒤 다시 실행
  if (ocrBusy) { ocrPending = true; return; }
  ocrBusy = true;
  btnOcr.disabled = true;
  btnTranslate.disabled = true;
  ocrText.value = '';
  ocrStatus.textContent = '준비 중…';
  try {
    const w = await getWorker(ocrLang.value);
    const { data } = await w.recognize(canvas);
    const text = cleanText(data.text);
    ocrText.value = text;
    ocrStatus.textContent = text ? '완료' : '문자를 찾지 못했습니다';
    btnTranslate.disabled = !text;
    if (text && autoRun.checked && !ocrPending) runTranslate();
  } catch (err) {
    console.error(err);
    ocrStatus.textContent = '오류 발생';
    worker = null;
    workerLang = null;
  } finally {
    ocrBusy = false;
    btnOcr.disabled = false;
    if (ocrPending) { ocrPending = false; runOcr(); }
  }
}

function cleanText(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()))
    .join('\n')
    .trim();
}

btnOcr.addEventListener('click', runOcr);
ocrLang.addEventListener('change', () => { if (hasPhoto) runOcr(); });
ocrText.addEventListener('input', () => { btnTranslate.disabled = !ocrText.value.trim(); });

/* ---------- ④ 한국어 번역 ---------- */

// MyMemory 무료 번역 API: 요청당 최대 500바이트 정도이므로 문장 단위로 나눠 보냄
const CHUNK_LIMIT = 450;

function splitChunks(text) {
  const chunks = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) { chunks.push(''); continue; }
    let rest = line;
    while (rest.length > CHUNK_LIMIT) {
      let cut = rest.lastIndexOf(' ', CHUNK_LIMIT);
      if (cut <= 0) cut = CHUNK_LIMIT;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    chunks.push(rest);
  }
  return chunks;
}

async function translateChunk(text, source) {
  if (!text.trim()) return '';
  // 숫자·기호만 있는 줄은 그대로 둔다
  if (!/\p{L}/u.test(text)) return text;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|ko`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.responseStatus !== 200 && json.responseStatus !== '200') {
    throw new Error(json.responseDetails || '번역 실패');
  }
  return json.responseData.translatedText;
}

let transRun = 0;

async function runTranslate() {
  const text = ocrText.value.trim();
  if (!text) return;
  const run = ++transRun; // 새 번역이 시작되면 이전 번역 결과는 버림
  btnTranslate.disabled = true;
  transText.value = '';
  const source = LANG_MAP[ocrLang.value] || 'en';
  const chunks = splitChunks(text);
  const out = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      transStatus.textContent = `번역 중… ${i + 1}/${chunks.length}`;
      const translated = await translateChunk(chunks[i], source);
      if (run !== transRun) return;
      out.push(translated);
      transText.value = out.join('\n');
    }
    transStatus.textContent = '완료';
  } catch (err) {
    console.error(err);
    if (run === transRun) transStatus.textContent = `오류: ${err.message}`;
  } finally {
    btnTranslate.disabled = false;
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

startCamera();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else startCamera();
});

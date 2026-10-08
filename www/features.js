'use strict';

/* 카메라 활용 기능: 영수증 · 명함 · 표(CSV) · 단어장 · QR/바코드 · 실시간 번역
 * app.js 의 전역(canvas, region, sourceCanvas, runOcr, saveOrShare …)을 그대로 쓴다. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inCameraMode = () => document.body.classList.contains('mode-camera');

const db = {
  get(key) { try { return JSON.parse(store.get(key)) || []; } catch { return []; } },
  set(key, list) { store.set(key, JSON.stringify(list)); },
  add(key, item) { const l = db.get(key); l.unshift({ id: Date.now(), ...item }); db.set(key, l); },
  remove(key, id) { db.set(key, db.get(key).filter((x) => x.id !== id)); },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const today = () => new Date().toISOString().slice(0, 10);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* 복사 권한이 없으면 건너뜀 */ }
}

/* ---------- 공용 시트 ---------- */

const menuOverlay = $('menu-overlay');
const formOverlay = $('form-overlay');
const formStatus = $('form-status');

function closeForm() { formOverlay.hidden = true; }
formOverlay.addEventListener('click', (e) => { if (e.target === formOverlay) closeForm(); });

// fields: [{ key, label, value, type?, options? }]  actions: [{ label, primary?, keep?, run(values) }]
function openForm(title, fields, actions, extraHtml = '') {
  $('form-title').textContent = title;
  $('form-body').innerHTML = extraHtml + fields.map((f) => {
    const id = `f-${f.key}`;
    if (f.options) {
      return `<label class="field">${esc(f.label)}<select id="${id}">${f.options.map((o) => `<option${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'textarea') return `<label class="field">${esc(f.label)}<textarea id="${id}">${esc(f.value)}</textarea></label>`;
    return `<label class="field">${esc(f.label)}<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value)}"></label>`;
  }).join('');
  const values = () => Object.fromEntries(fields.map((f) => [f.key, $(`f-${f.key}`).value.trim()]));
  const box = $('form-actions');
  box.replaceChildren();
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn${a.primary ? ' primary' : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      try {
        setStatus(formStatus, '');
        const r = await a.run?.(values());
        if (r === 'keep') return; // 시트를 닫지 않음
        if (!a.keep) closeForm();
      } catch (err) {
        if (!/cancel/i.test(String(err?.message || err))) { console.error(err); setStatus(formStatus, `오류: ${err.message || err}`); }
      }
    });
    box.append(b);
  }
  setStatus(formStatus, '');
  formOverlay.hidden = false;
}

// 인식이 끝나길 기다렸다가 추출된 글자를 돌려준다 (아직 안 했으면 인식부터)
async function ensureText() {
  while (ocrBusy) await sleep(150);
  if (!ocrText.value.trim()) {
    await runOcr();
    while (ocrBusy) await sleep(150);
  }
  return ocrText.value.trim();
}

async function needText(title) {
  menuOverlay.hidden = true;
  openForm(title, [], [{ label: '닫기' }], '<p class="status">글자를 읽는 중…</p>');
  const text = await ensureText();
  if (!text) {
    $('form-body').innerHTML = '<p class="status error">글자를 찾지 못했습니다. 글자 부분을 드래그하거나 사진 언어를 바꿔 보세요.</p>';
    return null;
  }
  return text;
}

/* ---------- 기능 메뉴 ---------- */

$('btn-menu').addEventListener('click', () => {
  const camera = inCameraMode();
  menuOverlay.querySelectorAll('.menu-item').forEach((el) => {
    const needs = el.dataset.needs;
    el.disabled = (needs === 'photo' && (camera || !hasPhoto)) || (needs === 'camera' && !camera);
  });
  $('menu-note').textContent = camera ? '회색 기능은 사진을 찍은 뒤 쓸 수 있습니다' : '회색 기능은 카메라 화면에서 쓸 수 있습니다';
  menuOverlay.hidden = false;
});
$('menu-close').addEventListener('click', () => { menuOverlay.hidden = true; });
menuOverlay.addEventListener('click', (e) => { if (e.target === menuOverlay) menuOverlay.hidden = true; });

const ACTIONS = { receipt: openReceipt, card: openCard, table: openTable, vocab: openVocab, qr: () => startLive('qr'), ar: () => startLive('ar'), library: () => showLibrary() };
menuOverlay.querySelectorAll('.menu-item').forEach((el) => el.addEventListener('click', () => {
  menuOverlay.hidden = true;
  ACTIONS[el.dataset.act]?.();
}));

/* ---------- 영수증 가계부 ---------- */

const AMOUNT = /\d{1,3}(?:,\d{3})+|\d{3,}/g;
const TOTAL_WORDS = /합\s*계|총\s*액|총\s*금\s*액|결제\s*금액|받을\s*금액|청구\s*금액|total|amount\s*due|grand/i;
const pad2 = (n) => String(n).padStart(2, '0');

function parseDate(text) {
  let m = text.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (!m) m = text.match(/\b(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/);
  if (!m) return '';
  const y = m[1].length === 2 ? `20${m[1]}` : m[1];
  const mo = +m[2], d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad2(mo)}-${pad2(d)}` : '';
}

function parseReceipt(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const amounts = (s) => (s.match(AMOUNT) || []).map((n) => parseInt(n.replace(/,/g, ''), 10)).filter((n) => n >= 100);
  let total = 0;
  for (const l of lines) if (TOTAL_WORDS.test(l)) total = Math.max(total, ...amounts(l), 0);
  if (!total) total = Math.max(0, ...lines.flatMap(amounts));
  const store = lines.find((l) => (l.match(/[\p{L}]/gu) || []).length >= 2 && !parseDate(l) && !TOTAL_WORDS.test(l)) || '';
  return { store, date: parseDate(text) || today(), total };
}

async function openReceipt() {
  const text = await needText('영수증');
  if (!text) return;
  const r = parseReceipt(text);
  openForm('영수증 저장', [
    { key: 'store', label: '상호', value: r.store },
    { key: 'date', label: '날짜', value: r.date, type: 'date' },
    { key: 'total', label: '금액(원)', value: r.total || '', type: 'number' },
    { key: 'category', label: '분류', value: '식비', options: ['식비', '교통', '쇼핑', '의료', '문화', '기타'] },
  ], [
    { label: '저장', primary: true, run(v) { db.add('receipts', { ...v, total: Number(v.total) || 0 }); } },
    { label: '보관함', run() { showLibrary('receipts'); }, keep: true },
    { label: '닫기' },
  ]);
}

/* ---------- 명함 ---------- */

function parseCard(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const email = (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0];
  const phones = [...text.matchAll(/\+?\d[\d\s\-().]{7,}\d/g)].map((m) => m[0].trim());
  const phone = phones.find((p) => /010/.test(p.replace(/\D/g, ''))) || phones[0] || '';
  const plain = lines.filter((l) => !l.includes('@') && !/\d{3,}/.test(l));
  const company = plain.find((l) => /주식회사|\(주\)|㈜|Inc|Co\.|Ltd|Corp|Company|회사|연구소|대학/i.test(l)) || '';
  const TITLES = /^(대표|이사|팀장|과장|차장|부장|대리|사원|실장|본부장|교수|사장|원장|매니저|연구원|선임|책임|수석)/;
  const tokens = plain.filter((l) => l !== company).flatMap((l) => l.split(/\s+/));
  // 직함이 붙은 줄("홍길동 대표")의 이름을 우선
  const titled = plain.filter((l) => l.split(/\s+/).some((t) => TITLES.test(t))).flatMap((l) => l.split(/\s+/));
  const isName = (t) => /^[가-힣]{2,4}$/.test(t) && !TITLES.test(t);
  const name = titled.find(isName) || tokens.find(isName)
    || plain.find((l) => l !== company && /^[A-Za-z][A-Za-z .'-]{2,30}$/.test(l)) || '';
  return { name: name.replace(/\s/g, ''), company, phone, email };
}

function vcard(c) {
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${c.name}`, c.company && `ORG:${c.company}`, c.phone && `TEL;TYPE=CELL:${c.phone}`, c.email && `EMAIL:${c.email}`, 'END:VCARD']
    .filter(Boolean).join('\r\n');
}

const shareVcard = (c) => saveOrShare(new TextEncoder().encode(vcard(c)), `${(c.name || 'contact').replace(/[^\p{L}\p{N}]+/gu, '_')}.vcf`, 'text/vcard', '연락처로 보내기');

async function openCard() {
  const text = await needText('명함');
  if (!text) return;
  const c = parseCard(text);
  openForm('명함 저장', [
    { key: 'name', label: '이름', value: c.name },
    { key: 'company', label: '회사', value: c.company },
    { key: 'phone', label: '전화', value: c.phone, type: 'tel' },
    { key: 'email', label: '이메일', value: c.email, type: 'email' },
  ], [
    { label: '저장', primary: true, run(v) { db.add('cards', v); } },
    { label: '연락처로 보내기', run: (v) => { db.add('cards', v); return shareVcard(v); } },
    { label: '닫기' },
  ]);
}

/* ---------- 표 → CSV ---------- */

// 한 줄 안에서 글자 사이가 줄 높이보다 많이 벌어진 곳을 칸 경계로 본다
function tableRows(data) {
  const rows = [];
  for (const line of data.lines || []) {
    const words = (line.words || []).filter((w) => w.text.trim() && w.confidence >= 30);
    if (!words.length) continue;
    const gap = Math.max(12, (line.bbox.y1 - line.bbox.y0) * 0.9);
    const cells = [[words[0].text]];
    for (let i = 1; i < words.length; i++) {
      if (words[i].bbox.x0 - words[i - 1].bbox.x1 > gap) cells.push([words[i].text]);
      else cells[cells.length - 1].push(words[i].text);
    }
    rows.push(cells.map((c) => c.join(' ')));
  }
  return rows;
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

async function openTable() {
  menuOverlay.hidden = true;
  openForm('표 → CSV', [], [{ label: '닫기' }], '<p class="status">표를 읽는 중…</p>');
  const w = await getWorker(ocrLang.value);
  const { data } = await w.recognize(sourceCanvas());
  const rows = tableRows(data);
  if (!rows.length) { $('form-body').innerHTML = '<p class="status error">표를 찾지 못했습니다. 표 부분만 드래그해서 다시 해 보세요.</p>'; return; }
  const csv = toCsv(rows);
  openForm('표 → CSV', [{ key: 'csv', label: `${rows.length}줄 · 칸은 쉼표로 구분됩니다 (고쳐도 됩니다)`, value: csv, type: 'textarea' }], [
    // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙여 저장
    { label: 'CSV 저장', primary: true, keep: true, async run(v) { await saveOrShare(new TextEncoder().encode(`\uFEFF${v.csv}`), timestampName('csv'), 'text/csv', 'CSV 저장'); return 'keep'; } },
    { label: '복사', keep: true, async run(v) { await copyText(v.csv); setStatus(formStatus, '복사됨'); return 'keep'; } },
    { label: '닫기' },
  ]);
}

/* ---------- 단어장 ---------- */

function selectedText() {
  for (const el of [ocrText, transText]) {
    const s = el.value.slice(el.selectionStart, el.selectionEnd).trim();
    if (s) return { text: s, fromTrans: el === transText };
  }
  return { text: '', fromTrans: false };
}

async function openVocab(prefill) {
  const sel = prefill || selectedText();
  const fields = [
    { key: 'word', label: '단어·표현 (원문에서 고른 글자)', value: sel.fromTrans ? '' : sel.text },
    { key: 'meaning', label: '뜻', value: sel.fromTrans ? sel.text : '' },
  ];
  openForm('단어장에 담기', fields, [
    { label: '저장', primary: true, run(v) {
      if (!v.word) throw new Error('단어를 입력하세요');
      db.add('vocab', { ...v, lang: ocrLang.value });
    } },
    { label: '뜻 번역', keep: true, async run(v) {
      if (!v.word) throw new Error('단어를 입력하세요');
      setStatus(formStatus, '번역 중…');
      $('f-meaning').value = await translateGoogle(v.word);
      setStatus(formStatus, '');
      return 'keep';
    } },
    { label: '닫기' },
  ], '<p class="status">추출된 글자에서 단어를 길게 눌러 고른 뒤 이 기능을 쓰면 자동으로 채워집니다.</p>');
  if (fields[0].value && !fields[1].value) {
    try { $('f-meaning').value = await translateGoogle(fields[0].value); } catch { /* 직접 입력 가능 */ }
  }
}

// 번역 팝업에도 단어장 버튼을 둔다
(() => {
  const b = document.createElement('button');
  b.className = 'btn';
  b.type = 'button';
  b.textContent = '단어장';
  b.title = '고른 글자를 단어장에 저장';
  b.addEventListener('click', () => openVocab());
  $('block-trans').querySelector('footer').prepend(b);
})();

/* ---------- 보관함 ---------- */

function showLibrary(tab = 'receipts') {
  const tabs = [['receipts', '영수증'], ['cards', '명함'], ['vocab', '단어장']];
  const tabBar = `<div class="seg" style="margin:0 0 8px">${tabs.map(([k, t]) => `<label><input type="radio" name="lib-tab" value="${k}"${k === tab ? ' checked' : ''}><span>${t}</span></label>`).join('')}</div>`;
  let body = '', actions = [{ label: '닫기' }];
  if (tab === 'receipts') {
    const list = db.get('receipts');
    const months = {};
    for (const r of list) { const m = (r.date || '').slice(0, 7) || '날짜없음'; months[m] = (months[m] || 0) + (r.total || 0); }
    body = `<div class="sum">${Object.entries(months).sort().reverse().map(([m, t]) => `${m} · ${won(t)}`).join('<br>') || '저장된 영수증이 없습니다'}</div>
      <ul class="rows">${list.map((r) => `<li><div class="grow">${esc(r.store || '(상호 없음)')}<small>${esc(r.date)} · ${esc(r.category)}</small></div><b>${won(r.total || 0)}</b><button data-del="${r.id}">삭제</button></li>`).join('')}</ul>`;
    if (list.length) actions = [{ label: 'CSV로 내보내기', primary: true, keep: true, async run() {
      const rows = [['날짜', '상호', '분류', '금액'], ...list.map((r) => [r.date, r.store, r.category, String(r.total || 0)])];
      await saveOrShare(new TextEncoder().encode(`\uFEFF${toCsv(rows)}`), 'SnapRead_가계부.csv', 'text/csv', '가계부 내보내기');
      return 'keep';
    } }, { label: '닫기' }];
  } else if (tab === 'cards') {
    const list = db.get('cards');
    body = `<ul class="rows">${list.map((c) => `<li><div class="grow">${esc(c.name || '(이름 없음)')}<small>${esc([c.company, c.phone, c.email].filter(Boolean).join(' · '))}</small></div><button data-share="${c.id}">연락처</button><button data-del="${c.id}">삭제</button></li>`).join('') || '<li>저장된 명함이 없습니다</li>'}</ul>`;
  } else {
    const list = db.get('vocab');
    body = `<ul class="rows">${list.map((w) => `<li><div class="grow">${esc(w.word)}<small>${esc(w.meaning)}</small></div><button data-del="${w.id}">삭제</button></li>`).join('') || '<li>저장된 단어가 없습니다</li>'}</ul>`;
    if (list.length) actions = [{ label: '복습하기', primary: true, keep: true, run() { reviewVocab(); return 'keep'; } }, { label: '닫기' }];
  }
  openForm('보관함', [], actions, tabBar + body);
  $('form-title').textContent = '보관함';
  formOverlay.querySelectorAll('input[name="lib-tab"]').forEach((el) => el.addEventListener('change', () => showLibrary(el.value)));
  formOverlay.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => {
    db.remove(tab, Number(el.dataset.del));
    showLibrary(tab);
  }));
  formOverlay.querySelectorAll('[data-share]').forEach((el) => el.addEventListener('click', () => {
    const c = db.get('cards').find((x) => x.id === Number(el.dataset.share));
    if (c) shareVcard(c).catch((err) => { if (!/cancel/i.test(String(err?.message || err))) setStatus(formStatus, `오류: ${err.message || err}`); });
  }));
}

// 카드 넘기기 방식 복습: 단어를 보고 눌러서 뜻 확인
function reviewVocab() {
  const deck = db.get('vocab').sort(() => Math.random() - 0.5);
  let i = 0, shown = false;
  const render = () => {
    const w = deck[i];
    openForm(`단어 복습 ${i + 1}/${deck.length}`, [], [
      { label: i + 1 < deck.length ? '다음' : '끝내기', primary: true, keep: true, run() {
        if (i + 1 < deck.length) { i++; shown = false; render(); } else showLibrary('vocab');
        return 'keep';
      } },
      { label: '보관함으로', run() { showLibrary('vocab'); }, keep: true },
    ], `<div class="card-face" id="card-face">${esc(w.word)}</div><p class="status">카드를 누르면 뜻이 보입니다</p>`);
    $('card-face').addEventListener('click', () => {
      shown = !shown;
      $('card-face').textContent = shown ? w.meaning || '(뜻 없음)' : w.word;
    });
  };
  if (deck.length) render();
}

/* ---------- 실시간 화면: QR·바코드 / 번역 ---------- */

const liveLayer = $('live-layer');
const liveBar = $('live-bar');
let live = null; // { kind, stop }

function stopLive() {
  if (!live) return;
  live.stop();
  live = null;
  liveLayer.replaceChildren();
  liveLayer.hidden = true;
  liveBar.hidden = true;
}
function onModeChange() { stopLive(); }
$('live-stop').addEventListener('click', stopLive);

// 카메라 영상에서 작은 프레임을 떠낸다
function grabFrame(maxSide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(1, maxSide / Math.max(vw, vh));
  const c = document.createElement('canvas');
  c.width = Math.round(vw * s);
  c.height = Math.round(vh * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height);
  return { c, s, vw, vh };
}

function startLive(kind) {
  stopLive();
  if (!inCameraMode()) return;
  liveBar.hidden = false;
  liveLayer.hidden = false;
  $('live-title').textContent = kind === 'qr' ? 'QR·바코드를 비춰 주세요' : '실시간 번역';
  const lang = $('live-lang');
  if (lang) lang.remove();
  if (kind === 'ar') {
    const sel = document.createElement('select');
    sel.id = 'live-lang';
    sel.innerHTML = ocrLang.innerHTML;
    sel.value = ocrLang.value;
    sel.addEventListener('change', () => { ocrLang.value = sel.value; store.set('ocrLang', sel.value); liveLayer.replaceChildren(); });
    $('live-title').after(sel);
  }
  let alive = true;
  live = { kind, stop() { alive = false; } };
  (kind === 'qr' ? qrLoop : arLoop)(() => alive);
}

/* QR·바코드 */

let detector = null;
async function detectCodes(frame) {
  if ('BarcodeDetector' in window) {
    try {
      detector ||= new BarcodeDetector();
      const found = await detector.detect(frame.c);
      if (found.length) return { text: found[0].rawValue, format: found[0].format };
    } catch { detector = null; /* 아래 jsQR 로 대체 */ }
  }
  if (typeof jsQR === 'function') {
    const img = frame.c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, frame.c.width, frame.c.height);
    const code = jsQR(img.data, img.width, img.height);
    if (code) return { text: code.data, format: 'qr_code' };
  }
  return null;
}

async function qrLoop(alive) {
  while (alive()) {
    const frame = grabFrame(900);
    const code = frame && await detectCodes(frame);
    if (code && alive()) { stopLive(); showCode(code); return; }
    await sleep(250);
  }
}

function parseWifi(text) {
  if (!/^WIFI:/i.test(text)) return null;
  const get = (k) => (text.match(new RegExp(`(?:^|;|:)${k}:((?:\\\\.|[^;])*)`, 'i')) || [])[1]?.replace(/\\(.)/g, '$1') || '';
  return { ssid: get('S'), pass: get('P'), type: get('T') };
}

function showCode({ text, format }) {
  const wifi = parseWifi(text);
  const isUrl = /^https?:\/\//i.test(text);
  const isProduct = /^(ean_13|ean_8|upc_a|upc_e)$/.test(format) || (/^\d{8,14}$/.test(text) && format !== 'qr_code');
  const actions = [];
  if (isUrl) actions.push({ label: '링크 열기', primary: true, run() { window.open(text, '_blank'); } });
  if (wifi) actions.push({ label: '비밀번호 복사', primary: true, async run() { await copyText(wifi.pass); setStatus(formStatus, '복사됨'); return 'keep'; } });
  if (isProduct) actions.push({ label: '상품 검색', primary: true, run() { window.open(`https://www.google.com/search?q=${encodeURIComponent(text)}`, '_blank'); } });
  if (!actions.length) actions.push({ label: '구글에서 검색', primary: true, run() { window.open(`https://www.google.com/search?q=${encodeURIComponent(text)}`, '_blank'); } });
  actions.push({ label: '내용 복사', keep: true, async run() { await copyText(text); setStatus(formStatus, '복사됨'); return 'keep'; } });
  actions.push({ label: '다시 스캔', run() { startLive('qr'); } });
  actions.push({ label: '닫기' });
  const note = wifi ? `<p class="status">와이파이 ${esc(wifi.ssid)} · 비밀번호를 복사해 설정의 와이파이에서 붙여넣으세요</p>` : '';
  openForm(wifi ? '와이파이' : isProduct ? '바코드' : 'QR 코드', [{ key: 'text', label: '내용', value: text, type: 'textarea' }], actions, note);
}

/* 실시간 번역 */

const arCache = new Map(); // 원문 → 번역
async function translateLine(text) {
  if (arCache.has(text)) return arCache.get(text);
  arCache.set(text, ''); // 중복 요청 방지
  try {
    const t = await translateGoogle(text);
    arCache.set(text, t);
    return t;
  } catch { arCache.delete(text); return ''; }
}

async function arLoop(alive) {
  while (alive()) {
    const frame = grabFrame(1000);
    if (!frame) { await sleep(300); continue; }
    try {
      const lang = ocrLang.value;
      const w = await getWorker(lang);
      const { data } = await w.recognize(frame.c);
      if (!alive()) return;
      const min = minConfidenceFor(lang);
      // 위치(bbox)가 필요하므로 줄마다 따로 신뢰도 검사
      const picked = (data.lines || []).filter((l) => readLines({ lines: [l] }, lang, Math.max(min, 60)).length);
      const items = picked.slice(0, 8).map((l) => ({ text: fixCommonErrors(l.text.trim(), lang), bbox: l.bbox }));
      await Promise.all(items.filter((it) => lang !== 'kor' && !arCache.has(it.text)).slice(0, 4).map((it) => translateLine(it.text)));
      if (!alive()) return;
      drawLabels(items, frame);
    } catch (err) {
      console.warn('실시간 번역 실패', err);
      await sleep(1000);
    }
    await sleep(200);
  }
}

function drawLabels(items, frame) {
  const cw = video.clientWidth, ch = video.clientHeight;
  const k = Math.max(cw / frame.vw, ch / frame.vh); // 영상은 화면을 꽉 채우도록 잘려 있음
  const ox = (cw - frame.vw * k) / 2, oy = (ch - frame.vh * k) / 2;
  const k2 = k / frame.s;
  liveLayer.replaceChildren(...items.map((it) => {
    const t = arCache.get(it.text);
    if (!t || t === it.text) return '';
    const el = document.createElement('div');
    el.className = 'ar-label';
    const h = (it.bbox.y1 - it.bbox.y0) * k2;
    el.textContent = t;
    el.style.left = `${ox + it.bbox.x0 * k2}px`;
    el.style.top = `${oy + it.bbox.y0 * k2}px`;
    el.style.minWidth = `${(it.bbox.x1 - it.bbox.x0) * k2}px`;
    el.style.fontSize = `${Math.max(11, Math.min(22, h * 0.8))}px`;
    return el;
  }).filter(Boolean));
}

'use strict';

/* 카메라 활용 기능: 명함 · 표(CSV) · 단어장 · QR/바코드 · 실시간 번역
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

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* 복사 권한이 없으면 건너뜀 */ }
}

/* ---------- 공용 시트 ---------- */

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
  openForm(title, [], [{ label: '닫기' }], '<p class="status">글자를 읽는 중…</p>');
  const text = await ensureText();
  if (!text) {
    $('form-body').innerHTML = '<p class="status error">글자를 찾지 못했습니다. 글자 부분을 드래그하거나 사진 언어를 바꿔 보세요.</p>';
    return null;
  }
  return text;
}

/* ---------- 사용 방법 안내 ---------- */

const HELP = {
  translate: {
    title: '사진 번역',
    steps: [
      '번역할 글자가 화면 틀 안에 크게 보이게 하고, 하얀 동그란 촬영 버튼을 누르세요. 아래 왼쪽 버튼으로 갤러리 사진을 골라도 됩니다.',
      '촬영하면 글자를 자동으로 추출해 한국어로 번역한 결과가 나옵니다.',
      '글자가 사진 일부에만 있으면 그 부분을 손가락으로 드래그하세요. 그 부분만 다시 인식합니다. 두 손가락으로 확대·이동도 됩니다.',
      '사진 속 글자가 영어가 아니면 결과 창 위쪽에서 언어를 바꾸세요. 잘못 읽은 글자는 직접 고친 뒤 "다시 번역"을 누르면 됩니다.',
    ],
    tip: '글자가 흔들리거나 그림자가 지면 인식이 잘 안 됩니다. 밝은 곳에서 글자와 화면을 나란히 맞춰 찍어 보세요.',
  },
  ar: {
    title: '실시간 번역',
    steps: [
      '촬영 버튼은 없습니다. 카메라를 글자에 비추기만 하면 번역이 글자 위에 바로 겹쳐서 나옵니다.',
      '휴대폰을 가만히 들고 글자에 초점이 맞을 때까지 1~2초 기다려 주세요. 화면 아래에 지금 하는 일이 표시됩니다.',
      '위쪽 목록에서 비추는 글자의 언어를 고르세요. 영어 외 언어는 처음 한 번 인터넷으로 언어 데이터를 받습니다.',
      '"끄기"를 누르면 메뉴로 돌아갑니다. 사진으로 남기고 싶으면 "사진 번역"을 쓰세요.',
    ],
    tip: '실시간 번역은 인터넷 연결이 필요합니다. 큰 글자가 또렷할수록 잘 됩니다.',
  },
  scan: {
    title: '북스캔 · 문서 스캔',
    steps: [
      '위쪽 스위치에서 "한 쪽" 또는 "두 쪽 펼침"을 고르고, 가이드 틀 안에 책이나 문서를 맞춰 촬영하세요. 두 쪽이면 노란 점선을 책 가운데(제본선)에 맞춥니다.',
      '편집 화면에서 네 모서리 점을 책 모서리에 맞게 끌어 주세요. 처음엔 자동으로 찾아 줍니다. "두 쪽으로 나누기"를 켜면 가운데 두 점으로 쪽 경계를 맞춥니다.',
      '"평평하게 펴기"는 기울어 찍힌 쪽을 반듯한 사각형으로 펴 주고, "선명(컬러)"는 책 가운데 그림자를 옅게 합니다. "결과 보기"로 미리 확인하세요.',
      '"다음 쪽 촬영"으로 계속 찍고, 다 찍으면 "완료"에서 PDF 한 파일 또는 JPG 여러 장으로 저장합니다.',
    ],
    tip: '밝은 곳에서 손이나 휴대폰 그림자가 지지 않게 찍고, 책은 손으로 눌러 최대한 평평하게 펴 주세요. 심하게 휘어진 쪽의 곡면은 완전히 펴지지 않습니다.',
  },
  card: {
    title: '명함 저장',
    steps: [
      '명함을 가이드 틀에 꽉 차게 맞추고, 글자가 수평이 되게 촬영하세요.',
      '이름·회사·전화·이메일을 자동으로 찾아 채워 줍니다. 틀린 곳은 고친 뒤 "저장"을 누르세요.',
      '"연락처로 보내기"를 누르면 휴대폰 연락처 앱에 저장할 수 있습니다. 저장한 명함은 보관함에서 다시 봅니다.',
    ],
  },
  table: {
    title: '표 → CSV',
    steps: [
      '표 전체가 가이드 틀 안에 들어오게 하고, 표 선이 화면과 나란하도록 맞춰 촬영하세요.',
      '칸을 나눠 읽은 결과가 쉼표(,)로 구분된 글로 나옵니다. 고친 뒤 "CSV 저장"을 누르면 엑셀에서 열 수 있는 파일이 됩니다.',
      '표의 일부만 필요하면 찍기 전에 필요한 부분만 틀에 맞추세요.',
    ],
  },
  search: {
    title: '구글 이미지 검색',
    steps: [
      '검색할 물건·간판·그림을 가이드 틀 가운데에 넣고 촬영하세요.',
      '공유 창이 열리면 "구글 렌즈"나 "구글" 앱을 골라 이미지를 보내면 비슷한 이미지와 정보를 찾아 줍니다.',
    ],
  },
  vocab: {
    title: '단어장에 담기',
    steps: [
      '글자가 있는 곳을 촬영하면 글자가 추출됩니다.',
      '추출된 글자(번역 결과 창)에서 단어를 길게 눌러 고른 뒤 "단어장" 버튼을 누르면 뜻과 함께 저장됩니다.',
      '저장한 단어는 메뉴의 보관함 → 단어장에서 카드로 복습할 수 있습니다.',
    ],
  },
  qr: {
    title: 'QR·바코드',
    steps: [
      'QR코드나 바코드를 가이드 틀 안에 맞추면 자동으로 읽습니다. 촬영 버튼은 없습니다.',
      '링크는 바로 열고, 와이파이는 비밀번호를 복사하고, 상품 바코드는 검색해 줍니다.',
    ],
  },
};

const helpHtml = (h) => `<ol class="help-steps">${h.steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>${h.tip ? `<p class="help-tip">${esc(h.tip)}</p>` : ''}`;

// 기능마다 처음 들어갈 때 한 번 자동으로 보여 주고, 이후에는 위쪽 ? 버튼으로 다시 볼 수 있다
function showHelp(act, { first = false } = {}) {
  const h = HELP[act];
  if (!h) return;
  store.set(`help_${act}`, '1');
  openForm(`${h.title} 사용 방법`, [], [{ label: '알겠어요', primary: true }],
    helpHtml(h) + (first ? '<p class="status" style="text-align:left">나중에 위쪽 ? 버튼에서 다시 볼 수 있어요.</p>' : ''));
}

function showAllHelp() {
  openForm('사용 방법', [], [{ label: '닫기' }],
    Object.values(HELP).map((h) => `<details class="help-item"><summary>${esc(h.title)}</summary>${helpHtml(h)}</details>`).join(''));
}

$('btn-help').addEventListener('click', () => showHelp(pendingAct));

/* ---------- 촬영 가이드 (틀 + 안내 문구) ---------- */

// ar: 틀의 가로/세로 비율 (null 이면 화면 가득 모서리 표시만)
const GUIDES = {
  translate: { ar: null, text: '번역할 글자가 화면에 크게, 또렷하게 보이게 하고 촬영하세요' },
  vocab: { ar: null, text: '단어를 고를 글자가 크게 보이게 하고 촬영하세요' },
  card: { ar: 1.586, dim: true, rounded: true, text: '명함을 틀에 꽉 차게 맞추고, 글자가 수평이 되게 찍으세요' },
  table: { ar: 1.3, dim: true, grid: true, text: '표 전체를 틀 안에 넣고, 표 선이 화면과 나란하게 맞추세요' },
  search: { ar: 1, dim: true, rounded: true, text: '검색할 물건·간판을 틀 가운데에 넣으세요' },
  qr: { ar: 1, dim: true, rounded: true, live: true, text: 'QR코드·바코드를 틀 안에 맞추면 자동으로 읽습니다' },
  scan: { dynamic: true },
};

function currentGuide() {
  const g = GUIDES[pendingAct];
  if (!g) return null;
  if (!g.dynamic) return g;
  const spread = bookMode() === 'spread';
  return {
    ar: spread ? 1.42 : 0.72, dim: true, spine: spread, top: 112,
    text: spread ? '책을 틀에 맞추고, 노란 점선을 책 가운데(제본선)에 맞추세요' : '한 쪽(문서)을 틀에 꽉 차게 맞추세요',
  };
}

function layoutGuide() {
  const g = currentGuide();
  const guide = $('guide');
  if (!g || !inCameraMode()) { guide.hidden = true; return; }
  guide.hidden = false;
  const W = media.clientWidth, H = media.clientHeight;
  const top = g.top || 70, bottom = 54;
  const maxW = W - 24, maxH = Math.max(80, H - top - bottom);
  let w = maxW, h = maxH;
  if (g.ar) { w = Math.min(maxW, maxH * g.ar); h = w / g.ar; }
  const frame = $('guide-frame');
  frame.style.width = `${Math.round(w)}px`;
  frame.style.height = `${Math.round(h)}px`;
  frame.style.left = `${Math.round((W - w) / 2)}px`;
  frame.style.top = `${Math.round(top + (maxH - h) / 2)}px`;
  frame.className = `guide-frame${g.dim ? ' dim' : ''}${g.rounded ? ' rounded' : ''}${g.grid ? ' grid' : ''}${g.live ? ' live-frame' : ''}`;
  $('guide-spine').hidden = !g.spine;
  $('guide-text').textContent = g.text;
}
window.addEventListener('resize', layoutGuide);

// 북스캔: 한 쪽 / 두 쪽 선택 (선택은 기억)
const bookMode = () => document.querySelector('input[name="book-mode"]:checked').value;
{
  const saved = store.get('bookMode');
  const el = document.querySelector(`input[name="book-mode"][value="${saved === 'single' ? 'single' : 'spread'}"]`);
  if (el) el.checked = true;
}
document.querySelectorAll('input[name="book-mode"]').forEach((el) => el.addEventListener('change', () => {
  store.set('bookMode', bookMode());
  layoutGuide();
}));

// app.js 의 setMode('camera') 가 부른다
function onCameraMode() {
  $('book-bar').hidden = pendingAct !== 'scan';
  if (typeof updateBookBar === 'function') updateBookBar();
  layoutGuide();
}

/* ---------- 첫 화면 메뉴 ---------- */

// 메뉴에서 고른 기능. 촬영 화면으로 가서, 사진을 찍으면 바로 이어서 실행한다
let pendingAct = null;
const LIVE_ACTS = { ar: () => startLive('ar'), qr: () => startLive('qr') };
const PHOTO_ACTS = {
  translate: () => $('btn-open-result').click(),
  scan: () => openBookEditor(),
  search: () => $('btn-search').click(),
  card: openCard, table: openTable, vocab: openVocab,
};

function goHome(force = false) {
  if (!force && typeof bookPages !== 'undefined' && bookPages.length && !confirm(`찍어 둔 ${bookPages.length}쪽이 사라집니다. 메뉴로 갈까요?`)) return;
  if (typeof resetBook === 'function') resetBook();
  pendingAct = null;
  hasPhoto = false;
  stopLive();
  formOverlay.hidden = true;
  setMode('home');
}
$('btn-menu').addEventListener('click', () => goHome());

// 사진이 찍히면(또는 골라지면) 메뉴에서 고른 기능을 이어서 실행
function onPhotoReady() {
  const act = PHOTO_ACTS[pendingAct];
  if (act) setTimeout(act, 0);
}

document.querySelectorAll('#home .row').forEach((el) => el.addEventListener('click', () => {
  const act = el.dataset.act;
  if (act === 'library') { showLibrary(); return; }
  if (act === 'help') { showAllHelp(); return; }
  pendingAct = act;
  if (typeof resetBook === 'function') resetBook();
  setMode('camera');
  if (LIVE_ACTS[act]) setTimeout(LIVE_ACTS[act], 0);
  if (!store.get(`help_${act}`)) showHelp(act, { first: true });
}));

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

function showLibrary(tab = 'cards') {
  const tabs = [['cards', '명함'], ['vocab', '단어장']];
  const tabBar = `<div class="seg" style="margin:0 0 8px">${tabs.map(([k, t]) => `<label><input type="radio" name="lib-tab" value="${k}"${k === tab ? ' checked' : ''}><span>${t}</span></label>`).join('')}</div>`;
  let body = '', actions = [{ label: '닫기' }];
  if (tab === 'cards') {
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
  document.body.classList.remove('live-on');
  $('live-hint').hidden = true;
  if (!live) return;
  live.stop();
  live = null;
  liveLayer.replaceChildren();
  liveLayer.hidden = true;
  liveBar.hidden = true;
  // 실시간용으로 바꿔 둔 OCR 설정을 사진 인식용으로 되돌림
  if (worker) worker.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {});
}
function onModeChange() { stopLive(); }
// 끄기: 카메라만 켜진 빈 화면으로 남기지 않고 메뉴로 돌아간다
$('live-stop').addEventListener('click', () => goHome(true));
$('live-flip').addEventListener('click', () => $('btn-switch').click());

function setLiveHint(text, error = false) {
  const el = $('live-hint');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', error);
}

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
  document.body.classList.add('live-on');
  liveBar.hidden = false;
  liveLayer.hidden = false;
  $('live-title').textContent = kind === 'qr' ? 'QR·바코드' : '실시간 번역';
  const lang = $('live-lang');
  if (lang) lang.remove();
  if (kind === 'ar') {
    const sel = document.createElement('select');
    sel.id = 'live-lang';
    sel.setAttribute('aria-label', '비추는 글자의 언어');
    sel.innerHTML = ocrLang.innerHTML;
    sel.value = ocrLang.value;
    sel.addEventListener('change', () => { ocrLang.value = sel.value; store.set('ocrLang', sel.value); liveLayer.replaceChildren(); });
    $('live-title').after(sel);
    setLiveHint('카메라를 글자에 비추고 잠깐 가만히 들고 계세요');
  } else {
    setLiveHint('');
  }
  layoutGuide();
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

// 원문 → 번역. 같은 글자가 조금씩 다르게 읽혀도 한 번만 번역하도록 정규화한 글자를 키로 쓴다
const arCache = new Map();
const arKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
async function translateLine(text) {
  const key = arKey(text);
  if (!key) return '';
  if (arCache.has(key)) return arCache.get(key);
  arCache.set(key, ''); // 중복 요청 방지
  try {
    const t = await translateGoogle(text);
    arCache.set(key, t);
    return t;
  } catch (err) {
    arCache.delete(key);
    throw err;
  }
}

async function arLoop(alive) {
  let empty = 0;
  let netFail = 0;
  while (alive()) {
    const frame = grabFrame(1280);
    if (!frame) { await sleep(300); continue; }
    try {
      const lang = ocrLang.value;
      if (!workerReady(lang)) setLiveHint('글자 인식 엔진을 준비하는 중… (처음 한 번만 걸려요)');
      const w = await getWorker(lang);
      if (!alive()) return;
      // 실시간은 화면 속 글자가 여러 군데 흩어져 있으므로 흩어진 글자 모드로 읽는다
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await w.recognize(frame.c);
      if (!alive()) return;
      // 위치(bbox)가 필요하므로 줄마다 따로 신뢰도 검사. 움직이는 영상이라 사진보다 기준을 낮춘다
      const min = Math.max(25, minConfidenceFor(lang) - 10);
      const picked = (data.lines || []).filter((l) => readLines({ lines: [l] }, lang, min).length);
      const items = picked.slice(0, 10).map((l) => ({ text: fixCommonErrors(l.text.trim(), lang), bbox: l.bbox }));
      if (!items.length) {
        if (++empty >= 3) setLiveHint('글자를 찾지 못했어요. 글자에 더 가까이, 또렷하게 비춰 주세요');
        liveLayer.replaceChildren();
      } else {
        empty = 0;
        const todo = lang === 'kor' ? [] : items.filter((it) => !arCache.has(arKey(it.text))).slice(0, 4);
        if (todo.length) setLiveHint('번역하는 중…');
        const results = await Promise.allSettled(todo.map((it) => translateLine(it.text)));
        if (!alive()) return;
        if (results.length && results.every((r) => r.status === 'rejected')) {
          if (++netFail >= 2) setLiveHint(`번역하지 못했어요: ${results[0].reason?.message || '인터넷 연결을 확인하세요'}`, true);
        } else {
          netFail = 0;
          setLiveHint('');
        }
        drawLabels(items, frame);
      }
    } catch (err) {
      console.warn('실시간 번역 실패', err);
      if (alive()) setLiveHint(`글자 인식 오류: ${err.message || err}`, true);
      await sleep(1500);
    }
    await sleep(150);
  }
}

// 지금 언어의 OCR 엔진이 이미 준비돼 있는지
const workerReady = (lang) => !!worker && workerLang === lang;

function drawLabels(items, frame) {
  const cw = video.clientWidth, ch = video.clientHeight;
  const k = Math.max(cw / frame.vw, ch / frame.vh); // 영상은 화면을 꽉 채우도록 잘려 있음
  const ox = (cw - frame.vw * k) / 2, oy = (ch - frame.vh * k) / 2;
  const k2 = k / frame.s;
  liveLayer.replaceChildren(...items.map((it) => {
    const t = arCache.get(arKey(it.text));
    if (!t || arKey(t) === arKey(it.text)) return '';
    const el = document.createElement('div');
    el.className = 'ar-label';
    const h = (it.bbox.y1 - it.bbox.y0) * k2;
    el.textContent = t;
    // 화면 밖으로 잘린 글자의 번역도 화면 안에서 보이도록 위치를 안으로 당김
    const left = Math.min(Math.max(2, ox + it.bbox.x0 * k2), Math.max(2, cw - 60));
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(2, oy + it.bbox.y0 * k2)}px`;
    el.style.minWidth = `${Math.min((it.bbox.x1 - it.bbox.x0) * k2, cw - left - 2)}px`;
    el.style.maxWidth = `${cw - left - 2}px`;
    el.style.fontSize = `${Math.max(12, Math.min(24, h * 0.8))}px`;
    return el;
  }).filter(Boolean));
}

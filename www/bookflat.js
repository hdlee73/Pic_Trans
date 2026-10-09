'use strict';

/* 북스캔 보정: 모서리 정밀화 · 휘어짐(곡면) 펴기 · 손가락 지우기
 * bookscan.js 가 쓴다 (외부 라이브러리 없음). 좌표는 모두 원본 사진 픽셀. */

/* ---------- 흑백 축소본 (모서리·가장자리 분석용) ---------- */

let grayCache = null;
function grayOf(src) {
  const stamp = src._stamp || 0;
  if (grayCache && grayCache.src === src && grayCache.stamp === stamp && grayCache.sw === src.width) return grayCache;
  const s = Math.min(1, 800 / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * s)), h = Math.max(8, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  grayCache = { src, stamp, sw: src.width, w, h, s, g };
  return grayCache;
}

function sampleGray(G, x, y) {
  x = x < 0 ? 0 : x > G.w - 1.001 ? G.w - 1.001 : x;
  y = y < 0 ? 0 : y > G.h - 1.001 ? G.h - 1.001 : y;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * G.w + x0;
  return G.g[i] * (1 - fx) * (1 - fy) + G.g[i + 1] * fx * (1 - fy) + G.g[i + G.w] * (1 - fx) * fy + G.g[i + G.w + 1] * fx * fy;
}

/* ---------- 변(가장자리) 맞추기 ---------- */

// 가중 최소제곱: d(t) = a + b·t + 4c·t(1−t)
function fitCurve(pts, w) {
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let k = 0; k < pts.length; k++) {
    if (!w[k]) continue;
    const t = pts[k][0], y = pts[k][1];
    const f = [1, t, 4 * t * (1 - t)];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) M[i][j] += f[i] * f[j];
      M[i][3] += f[i] * y;
    }
  }
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-9) return null;
    for (let k = c; k < 4; k++) M[c][k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

// 종이가 배경보다 밝으면 +1, 어두우면 −1
function insideSign(G, q) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const A = q[i], B = q[(i + 1) % 4];
    const dx = (B.x - A.x) * G.s, dy = (B.y - A.y) * G.s, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const mx = (A.x + B.x) / 2 * G.s, my = (A.y + B.y) / 2 * G.s;
    sum += sampleGray(G, mx + nx * 7, my + ny * 7) - sampleGray(G, mx - nx * 7, my - ny * 7);
  }
  return sum >= 0 ? 1 : -1;
}

// 사각형의 한 변(A→B)을 따라 종이 가장자리를 찾아 위치(a, b)와 휘어짐(c)을 구한다 (원본 픽셀 단위)
// 반환 n: 변의 안쪽 방향 단위벡터
function fitEdge(G, A, B, sign) {
  const s = G.s;
  const dx = (B.x - A.x) * s, dy = (B.y - A.y) * s, len = Math.hypot(dx, dy);
  const nx = len ? -dy / len : 0, ny = len ? dx / len : 0;
  const out = { a: 0, b: 0, c: 0, ok: false, n: { x: nx, y: ny }, len: len / s };
  if (len < 24) return out;
  const R = Math.max(6, Math.min(G.w, G.h) * 0.06);
  const pts = [];
  const N = 30;
  for (let i = 0; i < N; i++) {
    const t = 0.1 + 0.8 * i / (N - 1);
    const px = A.x * s + dx * t, py = A.y * s + dy * t;
    let best = -1, bd = 0;
    for (let d = -R; d <= R; d += 1) {
      const g1 = sampleGray(G, px + nx * (d + 1.5), py + ny * (d + 1.5));
      const g0 = sampleGray(G, px + nx * (d - 1.5), py + ny * (d - 1.5));
      const score = sign * (g1 - g0) * (1 - 0.35 * Math.abs(d) / R);
      if (score > best) { best = score; bd = d; }
    }
    if (best > 14) pts.push([t, bd]);
  }
  if (pts.length < 10) return out;
  // 이상값(손·그림자에 끌린 점)을 걸러 가며 다시 맞춤
  let w = pts.map(() => 1);
  let coef = null;
  for (let it = 0; it < 4; it++) {
    const c = fitCurve(pts, w);
    if (!c) return out;
    coef = c;
    const res = pts.map((p) => Math.abs(p[1] - (c[0] + c[1] * p[0] + 4 * c[2] * p[0] * (1 - p[0]))));
    const sorted = [...res].sort((x, y) => x - y);
    const lim = Math.max(1.5, 2.2 * sorted[sorted.length >> 1]);
    w = res.map((r) => (r <= lim ? 1 : 0));
    if (w.reduce((x, y) => x + y, 0) < 8) return out;
  }
  out.a = coef[0] / s; out.b = coef[1] / s; out.c = coef[2] / s;
  out.ok = true;
  return out;
}

function lineIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-6) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

// 대략 찾은 모서리를 종이 가장자리에 맞춰 다듬는다. 변마다 가장자리를 찾아 직선을 맞추고 교점을 모서리로 삼는다
function refineQuad(src, q) {
  const G = grayOf(src);
  const sign = insideSign(G, q);
  const fits = [0, 1, 2, 3].map((i) => fitEdge(G, q[i], q[(i + 1) % 4], sign));
  const lines = fits.map((f, i) => {
    const A = q[i], B = q[(i + 1) % 4];
    return [{ x: A.x + f.n.x * f.a, y: A.y + f.n.y * f.a }, { x: B.x + f.n.x * (f.a + f.b), y: B.y + f.n.y * (f.a + f.b) }];
  });
  const lim = 0.09 * Math.max(src.width, src.height);
  return q.map((p, i) => {
    const prev = lines[(i + 3) % 4], cur = lines[i];
    const x = lineIntersect(prev[0], prev[1], cur[0], cur[1]);
    // 교점이 너무 멀면(변을 못 찾았거나 거의 평행) 원래 점 유지
    return x && Math.hypot(x.x - p.x, x.y - p.y) < lim ? x : p;
  });
}

// 사각형 네 변의 휘어짐: c[i] 는 변 i(TL→TR, TR→BR, BR→BL, BL→TL)가 안쪽으로 휜 정도(원본 픽셀, 바깥쪽이면 음수)
function edgeCurves(src, q) {
  const G = grayOf(src);
  const sign = insideSign(G, q);
  const fits = [0, 1, 2, 3].map((i) => fitEdge(G, q[i], q[(i + 1) % 4], sign));
  return {
    n: fits.map((f) => f.n),
    // 너무 큰 값은 잘못 찾은 것으로 보고 한 변 길이의 5%로 제한
    c: fits.map((f) => (f.ok ? Math.max(-0.05 * f.len, Math.min(0.05 * f.len, f.c)) : 0)),
  };
}

/* ---------- 휘어짐까지 펴기 ---------- */

// 원근(투영 변환) + 변 휘어짐 보정으로 쪽 하나를 w×h 반듯한 사각형으로 편다.
// curv: { c: [위, 오른쪽, 아래, 왼쪽 휘어짐], n: [각 변의 안쪽 방향] }
function warpPatch(src, q, curv, w, h) {
  const { data: sd, w: sw, h: sh } = pixelsOf(src);
  const [a, b, c, d, e, f, g, hh] = solveHomography(w, h, q);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const od = img.data;
  const [ct, cr, cb, cl] = curv.c;
  const [nT, nR, nB, nL] = curv.n;
  let o = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const bv = 4 * v * (1 - v);
    for (let x = 0; x < w; x++, o += 4) {
      const px = x + 0.5, py = y + 0.5;
      const u = px / w;
      const bu = 4 * u * (1 - u);
      const den = g * px + hh * py + 1;
      const dT = (1 - v) * bu * ct, dB = v * bu * cb, dL = (1 - u) * bv * cl, dR = u * bv * cr;
      let sx = (a * px + b * py + c) / den - 0.5 + dT * nT.x + dB * nB.x + dL * nL.x + dR * nR.x;
      let sy = (d * px + e * py + f) / den - 0.5 + dT * nT.y + dB * nB.y + dL * nL.y + dR * nR.y;
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

/* ---------- 손가락 지우기 ---------- */

// 상자 필터로 팽창(wantAll=false)·침식(true)
function boxMorph(mask, w, h, r, wantAll) {
  const iw = w + 1;
  const sum = new Int32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
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
}

// 쪽 가장자리에 걸친 손가락(피부색 덩어리)을 찾아 주변 종이색으로 메운다.
// 종이 색보다 붉은 쪽으로 치우친 큰 덩어리만 대상이므로 흰색·회색 종이와 작은 글자는 그대로 둔다
function fingerCore(src, quad) {
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  const ys = [];
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    Y[j] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[j] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[j] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if ((j & 15) === 0) ys.push(Y[j]);
  }
  // 종이 색: 가장 밝은 쪽 30% 의 평균
  ys.sort((p, q) => p - q);
  const yCut = ys[Math.floor(ys.length * 0.7)];
  let pCb = 0, pCr = 0, pY = 0, pn = 0;
  for (let j = 0; j < n; j += 16) if (Y[j] >= yCut) { pCb += Cb[j]; pCr += Cr[j]; pY += Y[j]; pn++; }
  pCb /= pn || 1; pCr /= pn || 1; pY /= pn || 1;

  let mask = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const redder = Cr[j] - pCr, dist = Math.hypot(Cb[j] - pCb, redder);
    if (redder > 9 && dist > 14 && Cr[j] > 134 && Cb[j] < 124 && Y[j] > pY * 0.38 && Y[j] < pY * 0.97) mask[j] = 1;
  }
  const r0 = Math.max(2, Math.round(Math.min(w, h) / 220));
  mask = boxMorph(boxMorph(mask, w, h, r0, true), w, h, r0, false); // 열기: 가는 글씨·잡티 제거
  mask = boxMorph(boxMorph(mask, w, h, r0 * 3, false), w, h, r0 * 3, true); // 닫기: 구멍 메움

  // 덩어리 중 충분히 크고 쪽 가장자리에 닿은 것만
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const keep = new Uint8Array(n);
  const edge = Math.max(8, Math.round(Math.min(w, h) * 0.05));
  // 쪽(사각형) 가장자리에서 edge 이내이거나 바깥이면 가장자리에 닿은 것으로 본다
  const nearQuad = (x, y) => {
    let pos = 0;
    for (let k = 0; k < 4; k++) {
      const A = quad[k], B = quad[(k + 1) % 4];
      const ex = B.x - A.x, ey = B.y - A.y, len = Math.hypot(ex, ey) || 1;
      const cross = (ex * (y - A.y) - ey * (x - A.x)) / len; // 부호 있는 거리
      const t = ((x - A.x) * ex + (y - A.y) * ey) / (len * len);
      const tc = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (A.x + ex * tc), y - (A.y + ey * tc)) < edge) return true;
      if (cross > 0) pos++;
    }
    return pos !== 0 && pos !== 4;
  };
  let found = 0;
  for (let i = 0, next = 0; i < n; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let sp = 0, size = 0, touches = false;
    const members = [];
    stack[sp++] = i; label[i] = next;
    while (sp) {
      const p = stack[--sp];
      members.push(p);
      size++;
      const x = p % w, y = (p / w) | 0;
      if (!touches && nearQuad(x, y)) touches = true;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    if (touches && size > n * 0.0015 && size < n * 0.3) { for (const p of members) keep[p] = 1; found++; }
  }
  if (!found) return null;

  // 손가락 둘레(그림자·가장자리 번짐)까지 조금 넓힘
  const grow = boxMorph(keep, w, h, Math.max(3, Math.round(Math.max(w, h) / 160)), false);

  // 가장 가까운 상하좌우의 지워지지 않은 점 색을 거리 반비례로 섞어 메움
  // 채울 색은 쪽 안쪽에서만 가져온다 (쪽 밖 책상 색이 번지지 않게)
  const bad = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (grow[p]) { bad[p] = 1; continue; }
    let pos = 0;
    for (let k = 0; k < 4; k++) {
      const A = quad[k], B = quad[(k + 1) % 4];
      if ((B.x - A.x) * (y - A.y) - (B.y - A.y) * (x - A.x) > 0) pos++;
    }
    if (pos !== 0 && pos !== 4) bad[p] = 1;
  }
  const L = new Int32Array(n), Rr = new Int32Array(n), U = new Int32Array(n), D = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    let last = -1;
    for (let x = 0; x < w; x++) { const p = y * w + x; if (!bad[p]) last = x; L[p] = last < 0 ? -1 : x - last; }
    last = -1;
    for (let x = w - 1; x >= 0; x--) { const p = y * w + x; if (!bad[p]) last = x; Rr[p] = last < 0 ? -1 : last - x; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) { const p = y * w + x; if (!bad[p]) last = y; U[p] = last < 0 ? -1 : y - last; }
    last = -1;
    for (let y = h - 1; y >= 0; y--) { const p = y * w + x; if (!bad[p]) last = y; D[p] = last < 0 ? -1 : last - y; }
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const res = octx.createImageData(w, h);
  const rd = res.data;
  rd.set(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!grow[p]) continue;
      let r = 0, g = 0, b = 0, ws = 0;
      const add = (dist, q) => {
        if (dist < 0) return;
        const wt = 1 / (dist * dist);
        r += d[q * 4] * wt; g += d[q * 4 + 1] * wt; b += d[q * 4 + 2] * wt; ws += wt;
      };
      add(L[p], p - L[p]); add(Rr[p], p + Rr[p]); add(U[p], p - U[p] * w); add(D[p], p + D[p] * w);
      const i = p * 4;
      if (ws) { rd[i] = r / ws; rd[i + 1] = g / ws; rd[i + 2] = b / ws; } else { rd[i] = rd[i + 1] = rd[i + 2] = pY; }
      rd[i + 3] = 255;
    }
  }
  octx.putImageData(res, 0, 0);
  return { out, grow };
}

// 큰 사진은 줄여서 손가락을 찾고, 찾은 자리만 원본 위에 덮어 쓴다. quad: 쪽 네 모서리(원본 픽셀)
function removeFingers(src, quad) {
  const w = src.width, h = src.height;
  const s = Math.min(1, 1100 / Math.max(w, h));
  const sw = Math.max(16, Math.round(w * s)), sh = Math.max(16, Math.round(h * s));
  let small = src;
  if (s < 1) {
    small = document.createElement('canvas'); small.width = sw; small.height = sh;
    small.getContext('2d').drawImage(src, 0, 0, sw, sh);
  }
  const r = fingerCore(small, quad.map((p) => ({ x: p.x * sw / w, y: p.y * sh / h })));
  if (!r) return src;
  if (s === 1) return r.out;
  // 지울 자리(마스크)만 걸러 낸 채움 그림을 원본 크기로 키워 덮는다
  const m = document.createElement('canvas'); m.width = sw; m.height = sh;
  const mctx = m.getContext('2d');
  const mi = mctx.createImageData(sw, sh);
  for (let i = 0; i < r.grow.length; i++) mi.data[i * 4 + 3] = r.grow[i] ? 255 : 0;
  mctx.putImageData(mi, 0, 0);
  mctx.globalCompositeOperation = 'source-in';
  mctx.drawImage(r.out, 0, 0);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d');
  octx.drawImage(src, 0, 0);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(m, 0, 0, w, h);
  return out;
}

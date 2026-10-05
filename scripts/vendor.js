// Tesseract.js(OCR) 파일과 영어 언어 데이터를 www/vendor 로 복사한다.
// 앱 안에 포함되므로 처음 실행할 때도 영어 인식에 인터넷이 필요 없다.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www', 'vendor', 'tesseract');
const mod = (p) => path.dirname(require.resolve(`${p}/package.json`));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'core'), { recursive: true });
fs.mkdirSync(path.join(out, 'lang'), { recursive: true });

const copy = (from, to) => {
  fs.copyFileSync(from, path.join(out, to));
  console.log(`vendor: ${to}`);
};

const dist = path.join(mod('tesseract.js'), 'dist');
copy(path.join(dist, 'tesseract.min.js'), 'tesseract.min.js');
copy(path.join(dist, 'worker.min.js'), 'worker.min.js');

// LSTM 엔진만 쓰므로 LSTM 전용 코어만 복사 (SIMD 지원 기기용 + 미지원 기기용)
const core = mod('tesseract.js-core');
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
  copy(path.join(core, f), `core/${f}`);
}

copy(path.join(mod('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), 'lang/eng.traineddata.gz');

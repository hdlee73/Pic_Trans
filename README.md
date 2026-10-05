# Pic Trans

카메라로 찍은 사진에서 문자·숫자를 추출하고 한국어로 번역하는 웹 앱입니다.
화면이 4개(2×2)로 나뉘어 있습니다.

| ① 카메라 | ② 찍은 사진 |
|---|---|
| **③ 추출된 문자 (OCR)** | **④ 한국어 번역** |

## 사용 방법

1. ① 화면에서 **📸 촬영**을 누르거나 **🖼️ 사진 선택**으로 이미지를 고릅니다.
2. ② 화면에 사진이 표시됩니다. 사진 속 글자의 언어를 고르고 **🔍 문자 추출**을 누릅니다.
3. ③ 화면에 추출된 텍스트가 나타납니다. 잘못 인식된 부분은 직접 고칠 수 있습니다.
4. **🌐 한국어로 번역**을 누르면 ④ 화면에 번역 결과가 나타납니다.

"촬영 후 자동 추출·번역"이 켜져 있으면 2~4단계가 촬영 직후 자동으로 진행됩니다.

## 안드로이드 앱

[Releases](../../releases)에서 `PicTrans-<버전>.apk`를 내려받아 휴대폰에 설치합니다.
(설정에서 "출처를 알 수 없는 앱 설치"를 허용해야 합니다. `.aab`는 Google Play 업로드용입니다.)

웹 화면(`www/`)을 [Capacitor](https://capacitorjs.com/)로 감싼 앱이며, `android/`가 안드로이드 프로젝트입니다.

### 새 버전 릴리스

`v`로 시작하는 태그를 푸시하면 GitHub Actions(`.github/workflows/android-release.yml`)가 APK/AAB를 빌드해 Release를 만듭니다.

```bash
git tag v1.0.1
git push origin v1.0.1
```

또는 GitHub의 **Actions → Android Release → Run workflow**에서 버전(예: `1.0.1`)을 입력해 실행해도 됩니다.

### 서명 키 등록 (권장)

키를 등록하지 않으면 빌드마다 임시 키로 서명되어, 새 버전 설치 시 기존 앱을 지워야 할 수 있습니다.
한 번만 키를 만들어 저장소 **Settings → Secrets and variables → Actions**에 등록하세요.

```bash
keytool -genkeypair -v -keystore pictrans.keystore -alias pictrans \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 pictrans.keystore   # 출력값을 ANDROID_KEYSTORE_BASE64 로 등록
```

| Secret | 값 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 위 base64 출력 |
| `ANDROID_KEYSTORE_PASSWORD` | 키스토어 비밀번호 |
| `ANDROID_KEY_ALIAS` | `pictrans` |
| `ANDROID_KEY_PASSWORD` | 키 비밀번호 (키스토어와 같으면 생략 가능) |

키스토어 파일은 저장소에 올리지 말고 안전하게 따로 보관하세요. 잃어버리면 Play 스토어 앱을 업데이트할 수 없습니다.

### 직접 빌드

Node 22+, JDK 21, Android SDK가 필요합니다.

```bash
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/
```

## 웹으로 실행

브라우저의 카메라 권한 정책 때문에 **HTTPS** 또는 **localhost**에서 열어야 합니다.

```bash
npm run serve
# 브라우저에서 http://localhost:8000 접속
```

## 사용 기술

- 카메라: 브라우저 `getUserMedia` API (후면 카메라 기본, 🔄로 전환)
- 문자 추출: [Tesseract.js](https://github.com/naptha/tesseract.js) — 브라우저 안에서 OCR 처리 (첫 사용 시 언어 데이터를 내려받음)
- 번역: [MyMemory](https://mymemory.translated.net/) 무료 번역 API — API 키 불필요, 하루 사용량 제한 있음

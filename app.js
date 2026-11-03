/* GitHub Pages 전용. QR 영상은 브라우저에서 해석하고 GAS에는 문자열만 보냅니다. */
// 같은 GAS 배포를 새 버전으로 갱신하면 이 URL은 그대로 사용합니다.
const GAS_URL = 'https://script.google.com/macros/s/AKfycby5jCVwAh8-YVe-gpYuRn2uHiAXYf7dNIARudvf188sr73VcG0P4z0xvLD81SsSLXkh/exec'; // 새 배포 URL이면 교체
const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
let stream = null;
let frame = 0;
let cameraVersion = 0;
let busy = false;
let scan = null;
let pending = null;
let lastFrameAt = 0;
let barcodeDetector = null;
let selectedCriterion = null;

function message(text = '') { $('message').textContent = text; }
function panel(name) {
  ['scan', 'loading', 'student', 'done'].forEach((value) => {
    $(`${value}-panel`).hidden = value !== name;
  });
  ['scan', 'student', 'done'].forEach((value, i) => {
    const active = value === name || (value === 'scan' && name === 'loading');
    $(`step${i + 1}`).classList.toggle('active', active);
    if (active) $(`step${i + 1}`).setAttribute('aria-current', 'step');
    else $(`step${i + 1}`).removeAttribute('aria-current');
  });
}
function stopCamera() {
  cameraVersion++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('start').hidden = false;
  $('start').disabled = false;
  $('stop').hidden = true;
  $('camera-hint').textContent = '카메라를 켜면 스캔이 시작됩니다';
}
async function prepareDecoder() {
  barcodeDetector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch { /* 지원하지 않는 환경에서는 jsQR로 처리합니다. */ }
  }
  if (!barcodeDetector && typeof window.jsQR !== 'function') {
    throw new Error('QR 인식 파일을 불러오지 못했습니다. jsQR.js도 HTML과 같은 폴더에 올려 주세요.');
  }
}
async function decodeVideo() {
  if (barcodeDetector) {
    try {
      const codes = await barcodeDetector.detect(video);
      if (codes[0]?.rawValue) return codes[0].rawValue;
    } catch {
      barcodeDetector = null;
      if (typeof window.jsQR !== 'function') throw new Error('기기 QR 인식기를 사용할 수 없고 대체 인식 파일도 없습니다. 페이지를 다시 열어 주세요.');
    }
  }
  if (typeof window.jsQR !== 'function') return null;
  // 기존에 인식되던 버전과 같은 최대 1200px 해상도를 사용합니다.
  const scale = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data || null;
}
async function api(action, payload) {
  if (!window.isSecureContext) {
    throw new Error(
      '보안 연결이 아닙니다. HTTPS 주소에서 다시 접속해 주세요.'
    );
  }
  // HTML 폼 제출은 CORS fetch가 아닙니다. GAS의 응답 페이지가 postMessage로
  // 처리 결과를 반환합니다. HTML을 JSON으로 읽거나 no-cors로 성공을 추측하지 않습니다.
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.name = 'gas_' + nonce.replaceAll('-', '');
    frame.hidden = true;
    frame.referrerPolicy = 'no-referrer';
    const form = document.createElement('form');
    form.method = 'POST'; form.action = GAS_URL; form.target = frame.name; form.hidden = true;
    const field = document.createElement('input');
    field.type = 'hidden'; field.name = 'packet';
    field.value = JSON.stringify({ action, payload, nonce, replyOrigin: location.origin });
    form.append(field);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      form.remove(); frame.remove();
    };
    const onMessage = (event) => {
      
      let host;
      try { const url = new URL(event.origin); if (url.protocol !== 'https:') return; host = url.hostname; } catch { return; }
      if (host !== 'script.google.com' && host !== 'script.googleusercontent.com' && !host.endsWith('-script.googleusercontent.com')) return;
      const packet = event.data;
      if (!packet || packet.channel !== 'qr-test-v1' || packet.nonce !== nonce || typeof packet.ok !== 'boolean') return;
      cleanup();
      if (packet.ok) resolve(packet.data);
      else {
        const error = new Error(packet.error || 'GAS에서 요청을 처리하지 못했습니다.');
        error.retryable = Boolean(packet.retryable);
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error('GAS 응답이 없습니다. 새 버전 웹 앱 배포, 모든 사용자 접근 권한, Code.gs의 PAGES_ORIGIN 설정을 확인해 주세요.');
      error.retryable = true;
      reject(error);
    }, 45000);
    window.addEventListener('message', onMessage);
    document.body.append(frame, form);
    form.submit();
  });
}
async function lookup(qr) {
  if (busy) return;
  busy = true;
  stopCamera();
  $('camera-hint').textContent = 'QR 인식 완료 · 학생 조회 중';
  $('start').disabled = true;
  $('start').textContent = 'QR 인식 완료 · 학생 조회 중…';
  panel('loading');
  message('QR 인식 성공! 시트에서 학생을 확인하고 있습니다…');
  try {
    scan = await api('lookup', { qr });
    pending = null;
    selectedCriterion = null;
    $('selection-summary').hidden = true;
    $('student-name').textContent = scan.student.name;
    $('student-detail').textContent = 'QR식별값이 일치하는 학생입니다.';
    $('student-grade').textContent = scan.student.grade || '—';
    $('student-class').textContent = scan.student.classNo || '—';
    $('student-number').textContent = scan.student.number || '—';
    $('student-year').textContent = scan.student.year;
    $('student-qr').textContent = scan.student.qr;
    $('requester-id').textContent = scan.requesterId;
    $('criteria').replaceChildren();
    for (const item of scan.criteria) {
      const label = document.createElement('label');
      label.className = 'criterion';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'criterion'; input.value = item.code;
      input.addEventListener('change', () => {
        selectedCriterion = item;
        pending = null;
        $('selected-reason').textContent = item.reason;
        $('selected-score').textContent = String(item.score);
        $('selection-summary').hidden = false;
        $('submit').textContent = '확인 · 시트에 저장';
        $('submit').disabled = false;
      });
      const reason = document.createElement('span');
      reason.textContent = item.reason;
      const score = document.createElement('b');
      score.textContent = `${item.score}점`;
      label.append(input, reason, score);
      $('criteria').append(label);
    }
    $('limits').textContent = scan.limitsEnabled !== false && scan.remaining
      ? `남은 등록: 전체 ${scan.remaining.total}건 / 이 학생 ${scan.remaining.student}건. QR 조회는 5분간 유효합니다.`
      : '학생 정보를 확인한 뒤 벌점을 선택해 주세요. QR 조회는 5분간 유효합니다.';
    $('criteria-empty').hidden = scan.criteria.length > 0;

    if (scan.criteria.length === 0) {
      message(
        scan.criteriaError
          ? '점수기준 시트 조회 실패: ' + scan.criteriaError
          : '현재 적용 가능한 벌점 항목이 없습니다. 점수기준 시트의 구분, 점수, 적용시작일, 사용여부를 확인해 주세요.'
      );
    }
    if (scan.criteriaError) {
      message('점수기준 조회 오류: ' + scan.criteriaError);
    }
    $('submit').disabled = true;
    panel('student');

    if (scan.criteria.length > 0) {
      message('');
    }
  } catch (error) {
    scan = null;
    panel('scan');
    message('QR은 인식했습니다.\n' + (error.message || '학생 조회에 실패했습니다. 카메라를 켜고 다시 스캔해 주세요.'));
  } finally {
    busy = false;
    $('start').disabled = false;
    $('start').textContent = 'QR 다시 스캔';
  }
}
async function decode(time, version) {
  if (!stream || version !== cameraVersion) return;
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && time - lastFrameAt > 220) {
    lastFrameAt = time;
    try {
      const value = await decodeVideo();
      if (!stream || version !== cameraVersion) return;
      if (value) { void lookup(value); return; }
    } catch (error) {
      if (version !== cameraVersion) return;
      stopCamera();
      message(error.message || 'QR 영상을 처리하지 못했습니다. 카메라를 다시 켜 주세요.');
      return;
    }
  }
  if (stream && version === cameraVersion) frame = requestAnimationFrame((next) => { void decode(next, version); });
}
async function startCamera() {
  if (busy || stream || $('start').disabled) return;
  message();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return message('카메라를 사용할 수 없습니다. HTTPS 주소로 접속해 주세요. PC에서는 localhost도 사용할 수 있습니다.');
  }
  const version = ++cameraVersion;
  $('start').disabled = true;
  $('stop').hidden = false;
  try {
    await prepareDecoder();
    if (version !== cameraVersion) return;
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    if (version !== cameraVersion) { acquired.getTracks().forEach((track) => track.stop()); return; }
    stream = acquired;
    video.srcObject = stream;
    await video.play();
    if (version !== cameraVersion) return;
    $('start').hidden = true;
    $('stop').hidden = false;
    $('camera-hint').textContent = 'QR 코드를 중앙에 맞춰 주세요';
    message('카메라 연결 완료 · QR을 찾고 있어요. QR 전체가 보이도록 맞춰 주세요.');
    lastFrameAt = 0;
    frame = requestAnimationFrame((time) => { void decode(time, version); });
  } catch (error) {
    if (version !== cameraVersion) return;
    stopCamera();
    message(error.name === 'NotAllowedError' ? '카메라 접근을 허용한 뒤 다시 켜 주세요.' : error.message || '카메라를 열 수 없습니다. 다른 앱의 카메라 사용을 종료하고 다시 시도해 주세요.');
  }
}
async function submit() {
  if (busy || !scan) return;
  const code = selectedCriterion?.code;
  if (!code) return;
  pending ??= { scanToken: scan.scanToken, code, requestId: crypto.randomUUID() };
  busy = true;
  $('submit').disabled = true;
  $('rescan').disabled = true;
  document.querySelectorAll('input[name="criterion"]').forEach((input) => { input.disabled = true; });
  message('학생 정보와 선택한 벌점을 시트에 저장하고 있습니다…');
  try {
    const result = await api('submit', pending);
    $('saved-student').textContent = `${result.student.name} · ${result.student.grade}학년 ${result.student.classNo}반 ${result.student.number}번`;
    $('saved-reason').textContent = selectedCriterion.reason;
    $('saved-score').textContent = `${result.score ?? selectedCriterion.score}점`;
    $('saved-requester').textContent = result.requesterId;
    $('receipt').textContent = `점수 부여 ${result.row}행 · ${result.status}`;
    panel('done');
    scan = null; pending = null; message();
    void loadRecords();
  } catch (error) {
    // 응답 유실 시 항목 변경/다른 QR로 이동하면 중복 등록할 수 있으므로 재시도만 허용합니다.
    message(`${error.message || '연결이 끊겼습니다.'}\n응답이 불확실하면 같은 요청으로 다시 시도해 주세요. 같은 요청ID는 한 번만 저장됩니다.`);
    $('submit').textContent = '같은 요청으로 다시 확인';
    if (error.retryable === false) {
      pending = null;
      $('rescan').disabled = false;
      document.querySelectorAll('input[name="criterion"]').forEach((input) => { input.disabled = false; });
    }
  } finally { busy = false; $('submit').disabled = false; }
}
function reset() {
  if (busy) return;
  scan = null; pending = null;
  selectedCriterion = null;
  $('submit').textContent = '확인 · 시트에 저장';
  $('rescan').disabled = false;
  panel('scan'); message();
  void startCamera();
}
$('start').addEventListener('click', startCamera);
$('stop').addEventListener('click', stopCamera);
$('submit').addEventListener('click', submit);
$('rescan').addEventListener('click', reset);
$('again').addEventListener('click', reset);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);


/* ==================== 전체 기록 (Google Sheets) ==================== */
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
let recordsBusy = false;
let currentRecords = [];

// 카테고리별 전체 기록 구분해서 표시
let recordPeriod = "today";

function getFilteredRecords() {
  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  return currentRecords.filter(record => {
    if (recordPeriod === "all") return true;

    const date = new Date(
      String(record.createdAt).replace(" ", "T")
    );

    if (Number.isNaN(date.getTime())) return false;

    if (recordPeriod === "today") {
      return date >= today;
    }

    if (recordPeriod === "week") {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return date >= start && date <= now;
    }

    return true;
  });
}

function renderRecords() {
  const records = getFilteredRecords();

  document.querySelectorAll(".record-filter")
    .forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.period === recordPeriod
      );
    });

  $("record-count").textContent =
    `${records.length}건의 기록`;

  $("record-list").innerHTML = records.length
    ? records.map(recordCard).join("")
    : '<div class="empty-records">해당 기간의 기록이 없습니다.</div>';
}

document.querySelectorAll(".record-filter")
  .forEach(button => {
    button.addEventListener("click", () => {
      recordPeriod = button.dataset.period;
      renderRecords();
    });
  });

function switchView(view) {
  const showRecords = view === 'records';
  $('scan-view').hidden = showRecords;
  $('records-view').hidden = !showRecords;
  $('tab-scan').classList.toggle('active', !showRecords);
  $('tab-records').classList.toggle('active', showRecords);
  if (showRecords) { stopCamera(); void loadRecords(); }
  message('');
}
function recordCard(r) {
  const score = Number(r.score);
  const signed = score > 0 ? `+${score}` : String(score);
  const category = score > 0 ? 'merit' : 'demerit';
  const canDelete = !!r.id;
  return `<article class="record-card">
    <div class="record-top"><div><strong>${escapeHTML(r.studentName)}</strong><span class="record-student">${escapeHTML(r.grade)}학년 ${escapeHTML(r.classNo)}반 ${escapeHTML(r.number)}번</span></div>
      <b class="record-score ${category}">${escapeHTML(signed)}점</b></div>
    <p class="record-reason">${escapeHTML(r.reason)}</p>
    <div class="record-bottom"><div><time>${escapeHTML(r.createdAt)}</time><small>등록자: ${escapeHTML(r.requesterId || '테스트')}</small></div>
      ${canDelete ? `<button type="button" class="record-delete" data-record-id="${escapeHTML(r.id)}">삭제</button>` : '<small>이전 기록</small>'}</div>
  </article>`;
}

async function loadRecords() {
  if (recordsBusy) return;

  recordsBusy = true;
  $("refresh-records").disabled = true;
  $("record-count").textContent =
    "Google Sheets에서 기록 불러오는 중…";

  try {
    const result = await api("getRecords", {});

    if (!Array.isArray(result)) {
      throw new Error("기록 데이터 형식이 올바르지 않습니다.");
    }

    currentRecords = result;
    renderRecords();

  } catch (error) {
    $("record-count").textContent = "기록 조회 실패";
    $("record-list").textContent =
      error.message || "시트 연결을 확인해 주세요.";
  } finally {
    recordsBusy = false;
    $("refresh-records").disabled = false;
  }
}

async function deleteRecord(id) {
  if (!confirm('이 기록을 삭제 처리할까요? 시트에는 삭제 이력이 남습니다.')) return;
  const buttons = [...document.querySelectorAll('.record-delete')];
  buttons.forEach(b => b.disabled = true);
  try {
    const result = await api('deleteRecord', { id });

    if (!result || result.success !== true) {
      throw new Error('삭제 처리 결과를 확인하지 못했습니다.');
    }

    await loadRecords();
  } catch (error) {
    alert('삭제 실패: ' + (error.message || '알 수 없는 오류'));
  } finally { buttons.forEach(b => b.disabled = false); }
}
$('tab-scan').addEventListener('click', () => switchView('scan'));
$('tab-records').addEventListener('click', () => switchView('records'));
$('refresh-records').addEventListener('click', loadRecords);
$('record-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-record-id]');
  if (button) void deleteRecord(button.dataset.recordId);
});

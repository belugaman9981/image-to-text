'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Screens ────────────────────────────────────────────────────────────────
const screens = {
  home:       $('home-screen'),
  crop:       $('crop-screen'),
  processing: $('processing-screen'),
  result:     $('result-screen'),
  error:      $('error-screen'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showError(msg) {
  $('error-message').textContent = msg;
  showScreen('error');
}

// ── Language selector (persisted) ──────────────────────────────────────────
chrome.storage.local.get('ocrLang', ({ ocrLang }) => {
  if (ocrLang) $('lang-select').value = ocrLang;
});

$('lang-select').addEventListener('change', function () {
  chrome.storage.local.set({ ocrLang: this.value });
});

function getLang() {
  return $('lang-select').value || 'eng';
}

// ═══════════════════════════════════════════════════════════════════════════
// OCR  (ocr.space free API)
// ═══════════════════════════════════════════════════════════════════════════
const OCR_KEY = 'helloworld';

function compressImage(dataUrl, maxKB) {
  maxKB = maxKB || 900;
  if (dataUrl.length * 0.75 / 1024 <= maxKB) return Promise.resolve(dataUrl);

  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const byteRatio = Math.max(0.2, Math.sqrt((maxKB * 1024) / (dataUrl.length * 0.75)));
      const edgeRatio = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      const ratio = Math.min(byteRatio, edgeRatio);
      const c = document.createElement('canvas');
      c.width  = Math.max(1, Math.floor(img.naturalWidth  * ratio));
      c.height = Math.max(1, Math.floor(img.naturalHeight * ratio));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function callOcr(dataUrl, engine) {
  const compressed = await compressImage(dataUrl);
  const fd = new FormData();
  fd.append('apikey',            OCR_KEY);
  fd.append('base64image',       compressed);
  fd.append('language',          getLang());
  fd.append('isOverlayRequired', 'false');
  fd.append('OCREngine',         String(engine));

  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('Server error ' + res.status + '. Try again.');

  const json = await res.json();

  if (json.IsErroredOnProcessing) {
    const msg = Array.isArray(json.ErrorMessage)
      ? json.ErrorMessage[0]
      : (json.ErrorMessage || 'OCR processing failed.');
    throw new Error(msg);
  }

  if (!json.ParsedResults || !json.ParsedResults.length) return '';
  return json.ParsedResults.map(r => r.ParsedText).join('\n').trim();
}

async function performOCR(dataUrl) {
  try {
    const text = await callOcr(dataUrl, 1);
    if (text) return text;
    return await callOcr(dataUrl, 2);
  } catch (firstErr) {
    try { return await callOcr(dataUrl, 2); }
    catch (_) { throw firstErr; }
  }
}

async function processImage(dataUrl) {
  showScreen('processing');
  try {
    const text = await performOCR(dataUrl);
    $('result-text').value = text;
    showScreen('result');
  } catch (err) {
    showError(err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE READING  (shared by upload, paste, drag-drop)
// ═══════════════════════════════════════════════════════════════════════════
function readFileAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read the file.'));
    reader.readAsDataURL(blob);
  });
}

async function handleImageInput(fileOrBlob) {
  if (!fileOrBlob || !fileOrBlob.type || !fileOrBlob.type.startsWith('image/')) {
    showError('Please use a valid image file (JPG, PNG, GIF, WEBP).');
    return;
  }
  const dataUrl = await readFileAsDataUrl(fileOrBlob);
  showCropScreen(dataUrl);
}

// ═══════════════════════════════════════════════════════════════════════════
// CROP SCREEN
// ═══════════════════════════════════════════════════════════════════════════
let cropImage   = null;
let cropDataUrl = null;
let cropSel     = { x: 0, y: 0, w: 0, h: 0 };
let drawing     = false;
let dragOrigin  = { x: 0, y: 0 };
let scaleX      = 1;
let scaleY      = 1;

const canvas      = $('crop-canvas');
const ctx         = canvas.getContext('2d');
const placeholder = $('canvas-placeholder');

function showCropScreen(dataUrl) {
  cropDataUrl = dataUrl;
  cropSel     = { x: 0, y: 0, w: 0, h: 0 };
  drawing     = false;

  placeholder.classList.remove('hidden');
  canvas.style.display = 'none';
  showScreen('crop');

  const img = new Image();
  img.onload = () => {
    cropImage = img;
    const maxW = 316, maxH = 280;
    const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    canvas.width  = Math.round(img.naturalWidth  * ratio);
    canvas.height = Math.round(img.naturalHeight * ratio);
    scaleX = img.naturalWidth  / canvas.width;
    scaleY = img.naturalHeight / canvas.height;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    placeholder.classList.add('hidden');
    canvas.style.display = 'block';
  };
  img.onerror = () => processImage(dataUrl);
  img.src = dataUrl;
}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(e.clientX - r.left, canvas.width)),
    y: Math.max(0, Math.min(e.clientY - r.top,  canvas.height)),
  };
}

function drawOverlay() {
  if (!cropImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cropImage, 0, 0, canvas.width, canvas.height);

  const sw = Math.abs(cropSel.w), sh = Math.abs(cropSel.h);
  if (sw < 3 || sh < 3) return;

  const sx = Math.min(cropSel.x, cropSel.x + cropSel.w);
  const sy = Math.min(cropSel.y, cropSel.y + cropSel.h);

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(sx, sy, sw, sh);
  ctx.drawImage(cropImage,
    sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY,
    sx, sy, sw, sh);

  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
  ctx.setLineDash([]);
}

canvas.addEventListener('mousedown', e => {
  const p = canvasPos(e);
  dragOrigin = p;
  cropSel = { x: p.x, y: p.y, w: 0, h: 0 };
  drawing = true;
});
canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  const p = canvasPos(e);
  cropSel.w = p.x - dragOrigin.x;
  cropSel.h = p.y - dragOrigin.y;
  drawOverlay();
});
canvas.addEventListener('mouseup',    () => { drawing = false; });
canvas.addEventListener('mouseleave', () => { drawing = false; });

$('crop-extract-btn').addEventListener('click', () => {
  const sw = Math.abs(cropSel.w), sh = Math.abs(cropSel.h);
  if (sw < 10 || sh < 10) { processImage(cropDataUrl); return; }

  const sx = Math.min(cropSel.x, cropSel.x + cropSel.w);
  const sy = Math.min(cropSel.y, cropSel.y + cropSel.h);
  const off = document.createElement('canvas');
  off.width  = Math.round(sw * scaleX);
  off.height = Math.round(sh * scaleY);
  off.getContext('2d').drawImage(cropImage,
    sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY,
    0, 0, off.width, off.height);
  processImage(off.toDataURL('image/png'));
});

$('crop-full-btn').addEventListener('click', () => processImage(cropDataUrl));

$('crop-back-btn').addEventListener('click', () => {
  cropImage = null;
  cropDataUrl = null;
  showScreen('home');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1) UPLOAD IMAGE
// ═══════════════════════════════════════════════════════════════════════════
$('upload-btn').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', function () {
  const file = this.files[0];
  this.value = '';
  if (file) handleImageInput(file);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) TAKE SCREENSHOT
// ═══════════════════════════════════════════════════════════════════════════
$('screenshot-btn').addEventListener('click', () => {
  showScreen('processing');
  chrome.runtime.sendMessage({ action: 'takeScreenshot' }, response => {
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }
    if (!response || response.error) {
      showError((response && response.error) || 'Screenshot failed.');
      return;
    }
    if (!response.dataUrl) {
      showError('Screenshot returned no image data.');
      return;
    }
    showCropScreen(response.dataUrl);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) PASTE FROM CLIPBOARD
// ═══════════════════════════════════════════════════════════════════════════
async function readClipboardImage() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error('Clipboard API not available. Use Upload instead.');
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imgType = item.types.find(t => t.startsWith('image/'));
    if (imgType) {
      const blob = await item.getType(imgType);
      await handleImageInput(blob);
      return;
    }
  }
  throw new Error('No image in clipboard. Copy an image first.');
}

$('clipboard-btn').addEventListener('click', () => {
  readClipboardImage().catch(err => {
    showError(err.name === 'NotAllowedError'
      ? 'Clipboard access denied. Allow it in browser settings.'
      : err.message);
  });
});

// Ctrl+V / Cmd+V on homepage
document.addEventListener('paste', e => {
  if (!screens.home.classList.contains('active')) return;
  const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
  const imgItem = items.find(i => i.type.startsWith('image/'));
  if (!imgItem) return;
  e.preventDefault();
  handleImageInput(imgItem.getAsFile());
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) DRAG & DROP
// ═══════════════════════════════════════════════════════════════════════════
let dragDepth = 0;

document.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!screens.home.classList.contains('active')) return;
  dragDepth++;
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag-over');
  }
});

document.addEventListener('dragover', e => e.preventDefault());

document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  if (!screens.home.classList.contains('active')) return;
  const file = e.dataTransfer.files[0];
  if (file) handleImageInput(file);
});

// ═══════════════════════════════════════════════════════════════════════════
// RESULT SCREEN — Copy / Download / Back / Retry
// ═══════════════════════════════════════════════════════════════════════════
$('copy-btn').addEventListener('click', async function () {
  const text  = $('result-text').value;
  const label = this.querySelector('.btn-label');
  try { await navigator.clipboard.writeText(text); }
  catch (_) { $('result-text').select(); document.execCommand('copy'); }
  this.classList.add('copied');
  label.textContent = 'Copied!';
  const btn = this;
  setTimeout(() => { btn.classList.remove('copied'); label.textContent = 'Copy All'; }, 2000);
});

$('download-btn').addEventListener('click', () => {
  const blob = new Blob([$('result-text').value], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'extracted-text.txt';
  a.click();
  URL.revokeObjectURL(url);
});

$('back-btn').addEventListener('click', () => {
  $('result-text').value = '';
  hideAiPanel();
  showScreen('home');
});

$('retry-btn').addEventListener('click', () => {
  hideAiPanel();
  showScreen('home');
});

// ═══════════════════════════════════════════════════════════════════════════
// AI CLEANUP  (Anthropic — optional, needs user's key)
// ═══════════════════════════════════════════════════════════════════════════
function clearAiError() {
  const el = $('ai-inline-error');
  if (el) el.remove();
}

function showAiError(msg) {
  clearAiError();
  const p = document.createElement('p');
  p.id = 'ai-inline-error';
  p.style.cssText = 'font-size:11px;color:#c47a6a;margin-top:2px;';
  p.textContent = msg;
  $('ai-btn').insertAdjacentElement('afterend', p);
  setTimeout(clearAiError, 6000);
}

function hideAiPanel() {
  $('api-key-panel').style.display = 'none';
  $('api-key-input').value = '';
  clearAiError();
}

function setAiLoading(on) {
  $('ai-btn').disabled = on;
  $('ai-spinner').classList.toggle('visible', on);
  $('ai-btn-label').textContent = on ? 'Cleaning up…' : 'Clean up with AI';
}

function getApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('anthropicApiKey', d => resolve(d.anthropicApiKey || null));
  });
}

function storeApiKey(key) {
  return new Promise(resolve => {
    chrome.storage.local.set({ anthropicApiKey: key }, resolve);
  });
}

async function runAiCleanup(apiKey) {
  const rawText = $('result-text').value.trim();
  if (!rawText) return;

  setAiLoading(true);
  hideAiPanel();

  try {
    const maxTok = Math.max(256, Math.min(1024, Math.ceil(rawText.length / 3)));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: maxTok,
        messages: [{
          role: 'user',
          content:
            'You are an OCR post-processor. Fix recognition errors, spacing, ' +
            'punctuation and formatting. Return ONLY the corrected text.\n\n' +
            rawText,
        }],
      }),
    });

    if (!res.ok) {
      let errMsg = 'API error ' + res.status + '.';
      try { const ed = await res.json(); errMsg = (ed.error && ed.error.message) || errMsg; } catch (_) {}
      if (res.status === 401) chrome.storage.local.remove('anthropicApiKey');
      throw new Error(errMsg);
    }

    const json = await res.json();
    const cleaned = json.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    $('result-text').value = cleaned;
    clearAiError();
  } catch (err) {
    showAiError(err.message);
  } finally {
    setAiLoading(false);
  }
}

// "Clean up with AI" button
$('ai-btn').addEventListener('click', async () => {
  const text = $('result-text').value.trim();
  if (!text) return;

  const key = await getApiKey();
  if (key) {
    await runAiCleanup(key);
  } else {
    const panel = $('api-key-panel');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'flex';
    panel.style.flexDirection = 'column';
    if (!visible) $('api-key-input').focus();
  }
});

// Save key + run
async function saveKeyAndRun() {
  const key = $('api-key-input').value.trim();
  if (!key) {
    showAiError('Paste your Anthropic API key first.');
    $('api-key-input').focus();
    return;
  }
  await storeApiKey(key);
  await runAiCleanup(key);
}

$('save-key-btn').addEventListener('click', saveKeyAndRun);

$('api-key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); saveKeyAndRun(); }
});

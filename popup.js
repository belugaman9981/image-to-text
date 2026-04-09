'use strict';

// ── Screen references ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const homeScreen       = $('home-screen');
const cropScreen       = $('crop-screen');
const processingScreen = $('processing-screen');
const resultScreen     = $('result-screen');
const errorScreen      = $('error-screen');

function showScreen(el) {
  [homeScreen, cropScreen, processingScreen, resultScreen, errorScreen]
    .forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

function showError(msg) {
  $('error-message').textContent = msg;
  showScreen(errorScreen);
}

// ── Language selector ──────────────────────────────────────────────────────
// Persist the last-used language
chrome.storage.local.get('ocrLang', ({ ocrLang }) => {
  if (ocrLang) $('lang-select').value = ocrLang;
});
$('lang-select').addEventListener('change', function () {
  chrome.storage.local.set({ ocrLang: this.value });
});

function getSelectedLang() {
  return $('lang-select').value || 'eng';
}

// ── OCR via OCR.space ──────────────────────────────────────────────────────
const OCR_API_KEY = 'helloworld';

async function compressImage(dataUrl, maxKB = 900) {
  if (dataUrl.length * 0.75 / 1024 <= maxKB) return dataUrl;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio  = Math.sqrt((maxKB * 1024) / (dataUrl.length * 0.75));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.floor(img.naturalWidth  * ratio);
      canvas.height = Math.floor(img.naturalHeight * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.src = dataUrl;
  });
}

async function performOCR(dataUrl) {
  const compressed = await compressImage(dataUrl);
  const body = new FormData();
  body.append('apikey',            OCR_API_KEY);
  body.append('base64image',       compressed);
  body.append('language',          getSelectedLang());
  body.append('isOverlayRequired', 'false');
  body.append('OCREngine',         '2');

  const res = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body
  });

  if (!res.ok) throw new Error(`Server error ${res.status}. Please try again.`);

  const data = await res.json();

  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage[0]
      : (data.ErrorMessage || 'OCR processing failed.');
    throw new Error(msg);
  }

  if (!data.ParsedResults?.length) return '';
  return data.ParsedResults.map(r => r.ParsedText).join('\n').trim();
}

async function processImage(dataUrl) {
  showScreen(processingScreen);
  try {
    const text = await performOCR(dataUrl);
    $('result-text').value = text;
    showScreen(resultScreen);
  } catch (err) {
    showError(err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CROP SCREEN
// ═══════════════════════════════════════════════════════════════════════════
let cropOriginalImage = null;
let cropDataUrl       = null;
let cropSel           = { x: 0, y: 0, w: 0, h: 0 };
let isDrawing         = false;
let dragStart         = { x: 0, y: 0 };
let scaleFactorX      = 1;
let scaleFactorY      = 1;

const cropCanvas  = $('crop-canvas');
const cropCtx     = cropCanvas.getContext('2d');
const placeholder = $('canvas-placeholder');

function showCropScreen(dataUrl) {
  cropDataUrl = dataUrl;
  cropSel = { x: 0, y: 0, w: 0, h: 0 };
  isDrawing = false;

  // Show placeholder while image loads
  placeholder.classList.remove('hidden');
  cropCanvas.style.display = 'none';

  showScreen(cropScreen);

  const img = new Image();
  img.onload = () => {
    cropOriginalImage = img;

    // Fit within the popup canvas area (max 316 × 280)
    const maxW = 316;
    const maxH = 280;
    const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    cropCanvas.width  = Math.round(img.naturalWidth  * ratio);
    cropCanvas.height = Math.round(img.naturalHeight * ratio);

    scaleFactorX = img.naturalWidth  / cropCanvas.width;
    scaleFactorY = img.naturalHeight / cropCanvas.height;

    cropCtx.drawImage(img, 0, 0, cropCanvas.width, cropCanvas.height);

    placeholder.classList.add('hidden');
    cropCanvas.style.display = 'block';
  };
  img.onerror = () => {
    // Fallback: skip crop and go straight to OCR
    processImage(dataUrl);
  };
  img.src = dataUrl;
}

function getCanvasPos(e) {
  const rect = cropCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(e.clientX - rect.left, cropCanvas.width)),
    y: Math.max(0, Math.min(e.clientY - rect.top,  cropCanvas.height))
  };
}

function drawCropOverlay() {
  if (!cropOriginalImage) return;

  // Redraw the full image first
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(cropOriginalImage, 0, 0, cropCanvas.width, cropCanvas.height);

  const sw = Math.abs(cropSel.w);
  const sh = Math.abs(cropSel.h);

  if (sw < 2 || sh < 2) return;

  const sx = Math.min(cropSel.x, cropSel.x + cropSel.w);
  const sy = Math.min(cropSel.y, cropSel.y + cropSel.h);

  // Darken everything outside selection
  cropCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);

  // Restore the selected region at full brightness
  cropCtx.clearRect(sx, sy, sw, sh);
  cropCtx.drawImage(
    cropOriginalImage,
    sx * scaleFactorX, sy * scaleFactorY,
    sw * scaleFactorX, sh * scaleFactorY,
    sx, sy, sw, sh
  );

  // Dashed selection border
  cropCtx.strokeStyle = '#7a8f82';
  cropCtx.lineWidth = 1.5;
  cropCtx.setLineDash([5, 3]);
  cropCtx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
  cropCtx.setLineDash([]);

  // Corner handles
  const h = 6;
  cropCtx.fillStyle = '#fff';
  [
    [sx,      sy     ],
    [sx + sw, sy     ],
    [sx,      sy + sh],
    [sx + sw, sy + sh]
  ].forEach(([hx, hy]) => {
    cropCtx.fillRect(hx - h / 2, hy - h / 2, h, h);
    cropCtx.strokeStyle = '#7a8f82';
    cropCtx.lineWidth = 1.5;
    cropCtx.strokeRect(hx - h / 2, hy - h / 2, h, h);
  });
}

cropCanvas.addEventListener('mousedown', e => {
  const pos = getCanvasPos(e);
  dragStart = { ...pos };
  cropSel   = { x: pos.x, y: pos.y, w: 0, h: 0 };
  isDrawing = true;
});

cropCanvas.addEventListener('mousemove', e => {
  if (!isDrawing) return;
  const pos = getCanvasPos(e);
  cropSel.w = pos.x - dragStart.x;
  cropSel.h = pos.y - dragStart.y;
  drawCropOverlay();
});

cropCanvas.addEventListener('mouseup',    () => { isDrawing = false; });
cropCanvas.addEventListener('mouseleave', () => { isDrawing = false; });

// "Extract Region" — crop and OCR the selected area
$('crop-extract-btn').addEventListener('click', () => {
  const sw = Math.abs(cropSel.w);
  const sh = Math.abs(cropSel.h);

  if (sw < 10 || sh < 10) {
    // No meaningful selection — use full image
    processImage(cropDataUrl);
    return;
  }

  const sx = Math.min(cropSel.x, cropSel.x + cropSel.w);
  const sy = Math.min(cropSel.y, cropSel.y + cropSel.h);

  const offCanvas = document.createElement('canvas');
  offCanvas.width  = Math.round(sw * scaleFactorX);
  offCanvas.height = Math.round(sh * scaleFactorY);

  offCanvas.getContext('2d').drawImage(
    cropOriginalImage,
    sx * scaleFactorX, sy * scaleFactorY,
    sw * scaleFactorX, sh * scaleFactorY,
    0, 0, offCanvas.width, offCanvas.height
  );

  processImage(offCanvas.toDataURL('image/png'));
});

// "Full Image" — skip region selection
$('crop-full-btn').addEventListener('click', () => processImage(cropDataUrl));

// Back button on crop screen
$('crop-back-btn').addEventListener('click', () => {
  cropOriginalImage = null;
  cropDataUrl = null;
  showScreen(homeScreen);
});

// ── Upload Image ───────────────────────────────────────────────────────────
$('upload-btn').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', function () {
  const file = this.files[0];
  this.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError('Please select a valid image file (JPG, PNG, GIF, WEBP, etc.).');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => showCropScreen(e.target.result);
  reader.readAsDataURL(file);
});

// ── Take Screenshot ────────────────────────────────────────────────────────
$('screenshot-btn').addEventListener('click', () => {
  // Show processing briefly while we capture
  showScreen(processingScreen);
  chrome.runtime.sendMessage({ action: 'takeScreenshot' }, response => {
    const err = chrome.runtime.lastError?.message || response?.error;
    if (err) { showError(err); return; }
    showCropScreen(response.dataUrl);
  });
});

// ── Paste from Clipboard ───────────────────────────────────────────────────
async function readClipboard() {
  try {
    if (!navigator.clipboard?.read) {
      throw new Error('Clipboard API unavailable. Try using the Upload option instead.');
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob   = await item.getType(imgType);
        const reader = new FileReader();
        reader.onload = e => showCropScreen(e.target.result);
        reader.readAsDataURL(blob);
        return;
      }
    }
    throw new Error('No image found in clipboard. Copy an image first, then click this button.');
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Clipboard access denied. Allow clipboard access in your browser settings.'
      : err.message;
    showError(msg);
  }
}

$('clipboard-btn').addEventListener('click', readClipboard);

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'v' && homeScreen.classList.contains('active')) {
    e.preventDefault();
    readClipboard();
  }
});

// ── Drag & Drop ────────────────────────────────────────────────────────────
let dragDepth = 0;

document.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!homeScreen.classList.contains('active')) return;
  dragDepth++;
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag-over');
  }
});

document.addEventListener('dragover',  e => e.preventDefault());

document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  if (!homeScreen.classList.contains('active')) return;

  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError('Please drop an image file (JPG, PNG, GIF, WEBP, etc.).');
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => showCropScreen(ev.target.result);
  reader.readAsDataURL(file);
});

// ── Copy All button ────────────────────────────────────────────────────────
$('copy-btn').addEventListener('click', async () => {
  const text  = $('result-text').value;
  const btn   = $('copy-btn');
  const label = btn.querySelector('.btn-label');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('result-text').select();
    document.execCommand('copy');
  }
  btn.classList.add('copied');
  label.textContent = 'Copied!';
  setTimeout(() => {
    btn.classList.remove('copied');
    label.textContent = 'Copy All';
  }, 2000);
});

// ── Download as .txt ───────────────────────────────────────────────────────
$('download-btn').addEventListener('click', () => {
  const text = $('result-text').value;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'extracted-text.txt';
  a.click();
  URL.revokeObjectURL(url);
});

// ── Back / Try Again ───────────────────────────────────────────────────────
$('back-btn').addEventListener('click', () => {
  $('result-text').value = '';
  hideApiKeyPanel();
  showScreen(homeScreen);
});

$('retry-btn').addEventListener('click', () => {
  hideApiKeyPanel();
  showScreen(homeScreen);
});

// ═══════════════════════════════════════════════════════════════════════════
// AI CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

function hideApiKeyPanel() {
  $('api-key-panel').style.display = 'none';
  $('api-key-input').value = '';
}

function setAiLoading(loading) {
  const btn     = $('ai-btn');
  const label   = $('ai-btn-label');
  const spinner = $('ai-spinner');

  btn.disabled = loading;
  spinner.classList.toggle('visible', loading);
  label.textContent = loading ? 'Cleaning up…' : 'Clean up with AI';
}

async function getStoredApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('anthropicApiKey', data =>
      resolve(data.anthropicApiKey || null)
    );
  });
}

async function saveApiKey(key) {
  return new Promise(resolve => {
    chrome.storage.local.set({ anthropicApiKey: key }, resolve);
  });
}

async function runAiCleanup(apiKey) {
  const rawText = $('result-text').value.trim();
  if (!rawText) return;

  setAiLoading(true);
  hideApiKeyPanel();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content:
            'You are an OCR post-processor. Fix all character recognition errors, ' +
            'correct spacing and punctuation, and restore proper formatting. ' +
            'Return ONLY the corrected text — no explanations, no preamble.\n\n' +
            rawText
        }]
      })
    });

    if (!response.ok) {
      let errMsg = `API error ${response.status}.`;
      try {
        const errData = await response.json();
        errMsg = errData.error?.message || errMsg;
      } catch { /* ignore */ }

      // Clear bad key so user can re-enter
      if (response.status === 401) {
        chrome.storage.local.remove('anthropicApiKey');
      }
      throw new Error(errMsg);
    }

    const data = await response.json();
    const cleaned = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    $('result-text').value = cleaned;

  } catch (err) {
    // Show error inline rather than navigating away
    const errP = document.createElement('p');
    errP.style.cssText = 'font-size:11px;color:#c47a6a;margin-top:-4px;';
    errP.textContent = err.message;
    const aiBtn = $('ai-btn');
    const existing = aiBtn.nextSibling;
    if (existing && existing.tagName === 'P') existing.remove();
    aiBtn.insertAdjacentElement('afterend', errP);
    setTimeout(() => errP.remove(), 6000);
  } finally {
    setAiLoading(false);
  }
}

$('ai-btn').addEventListener('click', async () => {
  const text = $('result-text').value.trim();
  if (!text) return;

  const apiKey = await getStoredApiKey();

  if (apiKey) {
    await runAiCleanup(apiKey);
  } else {
    // Show the API key input panel
    const panel = $('api-key-panel');
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'flex';
    panel.style.flexDirection = 'column';
    if (!isVisible) $('api-key-input').focus();
  }
});

$('save-key-btn').addEventListener('click', async () => {
  const key = $('api-key-input').value.trim();
  if (!key.startsWith('sk-ant-')) {
    $('api-key-input').style.borderColor = '#c47a6a';
    setTimeout(() => ($('api-key-input').style.borderColor = ''), 1500);
    return;
  }
  await saveApiKey(key);
  await runAiCleanup(key);
});

// Allow pressing Enter in the key input
$('api-key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('save-key-btn').click();
});

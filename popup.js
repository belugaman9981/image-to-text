'use strict';

// ── Screen references ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const homeScreen       = $('home-screen');
const processingScreen = $('processing-screen');
const resultScreen     = $('result-screen');
const errorScreen      = $('error-screen');

function showScreen(el) {
  [homeScreen, processingScreen, resultScreen, errorScreen]
    .forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

function showError(msg) {
  $('error-message').textContent = msg;
  showScreen(errorScreen);
}

// ── OCR via OCR.space (free "helloworld" demo key) ─────────────────────────
// You can replace 'helloworld' with a free personal key from https://ocr.space/ocrapi
const OCR_API_KEY = 'helloworld';

async function compressImage(dataUrl, maxKB = 900) {
  // OCR.space base64 limit is ~1 MB; compress large images on canvas
  if (dataUrl.length * 0.75 / 1024 <= maxKB) return dataUrl;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio  = Math.sqrt((maxKB * 1024) / (dataUrl.length * 0.75));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.floor(img.naturalWidth  * ratio);
      canvas.height = Math.floor(img.naturalHeight * ratio);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
  body.append('language',          'eng');
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

// ── Upload Image ───────────────────────────────────────────────────────────
$('upload-btn').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', function () {
  const file = this.files[0];
  this.value = ''; // allow re-selecting the same file
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError('Please select a valid image file (JPG, PNG, GIF, WEBP, etc.).');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => processImage(e.target.result);
  reader.readAsDataURL(file);
});

// ── Take Screenshot ────────────────────────────────────────────────────────
$('screenshot-btn').addEventListener('click', () => {
  showScreen(processingScreen);
  chrome.runtime.sendMessage({ action: 'takeScreenshot' }, response => {
    const err = chrome.runtime.lastError?.message || response?.error;
    if (err) { showError(err); return; }
    processImage(response.dataUrl);
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
        reader.onload = e => processImage(e.target.result);
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

// Ctrl+V / ⌘+V shortcut on home screen
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

document.addEventListener('dragover', e => e.preventDefault());

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
  reader.onload = ev => processImage(ev.target.result);
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
    // Fallback for restricted contexts
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
  showScreen(homeScreen);
});

$('retry-btn').addEventListener('click', () => showScreen(homeScreen));

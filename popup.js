// ── Tesseract OCR via CDN (loaded dynamically) ────────────
// We use Tesseract.js for client-side OCR.

const $ = id => document.getElementById(id);

const btnUpload    = $('btn-upload');
const btnScreenshot = $('btn-screenshot');
const btnClipboard  = $('btn-clipboard');
const btnDragDrop   = $('btn-dragdrop');
const fileInput     = $('file-input');
const loading       = $('loading');
const resultPanel   = $('result-panel');
const resultText    = $('result-text');
const resultPreview = $('result-preview');
const btnCopyText   = $('btn-copy-text');
const btnClear      = $('btn-clear');
const dragOverlay   = $('drag-overlay');
const toast         = $('toast');

// ── Toast helper ─────────────────────────────────────────
function showToast(msg, duration = 2000) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── Show result ──────────────────────────────────────────
function showResult(text, imageUrl = null) {
  resultText.value = text || '(No text detected)';
  if (imageUrl) {
    resultPreview.innerHTML = `<img src="${imageUrl}" alt="processed" />`;
    resultPreview.classList.add('has-image');
  } else {
    resultPreview.classList.remove('has-image');
    resultPreview.innerHTML = '';
  }
  resultPanel.classList.add('visible');
}

function setLoading(on) {
  loading.classList.toggle('visible', on);
  [btnUpload, btnScreenshot, btnClipboard, btnDragDrop].forEach(b => {
    b.disabled = on;
    b.style.opacity = on ? '.5' : '1';
  });
}

// ── OCR via Tesseract.js (loaded lazily) ─────────────────
let tesseractReady = false;

function loadTesseract() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => { tesseractReady = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function runOCR(imageData) {
  const lang = $('language-select').value;
  setLoading(true);
  try {
    await loadTesseract();
    const worker = await Tesseract.createWorker(lang, 1, {
      logger: () => {}
    });
    const { data: { text } } = await worker.recognize(imageData);
    await worker.terminate();
    showResult(text.trim(), typeof imageData === 'string' ? imageData : null);
  } catch (err) {
    showToast('OCR failed: ' + err.message, 3000);
    console.error(err);
  } finally {
    setLoading(false);
  }
}

// ── 1. Upload Image ──────────────────────────────────────
btnUpload.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  await runOCR(url);
  fileInput.value = '';
});

// ── 2. Screenshot + Crop ─────────────────────────────────
btnScreenshot.addEventListener('click', async () => {
  // Ask background to capture the tab, then inject crop UI
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Capture screenshot
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // Store screenshot and open crop page
    await chrome.storage.local.set({ screenshotData: dataUrl });

    // Open crop page in a new tab
    const cropUrl = chrome.runtime.getURL('crop.html');
    await chrome.tabs.create({ url: cropUrl });
    window.close();
  } catch (err) {
    showToast('Screenshot failed. Try on a web page.', 3000);
    console.error(err);
  }
});

// Check if we have cropped result (from crop page)
chrome.storage.local.get(['croppedImage'], async (result) => {
  if (result.croppedImage) {
    await chrome.storage.local.remove('croppedImage');
    await runOCR(result.croppedImage);
  }
});

// ── 3. Paste from Clipboard ──────────────────────────────
btnClipboard.addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    let found = false;
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const url = URL.createObjectURL(blob);
          await runOCR(url);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) showToast('No image in clipboard', 2500);
  } catch (err) {
    // Fallback: prompt user to paste
    showToast('Paste an image below (Ctrl+V / ⌘+V)', 3000);
    document.addEventListener('paste', handlePaste, { once: true });
  }
});

async function handlePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      const url = URL.createObjectURL(blob);
      await runOCR(url);
      return;
    }
  }
  showToast('No image found in clipboard', 2500);
}

// Global paste listener
document.addEventListener('paste', handlePaste);

// ── 4. Drag & Drop ───────────────────────────────────────
const container = document.querySelector('.container');

container.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if ([...e.dataTransfer.items].some(i => i.type.startsWith('image/'))) {
    dragOverlay.classList.add('active');
  }
});

container.addEventListener('dragover', (e) => e.preventDefault());

container.addEventListener('dragleave', (e) => {
  if (!container.contains(e.relatedTarget)) {
    dragOverlay.classList.remove('active');
  }
});

container.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragOverlay.classList.remove('active');
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (file) {
    const url = URL.createObjectURL(file);
    await runOCR(url);
  } else {
    showToast('Please drop an image file', 2500);
  }
});

btnDragDrop.addEventListener('click', () => {
  showToast('Drag an image onto this popup window', 2500);
});

// ── Copy & Clear ─────────────────────────────────────────
btnCopyText.addEventListener('click', async () => {
  const text = resultText.value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!');
});

btnClear.addEventListener('click', () => {
  resultText.value = '';
  resultPreview.innerHTML = '';
  resultPreview.classList.remove('has-image');
  resultPanel.classList.remove('visible');
});

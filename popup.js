// ── Helpers ───────────────────────────────────────────
const $ = id => document.getElementById(id);

const btnUpload     = $('btn-upload');
const btnScreenshot = $('btn-screenshot');
const btnClipboard  = $('btn-clipboard');
const btnDragDrop   = $('btn-dragdrop');
const fileInput     = $('file-input');
const loading       = $('loading');
const resultPanel   = $('result-panel');
const resultText    = $('result-text');
const resultPreview = $('result-preview');
const dragOverlay   = $('drag-overlay');
const toast         = $('toast');

// ── Toast ─────────────────────────────────────────────
function showToast(msg, duration = 2200) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── Show result ───────────────────────────────────────
function showResult(text, imageUrl = null) {
  resultText.value = text || '(No text detected)';
  if (imageUrl) {
    resultPreview.innerHTML = `<img src="${imageUrl}" alt="source" />`;
    resultPreview.classList.add('has-image');
  } else {
    resultPreview.classList.remove('has-image');
    resultPreview.innerHTML = '';
  }
  resultPanel.classList.add('visible');
}

// ── Loading state ─────────────────────────────────────
function setLoading(on) {
  loading.classList.toggle('visible', on);
  [btnUpload, btnScreenshot, btnClipboard, btnDragDrop].forEach(b => {
    b.disabled = on;
    b.style.opacity = on ? '.45' : '1';
    b.style.pointerEvents = on ? 'none' : '';
  });
}

// ── Lazy-load Tesseract ───────────────────────────────
async function loadTesseract() {
  if (window.Tesseract) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── Run OCR ───────────────────────────────────────────
async function runOCR(imageData) {
  const lang = $('language-select').value;
  setLoading(true);
  resultPanel.classList.remove('visible');
  try {
    await loadTesseract();
    const worker = await Tesseract.createWorker(lang, 1, { logger: () => {} });
    const { data: { text } } = await worker.recognize(imageData);
    await worker.terminate();
    showResult(
      text.trim(),
      typeof imageData === 'string' ? imageData : null
    );
  } catch (err) {
    showToast('OCR failed: ' + err.message, 3500);
    console.error(err);
  } finally {
    setLoading(false);
  }
}

// ── 1. Upload Image ───────────────────────────────────
btnUpload.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  await runOCR(url);
  fileInput.value = '';
});

// ── 2. Screenshot + Crop ──────────────────────────────
btnScreenshot.addEventListener('click', async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) { showToast('No active tab found.', 3000); return; }

    const response = await chrome.runtime.sendMessage({
      action: 'captureTab',
      windowId: activeTab.windowId
    });

    if (response?.error) throw new Error(response.error);

    await chrome.storage.local.set({
      screenshotData: response.dataUrl,
      originTabId: activeTab.id
    });

    const cropUrl = chrome.runtime.getURL('crop.html');
    await chrome.tabs.create({ url: cropUrl });
  } catch (err) {
    showToast('Screenshot failed: ' + err.message, 3500);
    console.error(err);
  }
});

// Check for cropped result (returned from crop page)
chrome.storage.local.get(['croppedImage'], async ({ croppedImage }) => {
  if (croppedImage) {
    await chrome.storage.local.remove(['croppedImage', 'originTabId']);
    await runOCR(croppedImage);
  }
});

// ── 3. Paste from Clipboard ───────────────────────────
async function handlePaste(e) {
  if (e?.clipboardData) {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        await runOCR(URL.createObjectURL(blob));
        return;
      }
    }
  }
  showToast('No image in clipboard', 2500);
}

btnClipboard.addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    let found = false;
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          await runOCR(URL.createObjectURL(blob));
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) showToast('No image in clipboard — try Ctrl+V / ⌘+V', 3000);
  } catch {
    showToast('Paste an image with Ctrl+V / ⌘+V', 2800);
  }
});

document.addEventListener('paste', handlePaste);

// ── 4. Drag & Drop ────────────────────────────────────
const panel = document.querySelector('.panel');

panel.addEventListener('dragenter', e => {
  e.preventDefault();
  if ([...e.dataTransfer.items].some(i => i.type.startsWith('image/'))) {
    dragOverlay.classList.add('active');
  }
});

panel.addEventListener('dragover', e => e.preventDefault());

panel.addEventListener('dragleave', e => {
  if (!panel.contains(e.relatedTarget)) {
    dragOverlay.classList.remove('active');
  }
});

panel.addEventListener('drop', async e => {
  e.preventDefault();
  dragOverlay.classList.remove('active');
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (file) {
    await runOCR(URL.createObjectURL(file));
  } else {
    showToast('Please drop an image file', 2500);
  }
});

btnDragDrop.addEventListener('click', () => {
  showToast('Drag an image file onto this panel', 2500);
});

// ── Copy & Clear — use event delegation so they always fire ──
document.addEventListener('click', async e => {
  if (e.target.closest('#btn-copy-text')) {
    const text = resultText.value;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!');
  }

  if (e.target.closest('#btn-clear')) {
    resultText.value = '';
    resultPreview.innerHTML = '';
    resultPreview.classList.remove('has-image');
    resultPanel.classList.remove('visible');
  }
});

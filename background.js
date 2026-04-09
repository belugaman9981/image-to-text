'use strict';

// Listens for screenshot requests from popup.js.
// Uses getLastFocused({ windowTypes: ['normal'] }) so we always capture
// the actual browser tab, never the extension popup window.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action !== 'takeScreenshot') return false;

  chrome.windows.getLastFocused({ windowTypes: ['normal'] }, win => {
    if (chrome.runtime.lastError || !win) {
      sendResponse({ error: chrome.runtime.lastError?.message || 'No browser window found.' });
      return;
    }
    chrome.tabs.captureVisibleTab(win.id, { format: 'png' }, dataUrl => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
  });

  return true; // keep message channel open for async sendResponse
});

/**
 * Browser detection utilities for FocusFinder extension
 */

/**
 * Detects which browser is currently running the extension
 * @returns {string} 'firefox' or 'chrome' or 'other'
 */
function detectBrowser() {
  // Check if browser object exists (Firefox)
  if (typeof browser !== 'undefined') {
    return 'firefox';
  }
  
  // Check if chrome object exists (Chrome, Edge, Opera, etc.)
  if (typeof chrome !== 'undefined') {
    // Check for Firefox-specific properties to detect Firefox with polyfill
    if (chrome.runtime && chrome.runtime.getBrowserInfo) {
      return 'firefox';
    }
    return 'chrome';
  }
  
  return 'other';
}

/**
 * Returns the appropriate API object (browser or chrome)
 * This normalizes access to browser APIs
 */
function getBrowserAPI() {
  return typeof browser !== 'undefined' ? browser : chrome;
}

/**
 * Checks if a feature is supported in the current browser
 * @param {string} feature - The feature to check
 * @returns {boolean} Whether the feature is supported
 */
function isFeatureSupported(feature) {
  const browserType = detectBrowser();
  const api = getBrowserAPI();
  
  switch(feature) {
    case 'scripting':
      return !!api.scripting;
    case 'offscreen':
      return browserType === 'chrome' && !!api.offscreen;
    case 'manifestV3ServiceWorker':
      return browserType === 'chrome' || 
             (browserType === 'firefox' && parseInt(navigator.userAgent.match(/Firefox\/(\d+)/)[1], 10) >= 101);
    default:
      return false;
  }
}

// Export functions using ES modules
export {
  detectBrowser,
  getBrowserAPI,
  isFeatureSupported
}; 
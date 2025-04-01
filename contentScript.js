﻿// FocusFinder - Content Script (Shadow DOM Version)
// This script runs in the context of each webpage and manages:
// - User interface elements (timer widget, intention prompts) within Shadow DOM
// - Communication with the background service worker
// - Page visibility tracking
// - Timer display and updates
// - User interactions with the extension UI

(() => {
  // Use the browser API consistently throughout the code
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // Prevent multiple instances of the content script from running
  if (window.focusFinderContentScriptLoaded) {
    console.log("FocusFinder Content Script: Already loaded, skipping execution.");
    return; // Exit early
  }
  window.focusFinderContentScriptLoaded = true;

  // --- Utilities ---
  function extractDomain(url) {
    try {
      if (!url || typeof url !== 'string' || url.startsWith('chrome:') || url.startsWith('about:') || url.startsWith('file:')) return "";
      let hostname = new URL(url).hostname;
      if (hostname.startsWith('www.')) hostname = hostname.slice(4);
      const parts = hostname.split('.');
      if (parts.length > 2) {
        const knownDomains = ['facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'linkedin.com', 'amazon.com', 'google.com', 'microsoft.com', 'apple.com', 'github.com', 'reddit.com'];
        const potentialMainDomain = parts.slice(-2).join('.');
        if (knownDomains.includes(potentialMainDomain)) return potentialMainDomain;
        if (parts.length > 2 && parts[0].length <= 5) return parts.slice(-2).join('.');
      }
      return hostname.endsWith('/') ? hostname.slice(0, -1) : hostname;
    } catch (e) {
      console.error("FocusFinder Content Script: Error extracting domain:", e);
      return "";
    }
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  // --- Global State ---
  let currentDomain = extractDomain(window.location.href);
  let promptHost = null; // Host element for the intention prompt
  let widgetHost = null; // Host element for the timer widget
  let confirmationHost = null; // Host element for the extend confirmation
  let promptShadowRoot = null;
  let widgetShadowRoot = null;
  let confirmationShadowRoot = null;
  let currentReasons = []; // Store the latest reasons list
  let widgetState = {
    intention: '', timeSpent: 0, reminderTime: 300, isPaused: false,
    isTimeUp: false, expanded: false, pauseReason: '', position: 'bottom-right',
    hasExtended: false
  };
  let combinedCSS = ''; // To store combined CSS for injection

  // --- CSS Preparation ---
  async function prepareCSS() {
    try {
      const fontsCSSUrl = browserAPI.runtime.getURL('css/fonts.css');
      const commonCSSUrl = browserAPI.runtime.getURL('css/common.css');
      const contentScriptCSSUrl = browserAPI.runtime.getURL('css/contentScript.css');

      const [fontsRes, commonRes, contentScriptRes] = await Promise.all([
        fetch(fontsCSSUrl),
        fetch(commonCSSUrl),
        fetch(contentScriptCSSUrl)
      ]);

      if (!fontsRes.ok || !commonRes.ok || !contentScriptRes.ok) {
        throw new Error('Failed to fetch CSS files');
      }

      let fontsCSS = await fontsRes.text();
      let commonCSS = await commonRes.text();
      let contentScriptCSS = await contentScriptRes.text();

      // Process font URLs
      fontsCSS = fontsCSS.replace(/url\('\.\/fonts\/(.*?)'\)/g, (match, fontFile) => {
        return `url('${browserAPI.runtime.getURL(`css/fonts/${fontFile}`)}')`;
      });

      // Remove @import from common.css
      commonCSS = commonCSS.replace(/@import url\('\.\/fonts\.css'\);/g, '');

      // Combine CSS
      combinedCSS = `
        ${fontsCSS}
        ${commonCSS}
        ${contentScriptCSS}
      `;
      console.log("FocusFinder Content Script: CSS prepared successfully.");

    } catch (error) {
      console.error("FocusFinder Content Script: Error preparing CSS:", error);
      combinedCSS = '/* CSS failed to load */'; // Fallback
    }
  }

  function injectStyles(shadowRoot) {
    if (!shadowRoot || !combinedCSS) return;
    try {
      const styleElement = document.createElement('style');
      styleElement.textContent = combinedCSS;
      shadowRoot.appendChild(styleElement);
    } catch (error) {
      console.error("FocusFinder Content Script: Error injecting styles:", error);
    }
  }

  // --- Initialization ---
  async function init() {
    console.log("FocusFinder Content Script: Initializing (Shadow DOM) on", currentDomain);
    await prepareCSS(); // Load and prepare CSS first
    addMessageListener();
    addVisibilityListener();

    // Check initial state with background script
    browserAPI.runtime.sendMessage({ action: "getDomainState", domain: currentDomain })
      .then(state => {
        if (state && state.intentionSet) {
          widgetState = { ...widgetState, ...state };
          if (!widgetHost) {
            createCornerWidget(currentDomain, widgetState);
          } else {
            updateCornerWidget(widgetState);
          }
        }
      })
      .catch(error => {
        console.error("FocusFinder Content Script: Error getting initial state:", error);
      });
  }

  function addMessageListener() {
    browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("FocusFinder Content Script: Received message:", message);
      switch (message.action) {
        case "ping":
          sendResponse({ status: "ready" });
          break;
        case "settingsUpdated": // Handle settings updates from background
          console.log("FocusFinder Content Script: Received updated settings");
          if (message.newSettings) {
            currentReasons = [...(message.newSettings.defaultReasons || []), ...(message.newSettings.userReasons || [])];
            // If prompt is currently shown, update it (optional, might be complex)
            // if (promptHost) {
            //   removeIntentionPrompt();
            //   createIntentionPrompt(currentDomain, currentReasons);
            // }
          }
          sendResponse({ success: true });
          break;
        case "showIntentionPrompt":
          if (promptHost) removeIntentionPrompt();
          currentReasons = message.reasons || []; // Update reasons from message
          createIntentionPrompt(message.domain, currentReasons); // Use the received reasons
          sendResponse({ success: true, showingPrompt: true });
          break;
        case "initializeWidget":
          if (promptHost) removeIntentionPrompt();
          widgetState = { ...widgetState, ...message.state };
          if (!widgetHost) {
             createCornerWidget(message.domain, widgetState);
          } else {
              updateCornerWidget(widgetState);
          }
          sendResponse({ success: true });
          break;
         case "intentionConfirmed":
             widgetState.intention = message.intention;
             widgetState.reminderTime = message.reminderTime || 300;
             widgetState.timeSpent = 0;
             widgetState.isPaused = false;
             widgetState.isTimeUp = false;
             widgetState.pauseReason = '';
             if (promptHost) removeIntentionPrompt();
             if (!widgetHost) {
                 createCornerWidget(currentDomain, widgetState);
             } else {
                  updateCornerWidget(widgetState);
             }
             showToast(`Timer started for "${currentDomain}"`);
             sendResponse({ success: true });
             break;
        case "updateTimer":
          widgetState.timeSpent = message.timeSpent;
          widgetState.reminderTime = message.reminderTime;
          widgetState.isTimeUp = message.isTimeUp;
          updateCornerWidget(widgetState);
          sendResponse({ success: true });
          break;
        case "showReminder":
           widgetState.isTimeUp = true;
           widgetState.timeSpent = message.timeSpent;
           updateCornerWidget(widgetState);
           if (!widgetState.expanded) {
               toggleWidgetExpansion(true);
           }
           highlightWidget();
           if (message.shouldPlaySound) {
             playTimerCompletionSound();
           }
           sendResponse({ success: true });
           break;
        case "timerPaused":
          widgetState.isPaused = true;
          widgetState.pauseReason = message.reason || 'unknown';
          updateCornerWidget(widgetState);
          sendResponse({ success: true });
          break;
        case "timerResumed":
          widgetState.isPaused = false;
          widgetState.pauseReason = '';
          updateCornerWidget(widgetState);
          sendResponse({ success: true });
          break;
         case "timerExtended":
             widgetState.reminderTime = message.newReminderTime;
             widgetState.isTimeUp = false;
             widgetState.isPaused = false;
             widgetState.pauseReason = '';
             updateCornerWidget(widgetState);
             showToast(`Time extended by ${message.extensionMinutes} minutes`);
             sendResponse({ success: true });
             break;
        default:
          console.log("FocusFinder Content Script: Unknown action", message.action);
          sendResponse({ error: "Unknown action" });
      }
      return true; // Keep channel open for async responses
    });
  }

  function addVisibilityListener() {
     document.addEventListener('visibilitychange', visibilityChangeHandler);
  }

  // --- UI Management (Shadow DOM) ---

  // Updated to accept a combined list of reasons
  function createIntentionPrompt(domain, reasons = []) {
    if (promptHost) return; // Already exists

    promptHost = document.createElement('div');
    promptHost.id = 'ff-prompt-host';
    document.body.appendChild(promptHost);

    promptShadowRoot = promptHost.attachShadow({ mode: 'open' });
    injectStyles(promptShadowRoot);

    const promptElement = document.createElement('div'); // The actual UI container
    promptElement.className = 'ff-overlay ff-root'; // Apply root class for variables

    // Use the passed 'reasons' array
    let reasonButtonsHTML = reasons.map(reason =>
      `<button class="ff-button ff-reason-button">${reason}</button>`
    ).join('');

    // Add placeholder if no reasons exist
    if (reasons.length === 0) {
        reasonButtonsHTML = `<div class="ff-list-placeholder">No reasons configured. Add some in the extension settings.</div>`;
    }

    promptElement.innerHTML = `
      <div class="ff-dialog">
        <div class="ff-dialog-header">
          Why are you visiting ${domain}?
        </div>
        <div class="ff-dialog-content">
          <div class="ff-section">
            <label class="ff-label">Select a reason:</label>
            <div class="ff-reason-buttons">
              ${reasonButtonsHTML}
            </div>
            <div class="ff-or-divider">or</div>
            <input type="text" id="ff-custom-reason" class="ff-input" placeholder="Type your own reason..." maxlength="100">
          </div>
          <div class="ff-section">
            <label class="ff-label">How long do you need?</label>
            <div class="ff-time-buttons">
              <button class="ff-button ff-time-button" data-duration="60">1 min</button>
              <button class="ff-button ff-time-button selected" data-duration="180">3 min</button>
              <button class="ff-button ff-time-button" data-duration="300">5 min</button>
              <button class="ff-button ff-time-button" data-duration="600">10 min</button>
              <button class="ff-button ff-time-button" data-duration="900">15 min</button>
            </div>
          </div>
           <div class="ff-warning">
               <span>⚠️ No good reason? Consider closing this tab.</span>
           </div>
        </div>
        <div class="ff-dialog-footer">
          <button id="ff-prompt-close" class="ff-button" title="Close all tabs">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            Close all ${domain.length > 15 ? domain.substring(0, 15) + '...' : domain} tabs
          </button>
          <button id="ff-prompt-continue" class="ff-button ff-button-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Start Timer
          </button>
        </div>
      </div>
    `;

    promptShadowRoot.appendChild(promptElement);

    // --- Event Listeners for Prompt (within Shadow DOM) ---
    let selectedReason = '';
    let selectedDuration = 180;

    const reasonButtons = promptShadowRoot.querySelectorAll('.ff-reason-button');
    const customReasonInput = promptShadowRoot.querySelector('#ff-custom-reason');

    customReasonInput.focus(); // Focus input

    reasonButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        reasonButtons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedReason = btn.textContent;
        customReasonInput.value = '';
      });
    });

    customReasonInput.addEventListener('input', () => {
      reasonButtons.forEach(b => b.classList.remove('selected'));
      selectedReason = '';
    });

    customReasonInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        const continueButton = promptShadowRoot.querySelector('#ff-prompt-continue');
        if (continueButton) continueButton.click();
      }
    });

    const timeButtons = promptShadowRoot.querySelectorAll('.ff-time-button');
    timeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        timeButtons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedDuration = parseInt(btn.dataset.duration, 10);
      });
    });

    promptShadowRoot.querySelector('#ff-prompt-continue').addEventListener('click', () => {
      const finalReason = customReasonInput.value.trim() || selectedReason;
      if (!finalReason) {
        customReasonInput.focus();
        customReasonInput.style.borderColor = 'var(--accent-pink)';
        setTimeout(()=> customReasonInput.style.borderColor = '', 2000);
        return;
      }
      handlePromptContinue(finalReason, selectedDuration);
    });

    promptShadowRoot.querySelector('#ff-prompt-close').addEventListener('click', handlePromptCloseTabs);

     promptElement.addEventListener('click', (e) => {
         if (e.target === promptElement) { /* Only if click is on the overlay itself */ }
     });
  }

  function removeIntentionPrompt() {
    if (promptHost) {
      promptHost.remove();
      promptHost = null;
      promptShadowRoot = null;
    }
  }

  function createCornerWidget(domain, initialState) {
    if (widgetHost) return; // Already exists

    widgetHost = document.createElement('div');
    widgetHost.id = 'ff-widget-host';
    // Initial position styles applied to host
    widgetHost.style.position = 'fixed';
    widgetHost.style.zIndex = '2147483646';
    widgetHost.style.opacity = '0'; // Start invisible
    widgetHost.style.transition = 'all 0.3s ease'; // Add smooth transition for movement
    document.body.appendChild(widgetHost);

    widgetShadowRoot = widgetHost.attachShadow({ mode: 'open' });
    injectStyles(widgetShadowRoot);

    const widgetElement = document.createElement('div');
    widgetElement.className = 'ff-corner-widget ff-root collapsed';
    widgetElement.innerHTML = `
      <div class="ff-widget-header">
         <div class="ff-header">
             <div class="ff-expand-arrow"></div>
             <div class="ff-title">FocusFinder</div>
         </div>
         <div class="ff-widget-header-controls">
             <span class="ff-widget-timer-condensed"></span>
             <button class="ff-widget-move-btn" title="Change widget position">Move</button>
             <button class="ff-widget-toggle-btn" title="Toggle widget size">
                 <svg class="ff-icon-expand" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg>
                 <svg class="ff-icon-collapse" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"></path><path d="M20 10h-6V4"></path><path d="M14 10l7-7"></path><path d="M3 21l7-7"></path></svg>
             </button>
         </div>
         <div class="ff-progress-bar-container">
             <div class="ff-progress-bar"></div>
         </div>
      </div>
      <div class="ff-widget-content">
        <div class="ff-body">
          <div class="ff-intention-display">
            <span class="ff-intention-text"></span>
          </div>
          <div class="ff-timer-display">
            <span class="ff-timer-label">Time Spent:</span>
            <span class="ff-timer-value">0m 0s</span> /
            <span class="ff-timer-limit">?m ?s</span>
          </div>
           <div class="ff-pause-indicator">Paused</div>
           <div class="ff-timeup-indicator">Time's Up!</div>
          <div class="ff-extend-section">
             <label>I need more time:</label>
             <div class="ff-extend-buttons">
                <button class="ff-button ff-button-extend" data-extend-minutes="1">+1m</button>
                <button class="ff-button ff-button-extend" data-extend-minutes="3">+3m</button>
                <button class="ff-button ff-button-extend" data-extend-minutes="5">+5m</button>
             </div>
          </div>
          <div class="ff-widget-actions">
            <button class="ff-button ff-button-pause-resume">
               <svg class="ff-icon-pause" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
               <svg class="ff-icon-resume" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
               <span>Pause</span>
            </button>
            <button class="ff-button ff-button-close" title="Close all tabs">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
               End Session
            </button>
          </div>
        </div>
      </div>
    `;

    widgetShadowRoot.appendChild(widgetElement);

    // Apply initial state
    widgetState = { ...widgetState, ...initialState };
    updateCornerWidget(widgetState); // Set initial display

    // Make visible
    setTimeout(() => {
      if (widgetHost) widgetHost.style.opacity = '1';
    }, 0);

    // --- Event Listeners for Widget (within Shadow DOM) ---
    widgetShadowRoot.querySelector('.ff-widget-toggle-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWidgetExpansion();
    });
    widgetShadowRoot.querySelector('.ff-widget-move-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        handleMoveWidget();
    });
    widgetShadowRoot.querySelector('.ff-widget-header').addEventListener('click', () => toggleWidgetExpansion());
    widgetShadowRoot.querySelector('.ff-button-pause-resume').addEventListener('click', handleWidgetPauseResume);
    widgetShadowRoot.querySelector('.ff-button-close').addEventListener('click', handleWidgetEndBrowsing);

    widgetShadowRoot.querySelectorAll('.ff-button-extend').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const minutes = e.target.dataset.extendMinutes;
        handleWidgetExtendTime(minutes);
      });
    });

    // Set initial position on the host
    positionWidget(widgetState.position || 'bottom-right');
  }

  function updateCornerWidget(state) {
    if (!widgetShadowRoot || !widgetHost) return;

    widgetState = { ...widgetState, ...state }; // Update local cache

    const { intention, timeSpent, reminderTime, isPaused, isTimeUp, expanded, pauseReason, position } = widgetState;

    const widgetElement = widgetShadowRoot.querySelector('.ff-corner-widget');
    if (!widgetElement) return; // Element not found in shadow root

    // Update Classes based on state
    widgetElement.classList.toggle('expanded', expanded);
    widgetElement.classList.toggle('collapsed', !expanded);
    widgetElement.classList.toggle('paused', isPaused);
    widgetElement.classList.toggle('time-up', isTimeUp);

    // Apply position to host if changed
    if (position && widgetHost.getAttribute('data-position') !== position) {
      positionWidget(position);
    }

    // Header
    const titleEl = widgetShadowRoot.querySelector('.ff-title');
    const timerCondensedEl = widgetShadowRoot.querySelector('.ff-widget-timer-condensed');
    const headerEl = widgetShadowRoot.querySelector('.ff-widget-header');

    if (expanded) {
      titleEl.textContent = 'FocusFinder';
      timerCondensedEl.textContent = '';
      headerEl.classList.remove('ff-header-collapsed');
      const closeButton = widgetShadowRoot.querySelector('.ff-button-close');
      if (closeButton) closeButton.title = `Close all ${currentDomain} tabs`;
    } else {
      const displayIntention = intention || 'No goal set';
      titleEl.textContent = displayIntention.length > 25 ? displayIntention.substring(0, 25) + '...' : displayIntention;
      timerCondensedEl.textContent = formatTime(timeSpent);
      headerEl.classList.add('ff-header-collapsed');
    }
    timerCondensedEl.classList.toggle('ff-time-up-condensed', isTimeUp && !expanded);
    if (isPaused && !expanded) timerCondensedEl.textContent += ' (Paused)';

    // Progress Bar
    const progressBar = widgetShadowRoot.querySelector('.ff-progress-bar');
    const progress = Math.min(1, (reminderTime > 0 ? timeSpent / reminderTime : 0));
    progressBar.style.width = `${progress * 100}%`;
    progressBar.classList.toggle('ff-progress-bar-timeup', isTimeUp);

    // Content (only update if expanded)
    if (expanded) {
      widgetShadowRoot.querySelector('.ff-intention-text').textContent = intention || 'Not set';
      widgetShadowRoot.querySelector('.ff-timer-value').textContent = formatTime(timeSpent);
      widgetShadowRoot.querySelector('.ff-timer-limit').textContent = formatTime(reminderTime);
      widgetShadowRoot.querySelector('.ff-timer-value').classList.toggle('ff-time-alert', isTimeUp);

      const pauseResumeButton = widgetShadowRoot.querySelector('.ff-button-pause-resume');
      const pauseIcon = pauseResumeButton.querySelector('.ff-icon-pause');
      const resumeIcon = pauseResumeButton.querySelector('.ff-icon-resume');
      const pauseResumeText = pauseResumeButton.querySelector('span');
      if (isPaused) {
        pauseIcon.style.display = 'none'; resumeIcon.style.display = 'inline-block';
        pauseResumeText.textContent = 'Resume'; pauseResumeButton.title = "Resume tracking";
      } else {
        pauseIcon.style.display = 'inline-block'; resumeIcon.style.display = 'none';
        pauseResumeText.textContent = 'Pause'; pauseResumeButton.title = "Pause tracking";
      }

      widgetShadowRoot.querySelector('.ff-pause-indicator').style.display = isPaused ? 'block' : 'none';
      widgetShadowRoot.querySelector('.ff-timeup-indicator').style.display = isTimeUp ? 'block' : 'none';
      widgetShadowRoot.querySelector('.ff-extend-section').style.display = isTimeUp ? 'block' : 'none';
      widgetShadowRoot.querySelector('.ff-timer-display').classList.toggle('ff-time-alert', isTimeUp);
    }
  }

  function removeCornerWidget() {
    if (widgetHost) {
      widgetHost.remove();
      widgetHost = null;
      widgetShadowRoot = null;
    }
  }

  function toggleWidgetExpansion(forceExpand = null) {
     if (!widgetShadowRoot) return;
     const shouldBeExpanded = typeof forceExpand === 'boolean' ? forceExpand : !widgetState.expanded;
     if(widgetState.expanded !== shouldBeExpanded) {
         widgetState.expanded = shouldBeExpanded;
         updateCornerWidget(widgetState); // Update UI within shadow DOM
         browserAPI.runtime.sendMessage({ action: "saveWidgetState", domain: currentDomain, expanded: widgetState.expanded });
     }
  }

  function highlightWidget() {
    if (!widgetHost) return;
    // Highlight the host element
    const originalBorder = widgetHost.style.outline || 'none';
    widgetHost.style.outline = '2px solid var(--accent-blue)'; // Use outline for host
    widgetHost.style.outlineOffset = '2px';

    setTimeout(() => {
      if (widgetHost) widgetHost.style.outline = originalBorder;
    }, 1000);
  }

  function showToast(message, duration = 3000) {
    // Toast remains outside Shadow DOM for simplicity
    let toast = document.querySelector('#ff-toast-host'); // Use a host ID
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ff-toast-host';
      // Basic styling for the host itself
      toast.style.position = 'fixed';
      toast.style.bottom = '20px';
      toast.style.left = '20px';
      toast.style.zIndex = '2147483647';
      toast.style.pointerEvents = 'none';
      document.body.appendChild(toast);

      // Inject styles into toast shadow DOM if needed, or style host directly
      const toastShadow = toast.attachShadow({ mode: 'open' });
      injectStyles(toastShadow); // Inject full styles
      const toastElement = document.createElement('div');
      toastElement.className = 'ff-toast ff-root'; // Apply root class
      toastShadow.appendChild(toastElement);
    }

    const toastShadowRoot = toast.shadowRoot;
    const toastElement = toastShadowRoot.querySelector('.ff-toast');

    toastElement.textContent = message;
    toastElement.classList.add('show');

    setTimeout(() => {
      toastElement.classList.remove('show');
      // Optionally remove the host after a delay if not shown again soon
      // setTimeout(() => { if (!toastElement.classList.contains('show')) toast.remove(); }, 1000);
    }, duration);
  }

  function playTimerCompletionSound() {
    const audio = new Audio(browserAPI.runtime.getURL('sounds/bubble.mp3'));
    audio.volume = 0.5;
    audio.play().catch(error => console.log("FocusFinder Content Script: Error playing sound:", error));
  }

  // --- Event Handling ---
  // (Handlers mostly remain the same, just ensure messages are sent correctly)

  function handlePromptContinue(reason, durationSeconds) {
    browserAPI.runtime.sendMessage({
      action: "intentionSet", domain: currentDomain, intention: reason, duration: durationSeconds
    }).catch(error => console.error("FocusFinder Content Script: Error sending intention set:", error));
    removeIntentionPrompt();
  }

  function handlePromptCloseTabs() {
    browserAPI.runtime.sendMessage({ action: "closeAllTabs", domain: currentDomain })
      .catch(error => console.error("FocusFinder Content Script: Error sending close tabs:", error));
    removeIntentionPrompt();
  }

  function handleWidgetPauseResume() {
    const action = widgetState.isPaused ? "resumeTimer" : "pauseTimer";
    const wasIsPaused = widgetState.isPaused;
    widgetState.isPaused = !wasIsPaused;
    widgetState.pauseReason = wasIsPaused ? '' : 'userPaused';
    updateCornerWidget(widgetState); // Optimistic UI update

    browserAPI.runtime.sendMessage({ action: action, domain: currentDomain })
      .catch(error => {
        console.error("FocusFinder Content Script: Error sending pause/resume:", error);
        widgetState.isPaused = wasIsPaused; // Revert UI
        widgetState.pauseReason = wasIsPaused ? 'userPaused' : '';
        updateCornerWidget(widgetState);
      });
  }

  function handleWidgetExtendTime(minutes) {
    if (widgetState.hasExtended) {
      showExtendConfirmation(currentDomain, minutes);
    } else {
      widgetState.hasExtended = true; // Mark first extension
      browserAPI.runtime.sendMessage({ action: "extendTime", domain: currentDomain, minutes: parseInt(minutes) })
        .catch(error => console.error("FocusFinder Content Script: Error sending extend time:", error));
    }
  }

  function handleWidgetEndBrowsing() {
    browserAPI.runtime.sendMessage({ action: "closeAllTabs", domain: currentDomain })
      .catch(error => console.error("FocusFinder Content Script: Error sending close tabs:", error));
    removeCornerWidget();
  }

  function visibilityChangeHandler() {
      browserAPI.runtime.sendMessage({
          action: "visibilityChanged", domain: currentDomain, isVisible: document.visibilityState === 'visible'
      }).catch(error => console.error("FocusFinder Content Script: Error in visibility change:", error));
  }

  function positionWidget(position) {
    if (!widgetHost) return;

    // Reset host position styles
    widgetHost.style.top = 'auto';
    widgetHost.style.right = 'auto';
    widgetHost.style.bottom = 'auto';
    widgetHost.style.left = 'auto';
    widgetHost.setAttribute('data-position', position); // Store on host

    // Set new position on host with specific pixel values
    const offset = '20px';
    switch (position) {
        case 'bottom-right':
            widgetHost.style.bottom = offset;
            widgetHost.style.right = offset;
            break;
        case 'bottom-left':
            widgetHost.style.bottom = offset;
            widgetHost.style.left = offset;
            break;
        case 'top-left':
            widgetHost.style.top = offset;
            widgetHost.style.left = offset;
            break;
        case 'top-right':
            widgetHost.style.top = offset;
            widgetHost.style.right = offset;
            break;
    }
    
    // Update widget state
    widgetState.position = position;

    // Save position to background
    browserAPI.runtime.sendMessage({
        action: "saveWidgetPosition",
        domain: currentDomain,
        position: position
    }).catch(error => console.error("FocusFinder Content Script: Error saving widget position:", error));
  }

  function handleMoveWidget() {
    const currentPosition = widgetState.position || 'bottom-right';
    const positions = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
    const currentIndex = positions.indexOf(currentPosition);
    const nextIndex = (currentIndex + 1) % positions.length;
    positionWidget(positions[nextIndex]); // Apply next position
  }

  function showExtendConfirmation(domain, minutes) {
    if (confirmationHost) return; // Already showing

    confirmationHost = document.createElement('div');
    confirmationHost.id = 'ff-confirmation-host';
    document.body.appendChild(confirmationHost);

    confirmationShadowRoot = confirmationHost.attachShadow({ mode: 'open' });
    injectStyles(confirmationShadowRoot);

    const overlayElement = document.createElement('div');
    overlayElement.className = 'ff-overlay ff-root'; // Apply root class

    overlayElement.innerHTML = `
      <div class="ff-dialog">
        <div class="ff-dialog-header">
          Are you sure? You already extended your time before
        </div>
        <div class="ff-dialog-content">
          <div class="ff-warning">
            <span>⚠️ Consider if you really need more time on ${domain}</span>
          </div>
        </div>
        <div class="ff-dialog-footer">
          <button id="ff-extend-close" class="ff-button" title="Close all tabs">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            Close all ${domain} tabs
          </button>
          <button id="ff-extend-confirm" class="ff-button ff-button-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Extend time
          </button>
        </div>
      </div>
    `;

    confirmationShadowRoot.appendChild(overlayElement);

    confirmationShadowRoot.querySelector('#ff-extend-close').addEventListener('click', () => {
      removeExtendConfirmation();
      handleWidgetEndBrowsing();
    });

    confirmationShadowRoot.querySelector('#ff-extend-confirm').addEventListener('click', () => {
      removeExtendConfirmation();
      browserAPI.runtime.sendMessage({ action: "extendTime", domain: currentDomain, minutes: parseInt(minutes) })
        .catch(error => console.error("FocusFinder Content Script: Error sending extend time:", error));
    });

    overlayElement.addEventListener('click', (e) => {
      if (e.target === overlayElement) { /* Click on overlay background */ }
    });
  }

   function removeExtendConfirmation() {
       if (confirmationHost) {
           confirmationHost.remove();
           confirmationHost = null;
           confirmationShadowRoot = null;
       }
   }

  // --- Start Initialization ---
  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

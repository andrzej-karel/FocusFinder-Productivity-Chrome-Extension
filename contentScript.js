// Check if script already ran before any declarations
if (window.focusFinderContentScriptLoaded) {
  console.log("FocusFinder Content Script: Already loaded, skipping execution.");
} else {
  window.focusFinderContentScriptLoaded = true;

  // --- Utilities (defined first to avoid reference errors) ---
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
  let toastHost = null; // Host element for the toast message
  let confirmationHost = null; // Host element for the extend confirmation
  let promptShadowRoot = null;
  let widgetShadowRoot = null;
  let toastShadowRoot = null;
  let widgetState = { // Local cache of state
    intention: '',
    timeSpent: 0,
    reminderTime: 300,
    isPaused: false,
    isTimeUp: false,
    expanded: false, // Start collapsed
    pauseReason: '',
    position: 'bottom-right' // Add position state, default to bottom-right
  };
  let combinedCSS = ''; // To store combined CSS for injection

  // --- CSS Preparation ---
  async function prepareCSS() {
    try {
      const fontsCSSUrl = chrome.runtime.getURL('css/fonts.css');
      const commonCSSUrl = chrome.runtime.getURL('css/common.css');
      const contentScriptCSSUrl = chrome.runtime.getURL('css/contentScript.css');

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

      // Process font URLs using chrome.runtime.getURL
      fontsCSS = fontsCSS.replace(/url\('\.\/fonts\/(.*?)'\)/g, (match, fontFile) => {
        return `url('${chrome.runtime.getURL(`css/fonts/${fontFile}`)}')`;
      });

      // Remove @import from common.css as fontsCSS is prepended
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
    chrome.runtime.sendMessage({ action: "getDomainState", domain: currentDomain }, (state) => {
      if (chrome.runtime.lastError) {
        console.error("FocusFinder Content Script: Error getting initial state:", chrome.runtime.lastError.message);
        return;
      }
      console.log("FocusFinder Content Script: Received initial state", state);
      if (state && state.intentionSet) {
        widgetState = { ...widgetState, ...state }; // Update local cache
        if (!widgetHost) { // Use widgetHost to check existence
          createCornerWidget(currentDomain, widgetState);
        } else {
          updateCornerWidget(widgetState);
        }
      }
    });
  }

  function addMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("FocusFinder Content Script: Received message:", message);
      switch (message.action) {
        case "ping":
          sendResponse({ status: "ready" });
          break;
        case "settingsUpdated":
          console.log("FocusFinder Content Script: Received updated settings");
          sendResponse({ success: true });
          break;
        case "showIntentionPrompt":
          if (promptHost) removeIntentionPrompt(); // Use promptHost to check
          createIntentionPrompt(message.domain, message.reasons || []);
          sendResponse({ success: true, showingPrompt: true });
          break;
        case "initializeWidget":
          if (promptHost) removeIntentionPrompt(); // Use promptHost
          widgetState = { ...widgetState, ...message.state }; // Update cache
          if (!widgetHost) { // Use widgetHost
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
             if (promptHost) removeIntentionPrompt(); // Use promptHost
             if (!widgetHost) { // Use widgetHost
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
           widgetState.isTimeUp = true; // Mark as time up
           widgetState.timeSpent = message.timeSpent; // Sync time
           updateCornerWidget(widgetState);
           // Ensure widget is expanded and visible when reminder hits
           if (!widgetState.expanded) {
               toggleWidgetExpansion(true); // Force expand
           }
           highlightWidget();
           // Play sound if indicated
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
          if (confirmationHost) removeExtendConfirmation(); // Close confirmation if resuming
          widgetState.isPaused = false;
          widgetState.pauseReason = '';
          updateCornerWidget(widgetState);
          sendResponse({ success: true });
          break;
         case "timerExtended":
             widgetState.reminderTime = message.newReminderTime;
             widgetState.isTimeUp = false; // Reset time up flag
             widgetState.isPaused = false; // Ensure timer is running
             widgetState.pauseReason = '';
             updateCornerWidget(widgetState); // Update display with new time
             showToast(`Time extended by ${message.extensionMinutes} minutes`);
             sendResponse({ success: true });
             break;
        case "showExtendConfirmation":
            console.log("FocusFinder Content Script: Received request to show extend confirmation");
            showExtendConfirmation(currentDomain, message.minutes);
            sendResponse({ success: true });
            break;
        default:
          console.log("FocusFinder Content Script: Unknown action", message.action);
          sendResponse({ error: "Unknown action" });
      }
      return true; // Keep channel open for async responses if needed
    });
  }

  function addVisibilityListener() {
     document.addEventListener('visibilitychange', visibilityChangeHandler);
  }

  // --- UI Management (Shadow DOM) ---

  // Removed old injectCSS function

  function createIntentionPrompt(domain, reasons = []) {
    if (promptHost) return; // Already exists

    promptHost = document.createElement('div');
    promptHost.id = 'ff-prompt-host';
    // Basic styling for host to ensure it's positioned correctly
    promptHost.style.position = 'fixed';
    promptHost.style.top = '0';
    promptHost.style.left = '0';
    promptHost.style.width = '100%';
    promptHost.style.height = '100%';
    promptHost.style.zIndex = '2147483647'; // Max z-index
    document.body.appendChild(promptHost);

    promptShadowRoot = promptHost.attachShadow({ mode: 'open' });
    injectStyles(promptShadowRoot); // Inject combined CSS

    const promptElement = document.createElement('div'); // The actual UI container
    promptElement.className = 'ff-overlay ff-root'; // Apply root class for variables

    let reasonButtonsHTML = reasons.map(reason =>
      `<button class="ff-button ff-reason-button" data-reason="${reason}">${reason}</button>`
    ).join('');

    // Add placeholder if no reasons exist
    if (reasons.length === 0) {
        reasonButtonsHTML = `<div class="ff-list-placeholder">No default reasons configured.</div>`;
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
            <!-- Add 'or' divider if there are default reasons -->
            ${reasons.length > 0 ? '<div class="ff-or-divider">or</div>' : ''}
            <input type="text" id="ff-custom-reason" class="ff-input ff-input-intention" placeholder="type your reason here"></div>
          <div class="ff-section">
            <label class="ff-label">How long do you need?</label>
            <div class="ff-time-buttons">
              <button class="ff-button ff-time-button" data-duration="60">1 min</button>
              <button class="ff-button ff-time-button selected" data-duration="180">3 min</button> <!-- Default selected -->
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
    let selectedDuration = 180; // Default 3 minutes

    // Query within the shadow root
    const reasonButtons = promptShadowRoot.querySelectorAll('.ff-reason-button');
    const customReasonInput = promptShadowRoot.querySelector('#ff-custom-reason');

    // Focus on the custom reason input field immediately
    customReasonInput.focus();

    reasonButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        reasonButtons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedReason = btn.dataset.reason;
        customReasonInput.value = ''; // Clear custom input
      });
    });

    customReasonInput.addEventListener('input', () => {
      reasonButtons.forEach(b => b.classList.remove('selected'));
      selectedReason = ''; // Clear pre-selected reason
    });

    // Add event listener for Enter key on custom reason input
    customReasonInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        // Simulate click on continue button when Enter is pressed
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
        // Maybe show a small validation message?
        customReasonInput.focus();
        customReasonInput.style.borderColor = 'var(--accent-pink)'; // Highlight error
        setTimeout(()=> customReasonInput.style.borderColor = '', 2000);
        return;
      }
      handlePromptContinue(finalReason, selectedDuration);
    });

    promptShadowRoot.querySelector('#ff-prompt-close').addEventListener('click', handlePromptCloseTabs);

     // Prevent clicking outside the dialog from closing it (optional)
     promptElement.addEventListener('click', (e) => {
         // Check if the click target is the overlay itself (the container within the shadow DOM)
         if (e.target === promptElement) {
             // Clicked on overlay background, could close or do nothing
             // removeIntentionPrompt(); // Example: close on outside click
         }
     });
  }

  function removeIntentionPrompt() {
    if (promptHost) {
      promptHost.remove(); // Remove the host element from the document
      promptHost = null;
      promptShadowRoot = null; // Clear references
    }
  }

  function createCornerWidget(domain, initialState) {
    if (widgetHost) return; // Already exists

    widgetHost = document.createElement('div');
    widgetHost.id = 'ff-widget-host';
    // Style the host as a full non-interactive overlay
    widgetHost.style.position = 'fixed';
    widgetHost.style.top = '0';
    widgetHost.style.left = '0';
    widgetHost.style.width = '100vw'; // Use viewport units
    widgetHost.style.height = '100vh';// Use viewport units
    widgetHost.style.zIndex = '2147483647'; // Max z-index
    widgetHost.style.pointerEvents = 'none'; // Make host non-interactive
    // widgetHost.style.border = '1px dashed rgba(255,0,0,0.2)'; // REMOVE DEBUG BORDER

    // Get initial position from state or use default
    const initialPosition = initialState.position || 'bottom-right';
    
    document.body.appendChild(widgetHost);
    
    // Shadow DOM setup remains the same
    widgetShadowRoot = widgetHost.attachShadow({ mode: 'open' });
    injectStyles(widgetShadowRoot); // Inject combined CSS

    const widgetElement = document.createElement('div'); // The actual UI container
    widgetElement.className = 'ff-corner-widget ff-root collapsed'; // Apply root class
    widgetElement.style.pointerEvents = 'auto'; // Make widget interactive

    // Apply initial position *to the inner widget element*
    positionWidgetElement(widgetElement, initialPosition);

    // Inner HTML structure (keep as is)
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
             <!-- Label changed slightly to match backup -->
             <label>I need more time:</label>
             <div class="ff-extend-buttons">
                <button class="ff-button ff-button-extend" data-extend-minutes="1">+1m</button>
                <button class="ff-button ff-button-extend" data-extend-minutes="3">+3m</button>
                <button class="ff-button ff-button-extend" data-extend-minutes="5">+5m</button>
             </div>
          </div>
          <div class="ff-widget-actions">
            <button class="ff-button ff-button-pause-resume" title="Pause tracking">
               <svg class="ff-icon-pause" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
               <svg class="ff-icon-resume" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
               <span>Pause</span>
            </button>
            <button class="ff-button ff-button-close" title="Close all ${domain} tabs">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
               End Session
            </button>
          </div>
        </div>
      </div>
    `;

    widgetShadowRoot.appendChild(widgetElement);

    // Apply initial state (which might include expansion)
    widgetState = { ...widgetState, ...initialState }; // Update local cache
    updateCornerWidget(widgetState); // Update display based on full state

    // Make host visible (it's just an overlay frame now)
    setTimeout(() => {
      if (widgetHost) widgetHost.style.opacity = '1'; // Opacity doesn't matter much for non-interactive overlay
    }, 0);

    // Event Listeners (attach to elements *inside* widgetElement)
    widgetElement.querySelector('.ff-widget-toggle-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWidgetExpansion();
    });
    
    const moveButton = widgetElement.querySelector('.ff-widget-move-btn');
    if (moveButton) {
      moveButton.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        handleMoveWidget();
      });
    } else {
        console.error("FocusFinder Error: Could not find move button to attach listener.");
    }
    
    widgetElement.querySelector('.ff-widget-header').addEventListener('click', () => toggleWidgetExpansion()); 
    widgetElement.querySelector('.ff-button-pause-resume').addEventListener('click', handleWidgetPauseResume);
    widgetElement.querySelector('.ff-button-close').addEventListener('click', handleWidgetEndBrowsing);

    widgetElement.querySelectorAll('.ff-button-extend').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const minutes = e.target.dataset.extendMinutes;
        handleWidgetExtendTime(minutes);
      });
    });
  }

  function updateCornerWidget(state) {
    // Ensure shadow root exists before querying
    if (!widgetShadowRoot) return;

    widgetState = { ...widgetState, ...state }; // Update local cache before UI

    const { intention, timeSpent, reminderTime, isPaused, isTimeUp, expanded, pauseReason, position } = widgetState;

    const widgetElement = widgetShadowRoot.querySelector('.ff-corner-widget');
    if (!widgetElement) return;

    // Check if position needs updating
    const currentVisualPosition = widgetState.position; // Assuming state reflects visual
    if (position && position !== currentVisualPosition) {
        positionWidgetElement(widgetElement, position);
    }

    // Update Classes based on state (keep this)
    widgetElement.classList.toggle('expanded', expanded);
    widgetElement.classList.toggle('collapsed', !expanded);
    widgetElement.classList.toggle('paused', isPaused);
    widgetElement.classList.toggle('time-up', isTimeUp);

    // Header updates...
    const titleEl = widgetElement.querySelector('.ff-title');
    const timerCondensedEl = widgetElement.querySelector('.ff-widget-timer-condensed');
    const headerEl = widgetElement.querySelector('.ff-widget-header');
    if (expanded) {
        titleEl.textContent = 'FocusFinder';
        timerCondensedEl.textContent = ''; // Hide condensed timer when expanded
        headerEl.classList.remove('ff-header-collapsed');
        // Update close button title if it exists
        const closeButton = widgetElement.querySelector('.ff-button-close');
        if (closeButton) closeButton.title = `Close all ${currentDomain} tabs`;
    } else {
        // Show intention text in collapsed view, truncate if too long
        const displayIntention = intention || 'No goal set';
        // Adjusted length slightly
        titleEl.textContent = displayIntention.length > 25
            ? displayIntention.substring(0, 25) + '...'
            : displayIntention;
        timerCondensedEl.textContent = formatTime(timeSpent); // Show timer in collapsed view
        headerEl.classList.add('ff-header-collapsed');
    }

    // Show condensed timer in red if time is up
    timerCondensedEl.classList.toggle('ff-time-up-condensed', isTimeUp && !expanded);

    // Add pause indicator to condensed view
    if (isPaused && !expanded) {
        timerCondensedEl.textContent += ' (Paused)';
    }

    // Progress Bar updates...
    const progressBar = widgetElement.querySelector('.ff-progress-bar');
    const progress = Math.min(1, (reminderTime > 0 ? timeSpent / reminderTime : 0));
    progressBar.style.width = `${progress * 100}%`;
    progressBar.classList.toggle('ff-progress-bar-timeup', isTimeUp);

    // Content updates (only if expanded)...
    if (expanded) {
        widgetElement.querySelector('.ff-intention-text').textContent = intention || 'Not set';
        widgetElement.querySelector('.ff-timer-value').textContent = formatTime(timeSpent);
        widgetElement.querySelector('.ff-timer-limit').textContent = formatTime(reminderTime);
        widgetElement.querySelector('.ff-timer-value').classList.toggle('ff-time-alert', isTimeUp);

        // Pause/Resume Button (query within shadow root)
        const pauseResumeButton = widgetElement.querySelector('.ff-button-pause-resume');
        const pauseIcon = pauseResumeButton.querySelector('.ff-icon-pause');
        const resumeIcon = pauseResumeButton.querySelector('.ff-icon-resume');
        const pauseResumeText = pauseResumeButton.querySelector('span');

        if (isPaused) {
            pauseIcon.style.display = 'none';
            resumeIcon.style.display = 'inline-block';
            pauseResumeText.textContent = 'Resume';
            pauseResumeButton.title = "Resume tracking";
        } else {
            pauseIcon.style.display = 'inline-block';
            resumeIcon.style.display = 'none';
            pauseResumeText.textContent = 'Pause';
            pauseResumeButton.title = "Pause tracking";
        }

        // Indicators (query within shadow root)
        widgetElement.querySelector('.ff-pause-indicator').style.display = isPaused ? 'block' : 'none';
        widgetElement.querySelector('.ff-timeup-indicator').style.display = isTimeUp ? 'block' : 'none';

        // Extend Section visibility (query within shadow root)
        widgetElement.querySelector('.ff-extend-section').style.display = isTimeUp ? 'block' : 'none';

        // Timer Display styling (query within shadow root)
        widgetElement.querySelector('.ff-timer-display').classList.toggle('ff-time-alert', isTimeUp);
    }
  }

  function removeCornerWidget() {
    if (widgetHost) {
      widgetHost.remove(); // Remove host element
      widgetHost = null;
      widgetShadowRoot = null; // Clear references
    }
  }

  function toggleWidgetExpansion(forceExpand = null) {
     // Check shadow root exists
     if (!widgetShadowRoot) return;
     const shouldBeExpanded = typeof forceExpand === 'boolean' ? forceExpand : !widgetState.expanded;
     if(widgetState.expanded !== shouldBeExpanded) {
         widgetState.expanded = shouldBeExpanded;
         updateCornerWidget(widgetState); // Update UI within shadow DOM
         // Save preference to background
         chrome.runtime.sendMessage({ action: "saveWidgetState", domain: currentDomain, expanded: widgetState.expanded });
     }
  }

  function highlightWidget() {
    // Highlight the host element for visibility
    if (!widgetHost) return;
    const originalOutline = widgetHost.style.outline || 'none';
    widgetHost.style.outline = '2px solid var(--accent-blue)'; // Use outline on host
    widgetHost.style.outlineOffset = '2px';

    setTimeout(() => {
      if (widgetHost) widgetHost.style.outline = originalOutline;
    }, 1000); // Simple flash
  }

  function showToast(message, duration = 3000) {
    // Create a host for the toast if it doesn't exist
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'ff-toast-host';
      // Basic styling for the host itself
      toastHost.style.position = 'fixed';
      toastHost.style.bottom = '20px';
      toastHost.style.left = '20px';
      toastHost.style.zIndex = '2147483647'; // Max z-index
      toastHost.style.pointerEvents = 'none'; // Allow clicks through host
      document.body.appendChild(toastHost);

      toastShadowRoot = toastHost.attachShadow({ mode: 'open' });
      injectStyles(toastShadowRoot); // Inject styles into toast shadow DOM

      // Create the actual toast element inside the shadow DOM
      const toastElement = document.createElement('div');
      toastElement.className = 'ff-toast ff-root'; // Apply root class
      toastShadowRoot.appendChild(toastElement);
    }

    // Get the toast element from the shadow root
    const toastElement = toastShadowRoot.querySelector('.ff-toast');
    if (!toastElement) return; // Should not happen

    toastElement.textContent = message;
    toastElement.classList.add('show');

    // Simple timeout to hide the toast
    setTimeout(() => {
      toastElement.classList.remove('show');
      // Optionally remove the host after a delay if not shown again soon
      // setTimeout(() => { if (!toastElement.classList.contains('show')) toastHost.remove(); toastHost = null; toastShadowRoot = null; }, 1000);
    }, duration);
  }


  function playTimerCompletionSound() {
    // Use the bubble.mp3 file from the sounds directory
    const audio = new Audio(chrome.runtime.getURL('sounds/bubble.mp3'));
    audio.volume = 0.5;
    audio.play().catch(error => {
      console.log("FocusFinder Content Script: Error playing sound:", error);
    });
  }

  // --- Event Handling ---
  // Handlers remain mostly the same, just ensure messages are sent correctly

  function handlePromptContinue(reason, durationSeconds) {
    console.log("FocusFinder Content Script: Continue clicked. Reason:", reason, "Duration:", durationSeconds + "s");
    chrome.runtime.sendMessage({
      action: "intentionSet",
      domain: currentDomain,
      intention: reason,
      duration: durationSeconds
    });
    removeIntentionPrompt();
    // Widget creation will be triggered by 'intentionConfirmed' message from background
  }

  function handlePromptCloseTabs() {
    console.log("FocusFinder Content Script: Close Tabs clicked in prompt.");
    chrome.runtime.sendMessage({ action: "closeAllTabs", domain: currentDomain });
    removeIntentionPrompt();
  }

  function handleWidgetPauseResume() {
    const action = widgetState.isPaused ? "resumeTimer" : "pauseTimer";
    console.log("FocusFinder Content Script: Sending", action);
    // Optimistic UI update (optional but can feel snappier)
    // widgetState.isPaused = !widgetState.isPaused;
    // updateCornerWidget(widgetState);
    chrome.runtime.sendMessage({ action: action, domain: currentDomain });
    // UI update will happen via message from background anyway
  }

  function handleWidgetExtendTime(minutes) { 
    // The background script now handles the logic of whether to extend directly
    // or request confirmation. This function just sends the initial request.
    chrome.runtime.sendMessage({
        action: "extendTime", // Regular extend request
        domain: currentDomain,
        minutes: parseInt(minutes)
    }).catch(error => console.error("FocusFinder Content Script: Error sending extend time request:", error));
  }

  function handleWidgetEndBrowsing() {
    if (confirmationHost) removeExtendConfirmation(); // Close confirmation if ending session
    chrome.runtime.sendMessage({
        action: "closeAllTabs",
        domain: currentDomain
    });
    removeCornerWidget(); // Remove widget immediately on user action
  }

  function visibilityChangeHandler() {
      console.log("FocusFinder Content Script: Visibility changed to", document.visibilityState);
      chrome.runtime.sendMessage({
          action: "visibilityChanged",
          domain: currentDomain,
          tabId: null, // Content script doesn't know its tab ID, background script uses sender.tab.id
          isVisible: document.visibilityState === 'visible'
      }).catch(error => console.error("FocusFinder Content Script: Error in visibility change:", error));
  }

  // --- New Positioning Logic for Inner Widget Element ---
  function positionWidgetElement(widgetElement, position) {
    if (!widgetElement) return;

    // Define positions and default offset
    const positions = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
    const offset = '20px';

    // Set position absolute within the fixed host
    widgetElement.style.position = 'absolute';
    widgetElement.style.transition = 'all 0.3s ease'; // Apply transition here

    // Remove existing position classes from the inner element
    positions.forEach(p => widgetElement.classList.remove(`ff-pos-inner-${p}`));

    // Reset styles before applying new ones
    widgetElement.style.top = 'auto';
    widgetElement.style.right = 'auto';
    widgetElement.style.bottom = 'auto';
    widgetElement.style.left = 'auto';

    // Apply new position styles
    switch (position) {
      case 'bottom-right':
        widgetElement.style.bottom = offset;
        widgetElement.style.right = offset;
        widgetElement.classList.add('ff-pos-inner-bottom-right');
        break;
      case 'bottom-left':
        widgetElement.style.bottom = offset;
        widgetElement.style.left = offset;
        widgetElement.classList.add('ff-pos-inner-bottom-left');
        break;
      case 'top-left':
        widgetElement.style.top = offset;
        widgetElement.style.left = offset;
        widgetElement.classList.add('ff-pos-inner-top-left');
        break;
      case 'top-right':
        widgetElement.style.top = offset;
        widgetElement.style.right = offset;
        widgetElement.classList.add('ff-pos-inner-top-right');
        break;
      default:
        widgetElement.style.bottom = offset;
        widgetElement.style.right = offset;
        widgetElement.classList.add('ff-pos-inner-bottom-right');
        position = 'bottom-right';
        break;
    }

    // Update state (position is now conceptually applied to the inner widget)
    widgetState.position = position;
    
    // Save position preference to background (no change needed here)
    chrome.runtime.sendMessage({
        action: "saveWidgetPosition",
        domain: currentDomain,
        position: position
    }).catch(error => console.error("FocusFinder Content Script: Error saving widget position:", error));
  }

  // Update handleMoveWidget to use the new positioning function
  function handleMoveWidget() {
    // Get the widget element from the shadow DOM
    const widgetElement = widgetShadowRoot?.querySelector('.ff-corner-widget');
    if (!widgetElement) {
      console.error("Cannot find inner widget element to move.");
      return;
    }

    const positions = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
    const currentPosition = widgetState.position || 'bottom-right';
    const currentIndex = positions.indexOf(currentPosition);
    const nextIndex = (currentIndex + 1) % positions.length;
    const newPosition = positions[nextIndex];
    
    // Apply the new position to the inner widget element
    positionWidgetElement(widgetElement, newPosition);
    
    // Force a reflow (might still be useful)
    void widgetElement.offsetWidth;
  }

  // --- Extend Confirmation Dialog ---
  function showExtendConfirmation(domain, minutes) {
    if (confirmationHost) removeExtendConfirmation(); // Remove existing if any

    confirmationHost = document.createElement('div');
    confirmationHost.id = 'ff-confirmation-host';
    // Basic styling for host
    confirmationHost.style.position = 'fixed';
    confirmationHost.style.top = '0';
    confirmationHost.style.left = '0';
    confirmationHost.style.width = '100%';
    confirmationHost.style.height = '100%';
    confirmationHost.style.zIndex = '2147483647';
    document.body.appendChild(confirmationHost);

    confirmationShadowRoot = confirmationHost.attachShadow({ mode: 'open' });
    injectStyles(confirmationShadowRoot); // Inject combined CSS

    const overlayElement = document.createElement('div');
    overlayElement.className = 'ff-overlay ff-root'; // Apply root class

    overlayElement.innerHTML = `
      <div class="ff-dialog">
        <div class="ff-dialog-header">
          Are you sure? You already extended your time.
        </div>
        <div class="ff-dialog-content">
          <div class="ff-warning">
            <span>⚠️ Consider if you really need more time on ${domain}</span>
          </div>
        </div>
        <div class="ff-dialog-footer">
          <button id="ff-extend-close" class="ff-button" title="Close all tabs for this domain">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            End Session for ${domain}
          </button>
          <button id="ff-extend-confirm" class="ff-button ff-button-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Extend by ${minutes} min
          </button>
        </div>
      </div>
    `;

    confirmationShadowRoot.appendChild(overlayElement);

    // Event listener for closing tabs
    confirmationShadowRoot.querySelector('#ff-extend-close').addEventListener('click', () => {
      removeExtendConfirmation();
      handleWidgetEndBrowsing(); // Use existing function
    });

    // Event listener for confirming extension
    confirmationShadowRoot.querySelector('#ff-extend-confirm').addEventListener('click', () => {
      removeExtendConfirmation();
      // Send the *force* extend message to the background script
      chrome.runtime.sendMessage({
          action: "forceExtendTime", // Use the new action
          domain: currentDomain,
          minutes: parseInt(minutes)
      }).catch(error => console.error("FocusFinder Content Script: Error sending force extend time:", error));
    });

    // Optional: Close if clicking outside the dialog
    overlayElement.addEventListener('click', (e) => {
      if (e.target === overlayElement) {
         // Currently does nothing, add removeExtendConfirmation(); if desired
      }
    });
  }

  function removeExtendConfirmation() {
    if (confirmationHost) {
      confirmationHost.remove();
      confirmationHost = null;
      confirmationShadowRoot = null;
    }
  }

  // Initialize as soon as DOM is ready
  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

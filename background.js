// --- Default Settings ---
const defaultSettings = {
  watchlist: [
    "facebook.com", "x.com", "twitter.com", "instagram.com", "youtube.com",
    "tiktok.com", "linkedin.com", "reddit.com", "yahoo.com", "cnn.com",
    "foxnews.com", "nbc.com", "cbs.com", "bbc.com", "amazon.com", "ebay.com"
  ],
  defaultReasons: [
    "Messaging", "Searching info", "Checking notifications", "Taking a break"
  ],
  userReasons: [],
  pauseOnBlur: true, // Default to ON as requested
  isExtensionEnabled: true,
  domains: [],
  domainStates: {}
};

// --- State Variables ---
let domainStates = {}; // In-memory state
let settings = { ...defaultSettings };
let activeTabId = null;
let activeDomain = null;
let isWindowFocused = true;
const BLUR_GRACE_PERIOD_MS = 4000;
const INITIAL_STARTUP_GRACE_MS = 10000; // 10 seconds for initial timer start
const MAIN_TIMER_ALARM_NAME = 'focusFinderMainTimer';

// --- Initialization ---
chrome.runtime.onInstalled.addListener(onInstalledHandler);
chrome.runtime.onStartup.addListener(initializeExtension); // Initialize on browser start
initializeExtension(); // Initialize on script load (e.g., after update)

async function initializeExtension() {
  console.log("FocusFinder: Initializing...");
  await loadSettings();
  setupListeners();
  createMainTimerAlarm();
  console.log("FocusFinder: Initialization complete. Settings:", settings);
}

async function loadSettings() {
  try {
    // Always use local storage only
    const result = await chrome.storage.local.get('settings');
    if (result.settings) {
      // Merge with defaults and validate
      settings = { ...defaultSettings, ...result.settings };
      settings.watchlist = Array.isArray(settings.watchlist) ? settings.watchlist : defaultSettings.watchlist;
      settings.defaultReasons = Array.isArray(settings.defaultReasons) ? settings.defaultReasons : defaultSettings.defaultReasons;
      settings.userReasons = Array.isArray(settings.userReasons) ? settings.userReasons : defaultSettings.userReasons;
    } else {
      console.log("FocusFinder: No settings found, using defaults.");
      settings = { ...defaultSettings };
      // Need to save the defaults if none were found
      await saveSettings();
    }
  } catch (error) {
    console.error("FocusFinder: Error loading settings:", error);
    settings = { ...defaultSettings };
    await saveSettings();
  }
}

async function saveSettings() {
  try {
    // Always use local storage only
    await chrome.storage.local.set({ settings: settings });
    console.log("FocusFinder: Settings saved to local storage:", settings);
  } catch (error) {
    console.error("FocusFinder: Error saving settings:", error);
  }
}

function onInstalledHandler(details) {
  if (details.reason === "install") {
    console.log("FocusFinder: First installation.");
    chrome.storage.local.set({ settings: defaultSettings });
    settings = { ...defaultSettings };
  } else if (details.reason === "update") {
    console.log("FocusFinder: Extension updated.");
    loadSettings();
  }
}

// --- Listeners Setup ---
function setupListeners() {
  // Remove existing listeners before adding new ones to prevent duplicates during re-initialization
  // This is important if the background script restarts or is updated.
  chrome.alarms.onAlarm.removeListener(mainTimerAlarmHandler);
  chrome.windows.onFocusChanged.removeListener(windowFocusChangedHandler);
  chrome.tabs.onUpdated.removeListener(tabUpdatedHandler);
  chrome.tabs.onActivated.removeListener(tabActivatedHandler);
  chrome.tabs.onRemoved.removeListener(tabRemovedHandler);
  chrome.runtime.onMessage.removeListener(messageHandler);
  chrome.storage.onChanged.removeListener(storageChangeHandler);

  // Add listeners
  chrome.alarms.onAlarm.addListener(mainTimerAlarmHandler);
  chrome.windows.onFocusChanged.addListener(windowFocusChangedHandler);
  chrome.tabs.onUpdated.addListener(tabUpdatedHandler);
  chrome.tabs.onActivated.addListener(tabActivatedHandler);
  chrome.tabs.onRemoved.addListener(tabRemovedHandler);
  chrome.runtime.onMessage.addListener(messageHandler);
  chrome.storage.onChanged.addListener(storageChangeHandler);
}

// --- Main Timer ---
// Runs every second to check the active tab's domain state
function createMainTimerAlarm() {
  console.log("FocusFinder: Creating main timer alarm.");
  chrome.alarms.create(MAIN_TIMER_ALARM_NAME, {
    periodInMinutes: 1 / 60 // Run every second
  });
}

function mainTimerAlarmHandler(alarm) {
  if (alarm.name !== MAIN_TIMER_ALARM_NAME) return;
  if (!settings.isExtensionEnabled) return; // Check if extension is globally enabled

  if (activeDomain && domainStates[activeDomain]) {
    const state = domainStates[activeDomain];

    if (state.isTracking && !state.isPaused) {
      state.timeSpent++;

      const isTimeUp = state.timeSpent >= state.reminderTime;

      // Reminder Check
      if (isTimeUp && !state.reminderShown) {
        state.reminderShown = true;
        console.log("FocusFinder: Reminder time reached for", activeDomain);
        broadcastToDomainTabs(activeDomain, {
          action: "showReminder",
          timeSpent: state.timeSpent,
          intention: state.intention,
          reminderTime: state.reminderTime,
          shouldPlaySound: true
        });
      }

      // Update Timer Broadcast
      broadcastToDomainTabs(activeDomain, {
        action: "updateTimer",
        timeSpent: state.timeSpent,
        reminderTime: state.reminderTime,
        isTimeUp: isTimeUp
      });
    }
  }
}

// --- Focus & Activity Handling ---
function windowFocusChangedHandler(windowId) {
  const previouslyFocused = isWindowFocused;
  isWindowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;

  if (previouslyFocused !== isWindowFocused) {
    console.log("FocusFinder: Window focus changed:", isWindowFocused);
    
    // If getting focus back after losing it
    if (isWindowFocused && !previouslyFocused) {
      // Don't do anything immediately, wait to see if this is a short focus loss
      setTimeout(() => {
        // Only resume if we still have focus after a slight delay
        if (isWindowFocused) {
          updatePauseStateForAllDomains();
        }
      }, 100);
    } else if (!isWindowFocused && previouslyFocused) {
      // Losing focus - check each domain's pause state individually
      Object.keys(domainStates).forEach(domain => {
        // Each domain's updateDomainPauseState will check if it has immunity
        updateDomainPauseState(domain);
      });
    }
  }
}

async function handleVisibilityChange(domain, tabId, isVisible) {
  console.log("FocusFinder: Tab visibility change for", domain, "(Tab", tabId, "):", isVisible);
  if (tabId === activeTabId && domainStates[domain]) {
     // Store visibility state - might be useful combined with focus
     // Note: Visibility alone doesn't pause, but is considered by updateDomainPauseState
     domainStates[domain].lastVisibilityState = isVisible;
     updateDomainPauseState(domain);
  }
}

function updatePauseStateForAllDomains() {
  Object.keys(domainStates).forEach(domain => {
    updateDomainPauseState(domain);
  });
}

function updateDomainPauseState(domain, reasonOverride = null) {
  if (!domainStates[domain]) return;

  const state = domainStates[domain];
  const wasPaused = state.isPaused;
  let newPauseReason = state.pauseReason;
  let shouldBePaused = false;

  // --- Determine Pause Reason ---
  if (!settings.isExtensionEnabled) {
    shouldBePaused = true;
    newPauseReason = 'extensionDisabled';
  } else if (state.pauseReason === 'userPaused' && reasonOverride !== '') { 
     // Maintain manual pause unless explicitly resumed
     shouldBePaused = true;
     newPauseReason = 'userPaused';
  } else if (reasonOverride) {
    shouldBePaused = (reasonOverride !== ''); // Pause if override reason is not empty
    newPauseReason = reasonOverride;
  } else {
    // Automatic pausing logic
    if (domain !== activeDomain) {
      shouldBePaused = true;
      newPauseReason = 'tabSwitched';
    } else if (settings.pauseOnBlur && !isWindowFocused) {
      // Check for temporary immunity (e.g., after regaining focus)
      const now = Date.now();
      if (state.ignorePauseOnBlurUntil && now < state.ignorePauseOnBlurUntil) {
        console.log("FocusFinder: Ignoring pauseOnBlur due to immunity flag for", domain);
        shouldBePaused = false;
        newPauseReason = '';
      } else {
        // Regular pauseOnBlur logic
        shouldBePaused = true;
        if (state.pauseReason !== 'windowBlurred' && state.pauseReason !== 'blurGracePeriod') {
          // Start grace period only if not already blurred/in grace
          newPauseReason = 'blurGracePeriod';
          clearTimeout(state.blurTimeoutId); // Prevent multiple grace period timeouts
          state.blurTimeoutId = setTimeout(() => {
            // Check focus again *after* the timeout
            if (!isWindowFocused && domain === activeDomain && state.pauseReason === 'blurGracePeriod') {
               console.log("FocusFinder: Blur grace period ended for", domain, ". Pausing.");
               updateDomainPauseState(domain, 'windowBlurred');
            }
          }, BLUR_GRACE_PERIOD_MS);
        } else {
           // Already blurred or in grace period, maintain state
           newPauseReason = state.pauseReason;
        }
      }
    } else { // Active domain and window focused (or pauseOnBlur is off)
      shouldBePaused = false;
      newPauseReason = '';
      // If focus returned, clear any blur timeout
      clearTimeout(state.blurTimeoutId);
      state.blurTimeoutId = null;
      
      // Clear the immunity flag if we've actively resumed focus
      if (state.ignorePauseOnBlurUntil) {
        console.log("FocusFinder: Clearing pauseOnBlur immunity for", domain, "as focus is active");
        state.ignorePauseOnBlurUntil = null;
      }
    }
  }

  // --- Apply State Change ---
  if (shouldBePaused !== wasPaused || newPauseReason !== state.pauseReason) {
    console.log("FocusFinder: Pause state change for", domain, ":", wasPaused, "->", shouldBePaused, ". Reason:", state.pauseReason, "->", newPauseReason);
    state.isPaused = shouldBePaused;
    state.pauseReason = newPauseReason;

    // Clear grace period timeout if we are resuming for any reason other than blur
    if (!shouldBePaused && newPauseReason !== 'blurGracePeriod') {
        clearTimeout(state.blurTimeoutId);
        state.blurTimeoutId = null;
    }

    // Broadcast change
    if (shouldBePaused && newPauseReason !== 'blurGracePeriod') { // Don't broadcast pause during grace period
      broadcastToDomainTabs(domain, { action: "timerPaused", reason: newPauseReason });
    } else if (!shouldBePaused) {
      broadcastToDomainTabs(domain, { action: "timerResumed" });
    }
  }
}

// --- Tab Management ---
async function tabUpdatedHandler(tabId, changeInfo, tab) {
    // Check primarily for URL changes on complete load or explicit URL change info
    if (tab.url && (changeInfo.status === 'complete' || changeInfo.url)) {
        const domain = extractDomain(tab.url);
        console.log("FocusFinder: Tab updated:", tabId, "Domain:", domain, "Status:", changeInfo.status, "URL changed:", !!changeInfo.url);

        if (domain) {
            // Update tab list for the domain
            if (domainStates[domain]) {
                domainStates[domain].tabIds.add(tabId);
            } else {
                // If domain state doesn't exist yet, might be created by checkDomainStatus
            }

            // If this tab becomes active due to update/navigation
            if (tab.active) {
                if (activeDomain !== domain) {
                    // Pause previously active domain if different
                    if (activeDomain && domainStates[activeDomain]) {
                         updateDomainPauseState(activeDomain, 'tabSwitched');
                    }
                    activeDomain = domain;
                }
                activeTabId = tabId;
                console.log("FocusFinder: Active tab updated to", tabId, "(", domain, ")");
                 // Ensure pause state is correct for the *new* active domain
                if (domainStates[domain]) {
                    updateDomainPauseState(domain);
                }
            }

            await checkDomainStatus(tabId, tab.url);

        } else {
             // Navigated away from a potentially tracked domain to an untracked URL (e.g., chrome://)
             if (tab.active) {
                 // If the previously active domain was tracked, pause it
                 if(activeDomain && domainStates[activeDomain]) {
                     updateDomainPauseState(activeDomain, 'tabSwitched');
                 }
                 activeDomain = null;
                 activeTabId = tabId;
             }
        }
         // Clean up tabIds for domains that might have lost this tab
         Object.keys(domainStates).forEach(d => {
            if(d !== domain && domainStates[d].tabIds.has(tabId)) {
                domainStates[d].tabIds.delete(tabId);
                 if (domainStates[d].tabIds.size === 0) {
                    console.log("FocusFinder: Deleting state for", d, "- no tabs left after update.");
                    delete domainStates[d];
                 }
            }
         });
    }
}

async function tabActivatedHandler(activeInfo) {
  const { tabId } = activeInfo;
  console.log("FocusFinder: Tab activated:", tabId);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) {
      const newDomain = extractDomain(tab.url);
      console.log("FocusFinder: Activated tab domain:", newDomain);

      // Pause previously active domain
      if (activeDomain && activeDomain !== newDomain && domainStates[activeDomain]) {
        console.log("FocusFinder: Pausing previously active domain", activeDomain);
        
        // No need to clear the immunity flag here - it will naturally expire
        // or be checked in updateDomainPauseState

        updateDomainPauseState(activeDomain, 'tabSwitched');
      }

      // Update active identifiers
      activeTabId = tabId;
      activeDomain = newDomain;

      // Check status of the newly activated domain
      if (newDomain) {
          await checkDomainStatus(tabId, tab.url);
          
          // Ensure the new active domain's pause state is correct
          if (domainStates[newDomain]) {
              updateDomainPauseState(newDomain);
          }
      } else {
         // Active tab is not a trackable domain (e.g., chrome://)
      }
    } else if (tab) {
         // Tab exists but has no URL or cannot be accessed (e.g., protected pages)
         console.log("FocusFinder: Activated tab", tabId, "has no URL or is inaccessible.");
         if (activeDomain && domainStates[activeDomain]) {
             updateDomainPauseState(activeDomain, 'tabSwitched');
         }
         activeDomain = null;
         activeTabId = tabId;
    }
  } catch (error) {
    console.error("FocusFinder: Error getting tab info for tab:", tabId, error);
     if (activeDomain && domainStates[activeDomain]) {
         updateDomainPauseState(activeDomain, 'tabSwitched');
     }
     activeDomain = null;
     activeTabId = tabId; // Still update activeTabId even on error
  }
}

function tabRemovedHandler(tabId, removeInfo) {
  console.log("FocusFinder: Tab removed:", tabId);
  let domainNeedingUpdate = null;
  
  Object.keys(domainStates).forEach(domain => {
    if (domainStates[domain].tabIds.has(tabId)) {
      domainStates[domain].tabIds.delete(tabId);
      console.log("FocusFinder: Removed tab", tabId, "from", domain, ". Remaining tabs:", domainStates[domain].tabIds.size);
      
      // Clear any initial grace period for this domain if it exists
      if (domainStates[domain].initialGracePeriodId) {
        clearTimeout(domainStates[domain].initialGracePeriodId);
        domainStates[domain].initialGracePeriodId = null;
      }
      
      // If this was the active tab for this domain, we need to update the domain's state
      if (tabId === activeTabId && domain === activeDomain) {
        domainNeedingUpdate = domain;
      }
      
      // Always clear state when last tab is closed
      if (domainStates[domain].tabIds.size === 0) {
        console.log("FocusFinder: Clearing state for", domain, "- last tab closed");
        delete domainStates[domain];
      }
    }
  });

  if (tabId === activeTabId) {
    console.log("FocusFinder: Active tab was closed.");
    activeTabId = null;
    
    // If we still have tabs for this domain, find one to activate
    if (domainNeedingUpdate && domainStates[domainNeedingUpdate] && 
        domainStates[domainNeedingUpdate].tabIds.size > 0) {
      
      // Don't clear activeDomain, as we'll find the new active tab soon
      // Chrome will handle activating another tab automatically
      console.log("FocusFinder: Domain still has tabs, waiting for new active tab");
      
      // Force a check of all tabs after a short delay to ensure we update the state correctly
      setTimeout(async () => {
        try {
          const tabs = await chrome.tabs.query({active: true, currentWindow: true});
          if (tabs.length > 0) {
            const activeTab = tabs[0];
            console.log("FocusFinder: New active tab after close:", activeTab.id);
            // Manually trigger an activation to update state
            await tabActivatedHandler({tabId: activeTab.id});
          }
        } catch (error) {
          console.error("FocusFinder: Error finding new active tab:", error);
        }
      }, 100);
    } else {
      activeDomain = null;
    }
  }
}


async function checkDomainStatus(tabId, url) {
  const domain = extractDomain(url);
  if (!domain) return; // Not a trackable URL

  const isWatched = await isDomainWatched(domain);
  console.log("FocusFinder: checkDomainStatus for", domain, "(Tab", tabId, "). Watched:", isWatched);

  if (isWatched) {
    if (!domainStates[domain]) {
        // First time seeing this watched domain in this session
         if (settings.isExtensionEnabled) {
            console.log("FocusFinder: New watched domain. Requesting intention for tab.");
            await requestIntention(domain, tabId);
            // Initialize state partially to track tabs, initially paused
             domainStates[domain] = {
                intention: "", intentionSet: false, timeSpent: 0, reminderTime: 300, // Default 5 min
                isTracking: false, isPaused: true, pauseReason: 'noIntention', reminderShown: false,
                blurTimeoutId: null, tabIds: new Set([tabId]), widgetExpanded: false, lastVisibilityState: true,
                initialGracePeriodId: null, ignorePauseOnBlurUntil: null, // Added immunity flag field
                widgetPosition: 'bottom-right', // Add default position
                hasExtended: false // Initialize hasExtended flag
            };
         } else {
             console.log("FocusFinder: Extension disabled, not prompting for.");
         }

    } else {
      // Domain state exists
      domainStates[domain].tabIds.add(tabId); // Ensure tab is tracked

      if (domainStates[domain].intentionSet && settings.isExtensionEnabled) {
        console.log("FocusFinder: Domain has intention. Initializing widget for tab.");
        await initializeWidgetForTab(tabId, domain);
        
        // If this is now the active tab, ensure tracking is potentially active
        if(tabId === activeTabId) {
            // NEW: Use immunity flag instead of grace period for new tab activation
            if (settings.pauseOnBlur) {
                // Set a short immunity to pauseOnBlur for this tab activation
                domainStates[domain].ignorePauseOnBlurUntil = Date.now() + 500;
                console.log("FocusFinder: Setting short pauseOnBlur immunity for new tab activation:", domain);
                
                // Ensure the timer is running initially for this tab
                if (domainStates[domain].isPaused && domainStates[domain].pauseReason !== 'userPaused' 
                    && domainStates[domain].pauseReason !== 'extensionDisabled') {
                    // Force timer to run for this new tab
                    domainStates[domain].isPaused = false;
                    domainStates[domain].pauseReason = '';
                    broadcastToDomainTabs(domain, { action: "timerResumed" });
                }
                
                // Force state update to respect immunity
                updateDomainPauseState(domain);
            } else {
                updateDomainPauseState(domain);
            }
        }
      } else if (!domainStates[domain].intentionSet && settings.isExtensionEnabled && tabId === activeTabId) {
         // State exists, but no intention set, and this is the active tab - prompt again
          console.log("FocusFinder: Domain state exists but no intention. Prompting active tab.");
          await requestIntention(domain, tabId);
           // Ensure it's paused until intention is set
           domainStates[domain].isPaused = true;
           domainStates[domain].pauseReason = 'noIntention';
      }
    }
  } else {
      // Domain is not watched
      if (domainStates[domain]) {
          console.log("FocusFinder: Domain is no longer watched (or never was). Ensuring state is removed/paused.");
          updateDomainPauseState(domain, 'notWatched');
      }
  }
}

// --- Communication & Handlers ---
function messageHandler(message, sender, sendResponse) {
  console.log("FocusFinder: Received message:", message, "From:", sender.tab ? "Tab" : "Popup/Other");
  const domain = message.domain || activeDomain; // Use message domain if provided, else assume active

  // Wrap message handling in an async IIFE for cleaner async/await usage
  (async () => {
    try {
      switch (message.action) {
        case "ping":
          sendResponse({ status: "ready" });
          break;
        case "getExtensionStatus":
          sendResponse({ isEnabled: settings.isExtensionEnabled });
          break;
        case "toggleExtension":
          await handleToggleExtension(message.enable); // Allow explicit state setting
          sendResponse({ success: true, isEnabled: settings.isExtensionEnabled });
          break;
        case "intentionSet":
          if (!domain) { throw new Error("Domain missing"); }
          await handleIntentionSet(domain, message.intention, message.duration, message.tabId);
          sendResponse({ success: true });
          break;
        case "pauseTimer":
          if (!domain) { throw new Error("Domain missing"); }
          // Remove immunity to pauseOnBlur when manually pausing
          if (domainStates[domain] && domainStates[domain].ignorePauseOnBlurUntil) {
            console.log("FocusFinder: Clearing pauseOnBlur immunity due to manual pause:", domain);
            domainStates[domain].ignorePauseOnBlurUntil = null;
          }
          updateDomainPauseState(domain, 'userPaused');
          sendResponse({ success: true });
          break;
        case "resumeTimer":
          if (!domain) { throw new Error("Domain missing"); }
          // Add immunity to blur pause when manually resuming
          if (domainStates[domain]) {
            const immunityDuration = 1500; // Grant 1.5 seconds immunity
            domainStates[domain].ignorePauseOnBlurUntil = Date.now() + immunityDuration; 
            console.log(`FocusFinder: Granting ${immunityDuration}ms pauseOnBlur immunity for manual resume:`, domain);
          }
          updateDomainPauseState(domain, ''); // Attempt resume
          sendResponse({ success: true });
          break;
        case "extendTime":
        case "forceExtendTime": // New message type for confirmed extension
          if (!domain) { throw new Error("Domain missing"); }
          await handleExtendTime(domain, message.minutes, message.action === "forceExtendTime");
          sendResponse({ success: true }); // Response should include updated state if needed by UI
          break;
        case "closeAllTabs":
          if (!domain) { throw new Error("Domain missing"); }
          await handleCloseTabsRequest(domain);
          sendResponse({ success: true });
          break;
        case "getSettings":
          sendResponse(settings);
          break;
        case "updateSettings":
          await handleUpdateSettings(message.newSettings);
          sendResponse({ success: true });
          break;
        case "getDomainState":
          if (!domain) { throw new Error("Domain missing"); }
          sendResponse(domainStates[domain] || {});
          break;
        case "visibilityChanged":
           if (!domain || message.tabId === undefined) { throw new Error("Domain or TabId missing for visibility change"); }
           await handleVisibilityChange(domain, message.tabId, message.isVisible);
           sendResponse({ success: true });
           break;
        case "saveWidgetState":
           if (!domain) { throw new Error("Domain missing"); }
           if (domainStates[domain]) {
            domainStates[domain].widgetExpanded = message.expanded;
           }
           sendResponse({ success: true });
           break;
        case "saveWidgetPosition": // Add handler for saving position
           if (!domain) { throw new Error("Domain missing"); }
           if (domainStates[domain]) {
              domainStates[domain].widgetPosition = message.position;
              console.log("FocusFinder: Saved widget position for", domain, ":", message.position);
           }
           sendResponse({ success: true });
           break;
        default:
          console.log("FocusFinder: Unknown message action:", message.action);
          sendResponse({ error: "Unknown action" });
      }
    } catch (error) {
      console.error("FocusFinder: Error handling message action:", error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true; // Indicate asynchronous response
}

async function broadcastToDomainTabs(domain, message) {
  if (!domainStates[domain] || !domainStates[domain].tabIds || domainStates[domain].tabIds.size === 0) {
    // console.log(FocusFinder: No tabs to broadcast to for );
    return;
  }

  console.log("FocusFinder: Broadcasting to", domainStates[domain].tabIds.size, "tabs for:", message);
  const promises = [];
  for (const tabId of domainStates[domain].tabIds) {
    promises.push(
      sendMessageToTab(tabId, message).catch(error => {
        console.warn("FocusFinder: Failed to send message to tab", tabId, "for:", error.message);
        // If sending fails because the tab is gone, remove it from state.
        if(error.message.includes("No tab with id") || error.message.includes("Receiving end does not exist")){
            domainStates[domain]?.tabIds.delete(tabId);
             if (domainStates[domain]?.tabIds.size === 0) {
                console.log("FocusFinder: Deleting state for", domain, "- no tabs left after broadcast failure.");
                delete domainStates[domain];
            }
        }
      })
    );
  }
  await Promise.all(promises);
}

async function sendMessageToTab(tabId, message) {
   try {
       // console.log(FocusFinder: Sending message to tab :, message);
       return await chrome.tabs.sendMessage(tabId, message);
   } catch (error) {
       // console.error(FocusFinder: Error sending message to tab :, error);
       // Rethrow specific errors if needed, or just log and continue
       throw error; // Propagate error for broadcast handler to catch
   }
}

async function ensureContentScriptReady(tabId, callback) {
   console.log("FocusFinder: Ensuring content script ready for tab");
   try {
       // Ping the content script to see if it's loaded and listening
       const response = await sendMessageToTab(tabId, { action: "ping" });
       if (response && response.status === 'ready') {
           console.log("FocusFinder: Content script ready in tab.");
           callback();
       } else {
            // This case shouldn't happen if ping works, but handle defensively
           console.warn("FocusFinder: Ping response invalid from tab. Injecting script.");
           await injectContentScript(tabId);
           setTimeout(callback, 150); // Give script time to load
       }
   } catch (error) {
       // Error usually means the script isn't there or tab doesn't exist
       console.warn("FocusFinder: Ping failed for tab(). Injecting script.");
        try {
           await injectContentScript(tabId);
           console.log("FocusFinder: Injected content script into tab.");
           setTimeout(callback, 150); // Give script time to load after injection
       } catch (injectionError) {
           console.error("FocusFinder: Failed to inject content script into tab:", injectionError);
           // Cannot proceed if injection fails
       }
   }
}

async function injectContentScript(tabId) {
   try {
       await chrome.scripting.executeScript({
           target: { tabId: tabId },
           files: ["contentScript.js"]
       });
   } catch(e) {
       console.error("FocusFinder: executeScript failed for tab:", e);
       throw e; // Re-throw to be caught by ensureContentScriptReady
   }
}


async function requestIntention(domain, tabId) {
  await ensureContentScriptReady(tabId, () => {
    console.log(`FocusFinder: Sending showIntentionPrompt to tab ${tabId} for ${domain}`);

    // Combine default and user reasons
    const allReasons = [...(settings.defaultReasons || []), ...(settings.userReasons || [])];

    sendMessageToTab(tabId, {
      action: "showIntentionPrompt",
      domain: domain,
      reasons: allReasons // Send the combined list
    }).catch(error => console.error("FocusFinder: Error sending showIntentionPrompt to tab:", tabId, error));
  });
}

async function handleIntentionSet(domain, intention, durationSeconds, tabId) {
  console.log("FocusFinder: Intention received for:", domain, "Duration:", durationSeconds, "s");
  if (!domainStates[domain]) {
    // Should usually be partially initialized, but handle case where it's not
    domainStates[domain] = {
       intention: "", intentionSet: false, timeSpent: 0, reminderTime: 300,
       isTracking: false, isPaused: false, pauseReason: '', reminderShown: false,
       blurTimeoutId: null, tabIds: new Set(), widgetExpanded: false, lastVisibilityState: true,
       initialGracePeriodId: null, ignorePauseOnBlurUntil: null,
       widgetPosition: 'bottom-right' // Add default position here too
   };
  }
  const state = domainStates[domain];
  state.intention = intention;
  state.reminderTime = durationSeconds || 300; // Default 5 mins (300s) if none provided
  state.timeSpent = 0; // Reset timer
  state.intentionSet = true;
  state.reminderShown = false;
  state.isTracking = true; // Start tracking
  
  // CRITICAL: Force the timer to start in running state
  state.isPaused = false;
  state.pauseReason = '';
  
  state.tabIds.add(tabId); // Ensure current tab is tracked

  // Clear any existing initial grace period
  if (state.initialGracePeriodId) {
    clearTimeout(state.initialGracePeriodId);
    state.initialGracePeriodId = null;
  }

  // NEW: Set immunity flag to ignore pauseOnBlur temporarily after intention set
  state.ignorePauseOnBlurUntil = Date.now() + 2000; // 2 second immunity
  console.log("FocusFinder: Setting pauseOnBlur immunity for manual resume:", domain);
  
  // Force a state update to ensure the timer is running
  updateDomainPauseState(domain, '');
  
  // Broadcast the intention confirmation immediately
  broadcastToDomainTabs(domain, {
    action: "intentionConfirmed",
    intention: state.intention,
    reminderTime: state.reminderTime
  });
  
  console.log("FocusFinder: Tracking started for", domain);
}

// Helper function specifically for applying the time extension
async function applyExtension(domain, minutes) {
  if (!domainStates[domain]) return;
  const state = domainStates[domain];
  const extensionSeconds = minutes * 60;

  state.reminderTime += extensionSeconds;
  state.isTracking = true;
  state.isPaused = false;
  state.pauseReason = '';
  state.reminderShown = false;
  state.hasExtended = true; // Always true when applying

  console.log(`FocusFinder: Time extended for ${domain} by ${minutes}m. New limit: ${state.reminderTime}s`);

  await broadcastToDomainTabs(domain, {
    action: "timerExtended",
    newReminderTime: state.reminderTime,
    extensionMinutes: minutes
  });
}

// Modify handleExtendTime to check the flag
async function handleExtendTime(domain, minutes, force = false) {
    if (!domainStates[domain]) return;
    const state = domainStates[domain];

    if (state.hasExtended && !force) {
        // Already extended, request confirmation from content script
        console.log(`FocusFinder: Requesting extend confirmation for ${domain}`);
        await broadcastToDomainTabs(domain, {
            action: "showExtendConfirmation",
            minutes: minutes
        });
    } else {
        // First extension or confirmation received (force=true)
        await applyExtension(domain, minutes);
    }
}

async function handleCloseTabsRequest(domain) {
  if (!domainStates[domain] || !domainStates[domain].tabIds) return;
  console.log("FocusFinder: Closing tabs for", domain);
  const tabIdsToClose = Array.from(domainStates[domain].tabIds);
  console.log("FocusFinder: Tab IDs to close:", tabIdsToClose);
  try {
    for (const tabId of tabIdsToClose) {
      await chrome.tabs.remove(tabId);
      console.log("FocusFinder: Closed tab");
    }
  } catch (error) {
    console.warn("FocusFinder: Failed to close tabs:", error.message);
  }
  // State will be cleaned up by tabRemovedHandler
}

async function handleUpdateSettings(newSettings) {
  console.log("FocusFinder: Updating settings:", newSettings);
  const oldPauseOnBlur = settings.pauseOnBlur;
  settings = { ...settings, ...newSettings }; // Merge new settings
  await saveSettings();

  // If pauseOnBlur setting changed, re-evaluate pause states
  if (oldPauseOnBlur !== settings.pauseOnBlur) {
    updatePauseStateForAllDomains();
  }
  // If watchlist changed, potentially need to check current tabs again? Less critical.
}

async function handleToggleExtension(enable) {
    settings.isExtensionEnabled = enable;
    await saveSettings();
    console.log(`FocusFinder: Extension ${enable ? 'enabled' : 'disabled'}.`);
    // Update pause state for all domains based on the new global setting
    updatePauseStateForAllDomains();

    // Optional: Could also broadcast this change to content scripts if they need to react
}


async function initializeWidgetForTab(tabId, domain) {
  if (!domainStates[domain] || !domainStates[domain].intentionSet) return;

  await ensureContentScriptReady(tabId, () => {
    sendMessageToTab(tabId, {
      action: "initializeWidget",
      state: domainStates[domain] // Send the full current state
    }).catch(error => console.error("FocusFinder: Error initializing widget for tab:", error));
  });
}

// --- Utilities ---
function extractDomain(url) {
  try {
    if (!url || typeof url !== 'string') return ""; // Basic check

    // Ignore chrome://, about:, file:, etc.
    if (url.startsWith('chrome:') || url.startsWith('about:') || url.startsWith('file:')) {
      return "";
    }
    
    let hostname = new URL(url).hostname;
    
    // Remove common prefixes like www.
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    
    // Handle localized subdomains like de-de.facebook.com -> facebook.com
    const parts = hostname.split('.');
    if (parts.length > 2) {
      // Check if it's a known domain pattern with country/language prefixes
      const knownDomains = [
        'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com',
        'linkedin.com', 'amazon.com', 'google.com', 'microsoft.com',
        'apple.com', 'github.com', 'reddit.com'
      ];
      
      // If it's a pattern like xx-xx.domain.com or xx.domain.com (where domain.com is known)
      const potentialMainDomain = parts.slice(-2).join('.');
      if (knownDomains.includes(potentialMainDomain)) {
        return potentialMainDomain;
      }
      
      // For other domains, simply use the last two parts 
      // This handles country code domains like de-de.example.com -> example.com
      if (parts.length > 2 && parts[0].length <= 5) { // Likely a language/country code
        return parts.slice(-2).join('.');
      }
    }
    
    // Handle trailing slash
    return hostname.endsWith('/') ? hostname.slice(0, -1) : hostname;
  } catch (e) {
    console.error("FocusFinder: Error extracting domain from URL:", e);
    return "";
  }
}

async function isDomainWatched(domain) {
  if (!domain) return false;
  // Ensure settings are loaded
  if (!settings || !settings.watchlist) await loadSettings();
  
  // Normalize input domain to prevent duplication
  const normalizedDomain = extractDomain('https://' + domain);
  
  // Check if the normalized domain exists in the watchlist
  const watched = settings.watchlist.some(watchedDomain => {
    // Also normalize each watched domain before comparison
    const normalizedWatchedDomain = extractDomain('https://' + watchedDomain);
    return normalizedWatchedDomain === normalizedDomain;
  });
  
  return watched;
}

// Listen for changes in storage and update local settings
function storageChangeHandler(changes, areaName) {
  if (areaName === 'local' && changes.settings) {
    console.log("FocusFinder: Detected settings change in storage.");
    const newSettingsData = changes.settings.newValue;
    if (!newSettingsData) return; // Should not happen, but check

    // Update the in-memory settings
    settings = { ...defaultSettings, ...newSettingsData };

    // TODO: Potentially broadcast changes to content scripts if they need live updates
    // Currently, popup reload handles most UI updates based on settings

    // Re-evaluate pause state if relevant settings changed
    if (oldPauseOnBlur !== settings.pauseOnBlur || oldIsEnabled !== settings.isExtensionEnabled) {
      updatePauseStateForAllDomains();
    }
  }
}

async function handleTimer() {
  for (const domain in domainStates) {
    if (domainStates[domain].isTracking && !domainStates[domain].isPaused) {
      domainStates[domain].timeSpent += 1; // Increment by 1 second
      const { timeSpent, reminderTime, reminderShown, tabIds } = domainStates[domain];

      // Broadcast timer update to all tabs of this domain
      if (tabIds.size > 0) {
        broadcastToDomainTabs(domain, {
          action: "updateTimer",
          timeSpent: timeSpent,
          reminderTime: reminderTime,
          isTimeUp: timeSpent >= reminderTime,
        });
      }

      // Show reminder if time limit reached and not already shown
      if (timeSpent >= reminderTime && !reminderShown) {
        domainStates[domain].reminderShown = true;
        console.log("FocusFinder: Time's up for", domain, "- showing reminder.");
        
        // Send message to show reminder and play sound
        broadcastToDomainTabs(domain, {
          action: "showReminder",
          timeSpent: timeSpent,
          shouldPlaySound: true,  // Ensure sound plays
          intention: domainStates[domain].intention,
          reminderTime: reminderTime
        });
      }
    }
  }
}

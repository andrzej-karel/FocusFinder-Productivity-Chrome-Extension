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

// --- Service Worker Persistence ---
// Keep service worker alive with periodic alarms
// This helps prevent Chrome from suspending the service worker after inactivity
try {
  // Create a persistent alarm that fires every 30 seconds
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
  
  // Also register for idle state changes which can help wake up the service worker
  if (chrome.idle) {
    chrome.idle.setDetectionInterval(30);
    chrome.idle.onStateChanged.addListener((state) => {
      console.log("FocusFinder: System idle state changed to", state);
      // When returning from idle, check active domain state
      if (state === "active" && activeDomain) {
        updateDomainPauseState(activeDomain);
      }
    });
  }
  
  console.log("FocusFinder: Service worker persistence mechanisms initialized");
} catch (e) {
  console.error("FocusFinder: Error setting up service worker persistence:", e);
}

// Add a listener for the keep-alive alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Just log the ping to keep the service worker alive
    console.log("FocusFinder: Service worker keep-alive ping");
  }
});

// --- State Variables ---
let domainStates = {}; // In-memory state
let settings = { ...defaultSettings };
let activeTabId = null;
let activeDomain = null;
let isWindowFocused = true;
const BLUR_GRACE_PERIOD_MS = 4000;
const INITIAL_STARTUP_GRACE_MS = 10000; // 10 seconds for initial timer start
const MAIN_TIMER_ALARM_NAME = 'focusFinderMainTimer';
// Add storage version for future migrations
const STORAGE_VERSION = 2; // Update version number as we make significant changes
// Add state save interval (every 30 seconds)
const STATE_SAVE_INTERVAL_MS = 30000;
// Save timer ID
let stateSaveIntervalId = null;
// Custom timer interval ID
let customTimerIntervalId = null;
// Timer precision interval in ms (100ms for smoother updates)
const TIMER_PRECISION_MS = 100;
// Timer counter for aggregating time
let timerCounter = 0;

// --- Debouncing State ---
let focusChangeTimeoutId = null;
const FOCUS_DEBOUNCE_MS = 150;

// --- Initialization ---
chrome.runtime.onInstalled.addListener(onInstalledHandler);
chrome.runtime.onStartup.addListener(initializeExtension); // Initialize on browser start
initializeExtension(); // Initialize on script load (e.g., after update)

// Add event listener for browser closing to ensure state is saved
// Note: This may not always work due to service worker constraints, 
// which is why we also have periodic saving
self.addEventListener('beforeunload', () => {
  console.log("FocusFinder: Browser is closing, saving final state...");
  // Clean up timers
  if (customTimerIntervalId !== null) {
    clearInterval(customTimerIntervalId);
    customTimerIntervalId = null;
  }
  if (stateSaveIntervalId !== null) {
    clearInterval(stateSaveIntervalId);
    stateSaveIntervalId = null;
  }
  saveDomainStates();
  saveSettings();
});

async function initializeExtension() {
  console.log("FocusFinder: Initializing...");
  
  // First load settings
  await loadSettings();
  
  // Then load domain states (which includes verifying active tabs)
  await loadDomainStates();
  
  // Clean up any invalid tab IDs that might have been loaded from storage
  cleanInvalidTabIds();
  
  // Set up listeners and timers
  setupListeners();
  createMainTimerAlarm();
  setupPeriodicStateSaving();
  
  // After setup, check the current active tab
  await checkCurrentActiveTab();
  
  console.log("FocusFinder: Initialization complete. Settings:", settings);
}

// --- Storage Functions ---
async function loadSettings() {
  try {
    // Always use local storage only
    const result = await chrome.storage.local.get('settings');
    if (result.settings) {
      // Check if migration is needed
      const storedVersion = result.settings.storageVersion || 0;
      
      if (storedVersion < STORAGE_VERSION) {
        console.log(`FocusFinder: Migrating settings from version ${storedVersion} to ${STORAGE_VERSION}`);
        await migrateStorage(storedVersion, STORAGE_VERSION, result.settings);
      }
      
      // Merge with defaults and validate (ensures any new fields are added)
      settings = { ...defaultSettings, ...result.settings };
      
      // Ensure critical arrays are valid
      settings.watchlist = Array.isArray(settings.watchlist) ? settings.watchlist : defaultSettings.watchlist;
      settings.defaultReasons = Array.isArray(settings.defaultReasons) ? settings.defaultReasons : defaultSettings.defaultReasons;
      settings.userReasons = Array.isArray(settings.userReasons) ? settings.userReasons : defaultSettings.userReasons;
      
      // Update storage version
      settings.storageVersion = STORAGE_VERSION;
      
      // Save if we had to update version
      if (storedVersion !== STORAGE_VERSION) {
        await saveSettings();
      }
    } else {
      console.log("FocusFinder: No settings found, using defaults.");
      settings = { ...defaultSettings, storageVersion: STORAGE_VERSION };
      // Need to save the defaults if none were found
      await saveSettings();
    }
  } catch (error) {
    console.error("FocusFinder: Error loading settings:", error);
    settings = { ...defaultSettings, storageVersion: STORAGE_VERSION };
    await saveSettings();
  }
}

/**
 * Migrate storage data between versions
 * @param {number} fromVersion - The current version of stored data
 * @param {number} toVersion - The target version to migrate to
 * @param {Object} currentSettings - The current settings object
 */
async function migrateStorage(fromVersion, toVersion, currentSettings) {
  console.log(`FocusFinder: Beginning migration from v${fromVersion} to v${toVersion}`);
  
  // Apply migrations incrementally
  if (fromVersion < 1) {
    // Migration to version 1 (our first version with versioning)
    console.log("FocusFinder: Applying migration to v1");
    // Nothing to do as this is our baseline
  }
  
  if (fromVersion < 2) {
    // Migration to version 2
    console.log("FocusFinder: Applying migration to v2");
    
    // In version 2, we changed how domain state persistence works
    try {
      // Clear any existing domain states to force re-initialization
      await chrome.storage.local.set({ domainStates: {} });
      console.log("FocusFinder: Migration to v2 - Reset domain states for fresh initialization");
    } catch (error) {
      console.error("FocusFinder: Error in v2 migration:", error);
    }
  }
  
  // Add more version migrations as needed
  // if (fromVersion < 3) { ... }
  
  console.log(`FocusFinder: Migration complete to v${toVersion}`);
}

async function saveSettings() {
  try {
    // Ensure storage version is set
    settings.storageVersion = STORAGE_VERSION;
    
    // Always use local storage only
    await chrome.storage.local.set({ settings: settings });
    console.log("FocusFinder: Settings saved to local storage");
  } catch (error) {
    console.error("FocusFinder: Error saving settings:", error);
  }
}

/**
 * Load domain states from storage
 */
async function loadDomainStates() {
  try {
    const result = await chrome.storage.local.get('domainStates');
    if (result.domainStates) {
      console.log("FocusFinder: Loading domain states from storage");
      
      // Process each stored domain state
      const storedStates = result.domainStates;
      
      // Clear in-memory domain states
      domainStates = {};
      
      // Rebuild domain states from storage
      Object.keys(storedStates).forEach(domain => {
        const storedState = storedStates[domain];
        
        // Skip if data is too old (more than 6 hours)
        const lastUpdated = storedState.lastUpdated || 0;
        const now = Date.now();
        const sixHoursMs = 6 * 60 * 60 * 1000;
        
        if (now - lastUpdated > sixHoursMs) {
          console.log(`FocusFinder: Skipping stale state for ${domain} (older than 6 hours)`);
          return;
        }
        
        // Recreate state with proper data structures (like Set for tabIds)
        domainStates[domain] = {
          intention: storedState.intention || "",
          intentionSet: storedState.intentionSet || false,
          timeSpent: storedState.timeSpent || 0,
          reminderTime: storedState.reminderTime || 300,
          isTracking: storedState.isTracking || false,
          // We start with isPaused true when recovering, to be safe
          isPaused: true, 
          pauseReason: 'sessionRecovery', // Special reason for recovery
          reminderShown: storedState.reminderShown || false,
          blurTimeoutId: null, // Always reset timers
          tabIds: new Set(), // Start with empty tab set - will add active tabs later
          widgetExpanded: storedState.widgetExpanded || false,
          lastVisibilityState: storedState.lastVisibilityState !== undefined ? storedState.lastVisibilityState : true,
          initialGracePeriodId: null, // Always reset timers
          ignorePauseOnBlurUntil: null, // Reset immunity
          widgetPosition: storedState.widgetPosition || 'bottom-right',
          hasExtended: storedState.hasExtended || false,
          lastUpdated: Date.now() // Update the timestamp to now
        };
      });
      
      console.log("FocusFinder: Loaded domain states:", Object.keys(domainStates).length);
      
      // After loading state, verify which tabs are still active
      await verifyActiveTabsAfterRecovery();
    } else {
      console.log("FocusFinder: No domain states found in storage");
      domainStates = {};
    }
  } catch (error) {
    console.error("FocusFinder: Error loading domain states:", error);
    domainStates = {};
  }
}

/**
 * Verify which tabs are still active after recovery and update tab IDs
 */
async function verifyActiveTabsAfterRecovery() {
  try {
    // Get all tabs
    const tabs = await chrome.tabs.query({});
    console.log(`FocusFinder: Verifying active tabs after recovery (${tabs.length} tabs found)`);
    
    // Track tabs for each domain
    for (const tab of tabs) {
      if (tab.url) {
        const domain = extractDomain(tab.url);
        if (domain && domainStates[domain]) {
          // Validate tab ID before adding
          if (validateTabId(tab.id)) {
            // Add tab to the domain's tab list
            domainStates[domain].tabIds.add(tab.id);
            console.log(`FocusFinder: Added existing tab ${tab.id} for domain ${domain}`);
            
            // If tab is active, set as active domain
            if (tab.active && tab.windowId === chrome.windows.WINDOW_ID_CURRENT) {
              activeTabId = tab.id;
              activeDomain = domain;
              console.log(`FocusFinder: Set active domain to ${domain} (tab ${tab.id})`);
            }
          } else {
            console.warn(`FocusFinder: Skipping invalid tab ID ${tab.id} during recovery for domain ${domain}`);
          }
        }
      }
    }
    
    // Clean up any domains with no active tabs
    Object.keys(domainStates).forEach(domain => {
      if (domainStates[domain].tabIds.size === 0) {
        console.log(`FocusFinder: Removing domain state for ${domain} - no active tabs`);
        delete domainStates[domain];
      }
    });
    
    // Save the updated state
    await saveDomainStates();
    
  } catch (error) {
    console.error("FocusFinder: Error verifying active tabs after recovery:", error);
  }
}

/**
 * Save domain states to storage
 */
async function saveDomainStates() {
  try {
    // Prepare domain states for storage
    const statesToStore = {};
    
    Object.keys(domainStates).forEach(domain => {
      const state = domainStates[domain];
      
      // Skip state if it's not tracking or has no intention set
      if (!state.intentionSet && !state.isTracking) return;
      
      // Skip domains with no tabs (cleanup)
      if (state.tabIds.size === 0) return;
      
      // Convert Set to Array for storage
      const tabIdsArray = Array.from(state.tabIds || []);
      
      // Update last updated timestamp
      state.lastUpdated = Date.now();
      
      // Remove non-serializable properties
      statesToStore[domain] = {
        intention: state.intention,
        intentionSet: state.intentionSet,
        timeSpent: state.timeSpent,
        reminderTime: state.reminderTime,
        isTracking: state.isTracking,
        isPaused: state.isPaused,
        pauseReason: state.pauseReason,
        reminderShown: state.reminderShown,
        tabIds: tabIdsArray,
        widgetExpanded: state.widgetExpanded,
        lastVisibilityState: state.lastVisibilityState,
        ignorePauseOnBlurUntil: state.ignorePauseOnBlurUntil,
        widgetPosition: state.widgetPosition,
        hasExtended: state.hasExtended,
        lastUpdated: state.lastUpdated
      };
    });
    
    // Save to storage
    await chrome.storage.local.set({ domainStates: statesToStore });
    console.log("FocusFinder: Domain states saved to storage:", Object.keys(statesToStore).length);
  } catch (error) {
    console.error("FocusFinder: Error saving domain states:", error);
  }
}

/**
 * Update a specific domain state and save it to storage
 */
async function updateAndSaveDomainState(domain) {
  // Check if domain and state still exist
  if (!domain || !domainStates[domain]) {
    console.log(`FocusFinder DEBUG: updateAndSaveDomainState - Domain ${domain} or its state no longer exists. Skipping save.`);
    return;
  }
  
  try {
    const result = await chrome.storage.local.get('domainStates');
    const allStates = result.domainStates || {};
    
    // Get current state
    const state = domainStates[domain];
    
    // Skip state if it's not tracking or has no intention set
    if (!state.intentionSet && !state.isTracking) return;
    
    // Convert Set to Array for storage
    const tabIdsArray = Array.from(state.tabIds || []);
    
    // Update last updated timestamp
    state.lastUpdated = Date.now();
    
    // Create serializable state
    allStates[domain] = {
      intention: state.intention,
      intentionSet: state.intentionSet,
      timeSpent: state.timeSpent,
      reminderTime: state.reminderTime,
      isTracking: state.isTracking,
      isPaused: state.isPaused,
      pauseReason: state.pauseReason,
      reminderShown: state.reminderShown,
      tabIds: tabIdsArray,
      widgetExpanded: state.widgetExpanded,
      lastVisibilityState: state.lastVisibilityState,
      ignorePauseOnBlurUntil: state.ignorePauseOnBlurUntil,
      widgetPosition: state.widgetPosition,
      hasExtended: state.hasExtended,
      lastUpdated: state.lastUpdated
    };
    
    // Save to storage
    await chrome.storage.local.set({ domainStates: allStates });
    console.log(`FocusFinder: Domain state saved for ${domain}`);
  } catch (error) {
    console.error(`FocusFinder: Error saving domain state for ${domain}:`, error);
  }
}

/**
 * Set up periodic saving of states
 */
function setupPeriodicStateSaving() {
  // Clear previous interval if exists
  if (stateSaveIntervalId) {
    clearInterval(stateSaveIntervalId);
  }
  
  // Set up new interval
  stateSaveIntervalId = setInterval(() => {
    saveDomainStates();
  }, STATE_SAVE_INTERVAL_MS);
  
  console.log(`FocusFinder: Periodic state saving set up (every ${STATE_SAVE_INTERVAL_MS / 1000}s)`);
}

/**
 * Periodically clean up tab IDs to prevent invalid IDs from accumulating
 */
function cleanInvalidTabIds() {
  let cleanupCount = 0;
  
  // Go through all domain states and clean up their tabIds Sets
  Object.keys(domainStates).forEach(domain => {
    if (!domainStates[domain].tabIds) return;
    
    const invalidIds = [];
    
    // Find all invalid IDs
    for (const tabId of domainStates[domain].tabIds) {
      if (!validateTabId(tabId)) {
        invalidIds.push(tabId);
      }
    }
    
    // Remove invalid IDs
    if (invalidIds.length > 0) {
      console.log(`FocusFinder: Cleaning up ${invalidIds.length} invalid tabIds for domain ${domain}`);
      invalidIds.forEach(id => {
        domainStates[domain].tabIds.delete(id);
        cleanupCount++;
      });
      
      // If no valid tabs left, remove the domain state
      if (domainStates[domain].tabIds.size === 0) {
        console.log(`FocusFinder: Removing domain ${domain} after tab cleanup - no valid tabs left`);
        delete domainStates[domain];
      }
    }
  });
  
  if (cleanupCount > 0) {
    console.log(`FocusFinder: Cleaned up ${cleanupCount} invalid tab IDs across all domains`);
    
    // Save the cleaned state
    saveDomainStates().catch(error => {
      console.error("FocusFinder: Error saving domain states after tab ID cleanup:", error);
    });
  }
}

function onInstalledHandler(details) {
  if (details.reason === "install") {
    console.log("FocusFinder: First installation.");
    settings = { ...defaultSettings, storageVersion: STORAGE_VERSION };
    chrome.storage.local.set({ 
      settings: settings,
      domainStates: {} 
    });
  } else if (details.reason === "update") {
    console.log("FocusFinder: Extension updated.");
    loadSettings();
    loadDomainStates();
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
  
  // Add runtime listener for extension termination
  chrome.runtime.onSuspend.addListener(() => {
    console.log("FocusFinder: Extension is being suspended, saving state...");
    saveDomainStates();
    saveSettings();
  });
  
  // Set up periodic tab cleanup (every 5 minutes)
  chrome.alarms.create('tabIdCleanup', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'tabIdCleanup') {
      cleanInvalidTabIds();
    }
  });
}

// --- Main Timer ---
// Runs every second to check the active tab's domain state
function createMainTimerAlarm() {
  console.log("FocusFinder: Creating main timer alarm.");
  
  // Clear any existing custom timer
  if (customTimerIntervalId !== null) {
    try {
      clearInterval(customTimerIntervalId);
    } catch (e) {
      console.error("FocusFinder: Error clearing existing timer:", e);
    }
    customTimerIntervalId = null;
  }
  
  try {
    // Use a more precise timer implementation instead of chrome.alarms
    // The 100ms precision helps prevent timer drift and ensures more reliable updates
    customTimerIntervalId = setInterval(() => {
      try {
        timerCounter += TIMER_PRECISION_MS;
        
        // Execute the main timer logic every second
        if (timerCounter >= 1000) {
          // Log timer execution with timestamp for diagnostics
          const now = Date.now();
          if (!self.lastTimerExecution) {
            self.lastTimerExecution = now;
          } else {
            const timeDiff = now - self.lastTimerExecution;
            if (timeDiff > 1200) {
              console.warn(`FocusFinder: Timer interval delay detected: ${timeDiff}ms between executions`);
            }
            self.lastTimerExecution = now;
          }
          
          timerCounter = 0;
          
          // Execute timer handler in try/catch to ensure one error doesn't break the timer
          try {
            mainTimerAlarmHandler({ name: MAIN_TIMER_ALARM_NAME });
          } catch (handlerError) {
            console.error("FocusFinder: Error in timer handler:", handlerError);
          }
        }
      } catch (e) {
        console.error("FocusFinder: Error in timer interval callback:", e);
      }
    }, TIMER_PRECISION_MS);
    
    console.log("FocusFinder: Created high-precision timer with interval:", TIMER_PRECISION_MS, "ms");
  } catch (e) {
    console.error("FocusFinder: Failed to create custom timer, falling back to Chrome alarms:", e);
    // Fall back to Chrome's alarm API if setInterval fails
    chrome.alarms.create(MAIN_TIMER_ALARM_NAME, {
      periodInMinutes: 1 / 60 // Run every second
    });
  }
}

function mainTimerAlarmHandler(alarm) {
  if (alarm.name !== MAIN_TIMER_ALARM_NAME) return;
  if (!settings.isExtensionEnabled) return; // Check if extension is globally enabled

  if (activeDomain && domainStates[activeDomain]) {
    const state = domainStates[activeDomain];

    if (state.isTracking && !state.isPaused) {
      state.timeSpent++;
      
      // Save state every 10 seconds to reduce storage writes
      if (state.timeSpent % 10 === 0) {
        updateAndSaveDomainState(activeDomain);
      }

      const isTimeUp = state.timeSpent >= state.reminderTime;

      // Reminder Check
      if (isTimeUp && !state.reminderShown) {
        state.reminderShown = true;
        console.log("FocusFinder: Reminder time reached for", activeDomain);
        updateAndSaveDomainState(activeDomain); // Save immediately when reminder is shown
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
  clearTimeout(focusChangeTimeoutId); // Clear any pending debounce

  focusChangeTimeoutId = setTimeout(() => {
    const previouslyFocused = isWindowFocused;
    isWindowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;

    if (isWindowFocused === previouslyFocused) {
      return;
    }

    if (isWindowFocused) {
      updatePauseStateForAllDomains('windowGainedFocus');
    } else {
      Object.keys(domainStates).forEach(domain => {
        updateDomainPauseState(domain, 'windowBlurred');
      });
    }
  }, FOCUS_DEBOUNCE_MS); // Wait 150ms before processing
}

async function handleVisibilityChange(domain, tabId, isVisible) {
  if (!domainStates[domain]) {
      return;
  }
  
  if (tabId === activeTabId && domainStates[domain]) {
     const state = domainStates[domain];
     const oldVisibility = state.lastVisibilityState;
     state.lastVisibilityState = isVisible;
     updateDomainPauseState(domain);
     
     if (oldVisibility !== isVisible) {
       await updateAndSaveDomainState(domain); 
     }
  }
}

function updatePauseStateForAllDomains(triggerReason = 'unknown') {
  Object.keys(domainStates).forEach(domain => {
    updateDomainPauseState(domain);
  });
}

function updateDomainPauseState(domain, reasonOverride = null) {
  if (!domainStates[domain]) return;

  const state = domainStates[domain];
  const wasPaused = state.isPaused;
  const oldPauseReason = state.pauseReason;
  let newPauseReason = oldPauseReason;
  let shouldBePaused = false;
  const now = Date.now();
  const hasImmunity = state.ignorePauseOnBlurUntil && now < state.ignorePauseOnBlurUntil;


  // --- Determine Pause Reason ---
  if (!settings.isExtensionEnabled) {
    shouldBePaused = true;
    newPauseReason = 'extensionDisabled';
  } else if (reasonOverride === 'userPaused') {
    shouldBePaused = true;
    newPauseReason = 'userPaused';
  } else if (oldPauseReason === 'userPaused' && reasonOverride !== '') {
     shouldBePaused = true;
     newPauseReason = 'userPaused';
  } else if (reasonOverride && reasonOverride !== 'windowBlurred' && reasonOverride !== 'blurGracePeriod') {
    shouldBePaused = (reasonOverride !== '');
    newPauseReason = reasonOverride;
  } else {
    if (domain !== activeDomain) {
      shouldBePaused = true;
      newPauseReason = 'tabSwitched';
    } else if (settings.pauseOnBlur && (!isWindowFocused || reasonOverride === 'windowBlurred' || reasonOverride === 'blurGracePeriod')) {
      if (hasImmunity) {
        shouldBePaused = false;
        newPauseReason = '';
      } else {
        shouldBePaused = true;
        if (oldPauseReason !== 'windowBlurred' && oldPauseReason !== 'blurGracePeriod') {
          newPauseReason = 'blurGracePeriod';
          clearTimeout(state.blurTimeoutId);
          state.blurTimeoutId = setTimeout(() => {
            if (!isWindowFocused && domain === activeDomain && domainStates[domain]?.pauseReason === 'blurGracePeriod') {
               updateDomainPauseState(domain, 'windowBlurred');
               updateAndSaveDomainState(domain).catch(error => {
                 console.error("FocusFinder: Error saving domain state after grace period:", error);
               });
            }
          }, BLUR_GRACE_PERIOD_MS);
        } else if (reasonOverride === 'windowBlurred') {
            newPauseReason = 'windowBlurred';
        } else {
           newPauseReason = oldPauseReason;
        }
      }
    } else {
      shouldBePaused = false;
      newPauseReason = '';
      if (state.blurTimeoutId) {
         clearTimeout(state.blurTimeoutId);
         state.blurTimeoutId = null;
      }

      if (state.ignorePauseOnBlurUntil) {
         state.ignorePauseOnBlurUntil = null;
      }
    }
  }

  // --- Apply State Change ---
  if (shouldBePaused !== wasPaused || newPauseReason !== oldPauseReason) {
    state.isPaused = shouldBePaused;
    state.pauseReason = newPauseReason;
    state.lastUpdated = Date.now();

    if (!shouldBePaused && newPauseReason !== 'blurGracePeriod') {
        if (state.blurTimeoutId) {
            clearTimeout(state.blurTimeoutId);
            state.blurTimeoutId = null;
        }
    }

    if (shouldBePaused && newPauseReason !== 'blurGracePeriod') {
      broadcastToDomainTabs(domain, { action: "timerPaused", reason: newPauseReason });
    } else if (!shouldBePaused) {
      broadcastToDomainTabs(domain, { action: "timerResumed" });
    }

  }

  return shouldBePaused !== wasPaused || newPauseReason !== oldPauseReason;
}

// --- Tab Management ---
async function tabUpdatedHandler(tabId, changeInfo, tab) {
    // Skip invalid tab IDs immediately
    if (!validateTabId(tabId)) {
        console.warn(`FocusFinder: Received update event for invalid tabId: ${tabId}, skipping`);
        return;
    }
    
    // Check primarily for URL changes on complete load or explicit URL change info
    if (tab.url && (changeInfo.status === 'complete' || changeInfo.url)) {
        const domain = extractDomain(tab.url);
        console.log("FocusFinder: Tab updated:", tabId, "Domain:", domain, "Status:", changeInfo.status, "URL changed:", !!changeInfo.url);

        if (domain) {
            // Update tab list for the domain
            if (domainStates[domain]) {
                domainStates[domain].tabIds.add(tabId);
                // Save domain state when adding a tab
                await updateAndSaveDomainState(domain);
            } else {
                // If domain state doesn't exist yet, might be created by checkDomainStatus
            }

            // If this tab becomes active due to update/navigation
            if (tab.active) {
                if (activeDomain !== domain) {
                    // Pause previously active domain if different
                    if (activeDomain && domainStates[activeDomain]) {
                         updateDomainPauseState(activeDomain, 'tabSwitched');
                         // Save state of previously active domain
                         await updateAndSaveDomainState(activeDomain);
                    }
                    activeDomain = domain;
                }
                activeTabId = tabId;
                console.log("FocusFinder: Active tab updated to", tabId, "(", domain, ")");
                 // Ensure pause state is correct for the *new* active domain
                if (domainStates[domain]) {
                    updateDomainPauseState(domain);
                    // Save state of new active domain
                    await updateAndSaveDomainState(domain);
                }
            }

            await checkDomainStatus(tabId, tab.url);

        } else {
             // Navigated away from a potentially tracked domain to an untracked URL (e.g., chrome://)
             if (tab.active) {
                 // If the previously active domain was tracked, pause it
                 if(activeDomain && domainStates[activeDomain]) {
                     updateDomainPauseState(activeDomain, 'tabSwitched');
                     // Save state of previously active domain
                     await updateAndSaveDomainState(activeDomain);
                 }
                 activeDomain = null;
                 activeTabId = tabId;
             }
        }
        
        // Clean up tabIds for domains that might have lost this tab
        // This needed when a tab navigates from one tracked domain to another
        let domainsChanged = false;
        Object.keys(domainStates).forEach(d => {
            if(d !== domain && domainStates[d].tabIds.has(tabId)) {
                domainStates[d].tabIds.delete(tabId);
                domainsChanged = true;
                 if (domainStates[d].tabIds.size === 0) {
                    console.log("FocusFinder: Deleting state for", d, "- no tabs left after update.");
                    delete domainStates[d];
                 }
            }
        });
         
        // Save domain states if any changes occurred
        if (domainsChanged) {
            await saveDomainStates();
        }
    }
}

async function tabActivatedHandler(activeInfo) {
  const { tabId } = activeInfo;
  
  // Validate tab ID first
  if (!validateTabId(tabId)) {
    console.warn(`FocusFinder: Received activation event for invalid tabId: ${tabId}, skipping`);
    return;
  }
  
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
        // Save state of previously active domain
        await updateAndSaveDomainState(activeDomain);
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
              // Save state of new active domain
              await updateAndSaveDomainState(newDomain);
          }
      } else {
         // Active tab is not a trackable domain (e.g., chrome://)
      }
    } else if (tab) {
         // Tab exists but has no URL or cannot be accessed (e.g., protected pages)
         console.log("FocusFinder: Activated tab", tabId, "has no URL or is inaccessible.");
         if (activeDomain && domainStates[activeDomain]) {
             updateDomainPauseState(activeDomain, 'tabSwitched');
             // Save state
             await updateAndSaveDomainState(activeDomain);
         }
         activeDomain = null;
         activeTabId = tabId;
    }
  } catch (error) {
    console.error("FocusFinder: Error getting tab info for tab:", tabId, error);
     if (activeDomain && domainStates[activeDomain]) {
         updateDomainPauseState(activeDomain, 'tabSwitched');
         // Save state
         await updateAndSaveDomainState(activeDomain);
     }
     activeDomain = null;
     activeTabId = tabId; // Still update activeTabId even on error
  }
}

function tabRemovedHandler(tabId, removeInfo) {
  // Validate tab ID first
  if (!validateTabId(tabId)) {
    console.warn(`FocusFinder: Received removal event for invalid tabId: ${tabId}, skipping`);
    return;
  }
  
  console.log("FocusFinder: Tab removed:", tabId);
  let domainNeedingUpdate = null;
  let domainsChanged = new Set();
  
  Object.keys(domainStates).forEach(domain => {
    if (domainStates[domain].tabIds.has(tabId)) {
      domainStates[domain].tabIds.delete(tabId);
      console.log("FocusFinder: Removed tab", tabId, "from", domain, ". Remaining tabs:", domainStates[domain].tabIds.size);
      
      // Add to list of changed domains
      domainsChanged.add(domain);
      
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

  // Save changes to all affected domains
  if (domainsChanged.size > 0) {
    // Use setTimeout to avoid blocking the handler
    setTimeout(async () => {
      try {
        await saveDomainStates();
      } catch (error) {
        console.error("FocusFinder: Error saving domain states after tab removal:", error);
      }
    }, 0);
  }

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
    // Check if this domain has a "sessionEnded" status, which means the user explicitly ended
    // the session and we should always start fresh
    const wasSessionEnded = domainStates[domain] && domainStates[domain].pauseReason === 'sessionEnded';
    
    // Check if domain state exists but has no active tabs (indicating it was previously closed)
    const domainHadNoTabs = domainStates[domain] && domainStates[domain].tabIds.size === 0;
    
    // Check if this domain was recovered from a previous session
    const isRecoveredDomain = domainStates[domain] && domainStates[domain].pauseReason === 'sessionRecovery';
    
    // If session was ended or domain has no tabs, start fresh
    if (!domainStates[domain] || domainHadNoTabs || wasSessionEnded) {
        // First time seeing this watched domain in this session
        // OR domain exists but all tabs were closed previously
        // OR user explicitly ended the session
        if (settings.isExtensionEnabled) {
            console.log("FocusFinder: New or reopened watched domain. Requesting intention for tab.");
            await requestIntention(domain, tabId);
            
            // Initialize state (or reset it if all tabs were closed before)
            // Preserve only the widget position if it exists
            const widgetPosition = (domainStates[domain] && !wasSessionEnded) 
                ? domainStates[domain].widgetPosition || 'bottom-right' 
                : 'bottom-right';
                
            domainStates[domain] = {
                intention: "",  // Always reset intention
                intentionSet: false, // Force user to set intention again
                timeSpent: 0, // Reset timer when reopening domain
                reminderTime: 300, // Default 5 min
                isTracking: false,
                isPaused: true,
                pauseReason: 'noIntention',
                reminderShown: false,
                blurTimeoutId: null,
                tabIds: new Set(), // Start fresh with just this tab
                widgetExpanded: false,
                lastVisibilityState: true,
                initialGracePeriodId: null,
                ignorePauseOnBlurUntil: null,
                widgetPosition: widgetPosition, // Preserve position preference
                hasExtended: false,
                lastUpdated: Date.now()
            };
            
            // Validate tabId before adding it to the set
            if (validateTabId(tabId)) {
                domainStates[domain].tabIds.add(tabId);
            }
            
            // Save new domain state immediately
            await updateAndSaveDomainState(domain);
        } else {
            console.log("FocusFinder: Extension disabled, not prompting.");
        }
    } else if (isRecoveredDomain) {
        // This is a domain recovered from storage but we need to verify intention
        console.log("FocusFinder: Recovered domain from previous session. Requesting intention confirmation.");
        
        // Validate tabId before adding it to the set
        if (validateTabId(tabId)) {
            domainStates[domain].tabIds.add(tabId); // Add this tab to the domain
        }
        
        // Request intention for recovered domain
        await requestIntention(domain, tabId);
        
        // Update the state to show we're waiting for intention
        domainStates[domain].isPaused = true;
        domainStates[domain].pauseReason = 'noIntention';
        domainStates[domain].intentionSet = false;
        
        // Save updated domain state
        await updateAndSaveDomainState(domain);
    } else {
        // Domain state exists and is active
        // Validate tabId before adding it to the set
        if (validateTabId(tabId)) {
            domainStates[domain].tabIds.add(tabId); // Ensure tab is tracked
        }

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
                    
                    // Save updated domain state
                    await updateAndSaveDomainState(domain);
                } else {
                    updateDomainPauseState(domain);
                    // Save updated domain state
                    await updateAndSaveDomainState(domain);
                }
            }
        } else if (!domainStates[domain].intentionSet && settings.isExtensionEnabled && tabId === activeTabId) {
            // State exists, but no intention set, and this is the active tab - prompt again
            console.log("FocusFinder: Domain state exists but no intention. Prompting active tab.");
            await requestIntention(domain, tabId);
            // Ensure it's paused until intention is set
            domainStates[domain].isPaused = true;
            domainStates[domain].pauseReason = 'noIntention';
            
            // Save updated domain state
            await updateAndSaveDomainState(domain);
        }
    }
  } else {
      // Domain is not watched
      if (domainStates[domain]) {
          console.log("FocusFinder: Domain is no longer watched (or never was). Ensuring state is removed/paused.");
          updateDomainPauseState(domain, 'notWatched');
          // Save updated domain state
          await updateAndSaveDomainState(domain);
      }
  }
}

// --- Communication & Handlers ---
function messageHandler(message, sender, sendResponse) {
  console.log("FocusFinder: Received message:", message, "From:", sender.tab ? "Tab" : "Popup/Other");
  const domain = message.domain || activeDomain;

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
          await handleToggleExtension(message.enable);
          sendResponse({ success: true, isEnabled: settings.isExtensionEnabled });
          break;
        case "intentionSet":
          if (!domain) { throw new Error("Domain missing"); }
          await handleIntentionSet(domain, message.intention, message.duration, message.tabId);
          sendResponse({ success: true });
          break;
        case "pauseTimer":
          if (!domain) { throw new Error("Domain missing"); }
          if (domainStates[domain] && domainStates[domain].ignorePauseOnBlurUntil) {
            console.log("FocusFinder: Clearing pauseOnBlur immunity due to manual pause:", domain);
            domainStates[domain].ignorePauseOnBlurUntil = null;
          }
          updateDomainPauseState(domain, 'userPaused');
          await updateAndSaveDomainState(domain);
          sendResponse({ success: true });
          break;
        case "resumeTimer":
          if (!domain) { throw new Error("Domain missing"); }
          if (domainStates[domain]) {
            const immunityDuration = 1500;
            domainStates[domain].ignorePauseOnBlurUntil = Date.now() + immunityDuration; 
            console.log(`FocusFinder: Granting ${immunityDuration}ms pauseOnBlur immunity for manual resume:`, domain);
          }
          updateDomainPauseState(domain, '');
          await updateAndSaveDomainState(domain);
          sendResponse({ success: true });
          break;
        case "extendTime":
        case "forceExtendTime":
          if (!domain) { throw new Error("Domain missing"); }
          await handleExtendTime(domain, message.minutes, message.action === "forceExtendTime");
          sendResponse({ success: true });
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
           if (!domain || !sender.tab) { throw new Error("Domain or sender tab missing for visibility change"); }
           await handleVisibilityChange(domain, sender.tab.id, message.isVisible);
           sendResponse({ success: true });
           break;
        case "saveWidgetState":
           if (!domain) { throw new Error("Domain missing"); }
           if (domainStates[domain]) {
            domainStates[domain].widgetExpanded = message.expanded;
            await updateAndSaveDomainState(domain);
           }
           sendResponse({ success: true });
           break;
        case "saveWidgetPosition":
           if (!domain) { throw new Error("Domain missing"); }
           if (domainStates[domain]) {
              domainStates[domain].widgetPosition = message.position;
              console.log("FocusFinder: Saved widget position for", domain, ":", message.position);
              await updateAndSaveDomainState(domain);
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
    return;
  }

  // First, ensure there are no invalid tab IDs in the set
  let validTabsCount = 0;
  const invalidTabIds = [];
  
  // Identify any invalid tabIds first before we iterate
  for (const tabId of domainStates[domain].tabIds) {
    if (!validateTabId(tabId)) {
      invalidTabIds.push(tabId);
    } else {
      validTabsCount++;
    }
  }
  
  // Clean up any invalid tabIds
  if (invalidTabIds.length > 0) {
    console.log(`FocusFinder: Removing ${invalidTabIds.length} invalid tabIds from domain ${domain}`);
    for (const invalidId of invalidTabIds) {
      domainStates[domain].tabIds.delete(invalidId);
    }
    
    // If we removed all tabs, might need to delete the domain state
    if (domainStates[domain].tabIds.size === 0) {
      console.log(`FocusFinder: No valid tabs left for ${domain} after cleanup. Deleting state.`);
      delete domainStates[domain];
      return; // Exit since we deleted the domain state
    }
  }

  console.log("FocusFinder: Broadcasting to", validTabsCount, "tabs for:", message);
  const promises = [];
  
  for (const tabId of domainStates[domain].tabIds) {
    // No need to check again, we just cleaned the set
    promises.push(
      sendMessageToTab(tabId, message).catch(error => {
        // Log the error regardless of type
        console.warn(`FocusFinder: Failed to send message to tab ${tabId} (domain: ${domain}). Error: ${error.message}`);
        
        // Attempt to remove the problematic tabId from the state on *any* send error
        // This handles cases like 'No tab with id', 'Receiving end does not exist', or sending to 'undefined'
        if (domainStates[domain] && domainStates[domain].tabIds) {
            const deleted = domainStates[domain].tabIds.delete(tabId);
            if (deleted) {
               console.log(`FocusFinder: Removed problematic tabId ${tabId} from domain ${domain} due to send error.`);
               // Check if this was the last tab
               if (domainStates[domain].tabIds.size === 0) {
                  console.log(`FocusFinder: Deleting state for ${domain} - no tabs left after broadcast failure.`);
                  delete domainStates[domain];
               }
            }
        } else {
            // Domain state might have been deleted already, which is fine.
        }
      })
    );
  }
  await Promise.all(promises);
}

async function sendMessageToTab(tabId, message) {
   try {
       return await chrome.tabs.sendMessage(tabId, message);
   } catch (error) {
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
            console.warn("FocusFinder: Ping response invalid from tab. Injecting script.");
           await injectContentScript(tabId);
           setTimeout(callback, 150); // Give script time to load
       }
   } catch (error) {
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
       widgetPosition: 'bottom-right', // Add default position here too
       hasExtended: false,
       lastUpdated: Date.now()
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
  
  // Validate tabId before adding it to the set
  if (validateTabId(tabId)) {
    state.tabIds.add(tabId); // Ensure current tab is tracked
  } else {
    console.warn(`FocusFinder: Tried to add invalid tabId: ${tabId} for domain: ${domain}`);
  }

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
  
  // Save the updated state immediately
  await updateAndSaveDomainState(domain);
  
  // Broadcast the intention confirmation immediately
  broadcastToDomainTabs(domain, {
    action: "intentionConfirmed",
    intention: state.intention,
    reminderTime: state.reminderTime
  });
  
  // Reset timer state to ensure clean tracking
  resetTimerState();
  
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
  state.lastUpdated = Date.now();

  console.log(`FocusFinder: Time extended for ${domain} by ${minutes}m. New limit: ${state.reminderTime}s`);

  // Save the state immediately after extension
  await updateAndSaveDomainState(domain);

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

// --- Modify the handler for end browsing ---
async function handleCloseTabsRequest(domain) {
  if (!domainStates[domain] || !domainStates[domain].tabIds) return;
  
  console.log("FocusFinder: End browsing session for", domain);
  const tabIdsToClose = Array.from(domainStates[domain].tabIds);
  console.log("FocusFinder: Tab IDs to close:", tabIdsToClose);
  
  // First, reset the domain state to ensure it doesn't carry over
  // if the user reopens the site immediately
  if (domainStates[domain]) {
    // Fully reset domain state but save widget position preference
    const widgetPosition = domainStates[domain].widgetPosition || 'bottom-right';
    
    // Create a fresh clean state
    domainStates[domain] = {
      intention: "",
      intentionSet: false,
      timeSpent: 0,
      reminderTime: 300,
      isTracking: false,
      isPaused: true,
      pauseReason: 'sessionEnded',
      reminderShown: false,
      blurTimeoutId: null,
      tabIds: new Set(), // Empty set as we're closing the tabs
      widgetExpanded: false,
      lastVisibilityState: true,
      initialGracePeriodId: null,
      ignorePauseOnBlurUntil: null,
      widgetPosition: widgetPosition, // Preserve position preference
      hasExtended: false,
      lastUpdated: Date.now()
    };
    
    // Save the reset state
    await updateAndSaveDomainState(domain);
  }
  
  // Now close the tabs
  try {
    for (const tabId of tabIdsToClose) {
      await chrome.tabs.remove(tabId);
      console.log("FocusFinder: Closed tab", tabId);
    }
  } catch (error) {
    console.warn("FocusFinder: Failed to close tabs:", error.message);
  }

  // After closing tabs, delete the domain state completely
  // This ensures a fresh start if the user reopens the site
  delete domainStates[domain];
  
  // Also update storage to remove this domain
  const result = await chrome.storage.local.get('domainStates');
  if (result.domainStates && result.domainStates[domain]) {
    const updatedStates = result.domainStates;
    delete updatedStates[domain];
    await chrome.storage.local.set({ domainStates: updatedStates });
    console.log("FocusFinder: Removed domain state from storage for", domain);
  }
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
    const oldSettingsData = changes.settings.oldValue || defaultSettings;
    if (!newSettingsData) return; // Should not happen, but check

    // Store original values for comparison
    const oldPauseOnBlur = oldSettingsData.pauseOnBlur;
    const oldIsEnabled = oldSettingsData.isExtensionEnabled;

    // Update the in-memory settings
    settings = { ...defaultSettings, ...newSettingsData };

    // Re-evaluate pause state if relevant settings changed
    if (oldPauseOnBlur !== settings.pauseOnBlur || oldIsEnabled !== settings.isExtensionEnabled) {
      updatePauseStateForAllDomains();
    }
  }
}

async function handleTimer() {
  // This function is now superseded by the custom timer implementation
  // and is kept for compatibility only
  console.log("FocusFinder: handleTimer called, but using custom timer implementation instead");
  return;
  
  // Old implementation below (not executed)
  /*
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
  */
}

/**
 * Check the current active tab and update state accordingly
 */
async function checkCurrentActiveTab() {
  try {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    if (tabs.length > 0) {
      const activeTab = tabs[0];
      console.log(`FocusFinder: Initial active tab is ${activeTab.id}`);
      
      activeTabId = activeTab.id;
      
      if (activeTab.url) {
        const domain = extractDomain(activeTab.url);
        activeDomain = domain;
        
        if (domain) {
          await checkDomainStatus(activeTab.id, activeTab.url);
        }
      }
    }
  } catch (error) {
    console.error("FocusFinder: Error checking current active tab:", error);
  }
}

// --- Timer Management ---
// Add this after createMainTimerAlarm function
function resetTimerState() {
  console.log("FocusFinder: Resetting timer state");
  
  // Stop existing timer if any
  if (customTimerIntervalId !== null) {
    clearInterval(customTimerIntervalId);
    customTimerIntervalId = null;
  }
  
  // Reset counter
  timerCounter = 0;
  self.lastTimerExecution = null;
  self.timerFallbackCounter = 0;
  
  // Restart timer with clean state
  createMainTimerAlarm();
  
  // Set up fallback alarm in case the custom timer fails
  // This ensures we have a backup mechanism for timer updates
  chrome.alarms.create('timerFallback', { periodInMinutes: 1 });
}

// Add a listener for the fallback alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'timerFallback') {
    // Check if our custom timer is working properly
    const now = Date.now();
    if (self.lastTimerExecution && (now - self.lastTimerExecution > 3000)) {
      // If more than 3 seconds since last timer execution, our custom timer might be failing
      console.warn("FocusFinder: Custom timer appears to be delayed, using fallback");
      self.timerFallbackCounter = (self.timerFallbackCounter || 0) + 1;
      
      // Execute the timer handler directly
      mainTimerAlarmHandler({ name: MAIN_TIMER_ALARM_NAME });
      
      // If fallback is consistently needed, restart the timer system
      if (self.timerFallbackCounter > 3) {
        console.warn("FocusFinder: Multiple timer failures detected, resetting timer system");
        resetTimerState();
      }
    } else {
      // Custom timer is working fine, reset the fallback counter
      self.timerFallbackCounter = 0;
    }
  }
});

// Add this after extractDomain function, around line ~1415
function validateTabId(tabId) {
  return tabId !== undefined && tabId !== null && Number.isInteger(tabId) && tabId > 0;
}

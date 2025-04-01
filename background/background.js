async function injectContentScriptForDomain(domain) {
  const pattern = `*://*.${domain}/*`;
  try {
    // Check if we have permission for this domain
    const hasPermission = await chrome.permissions.contains({
      origins: [pattern]
    });
    
    if (!hasPermission) {
      console.warn(`No permission for domain: ${domain}`);
      return;
    }

    // Get all matching tabs for this domain
    const tabs = await chrome.tabs.query({url: pattern});
    
    for (const tab of tabs) {
      try {
        // Check if content script is already injected
        const [isInjected] = await chrome.tabs.executeScript(tab.id, {
          code: 'typeof focusFinderInjected !== "undefined"'
        });
        
        if (!isInjected) {
          // Inject content script
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content.js']
          });
          
          // Inject content styles
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content/content.css']
          });
          
          console.log(`Content script injected for tab ${tab.id} (${domain})`);
        }
      } catch (error) {
        console.error(`Error injecting content script for tab ${tab.id}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error handling domain ${domain}:`, error);
  }
}

// Update initializeExtension to handle permissions
async function initializeExtension() {
  console.log('Initializing extension...');
  
  // Load settings first
  await loadSettings();
  
  // Setup listeners
  setupListeners();
  
  // Create main timer alarm
  chrome.alarms.create('mainTimer', { periodInMinutes: 1 });
  
  // Inject content scripts for all domains in watchlist
  for (const domain of settings.watchlist) {
    await injectContentScriptForDomain(domain);
  }
  
  console.log('Extension initialized');
}

// Update onStorageChange to handle new domains
async function onStorageChange(changes, namespace) {
  if (namespace === 'local' && changes.settings) {
    const newSettings = changes.settings.newValue;
    const oldSettings = changes.settings.oldValue || {};
    
    // Handle watchlist changes
    const newWatchlist = new Set(newSettings.watchlist);
    const oldWatchlist = new Set(oldSettings.watchlist || []);
    
    // Find new domains
    for (const domain of newWatchlist) {
      if (!oldWatchlist.has(domain)) {
        await injectContentScriptForDomain(domain);
      }
    }
    
    // Update settings
    settings = newSettings;
  }
}

// Add message listener for content script injection
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "injectContentScript" && message.domain) {
    injectContentScriptForDomain(message.domain);
  }
  // ... existing message handling code ...
}); 
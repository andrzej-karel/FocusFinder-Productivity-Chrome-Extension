﻿document.addEventListener('DOMContentLoaded', () => {
  // Use the browser API consistently throughout the code
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // --- State ---
  let settings = {}; // To be loaded

  // --- Elements ---
  const tabButtons = document.querySelectorAll('.ff-tab-button');
  const tabContents = document.querySelectorAll('.ff-tab-content');
  const websitesListEl = document.getElementById('ff-websites-list');
  const reasonsListEl = document.getElementById('ff-reasons-list');
  const defaultReasonsListEl = document.getElementById('ff-default-reasons-list');
  const addWebsiteBtn = document.getElementById('ff-add-website-btn');
  const addReasonBtn = document.getElementById('ff-add-reason-btn');
  const pauseOnBlurToggle = document.getElementById('ff-pause-on-blur');
  const toggleExtensionBtn = document.getElementById('ff-toggle-extension');
  const extensionStatusIndicator = document.querySelector('.ff-extension-status-indicator');

  // --- Initialization ---
  function initPopup() {
    setupEventListeners();
    loadInitialData();
  }

  function setupEventListeners() {
    // Tab switching
    tabButtons.forEach(button => {
      button.addEventListener('click', handleTabClick);
    });

    // Add buttons
    addWebsiteBtn.addEventListener('click', () => showModal('add-website'));
    addReasonBtn.addEventListener('click', () => showModal('add-reason'));

    // Settings toggles
    pauseOnBlurToggle.addEventListener('change', handleSettingToggle);

     // Global enable/disable
     toggleExtensionBtn.addEventListener('click', handleGlobalEnableToggle);
  }

  async function loadInitialData() {
    try {
      settings = await browserAPI.runtime.sendMessage({ action: "getSettings" }).catch(err => {
        console.error("Error in sendMessage:", err);
        return {};
      });
      
      if (!settings) { // Handle case where background script might not be ready
        console.error("FocusFinder Popup: Failed to load settings.");
        settings = {}; // Use empty settings to avoid errors
        document.body.innerHTML = `<div style="padding: 20px; color: var(--accent-pink);">Error loading extension data. Please try reloading.</div>`;
        return;
      }
       // Ensure nested arrays exist
       settings.watchlist = settings.watchlist || [];
       settings.defaultReasons = settings.defaultReasons || [];
       settings.userReasons = settings.userReasons || [];

      console.log("FocusFinder Popup: Settings loaded", settings);
      renderAllLists();
      updateSettingsUI();
      updateExtensionStatusUI(settings.isExtensionEnabled !== false); // Default to true if undefined
    } catch (error) {
      console.error("FocusFinder Popup: Error loading initial data:", error);
      document.body.innerHTML = `<div style="padding: 20px; color: var(--accent-pink);">Error loading extension data. Please try reloading.</div>`;
    }
  }

  // --- Rendering ---
  function renderAllLists() {
    renderWebsiteList();
    renderReasonList();
  }

  function renderWebsiteList() {
    websitesListEl.innerHTML = ''; // Clear list
    if (!settings.watchlist || settings.watchlist.length === 0) {
        websitesListEl.innerHTML = `<div class="ff-list-placeholder">No websites added yet.</div>`;
        return;
    }

    settings.watchlist.forEach((domain) => {
      const item = createListItem(domain, 'website', false); // isDefault = false for websites
      websitesListEl.appendChild(item);
    });
  }

  function renderReasonList() {
    reasonsListEl.innerHTML = ''; // Clear list
    
    // Combine both user reasons and default reasons in a single list
    const allReasons = [...settings.userReasons, ...settings.defaultReasons];
    
    if (allReasons.length === 0) {
      reasonsListEl.innerHTML = `<div class="ff-list-placeholder">No reasons added yet.</div>`;
      return;
    }
    
    allReasons.forEach((reason) => {
      const item = createListItem(reason, 'reason', false); // Treat all as non-default
      reasonsListEl.appendChild(item);
    });
  }

  function createListItem(text, type, isDefault = false) {
    const item = document.createElement('div');
    item.className = 'ff-list-item';
    item.dataset.value = text;
    item.dataset.type = type;

    const textSpan = document.createElement('span');
    textSpan.className = 'ff-item-text';
    textSpan.textContent = text;
    item.appendChild(textSpan);

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'ff-item-controls';

    // Edit button for all items
    const editBtn = document.createElement('button');
    editBtn.className = 'ff-item-button ff-edit-button';
    editBtn.title = 'Edit';
    editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Call the correct modal type based on item type
      showModal(`edit-${type}`, { value: text });
    });
    controlsDiv.appendChild(editBtn);

    // Delete button for all items
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ff-item-button ff-delete-button';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteClick(type, text);
    });
    controlsDiv.appendChild(deleteBtn);

    item.appendChild(controlsDiv);
    return item;
  }


  function updateSettingsUI() {
    // Update toggle states based on settings
    pauseOnBlurToggle.checked = settings.pauseOnBlur || false;
  }

 function updateExtensionStatusUI(isEnabled) {
    const iconOn = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;
    const iconOff = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`; // Same icon, color changes

    toggleExtensionBtn.innerHTML = isEnabled ? iconOn : iconOff;
    toggleExtensionBtn.classList.toggle('enabled', isEnabled);
    toggleExtensionBtn.title = isEnabled ? 'Disable Extension' : 'Enable Extension';

     if(extensionStatusIndicator) {
        extensionStatusIndicator.style.backgroundColor = isEnabled ? 'var(--accent-green)' : 'var(--accent-pink)';
         extensionStatusIndicator.title = isEnabled ? 'Extension Enabled' : 'Extension Disabled';
     }

     // Disable/Enable UI elements based on status
     const mainContent = document.querySelector('.ff-popup-main');
     const nav = document.querySelector('.ff-popup-nav');
     if (mainContent) mainContent.style.opacity = isEnabled ? '1' : '0.5';
     if (nav) nav.style.opacity = isEnabled ? '1' : '0.5';
     // Disable buttons/toggles if needed
      document.querySelectorAll('.ff-tab-content button, .ff-tab-content input, .ff-tab-content label.ff-switch')
          .forEach(el => {
              if (el.id !== 'ff-toggle-extension') { // Don't disable the main toggle itself
                  if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') {
                      el.disabled = !isEnabled;
                  }
                  el.style.pointerEvents = isEnabled ? 'auto' : 'none';
              }
          });
  }


  // --- Event Handlers ---
  function handleTabClick(event) {
    const clickedTab = event.currentTarget;
    const targetTabId = clickedTab.dataset.tab;

    // Update button states
    tabButtons.forEach(button => {
      button.classList.toggle('active', button === clickedTab);
    });

    // Update content visibility
    tabContents.forEach(content => {
      content.classList.toggle('active', content.id === `tab-${targetTabId}`);
    });
  }

  async function handleSettingToggle(event) {
    const settingName = event.target.id.replace('ff-', '').replace(/-/g, '_'); // e.g., 'pause_on_blur'
    let keyName = settingName;
    // Map setting names to their correct keys
    const settingMap = {
      'pause_on_blur': 'pauseOnBlur'
    };
    keyName = settingMap[settingName] || settingName;
    const value = event.target.checked;

    console.log('FocusFinder Popup: Toggling', keyName, 'to', value);
    settings[keyName] = value;
    await saveSettingsAndUpdateBackground();
  }

  async function handleGlobalEnableToggle() {
    try {
      const newState = !(settings.isExtensionEnabled !== false);
      settings.isExtensionEnabled = newState;
      updateExtensionStatusUI(newState);
      // Send message to background script
      try {
        await browserAPI.runtime.sendMessage({ action: "toggleExtension", enable: newState });
        console.log("FocusFinder Popup: Extension toggled to", newState);
      } catch (err) {
        console.error("Error in sendMessage:", err);
        // Continue with UI update even if messaging fails
      }
    } catch (error) {
      console.error("FocusFinder Popup: Error toggling extension:", error);
    }
  }


  function handleDeleteClick(type, value) {
    if (!confirm('Are you sure you want to delete "' + value + '"?')) return;

    console.log('FocusFinder Popup: Deleting', value);
    if (type === 'website') {
      settings.watchlist = settings.watchlist.filter(item => item !== value);
    } else if (type === 'reason') {
      // Remove from both arrays to ensure it's deleted no matter where it was originally
      settings.userReasons = settings.userReasons.filter(item => item !== value);
      settings.defaultReasons = settings.defaultReasons.filter(item => item !== value);
    }
    saveSettingsAndUpdateBackground().then(renderAllLists);
  }

  async function handleModalConfirm(type, originalValue, newValue) {
    if (!newValue || newValue.trim() === '') return; // Basic validation

    newValue = newValue.trim();
    
    // Enforce 60 character limit
    if (newValue.length > 60) {
      newValue = newValue.substring(0, 60);
      console.log('FocusFinder Popup: Input truncated to 60 characters');
    }
    
    console.log('FocusFinder Popup: Modal Confirm - Type:', type, 'Original:', originalValue, 'New:', newValue);

    // Function to normalize domains for comparison
    function normalizeDomain(domain) {
      // Remove protocol, www, and trailing slash
      let normalized = domain.trim().toLowerCase();
      // Remove protocol
      normalized = normalized.replace(/^(https?:\/\/)?(www\.)?/i, '');
      // Remove trailing slash
      normalized = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
      return normalized;
    }

    // Function to normalize reasons for case-insensitive comparison
    function normalizeReason(reason) {
      return reason.trim().toLowerCase();
    }

    if (type === 'add-website') {
      // Check if the domain has a dot (extension)
      if (!newValue.includes('.')) {
        alert("Please enter a valid domain with an extension (e.g., yahoo.com instead of yahoo)");
        return;
      }
      
      // Normalize the new domain
      const normalizedNewValue = normalizeDomain(newValue);
      
      // Check if any existing domain normalizes to the same value
      const isDuplicate = settings.watchlist.some(domain => 
        normalizeDomain(domain) === normalizedNewValue
      );
      
      if (!isDuplicate) {
        settings.watchlist.push(newValue);
      } else { 
        alert("Website already exists in the list."); 
        return; 
      }
    } else if (type === 'edit-website') {
      // Check if the domain has a dot (extension)
      if (!newValue.includes('.')) {
        alert("Please enter a valid domain with an extension (e.g., yahoo.com instead of yahoo)");
        return;
      }
      
      const index = settings.watchlist.indexOf(originalValue);
      
      // Normalize both values for comparison
      const normalizedNewValue = normalizeDomain(newValue);
      const normalizedOriginalValue = normalizeDomain(originalValue);
      
      // Check if editing to a different domain that already exists
      const isDuplicate = settings.watchlist.some((domain, i) => 
        i !== index && normalizeDomain(domain) === normalizedNewValue
      );
      
      if (index > -1 && !isDuplicate) {
        settings.watchlist[index] = newValue;
      } else if (isDuplicate) {
        alert("Another website with this name already exists."); 
        return;
      } else if (index === -1) { 
        console.error("Original website not found for edit"); 
        return; 
      }
    } else if (type === 'add-reason') {
      // Normalize the new reason for case-insensitive comparison
      const normalizedNewValue = normalizeReason(newValue);
      
      // Check if it exists in either list (case-insensitive)
      const existsInUserReasons = settings.userReasons.some(reason => 
        normalizeReason(reason) === normalizedNewValue
      );
      
      const existsInDefaultReasons = settings.defaultReasons.some(reason => 
        normalizeReason(reason) === normalizedNewValue
      );
      
      // Check total reason count before adding
      const totalReasons = (settings.userReasons?.length || 0) + (settings.defaultReasons?.length || 0);
      if (totalReasons >= 10) {
          alert("You can have a maximum of 10 reasons.");
          return;
      }

      if (!existsInUserReasons && !existsInDefaultReasons) {
        settings.userReasons.push(newValue);
      } else {
        alert("Reason already exists in the list (case-insensitive comparison).");
        return; 
      }
    } else if (type === 'edit-reason') {
      // Check if item is in userReasons
      const userIndex = settings.userReasons.indexOf(originalValue);
      // Check if item is in defaultReasons
      const defaultIndex = settings.defaultReasons.indexOf(originalValue);
      
      // Normalize for case-insensitive comparison
      const normalizedNewValue = normalizeReason(newValue);
      
      // Check if new value already exists anywhere (case-insensitive)
      const newValueExists = settings.userReasons.some(reason => 
        normalizeReason(reason) === normalizedNewValue
      ) || settings.defaultReasons.some(reason => 
        normalizeReason(reason) === normalizedNewValue
      );
      
      // If editing to same text (case might differ), don't treat as duplicate
      const isEditingSameValue = normalizeReason(originalValue) === normalizedNewValue;
      
      if (userIndex > -1 && (!newValueExists || isEditingSameValue)) {
        // Edit in userReasons
        settings.userReasons[userIndex] = newValue;
      } else if (defaultIndex > -1 && (!newValueExists || isEditingSameValue)) {
        // Move from defaultReasons to userReasons (can't edit default directly)
        settings.defaultReasons.splice(defaultIndex, 1);
        settings.userReasons.push(newValue);
      } else if (newValueExists && !isEditingSameValue) {
        alert("Another reason with this name already exists (case-insensitive comparison)."); 
        return;
      } else if (userIndex === -1 && defaultIndex === -1) { 
        console.error("Original reason not found for edit"); 
        return; 
      }
    }

    await saveSettingsAndUpdateBackground();
    renderAllLists();
    closeModal(); // Close modal after successful operation
  }


  // --- Modal Logic ---
 function showModal(type, data = null) {
    const template = document.getElementById('ff-modal-template');
    if (!template) {
      console.error("Modal template not found!");
      return;
    }

    // First check if a modal is already open and remove it
    closeModal();

    // Clone the template content
    const clone = document.importNode(template.content, true);
    const modalOverlay = clone.querySelector('.ff-modal-overlay');
    const modalContent = modalOverlay.querySelector('.ff-modal-content');
    const titleEl = modalOverlay.querySelector('.ff-modal-title');
    const bodyEl = modalOverlay.querySelector('.ff-modal-body');
    const cancelBtn = modalOverlay.querySelector('.ff-modal-cancel');
    const confirmBtn = modalOverlay.querySelector('.ff-modal-confirm');

    let modalInput;
    let originalValue = data?.value || '';

    // Configure based on type
    if (type === 'add-website' || type === 'edit-website') {
        titleEl.textContent = type === 'add-website' ? 'Add Website' : 'Edit Website';
        bodyEl.innerHTML = `<input type="text" id="ff-modal-input" class="ff-input" placeholder="e.g., example.com" value="${originalValue}" maxlength="60">`;
        confirmBtn.textContent = type === 'add-website' ? 'Add' : 'Update';
    } else if (type === 'add-reason' || type === 'edit-reason') {
        titleEl.textContent = type === 'add-reason' ? 'Add Reason' : 'Edit Reason';
        bodyEl.innerHTML = `<input type="text" id="ff-modal-input" class="ff-input" placeholder="e.g., Checking news" value="${originalValue}" maxlength="60">`;
         confirmBtn.textContent = type === 'add-reason' ? 'Add' : 'Update';
    } else {
        console.error("Unknown modal type:", type);
        return;
    }

     document.body.appendChild(modalOverlay);
     
     // Get reference to the input after it's added to DOM
     modalInput = document.getElementById('ff-modal-input');
     if (modalInput) {
       modalInput.focus();
       
       // Add input event listener
       modalInput.addEventListener('input', () => {
         const isEmpty = !modalInput.value.trim();
         confirmBtn.disabled = isEmpty;
         confirmBtn.style.opacity = isEmpty ? '0.6' : '1';
         confirmBtn.style.cursor = isEmpty ? 'not-allowed' : 'pointer';
       });
       
       // Initial validation check
       const isEmpty = !modalInput.value.trim();
       confirmBtn.disabled = isEmpty;
       confirmBtn.style.opacity = isEmpty ? '0.6' : '1';
       confirmBtn.style.cursor = isEmpty ? 'not-allowed' : 'pointer';
       
       // Add Enter key support
       modalInput.addEventListener('keydown', (e) => {
         if (e.key === 'Enter' && !confirmBtn.disabled) {
           handleModalConfirm(type, originalValue, modalInput.value);
         }
       });
     }


    // Event Listeners
    cancelBtn.addEventListener('click', closeModal);
    
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    
    confirmBtn.addEventListener('click', () => {
      if (modalInput) {
        handleModalConfirm(type, originalValue, modalInput.value);
      }
    });
}


  function closeModal() {
    const modal = document.querySelector('.ff-modal-overlay');
    if (modal) {
      modal.remove();
    }
  }

  // --- Communication ---
  async function saveSettingsAndUpdateBackground() {
    try {
      try {
        await browserAPI.runtime.sendMessage({ action: "updateSettings", newSettings: settings });
        console.log("FocusFinder Popup: Settings updated in background:", settings);
      } catch (err) {
        console.error("Error in sendMessage:", err);
        // Continue with local updates even if messaging fails
      }
    } catch (error) {
      console.error("FocusFinder Popup: Error updating settings:", error);
    }
  }

  // --- Run ---
  initPopup();
});

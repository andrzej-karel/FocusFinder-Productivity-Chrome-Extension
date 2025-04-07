# FocusFinder Chrome Extension

FocusFinder encourages intentional browsing by asking users to answer one simple question: "Why are you visiting this site?" This stated purpose then stays visible alongside a timer, helping users stay mindful and productive, while avoiding distractions.

## Extension Structure

The extension follows Chrome's Manifest V3 architecture for enhanced security and performance:

### Core Files
- `manifest.json`: Extension configuration and permissions
- `background.js`: Service worker for timer management and state tracking
- `contentScript.js`: Injects UI components (intention prompt, timer widget) and handles page-level interactions.
- `popup/`: Contains the HTML, CSS, and JS for the extension's popup window (settings, watched sites, reasons).
- `icons/`: Extension icons used in the browser UI and store listing.
- `css/`: Contains shared styles (`common.css`), component-specific styles, and fonts.
- `sounds/`: Audio feedback files (e.g., for timer completion).

### Required Permissions
The extension requires the following permissions for core functionality:

- `storage`: Saves user settings and browsing data locally
- `tabs`: Tracks active tabs and their states for time monitoring
- `alarms`: Powers the timer functionality for tracking browsing sessions
- `scripting`: Enables dynamic content script injection when needed
- `host_permissions` (`<all_urls>`): Required to track browsing time across different websites

### Key Features
1. **Set a Goal (Intention)**: Prompts users to define their purpose before visiting a site, promoting mindful and intentional browsing habits
2. **Timer Widget**: A non-intrusive corner widget showing time spent on sites together with your chosen goal, serving as a gentle reminder of your intended purpose
3. **Website Management**: Easy addition and management of monitored websites through an intuitive interface, allowing you to customize which sites to track
4. **Smart Auto-Pause**: Automatically pauses time tracking when switching to another window or tab, ensuring accurate time monitoring of active browsing sessions
5. **Customizable Reasons**: Define your own common reasons for visiting sites to quickly select them in the intention prompt.
6. **Extend Confirmation**: Prevents accidental excessive time extension by asking for confirmation on the second attempt to extend the timer.

### Code Documentation
- `background.js`: The core service worker. Manages timers, domain state (intention, time spent, paused status), settings persistence (using `chrome.storage.local`), and communication between tabs and the popup.
- `contentScript.js`: Runs on specified web pages. Creates the Shadow DOM elements for the intention prompt and the corner widget, injects CSS, handles user interactions within these elements, and communicates with the background script.
- `popup/popup.js`: Logic for the extension popup window. Handles displaying and managing watched websites, custom reasons, and settings (like pause-on-blur). Communicates with the background script to get/set data.

### Privacy & Security
- All data is stored locally on the user's device
- No external servers or data collection
- Uses Chrome's secure storage APIs
- Follows Manifest V3 best practices

### Lincense
FocusFinder © 2024 by Andrzej Karel is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International 
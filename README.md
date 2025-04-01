# FocusFinder Chrome Extension

FocusFinder encourages intentional browsing by asking users to answer one simple question: "Why are you visiting this site?" This stated purpose then stays visible alongside a timer, helping users stay mindful and productive, while avoiding distractions.

## Extension Structure

The extension follows Chrome's Manifest V3 architecture for enhanced security and performance:

### Core Files
- `manifest.json`: Extension configuration and permissions
- `background.js`: Service worker for timer management and state tracking
- `contentScript.js`: UI components and page-level functionality
- `popup/`: Extension popup interface
- `icons/`: Extension icons in various sizes
- `css/`: Styling and fonts
- `sounds/`: Audio feedback files

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

### Code Documentation
- `background.js`: Core service worker managing timers, state, and settings
- `contentScript.js`: Handles UI elements and user interactions
- `browserDetection.js`: Ensures cross-browser compatibility
- `browser-polyfill.js`: Standardizes browser APIs

### Privacy & Security
- All data is stored locally on the user's device
- No external servers or data collection
- Uses Chrome's secure storage APIs
- Follows Manifest V3 best practices

### Lincense
 FocusFinder © 2025 by Andrzej Karel is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International 
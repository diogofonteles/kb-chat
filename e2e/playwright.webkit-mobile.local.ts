import { devices } from '@playwright/test';
import base from './playwright.config';
// Local, not committed: the media specs in WebKit at 390 (iPhone-like), for KBC-129's check.
export default {
  ...base,
  projects: [
    {
      name: 'media-webkit-mobile',
      testMatch: /media-.*\.spec\.ts$/,
      use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
    },
  ],
};

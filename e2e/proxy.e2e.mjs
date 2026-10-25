// The E2E dev server's proxy to the E2E API (playwright.config.ts sets the port).
const target = `http://localhost:${process.env.KBC_E2E_API_PORT ?? '3117'}`;

export default {
  '/api': { target, secure: false },
  '/health': { target, secure: false },
};

import type { Page } from '@playwright/test';

/**
 * With the stub provider the app opens in "Pesquisa com IA" (KBC-008); the search-engine
 * specs start in "Buscar documentos", as a reader who chose it (remembered in kb-chat.view).
 */
export async function startInSearchView({ page }: { page: Page }) {
  await page.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
}

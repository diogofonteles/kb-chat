// Installs a global `$localize` so `i18n` markers render under the unit-test
// builder (the pt-BR source locale returns each message as written).
import '@angular/localize/init';
import { registerLocaleData } from '@angular/common';
import localePt from '@angular/common/locales/pt';

registerLocaleData(localePt, 'pt-BR');

// jsdom has no modal dialog: open/close toggle the attribute and close fires "close",
// like the browser (focus trapping itself is covered by the Playwright suite).
if (
  typeof HTMLDialogElement !== 'undefined' &&
  !HTMLDialogElement.prototype.showModal
) {
  HTMLDialogElement.prototype.showModal = function showModal(
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom does not lay out pages; scrolling is a no-op there (covered by Playwright).
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    // no layout in jsdom
  };
}

import { provideZonelessChangeDetection, viewChild } from '@angular/core';
import { Component } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { UiDialog } from './dialog.js';

@Component({
  imports: [UiDialog],
  template: `
    <ui-dialog
      #dialog
      title="Configurar o convite"
      titleId="test-dialog-title"
      [closeOnBackdrop]="closeOnBackdrop"
      (closed)="closedCount = closedCount + 1"
    >
      <label>E-mail <input name="email" /></label>
    </ui-dialog>
  `,
})
class Host {
  closeOnBackdrop = true;
  closedCount = 0;
  readonly dialog = viewChild.required(UiDialog);
}

async function renderDialog(closeOnBackdrop = true) {
  const result = await render(Host, {
    componentProperties: { closeOnBackdrop },
    providers: [provideZonelessChangeDetection()],
  });
  result.fixture.componentInstance.dialog().open();
  await result.fixture.whenStable();
  const element = document.querySelector('dialog') as HTMLDialogElement;
  return { ...result, element };
}

describe('UiDialog backdrop (KBC-132 review)', () => {
  it('closes on a press and a release on the backdrop', async () => {
    const { element } = await renderDialog();
    fireEvent.pointerDown(element);
    fireEvent.click(element);
    expect(element.open).toBe(false);
  });

  it('stays open when a text selection started in a field ends on the backdrop', async () => {
    const { element } = await renderDialog();
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'E-mail' }));
    // The release outside the box: the browser sends the click to the <dialog>.
    fireEvent.click(element);
    expect(element.open).toBe(true);
  });

  it('stays open on a backdrop click when closeOnBackdrop is off, and ✕ still closes', async () => {
    const { element } = await renderDialog(false);
    fireEvent.pointerDown(element);
    fireEvent.click(element);
    expect(element.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(element.open).toBe(false);
  });
});

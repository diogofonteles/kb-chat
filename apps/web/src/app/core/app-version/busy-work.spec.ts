import {
  EnvironmentInjector,
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  BusyWork,
  DRAFT_KEPT_ATTRIBUTE,
  EDIT_SCOPE_ATTRIBUTE,
} from './busy-work.js';

describe('BusyWork (KBC-123)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }),
  );

  it('is busy while any key is held', () => {
    const work = TestBed.inject(BusyWork);
    expect(work.busy()).toBe(false);
    work.hold('upload-1');
    work.hold('upload-2');
    work.release('upload-1');
    expect(work.busy()).toBe(true);
    work.release('upload-2');
    expect(work.busy()).toBe(false);
  });

  it('follows a busy signal until its owner is destroyed', () => {
    const work = TestBed.inject(BusyWork);
    const playing = signal(false);
    const owner = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    runInInjectionContext(owner, () => work.holdWhile(playing));
    expect(work.busy()).toBe(false);
    playing.set(true);
    expect(work.busy()).toBe(true);
    owner.destroy();
    expect(work.busy()).toBe(false);
  });

  describe('edits in forms and dialogs (any field of the app)', () => {
    let owner: EnvironmentInjector;

    beforeEach(() => {
      owner = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      runInInjectionContext(owner, () => TestBed.inject(BusyWork).watchEdits());
    });

    afterEach(() => {
      owner.destroy();
      document.body.replaceChildren();
    });

    function type(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function formWith<T extends HTMLElement>(field: T, scope = 'form'): T {
      const container = document.createElement(scope);
      container.append(field);
      document.body.append(container);
      return field;
    }

    it('QA BUG-1: a note typed in an inline editor marked data-edit-scope holds the reload until it leaves', () => {
      const work = TestBed.inject(BusyWork);
      const editor = document.createElement('div');
      editor.setAttribute(EDIT_SCOPE_ATTRIBUTE, '');
      const note = document.createElement('input');
      editor.append(note);
      document.body.append(editor);
      type(note, 'rever este trecho');
      expect(work.inProgress()).toBe(true);
      editor.remove();
      expect(work.inProgress()).toBe(false);
    });

    it('an input outside any form, dialog or edit scope never holds the reload', () => {
      const work = TestBed.inject(BusyWork);
      const search = document.createElement('input');
      document.body.append(search);
      type(search, 'ritmo');
      expect(work.inProgress()).toBe(false);
    });

    it('is in progress while a field of a form holds text, and free once it is empty again', () => {
      const work = TestBed.inject(BusyWork);
      const field = formWith(document.createElement('input'));
      type(field, 'chave sk-…');
      expect(work.inProgress()).toBe(true);
      type(field, '   ');
      expect(work.inProgress()).toBe(false);
    });

    it('lets go when the form is sent', () => {
      const work = TestBed.inject(BusyWork);
      const field = formWith(document.createElement('textarea'));
      type(field, 'nova legenda');
      field.form?.dispatchEvent(new Event('submit', { bubbles: true }));
      expect(work.inProgress()).toBe(false);
    });

    it('counts a choice changed in a dialog, and lets go when the dialog leaves the page', () => {
      const work = TestBed.inject(BusyWork);
      const select = formWith(document.createElement('select'), 'div');
      select.parentElement?.setAttribute('role', 'dialog');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.parentElement?.removeAttribute('role');
      expect(work.inProgress()).toBe(true);
      select.parentElement?.remove();
      expect(work.inProgress()).toBe(false);
    });

    it('lets go of a dialog closed with Esc that stays on the page ("Novo acervo", review R2-1)', () => {
      const work = TestBed.inject(BusyWork);
      const name = formWith(document.createElement('input'), 'dialog');
      const dialog = name.parentElement as HTMLDialogElement;
      dialog.showModal();
      type(name, 'Alquimia');
      expect(work.inProgress()).toBe(true);
      dialog.close();
      expect(dialog.isConnected).toBe(true);
      expect(work.inProgress()).toBe(false);
    });

    it('lets go of a field emptied without an input event, or inside a hidden part', () => {
      const work = TestBed.inject(BusyWork);
      const field = formWith(document.createElement('textarea'));
      type(field, 'nota');
      field.value = '';
      expect(work.inProgress()).toBe(false);
      type(field, 'nota');
      field.form?.setAttribute('hidden', '');
      expect(work.inProgress()).toBe(false);
    });

    it('counts typing in an editable text', () => {
      const work = TestBed.inject(BusyWork);
      const text = formWith(document.createElement('div'));
      text.setAttribute('contenteditable', 'true');
      text.textContent = 'trecho';
      text.dispatchEvent(new Event('input', { bubbles: true }));
      expect(work.inProgress()).toBe(true);
    });

    it('leaves out fields outside any form or dialog, and drafts that are kept', () => {
      const work = TestBed.inject(BusyWork);
      const filter = document.createElement('input');
      document.body.append(filter);
      type(filter, 'filtro');
      const question = formWith(document.createElement('textarea'));
      question.form?.setAttribute(DRAFT_KEPT_ATTRIBUTE, '');
      type(question, 'pergunta');
      expect(work.inProgress()).toBe(false);
    });

    it('is in progress while a dialog is open, and forgets edits on a new page', () => {
      const work = TestBed.inject(BusyWork);
      const dialog = document.createElement('dialog');
      document.body.append(dialog);
      expect(work.inProgress()).toBe(false);
      dialog.setAttribute('open', '');
      expect(work.inProgress()).toBe(true);
      dialog.remove();
      type(formWith(document.createElement('input')), 'x');
      work.forgetEdits();
      expect(work.inProgress()).toBe(false);
    });

    it('stops listening once its owner is destroyed', () => {
      const work = TestBed.inject(BusyWork);
      owner.destroy();
      // A fresh owner for afterEach, not watching anything.
      owner = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      type(formWith(document.createElement('input')), 'x');
      expect(work.inProgress()).toBe(false);
    });
  });

  it('writes every kept draft down before a reload, until its owner goes', () => {
    const work = TestBed.inject(BusyWork);
    const save = vi.fn();
    const owner = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    runInInjectionContext(owner, () => work.keepBeforeReload(save));
    work.saveDrafts();
    owner.destroy();
    work.saveDrafts();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';

/** A field that a person edits. */
const FIELD =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/**
 * Where an edit is kept until it is saved: a form, a dialog, or a container marked with
 * `data-edit-scope` (an inline editor without a <form>, such as a bookmark's note). Edits
 * elsewhere (a filter, the theme) apply at once.
 */
export const EDIT_SCOPE_ATTRIBUTE = 'data-edit-scope';
const SCOPE = `form, dialog, [role="dialog"], [${EDIT_SCOPE_ATTRIBUTE}]`;
/** A field whose draft survives a reload by itself (the question box keeps its text, KBC-123). */
export const DRAFT_KEPT_ATTRIBUTE = 'data-draft-kept';
/** An open dialog holds work the person has not finished. */
const OPEN_DIALOG = 'dialog[open], [role="dialog"]:not([hidden])';

/** What a field holds now; a select or a checkbox always holds a choice. */
function hasContent(field: Element): boolean {
  if (field instanceof HTMLInputElement) {
    if (field.type === 'checkbox' || field.type === 'radio') return true;
    return field.value.trim() !== '';
  }
  if (field instanceof HTMLTextAreaElement) return field.value.trim() !== '';
  if (field instanceof HTMLSelectElement) return true;
  return (field.textContent ?? '').trim() !== '';
}

/** An edited field that a reload would still lose. */
const stillEdited = (field: Element): boolean =>
  field.isConnected &&
  hasContent(field) &&
  field.closest('dialog:not([open]), [hidden]') === null;

/**
 * What a reload would lose right now (KBC-123): text typed and not sent, an upload, audio
 * playing, an answer arriving, a form or dialog with edits, an open dialog. AppVersion reads
 * it before reloading into a new version; whoever has such work registers it here. A draft
 * that can be kept instead (the question box) is saved just before the reload.
 */
@Injectable({ providedIn: 'root' })
export class BusyWork {
  private readonly document = inject(DOCUMENT);
  private readonly holds = signal<ReadonlySet<string>>(new Set());
  private readonly sources = signal<readonly Signal<boolean>[]>([]);
  private readonly edited = new Set<Element>();
  private readonly keepers = new Set<() => void>();
  private watching = false;

  /** Something registered here would be lost by a reload. */
  readonly busy = computed(
    () => this.holds().size > 0 || this.sources().some((source) => source()),
  );

  /** Marks `key` as in progress until `release(key)` (an upload, say). */
  hold(key: string): void {
    this.holds.update((keys) => new Set(keys).add(key));
  }

  release(key: string): void {
    this.holds.update((keys) => {
      const left = new Set(keys);
      left.delete(key);
      return left;
    });
  }

  /** In progress while `busy` is true, until the caller is destroyed. */
  holdWhile(
    busy: Signal<boolean>,
    destroyRef: DestroyRef = inject(DestroyRef),
  ): void {
    this.sources.update((list) => [...list, busy]);
    destroyRef.onDestroy(() =>
      this.sources.update((list) => list.filter((source) => source !== busy)),
    );
  }

  /** Saves a draft just before a reload (sessionStorage), until the caller is destroyed. */
  keepBeforeReload(
    save: () => void,
    destroyRef: DestroyRef = inject(DestroyRef),
  ): void {
    this.keepers.add(save);
    destroyRef.onDestroy(() => this.keepers.delete(save));
  }

  /** Called right before a reload: every kept draft is written down. */
  saveDrafts(): void {
    for (const save of this.keepers) save();
  }

  /** Follows edits in forms and dialogs, the same for every field of the app (once). */
  watchEdits(destroyRef: DestroyRef = inject(DestroyRef)): void {
    if (this.watching) return;
    this.watching = true;
    const onEdit = (event: Event) => this.noteEdit(event.target);
    const onSubmit = (event: Event) => this.forgetForm(event.target);
    this.document.addEventListener('input', onEdit, true);
    this.document.addEventListener('change', onEdit, true);
    this.document.addEventListener('submit', onSubmit, true);
    destroyRef.onDestroy(() => {
      this.document.removeEventListener('input', onEdit, true);
      this.document.removeEventListener('change', onEdit, true);
      this.document.removeEventListener('submit', onSubmit, true);
      this.watching = false;
    });
  }

  /** A new page: edits of the last one are gone with it. */
  forgetEdits(): void {
    this.edited.clear();
  }

  /**
   * Busy by registration, by an edited field that still matters, or by an open dialog. A
   * field stops mattering once it left the page, holds nothing, or its dialog was closed
   * or hidden (a closed <dialog> stays in the DOM: "Novo acervo" cancelled with Esc).
   */
  inProgress(): boolean {
    for (const field of this.edited)
      if (!stillEdited(field)) this.edited.delete(field);
    return (
      this.busy() ||
      this.edited.size > 0 ||
      this.document.querySelector(OPEN_DIALOG) !== null
    );
  }

  private noteEdit(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const field = target.closest(FIELD);
    if (!field?.closest(SCOPE) || field.closest(`[${DRAFT_KEPT_ATTRIBUTE}]`))
      return;
    if (hasContent(field)) this.edited.add(field);
    else this.edited.delete(field);
  }

  private forgetForm(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    for (const field of this.edited)
      if (target.contains(field)) this.edited.delete(field);
  }
}

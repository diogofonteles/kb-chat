import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { ChatView } from './view-store.js';

/**
 * "Buscar documentos | Pesquisa com IA" (KBC-008 FR-5): a native radio group styled as a
 * segmented control (MA-19), so arrow keys, Tab and screen readers work without ARIA.
 */
@Component({
  selector: 'app-view-switch',
  templateUrl: './view-switch.html',
  styleUrl: './view-switch.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewSwitch {
  readonly view = input.required<ChatView>();
  readonly researchAvailable = input(true);
  readonly changed = output<ChatView>();
}

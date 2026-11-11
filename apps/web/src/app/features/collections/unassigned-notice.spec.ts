import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Me, Topic } from '@kb-chat/contracts';
import { render, screen } from '@testing-library/angular';
import { SessionStore } from '@core/auth/session-store.js';
import { aMe, anOwner } from '../../testing/session-fixtures.js';
import { UnassignedNotice } from './unassigned-notice.js';

const topic = (slug: string, parent: string | null = null): Topic => ({
  slug,
  title: slug,
  documentCount: 1,
  trackCount: 0,
  parent,
  description: '',
  canOpen: true,
  canRename: false,
  mainAuthor: null,
});

async function open(me: Me, chosen: Topic | null) {
  const rendered = await render(UnassignedNotice, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SessionStore, useValue: { me: signal(me) } },
    ],
    inputs: { topic: chosen },
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  return { ...rendered, http };
}

const classifier = () => ({
  ...anOwner(),
  features: [...anOwner().features, 'content-levels' as const],
});

describe('The sidebar notice "N documentos sem nível" (KBC-107 FR-6)', () => {
  it('links the chosen collection (a sub-collection: its parent) to its "Sem nível"', async () => {
    const { fixture, http } = await open(
      classifier(),
      topic('hermetismo/aulas', 'hermetismo'),
    );
    http.expectOne('/api/v1/levels/unassigned').flush({
      items: [{ collection: 'hermetismo', unassigned: 40 }],
    });
    await fixture.whenStable();
    const link = screen.getByRole('link', { name: /40 documentos sem nível/ });
    expect(link.getAttribute('href')).toBe('/acervos/hermetismo/niveis');
  });

  it('AC-9: is gone at 0', async () => {
    const { fixture, http } = await open(classifier(), topic('hermetismo'));
    http.expectOne('/api/v1/levels/unassigned').flush({
      items: [{ collection: 'hermetismo', unassigned: 0 }],
    });
    await fixture.whenStable();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('asks nothing for whoever does not classify content', async () => {
    const { http } = await open(aMe(), topic('hermetismo'));
    http.expectNone('/api/v1/levels/unassigned');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { aResponse } from '../../testing/fixtures.js';
import { KbApi, documentUrl, searchesUrl, topicsUrl } from './kb-api.js';

describe('KbApi', () => {
  it('posts a search and parses the response', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    let mode = '';
    TestBed.inject(KbApi)
      .search('hermetismo', { q: 'ritmo', mode: 'exact' })
      .subscribe((response) => (mode = response.mode));
    const request = http.expectOne('/api/v1/topics/hermetismo/searches');
    expect(request.request.body).toEqual({ q: 'ritmo', mode: 'exact' });
    request.flush(aResponse([], { mode: 'exact' }));
    expect(mode).toBe('exact');
    http.verify();
  });
});

describe('API URLs', () => {
  it('encodes nested topics and document ids', () => {
    expect(topicsUrl()).toBe('/api/v1/topics');
    expect(searchesUrl('harness/goclaw')).toBe(
      '/api/v1/topics/harness%2Fgoclaw/searches',
    );
    expect(documentUrl('hermetismo', 'raw/a.md')).toBe(
      '/api/v1/topics/hermetismo/documents/raw%2Fa.md',
    );
  });
});

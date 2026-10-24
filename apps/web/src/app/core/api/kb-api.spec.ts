import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { aDocument, aResponse, TOPICS } from '../../testing/fixtures.js';
import { KbApi } from './kb-api.js';

describe('KbApi', () => {
  let api: KbApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(KbApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists topics', () => {
    let count = 0;
    api.listTopics().subscribe((list) => (count = list.items.length));
    http.expectOne('/api/v1/topics').flush(TOPICS);
    expect(count).toBe(2);
  });

  it('posts a search and parses the response', () => {
    let mode = '';
    api
      .search('hermetismo', { q: 'ritmo', mode: 'exact' })
      .subscribe((response) => (mode = response.mode));
    const request = http.expectOne('/api/v1/topics/hermetismo/searches');
    expect(request.request.body).toEqual({ q: 'ritmo', mode: 'exact' });
    request.flush(aResponse([], { mode: 'exact' }));
    expect(mode).toBe('exact');
  });

  it('encodes the document id in the URL', () => {
    let title = '';
    api
      .getDocument('hermetismo', 'raw/articles/a.md')
      .subscribe((doc) => (title = doc.title));
    http
      .expectOne('/api/v1/topics/hermetismo/documents/raw%2Farticles%2Fa.md')
      .flush(aDocument());
    expect(title).toBe('A Lei do Ritmo');
  });
});

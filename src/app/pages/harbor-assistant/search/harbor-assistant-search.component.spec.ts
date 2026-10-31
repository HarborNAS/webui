import { fakeAsync, tick } from '@angular/core/testing';
import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { MockComponent } from 'ng-mocks';
import { of, Subject } from 'rxjs';
import { WINDOW } from 'app/helpers/window.helper';
import { PageHeaderComponent } from 'app/modules/page-header/page-title-header/page-header.component';
import { HarborAssistantSearchComponent } from 'app/pages/harbor-assistant/search/harbor-assistant-search.component';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import { HarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

describe('Harbor Assistant search component', () => {
  let spectator: Spectator<HarborAssistantSearchComponent>;
  let scrollIntoViewSpy: jest.Mock;
  let api: Partial<Record<keyof HarborAssistantContentApiService, jest.Mock>>;
  const popup = { opener: null, location: { href: '' }, close: jest.fn() };
  const open = jest.fn(() => popup);
  const originalUrl = URL;

  const createComponent = createComponentFactory({
    component: HarborAssistantSearchComponent,
    imports: [
      MockComponent(PageHeaderComponent),
    ],
    providers: [
      { provide: WINDOW, useValue: { open } },
      {
        provide: HarborAssistantContentApiService,
        useFactory: (): Partial<Record<keyof HarborAssistantContentApiService, jest.Mock>> => api,
      },
    ],
  });

  beforeEach(() => {
    scrollIntoViewSpy = jest.fn();
    (Element.prototype as unknown as { scrollIntoView: jest.Mock }).scrollIntoView = scrollIntoViewSpy;
    localStorage.clear();
    const testUrl = class extends originalUrl {};
    Object.defineProperty(testUrl, 'createObjectURL', { value: jest.fn(() => 'blob:photo-preview') });
    Object.defineProperty(testUrl, 'revokeObjectURL', { value: jest.fn() });
    globalThis.URL = testUrl;
    popup.location.href = '';
    open.mockClear();
    api = {
      search: jest.fn(() => of(searchResponse())),
      preview: jest.fn(() => of(new Blob(['photo'], { type: 'image/jpeg' }))),
      previewUrl: jest.fn((path: string) => `/api/beacon/knowledge/preview?path=${encodeURIComponent(path)}`),
    };
  });

  afterEach(() => {
    globalThis.URL = originalUrl;
  });

  it('renders a RAG workbench without DVR controls', () => {
    spectator = createComponent();
    spectator.detectChanges();

    expect(spectator.query('.rag-workbench')).toExist();
    expect(spectator.query('.live-panel')).not.toExist();
    expect(spectator.query('[data-testid="harbor-assistant-search-media-library"]')).not.toExist();
    expect(spectator.query('textarea[aria-label="Assistant search query"]')).toExist();
    expect(spectator.element.textContent).not.toContain('Multimodal RAG');
    expect(spectator.element.textContent).not.toContain('Harbor Assistant Search');
    expect(spectator.element.textContent).not.toContain('RAG search');
    expect(spectator.element.textContent).toContain('Image search uses indexed image sources and citations');
    expect(spectator.element.textContent).toContain('Use Multimodal for a direct upload');
  });

  it('renders authenticated photo blobs and opens the loaded original', fakeAsync(() => {
    api.search = jest.fn(() => of(searchResponse({
      images: [{
        path: '/photos/001.jpg', title: '001.jpg', modality: 'image', score: 900,
      }],
      videos: [],
    })));
    spectator = createComponent();
    const component = spectator.component as unknown as {
      form: { controls: { query: { setValue: (value: string) => void } } };
      search: () => void;
    };
    component.form.controls.query.setValue('spring photos');
    component.search();
    tick();
    spectator.detectChanges();

    expect(api.preview).toHaveBeenCalledWith('/photos/001.jpg');
    expect(spectator.query<HTMLImageElement>('.image-frame img')?.getAttribute('src')).toBe('blob:photo-preview');
    spectator.click('.result-card.image');
    expect(open).toHaveBeenCalledWith('blob:photo-preview', '_blank', 'noopener');
    spectator.fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-preview');
  }));

  it('cancels photo previews from a previous result before loading new photos', fakeAsync(() => {
    const oldPreview$ = new Subject<Blob>();
    api.preview = jest.fn(() => oldPreview$);
    api.search = jest.fn(() => of(searchResponse({
      images: [{
        path: '/photos/old.jpg', title: 'old.jpg', modality: 'image', score: 900,
      }],
      videos: [],
    })));
    spectator = createComponent();
    const component = spectator.component as unknown as {
      form: { controls: { query: { setValue: (value: string) => void } } };
      search: () => void;
    };
    component.form.controls.query.setValue('spring photos');
    component.search();
    api.search = jest.fn(() => of(searchResponse({ images: [], videos: [] })));
    component.search();
    oldPreview$.next(new Blob(['stale photo'], { type: 'image/jpeg' }));
    tick();
    spectator.detectChanges();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  }));

  it('defaults Harbor Assistant search to all knowledge sources', fakeAsync(() => {
    spectator = createComponent();
    const component = spectator.component as unknown as {
      form: { controls: { query: { setValue: (value: string) => void } } };
      search: () => void;
    };

    component.form.controls.query.setValue('谁在倒啤酒');
    component.search();
    spectator.detectChanges();
    tick();

    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({
      query: '谁在倒啤酒',
      include_videos: true,
      source_scope: 'all',
    }));
    expect(scrollIntoViewSpy).toHaveBeenCalled();
  }));

  it('keeps embedding setup guidance visible in Harbor Assistant search', fakeAsync(() => {
    api.search = jest.fn(() => of(searchResponse({
      degraded: true,
      degraded_reason: 'embedding_unavailable',
      warnings: ['Embedding model unavailable'],
    })));
    spectator = createComponent();
    const component = spectator.component as unknown as {
      form: { controls: { query: { setValue: (value: string) => void } } };
      search: () => void;
    };

    component.form.controls.query.setValue('spring photos');
    component.search();
    tick();
    spectator.detectChanges();

    expect(spectator.query('.embedding-action')).toHaveText('Vector search model is unavailable');
    expect(spectator.query('.embedding-action')).toHaveText('Open model settings');
  }));

  it('shows a user-facing filter hint instead of debug evidence when the current type has no results', fakeAsync(() => {
    spectator = createComponent();
    const component = spectator.component as unknown as {
      form: {
        controls: {
          query: { setValue: (value: string) => void };
          filter: { setValue: (value: string) => void };
        };
      };
      search: () => void;
    };

    component.form.controls.query.setValue('Find spring photos');
    component.form.controls.filter.setValue('images');
    component.search();
    tick();
    spectator.detectChanges();

    expect(spectator.query('.filter-empty-state')).toHaveText('The current image filter has no related results');
    expect(spectator.query('.filter-empty-state')).toHaveText('add and index a folder with spring photos');
    expect(spectator.element.textContent).not.toContain('Evidence');
    expect(spectator.element.textContent).not.toContain('Content match');
  }));

  it('stores only recent search terms and reuses them without changing filters', fakeAsync(() => {
    spectator = createComponent();
    const component = spectator.component as unknown as {
      form: {
        controls: {
          query: { value: string; setValue: (value: string) => void };
          filter: { value: string; setValue: (value: string) => void };
          sourceScope: { value: string; setValue: (value: string) => void };
          from: { value: string; setValue: (value: string) => void };
        };
      };
      search: () => void;
      useSearchHistoryTerm: (term: string) => void;
    };

    component.form.controls.query.setValue('谁在倒啤酒');
    component.form.controls.filter.setValue('videos');
    component.form.controls.sourceScope.setValue('dvr_library');
    component.form.controls.from.setValue('2026-05-04T10:00');
    component.search();
    tick();
    spectator.detectChanges();

    expect(JSON.parse(localStorage.getItem('harborAssistant.searchTerms.v1') ?? '[]')).toEqual(['谁在倒啤酒']);
    expect(spectator.query('.search-history-strip')).toHaveText('谁在倒啤酒');

    component.useSearchHistoryTerm('最近有哪些录像');
    spectator.detectChanges();

    expect(component.form.controls.query.value).toBe('最近有哪些录像');
    expect(component.form.controls.filter.value).toBe('videos');
    expect(component.form.controls.sourceScope.value).toBe('dvr_library');
    expect(component.form.controls.from.value).toBe('2026-05-04T10:00');
  }));
});

function searchResponse(partial: Partial<HarborAssistantSearchResponse> = {}): HarborAssistantSearchResponse {
  return {
    query: partial.query ?? '谁在倒啤酒',
    roots: [],
    total_matches: partial.total_matches ?? 1,
    documents: partial.documents ?? [],
    images: partial.images ?? [],
    videos: partial.videos ?? [
      {
        modality: 'video',
        path: '/library/fixtures/beer.mp4',
        title: 'beer.mp4',
        score: 900,
        snippet: '有人在倒啤酒',
        content_source_kinds: ['video_sidecar'],
        content_indexed: true,
        filename_match_used: false,
        content_match_used: true,
      },
    ],
    reply_pack: { summary: '', citations: [] },
    supported_modalities: ['document', 'image', 'video'],
    pending_modalities: [],
    status: partial.status ?? 'ok',
    degraded: partial.degraded ?? false,
    degraded_reason: partial.degraded_reason,
    blockers: partial.blockers ?? [],
    warnings: partial.warnings ?? [],
    source_scope: [],
    privacy_level: 'strict_local',
    resource_profile: 'cpu_only',
  };
}

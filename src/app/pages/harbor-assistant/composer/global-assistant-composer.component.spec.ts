import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { MatMenuHarness } from '@angular/material/menu/testing';
import { createComponentFactory, mockProvider, Spectator } from '@ngneat/spectator/jest';
import { finalize, of, Subject, throwError } from 'rxjs';
import { WINDOW } from 'app/helpers/window.helper';
import { AuthService } from 'app/modules/auth/auth.service';
import { AssistantSessionStore } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { GlobalAssistantComposerComponent } from 'app/pages/harbor-assistant/composer/global-assistant-composer.component';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import { HarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

describe('GlobalAssistantComposerComponent', () => {
  let spectator: Spectator<GlobalAssistantComposerComponent>;
  const api = {
    search: jest.fn(),
    conversations: jest.fn(() => of({ conversations: [] })),
    preview: jest.fn(() => of(new Blob(['photo'], { type: 'image/jpeg' }))),
    previewUrl: (path: string) => `/api/harbor-beacon/knowledge/preview?path=${encodeURIComponent(path)}`,
  };
  const createComponent = createComponentFactory({
    component: GlobalAssistantComposerComponent,
    providers: [
      mockProvider(AuthService, { user$: of({ pw_name: 'admin' }) }),
      { provide: HarborAssistantContentApiService, useValue: api },
      mockProvider(HarborAssistantApiService, { getKnowledgeSettings: () => of({ source_roots: [] }) }),
    ],
  });

  const originalUrl = URL;
  let imageNumber = 0;

  beforeEach(() => {
    imageNumber = 0;
    const testUrl = class extends originalUrl {};
    Object.defineProperty(testUrl, 'createObjectURL', { value: jest.fn(() => `blob:photo-${++imageNumber}`) });
    Object.defineProperty(testUrl, 'revokeObjectURL', { value: jest.fn() });
    globalThis.URL = testUrl;
    api.preview.mockReset().mockImplementation(() => of(new Blob(['photo'], { type: 'image/jpeg' })));
  });

  afterEach(() => {
    globalThis.URL = originalUrl;
  });

  function imageResponse(paths: string[]): HarborAssistantSearchResponse {
    return {
      images: paths.map((path, index) => ({ path, title: `Photo ${index + 1}` })),
      reply_pack: { summary: 'Photos found', citations: [] },
      blockers: [],
      warnings: [],
    } as HarborAssistantSearchResponse;
  }

  it('renders ordered photo results from authenticated blobs beside the answer', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Find spring photos', response: imageResponse(['/nas/a.jpg', '/nas/b.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(api.preview.mock.calls.map(([path]) => path)).toEqual(['/nas/a.jpg', '/nas/b.jpg']);
    expect(spectator.queryAll('.assistant-photo-card img').map((image) => image.getAttribute('src')))
      .toEqual(['blob:photo-1', 'blob:photo-2']);
    expect(spectator.queryAll('.assistant-photo-number').map((number) => number.textContent)).toEqual(['1', '2']);
    expect(spectator.query('.assistant-answer')).toHaveText('Photos found');
    expect(spectator.query('.assistant-photo-grid img')?.getAttribute('src')).not.toContain('/api/');
    expect(spectator.element.classList.contains('assistant-results-open')).toBe(true);
  });

  it('shows original indexed photo descriptions with uncertainty and a bounded plain-text preview', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    const response = imageResponse(['/nas/a.jpg']);
    const original = '无法确认拍摄季节。' + '花园中的花朵与叶片。'.repeat(30);
    response.images[0].snippet = original;
    response.verification_status = 'skipped';
    session.turns.set([{ query: 'Photos', response }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    const description = spectator.query('.assistant-photo-description');
    expect(description).toHaveText(Array.from(original).slice(0, 220).join(''));
    expect(description).toHaveAttribute('title', original);
    expect(description?.textContent).toContain('无法确认拍摄季节。');
    expect(spectator.query('.assistant-verification-status')).toHaveText('Indexed results · not visually verified');
  });

  it('retains result order when image requests finish out of order', () => {
    const first$ = new Subject<Blob>();
    const second$ = new Subject<Blob>();
    api.preview.mockImplementation((path: string) => (path === '/nas/a.jpg' ? first$ : second$));
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Photos', response: imageResponse(['/nas/a.jpg', '/nas/b.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    second$.next(new Blob(['second'], { type: 'image/jpeg' }));
    spectator.detectChanges();
    expect(spectator.queryAll('.assistant-photo-card')[0].querySelector('img')).toBeNull();
    expect(spectator.queryAll('.assistant-photo-card')[1].querySelector('img')).not.toBeNull();
    first$.next(new Blob(['first'], { type: 'image/jpeg' }));
    spectator.detectChanges();
    expect(spectator.queryAll('.assistant-photo-card img').map((image) => image.getAttribute('src')))
      .toEqual(['blob:photo-2', 'blob:photo-1']);
  });

  it('cancels obsolete previews and releases loaded image URLs on conversation replacement', () => {
    const pending$ = new Subject<Blob>();
    const cancelled = jest.fn();
    api.preview.mockImplementation((path: string) => (path === '/nas/old.jpg'
      ? pending$.pipe(finalize(cancelled))
      : of(new Blob(['current'], { type: 'image/jpeg' }))));
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Old', response: imageResponse(['/nas/old.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(cancelled).not.toHaveBeenCalled();
    session.turns.set([{ query: 'New', response: imageResponse(['/nas/new.jpg']) }]);
    spectator.detectChanges();
    expect(cancelled).toHaveBeenCalledTimes(1);
    pending$.next(new Blob(['stale'], { type: 'image/jpeg' }));
    spectator.detectChanges();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(spectator.query('.assistant-photo-card figcaption')).toHaveText('Photo 1');
    session.resultsOpen.set(false);
    spectator.detectChanges();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1');
  });

  it('shows a preview failure without rendering an error document as a photo', () => {
    api.preview.mockReturnValue(of(new Blob(['<html>error</html>'], { type: 'text/html' })));
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Photos', response: imageResponse(['/nas/failed.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(spectator.query('.assistant-photo-error')).toHaveText('Image preview unavailable');
    expect(spectator.query('.assistant-photo-card img')).not.toExist();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('reports an authenticated thumbnail failure while preserving its original preview action', () => {
    api.preview.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 403 })));
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Photos', response: imageResponse(['/nas/restricted.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(spectator.query('.assistant-photo-error')).toHaveText('Image preview unavailable');
    expect(spectator.query('.assistant-photo-open')).toExist();
  });

  it('releases a thumbnail rejected by the browser decoder and shows a failure', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Photos', response: imageResponse(['/nas/broken.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    spectator.query<HTMLImageElement>('.assistant-photo-card img')?.dispatchEvent(new Event('error'));
    spectator.detectChanges();
    expect(spectator.query('.assistant-photo-card img')).not.toExist();
    expect(spectator.query('.assistant-photo-error')).toHaveText('Image preview unavailable');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1');
  });

  it('opens an image preview through the existing authenticated original preview flow', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    const preview = { opener: null, location: { href: '' }, close: jest.fn() };
    const open = jest.spyOn(spectator.inject(WINDOW), 'open').mockReturnValue(preview as unknown as Window);
    const get = jest.spyOn(spectator.inject(HttpClient), 'get')
      .mockReturnValue(of(new Blob(['original'], { type: 'image/jpeg' })));
    session.turns.set([{ query: 'Photos', response: imageResponse(['/nas/original.jpg']) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    spectator.click('.assistant-photo-open');
    expect(get).toHaveBeenCalledWith('/api/harbor-beacon/knowledge/preview?path=%2Fnas%2Foriginal.jpg', {
      responseType: 'blob',
    });
    expect(preview.location.href).toBe('blob:photo-2');
    open.mockRestore();
    get.mockRestore();
  });

  it('does not create a photo section or preview requests for an answer without images', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{ query: 'Documents', response: imageResponse([]) }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(spectator.query('.assistant-photo-grid')).not.toExist();
    expect(api.preview).not.toHaveBeenCalled();
  });

  it('renders one global composer with Automatic and a tools menu without sending a request', () => {
    spectator = createComponent();
    expect(spectator.query('textarea[aria-label="Ask Harbor Assistant"]')).toExist();
    expect(spectator.element.textContent).toContain('Automatic');
    expect(spectator.query('button[aria-label="Add to conversation"]')).toExist();
    expect(api.search).not.toHaveBeenCalled();
  });

  it.each([
    ['fast', 'Fast'],
    ['careful', 'Careful'],
    ['auto', 'Automatic'],
  ] as const)('keeps the %s response preference visible outside removable context chips', (preference, label) => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.updateDraft({ responsePreference: preference });
    spectator.detectChanges();
    expect(spectator.query('.assistant-response-preference')).toHaveText(label);
    expect(spectator.query('.assistant-response-preference')).toHaveAttribute('aria-label', `Response preference: ${label}`);
    expect(spectator.query('.assistant-context-chips')?.textContent).not.toContain(label);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('changes the response preference through its persistent menu without sending a request', async () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    const menu = await loader.getHarness(MatMenuHarness.with({ selector: '.assistant-response-preference' }));
    await menu.open();
    const items = await menu.getItems();
    expect(await Promise.all(items.map((item) => item.getText()))).toEqual([
      'Fast · indexed results first', 'Careful · visual verification', 'Automatic · match the request',
    ]);
    await items[1].click();
    spectator.detectChanges();
    expect(session.draft().responsePreference).toBe('careful');
    expect(spectator.query('.assistant-response-preference')).toHaveText('Careful');
    await menu.open();
    await (await menu.getItems())[2].click();
    spectator.detectChanges();
    expect(session.draft().responsePreference).toBe('auto');
    expect(spectator.query('.assistant-response-preference')).toHaveText('Automatic');
    expect(api.search).not.toHaveBeenCalled();
    expect(session.turns()).toEqual([]);
  });

  it('labels fast indexed photo results as not visually verified', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{
      query: 'Find photos',
      response: {
        reply_pack: { summary: 'Found photos.', citations: [] },
        verification_status: 'skipped',
        images: [],
        blockers: [],
        warnings: [],
      } as unknown as HarborAssistantSearchResponse,
    }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(spectator.query('.assistant-verification-status')).toHaveText('Indexed results · not visually verified');
  });

  it('shows only the runtime metadata actually returned with a conversation answer', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{
      query: 'Hello',
      response: {
        reply_pack: { summary: 'Hello', citations: [] },
        blockers: [],
        warnings: [],
        model: {
          model_name: 'Qwen2.5',
          metadata: {
            runtime_backend_kind: 'llama.cpp',
            runtime_device: 'Vulkan1: AMD Radeon Pro W7900',
            base_url: 'http://127.0.0.1:11435/v1',
            persistent: true,
          },
        },
      } as HarborAssistantSearchResponse,
    }]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    const metadata = spectator.query('.assistant-runtime-metadata');
    expect(metadata).toHaveText('Qwen2.5');
    expect(metadata).toHaveText('llama.cpp');
    expect(metadata).toHaveText('Vulkan1: AMD Radeon Pro W7900');
    expect(metadata).toHaveText('http://127.0.0.1:11435/v1');
    expect(metadata).toHaveText('true');
  });

  it('states when indexed image evidence has no generated answer', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{
      query: 'Find an indexed image',
      response: {
        total_matches: 1,
        documents: [],
        images: [{ path: '/docs/image.png' }],
        videos: [],
        reply_pack: { summary: '', citations: [{ path: '/docs/image.png' }] },
        blockers: [],
        warnings: [],
        degraded: false,
      },
    } as HarborAssistantSearchResponse]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(spectator.element.textContent).toContain('Indexed evidence was found, but no generated answer was returned.');
    expect(spectator.element.textContent).not.toContain('The server returned no answer.');
  });

  it('states when indexed image evidence has a degraded result', () => {
    spectator = createComponent();
    const session = spectator.inject(AssistantSessionStore);
    session.turns.set([{
      query: 'Find an indexed image',
      response: {
        total_matches: 0,
        documents: [],
        images: [],
        videos: [],
        reply_pack: { summary: '', citations: [] },
        blockers: ['embedding unavailable'],
        warnings: [],
        degraded: true,
      },
    } as HarborAssistantSearchResponse]);
    session.resultsOpen.set(true);
    spectator.detectChanges();
    expect(spectator.element.textContent).toContain('Knowledge search returned a degraded result.');
  });

  it('loads source previews through authenticated HttpClient and exposes a real preview failure', () => {
    spectator = createComponent();
    const preview = { opener: null, location: { href: '' }, close: jest.fn() };
    const open = jest.spyOn(spectator.inject(WINDOW), 'open').mockReturnValue(preview as unknown as Window);
    const get = jest.spyOn(spectator.inject(HttpClient), 'get').mockReturnValue(throwError(() => new HttpErrorResponse({ status: 403 })));
    const component = spectator.component as unknown as {
      openCitation: (url: string) => void;
      citationError: () => string | null;
    };
    component.openCitation('/api/harbor-beacon/knowledge/preview?path=%2Fdocs%2Fguide.pdf');
    expect(get).toHaveBeenCalledWith('/api/harbor-beacon/knowledge/preview?path=%2Fdocs%2Fguide.pdf', {
      responseType: 'blob',
    });
    expect(preview.close).toHaveBeenCalled();
    expect(component.citationError()).toContain('could not be loaded');
    open.mockRestore();
    get.mockRestore();
  });

  it('offers exactly four conversation tools and only changes options when a tool is selected', async () => {
    spectator = createComponent();
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    const menu = await loader.getHarness(MatMenuHarness.with({ triggerText: '+' }));
    await menu.open();
    const items = await menu.getItems();
    expect(await Promise.all(items.map((item) => item.getText()))).toEqual([
      'Sources and search options', 'Time range', 'New conversation', 'Conversation history',
    ]);
    await items[0].click();
    spectator.detectChanges();
    expect(spectator.query('.assistant-response-preference')).toExist();
    expect(spectator.query('select option[value="fast"]')).not.toExist();
    expect(spectator.query('select option[value="careful"]')).not.toExist();
    expect(spectator.query('input[type="datetime-local"]')).not.toExist();
    expect(api.search).not.toHaveBeenCalled();
    expect(TestBed.inject(AssistantSessionStore).turns()).toEqual([]);
  });
});

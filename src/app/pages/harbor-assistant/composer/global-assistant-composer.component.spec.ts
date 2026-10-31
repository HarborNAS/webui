import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { MatMenuHarness } from '@angular/material/menu/testing';
import { createComponentFactory, mockProvider, Spectator } from '@ngneat/spectator/jest';
import { of, throwError } from 'rxjs';
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

  it('renders one global composer with Automatic and a tools menu without sending a request', () => {
    spectator = createComponent();
    expect(spectator.query('textarea[aria-label="Ask Harbor Assistant"]')).toExist();
    expect(spectator.element.textContent).toContain('Automatic');
    expect(spectator.query('button[aria-label="Add to conversation"]')).toExist();
    expect(api.search).not.toHaveBeenCalled();
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
    await items[1].click();
    spectator.detectChanges();
    expect(spectator.query('input[type="datetime-local"]')).toExist();
    expect(api.search).not.toHaveBeenCalled();
    expect(TestBed.inject(AssistantSessionStore).turns()).toEqual([]);
  });
});

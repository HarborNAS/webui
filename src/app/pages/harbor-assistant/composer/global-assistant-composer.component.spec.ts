import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestBed } from '@angular/core/testing';
import { MatMenuHarness } from '@angular/material/menu/testing';
import { createComponentFactory, mockProvider, Spectator } from '@ngneat/spectator/jest';
import { of } from 'rxjs';
import { AuthService } from 'app/modules/auth/auth.service';
import { AssistantSessionStore } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { GlobalAssistantComposerComponent } from 'app/pages/harbor-assistant/composer/global-assistant-composer.component';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';

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

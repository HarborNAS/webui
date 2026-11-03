import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AssistantSessionStore } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import { HarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

const answer = { reply_pack: { summary: 'HarborOS is ready.', citations: [] }, blockers: [], warnings: [] } as unknown as HarborAssistantSearchResponse;

describe('AssistantSessionStore', () => {
  let store: AssistantSessionStore;
  let api: { search: jest.Mock; conversations: jest.Mock; conversation: jest.Mock };

  beforeEach(() => {
    sessionStorage.clear();
    api = {
      search: jest.fn(() => of(answer)),
      conversations: jest.fn(() => of({ conversations: [] })),
      conversation: jest.fn(() => of({ conversation_id: 'saved-1', turns: [{ query: 'Hello', response: answer }] })),
    };
    TestBed.configureTestingModule({
      providers: [
        AssistantSessionStore,
        { provide: HarborAssistantContentApiService, useValue: api },
        {
          provide: HarborAssistantApiService,
          useValue: {
            getKnowledgeSettings: jest.fn(() => of({ source_roots: [{ root_id: 'docs', path: '/docs', enabled: true }] })),
          },
        },
      ],
    });
    store = TestBed.inject(AssistantSessionStore);
    store.bindUser('admin');
  });

  it('initializes and starts conversations when HTTP does not expose crypto.randomUUID', () => {
    const originalRandomUuid = crypto.randomUUID;
    (crypto as { randomUUID?: typeof crypto.randomUUID }).randomUUID = undefined;
    try {
      const httpStore = TestBed.runInInjectionContext(() => new AssistantSessionStore());
      const uuid = /^harbor-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const initialId = httpStore.conversationId();
      expect(initialId).toMatch(uuid);
      httpStore.bindUser('http-admin');
      const userId = httpStore.conversationId();
      expect(userId).toMatch(uuid);
      expect(userId).not.toBe(initialId);
      httpStore.updateDraft({ text: 'Retained draft' });
      httpStore.bindUser('http-admin');
      expect(httpStore.draft().text).toBe('Retained draft');
      expect(httpStore.conversationId()).toBe(userId);
      httpStore.newConversation();
      expect(httpStore.conversationId()).toMatch(uuid);
      expect(httpStore.conversationId()).not.toBe(userId);
    } finally {
      crypto.randomUUID = originalRandomUuid;
    }
  });

  it('sends the conversation, retrieval, source, modality and time context to Knowledge Search', () => {
    store.updateDraft({
      text: 'What is in this guide?',
      sourceRootIds: ['docs'],
      retrievalMode: 'on',
      responsePreference: 'fast',
      filter: 'text',
      from: '2026-10-29T10:00',
      to: '2026-10-30T10:00',
    });
    const id = store.conversationId();
    store.send();
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'What is in this guide?',
      conversation_id: id,
      retrieval_mode: 'on',
      response_preference: 'fast',
      source_root_ids: ['docs'],
      filter: 'text',
      include_audio: true,
      include_documents: true,
      include_images: false,
      include_videos: false,
      from: String(new Date('2026-10-29T10:00').getTime() / 1000),
    }));
    expect(store.turns()[0].response).toBe(answer);
    expect(store.draft().text).toBe('');
  });

  it.each([
    { filter: 'all' as const, includeAudio: true },
    { filter: 'images' as const, includeAudio: false },
    { filter: 'videos' as const, includeAudio: false },
  ])('sends literal $filter filter and explicit audio selection', ({ filter, includeAudio }) => {
    store.updateDraft({ text: 'Find a matching source', filter });
    store.send();
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ filter, include_audio: includeAudio }));
  });

  it('announces only completed current responses and valid history restores for status refresh', () => {
    const completed = jest.fn();
    store.responseCompleted$.subscribe(completed);
    api.search.mockReturnValueOnce(throwError(() => new Error('unavailable')));
    store.updateDraft({ text: 'Failed question' });
    store.send();
    expect(completed).not.toHaveBeenCalled();
    store.updateDraft({ text: 'Successful question' });
    store.send();
    expect(completed).toHaveBeenCalledTimes(1);
    store.loadConversation('saved-1');
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it('keeps the same root store and draft when a page binds the same signed-in user', () => {
    store.updateDraft({
      text: 'Unsaved question', sourceRootIds: ['docs'], retrievalMode: 'off', responsePreference: 'careful',
    });
    const id = store.conversationId();
    store.bindUser('admin');
    expect(TestBed.inject(AssistantSessionStore)).toBe(store);
    expect(store.draft().text).toBe('Unsaved question');
    expect(store.conversationId()).toBe(id);
    expect(store.draft().retrievalMode).toBe('off');
    expect(store.draft().responsePreference).toBe('careful');
  });

  it('preserves a pending request across page changes and sends it only once', () => {
    const response$ = new Subject<HarborAssistantSearchResponse>();
    api.search.mockReturnValue(response$);
    store.updateDraft({ text: 'One request' });
    store.send();
    store.bindUser('admin');
    store.send();
    expect(store.busy()).toBe(true);
    expect(api.search).toHaveBeenCalledTimes(1);
    response$.next(answer);
    response$.complete();
    expect(store.busy()).toBe(false);
    expect(store.turns()[0].response).toBe(answer);
  });

  it('restores per-user draft and conversation id from session storage', () => {
    sessionStorage.setItem('harborAssistant.composer.v1:other', JSON.stringify({
      conversationId: 'saved-draft',
      draft: {
        text: 'Retained', retrievalMode: 'on', responsePreference: 'fast', sourceRootIds: ['docs'],
      },
    }));
    store.bindUser('other');
    expect(store.draft().text).toBe('Retained');
    expect(store.conversationId()).toBe('saved-draft');
    expect(store.draft().responsePreference).toBe('fast');
    expect(store.draft().sourceRootIds).toEqual(['docs']);
  });

  it('persists response preference across a new conversation without sending a request', () => {
    store.updateDraft({ text: 'Fast photo lookup', responsePreference: 'fast' });
    const before = store.conversationId();
    store.newConversation();
    expect(store.conversationId()).not.toBe(before);
    expect(store.draft().responsePreference).toBe('fast');
    expect(api.search).not.toHaveBeenCalled();
  });

  it('defaults new and legacy drafts to fast while preserving an explicit automatic preference', () => {
    expect(store.draft().responsePreference).toBe('fast');
    sessionStorage.setItem('harborAssistant.composer.v1:legacy', JSON.stringify({ draft: { responsePreference: 'invalid' } }));
    store.bindUser('legacy');
    expect(store.draft().responsePreference).toBe('fast');
    sessionStorage.setItem('harborAssistant.composer.v1:automatic', JSON.stringify({ draft: { responsePreference: 'auto' } }));
    store.bindUser('automatic');
    expect(store.draft().responsePreference).toBe('auto');
  });

  it('opens server history and never fabricates a local history success', () => {
    api.conversations.mockReturnValue(throwError(() => new Error('404 Not Found')));
    store.refreshHistory();
    expect(store.historyError()).toContain('unavailable');
    expect(store.history()).toEqual([]);
    store.loadConversation('saved-1');
    expect(api.conversation).toHaveBeenCalledWith('saved-1');
    expect(store.conversationId()).toBe('saved-1');
    expect(store.turns()[0].query).toBe('Hello');
  });

  it('ignores stale history responses from an earlier refresh', () => {
    const earlier$ = new Subject<unknown>();
    const latest$ = new Subject<unknown>();
    api.conversations.mockReturnValueOnce(earlier$).mockReturnValueOnce(latest$);
    store.refreshHistory();
    store.refreshHistory();
    latest$.next({ conversations: [{ conversation_id: 'latest', title: 'Latest', turn_count: 1 }] });
    latest$.complete();
    earlier$.next({ conversations: [{ conversation_id: 'old', title: 'Old', turn_count: 1 }] });
    earlier$.complete();
    expect(store.history().map((entry) => entry.conversation_id)).toEqual(['latest']);
    expect(store.historyLoading()).toBe(false);
  });

  it('ignores a late answer after the signed-in user changes', () => {
    const response$ = new Subject<HarborAssistantSearchResponse>();
    api.search.mockReturnValue(response$);
    store.updateDraft({ text: 'Private question' });
    store.send();
    store.bindUser('different');
    response$.next(answer);
    response$.complete();
    expect(store.turns()).toEqual([]);
    expect(store.busy()).toBe(false);
  });

  it('does not perform a search when source and time options change', () => {
    store.toggleSource('docs');
    store.updateDraft({ retrievalMode: 'off', from: '2026-10-29T10:00' });
    expect(api.search).not.toHaveBeenCalled();
  });

  it('creates a new conversation without sending the draft or changing configured source selection', () => {
    store.updateDraft({ text: 'Draft', sourceRootIds: ['docs'] });
    const before = store.conversationId();
    store.newConversation();
    expect(store.conversationId()).not.toBe(before);
    expect(store.draft().text).toBe('');
    expect(store.draft().sourceRootIds).toEqual(['docs']);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('continues with the canonical conversation id returned by the server', () => {
    api.search.mockReturnValue(of({ ...answer, conversation_id: 'canonical-server-id' }));
    store.updateDraft({ text: 'Hello' });
    store.send();
    expect(store.conversationId()).toBe('canonical-server-id');
    store.updateDraft({ text: 'Follow up' });
    store.send();
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ conversation_id: 'canonical-server-id' }));
  });

  it('preserves a precise server blocker when a requested time filter is unsupported', () => {
    api.search.mockReturnValue(throwError(() => new HttpErrorResponse({
      status: 422, error: { error: 'DVR content search is owned by HarborLink' },
    })));
    store.updateDraft({ text: 'Yesterday', from: '2026-10-29T10:00' });
    store.send();
    expect(store.error()).toBe('DVR content search is owned by HarborLink');
    expect(store.turns()[0].error).toBe('DVR content search is owned by HarborLink');
  });

  it('rejects a reversed time range without making a request', () => {
    store.updateDraft({ text: 'Question', from: '2026-10-30T10:00', to: '2026-10-29T10:00' });
    store.send();
    expect(api.search).not.toHaveBeenCalled();
    expect(store.error()).toContain('start time');
  });
});

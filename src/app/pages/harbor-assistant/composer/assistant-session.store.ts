import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { marker as T } from '@biesbjerg/ngx-translate-extract-marker';
import { Subject } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { generateUuid } from 'app/helpers/uuid.helper';
import { KnowledgeSourceRoot } from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';
import { HarborAssistantContentApiService, normalizeHarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import { HarborAssistantResponsePreference, HarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

export type AssistantRetrievalMode = 'auto' | 'on' | 'off';
export type AssistantResultFilter = 'all' | 'text' | 'images' | 'videos';
export type AssistantResponsePreference = HarborAssistantResponsePreference;

export interface AssistantDraft {
  text: string;
  sourceRootIds: string[];
  retrievalMode: AssistantRetrievalMode;
  responsePreference: AssistantResponsePreference;
  filter: AssistantResultFilter;
  from: string;
  to: string;
}

export interface AssistantTurn {
  query: string;
  response?: HarborAssistantSearchResponse;
  error?: string;
}

export interface AssistantConversation {
  conversation_id: string;
  title: string;
  turn_count: number;
}

const emptyDraft = (): AssistantDraft => ({
  text: '', sourceRootIds: [], retrievalMode: 'auto', responsePreference: 'fast', filter: 'all', from: '', to: '',
});

@Injectable({ providedIn: 'root' })
export class AssistantSessionStore {
  private readonly api = inject(HarborAssistantContentApiService);
  private readonly settingsApi = inject(HarborAssistantApiService);
  private readonly owner = signal('');
  private requestSequence = 0;
  private historySequence = 0;
  private initialized = false;
  private readonly responseCompletion$ = new Subject<void>();
  readonly responseCompleted$ = this.responseCompletion$.asObservable();

  readonly draft = signal<AssistantDraft>(emptyDraft());
  readonly conversationId = signal(this.newConversationId());
  readonly turns = signal<AssistantTurn[]>([]);
  readonly sources = signal<KnowledgeSourceRoot[]>([]);
  readonly history = signal<AssistantConversation[]>([]);
  readonly busy = signal(false);
  readonly historyLoading = signal(false);
  readonly historyError = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly resultsOpen = signal(false);
  readonly hasResults = computed(() => this.turns().length > 0);

  constructor() {
    effect(() => {
      const owner = this.owner();
      const saved = { draft: this.draft(), conversationId: this.conversationId() };
      if (!owner) {
        return;
      }
      try {
        sessionStorage.setItem(this.storageKey(owner), JSON.stringify(saved));
      } catch {
        // The active in-memory session remains usable when browser storage is unavailable.
      }
    });
  }

  bindUser(username: string): void {
    if (this.initialized && username === this.owner()) {
      return;
    }
    this.requestSequence += 1;
    this.historySequence += 1;
    this.initialized = true;
    this.owner.set(username);
    this.draft.set(emptyDraft());
    this.conversationId.set(this.newConversationId());
    this.turns.set([]);
    this.sources.set([]);
    this.history.set([]);
    this.historyError.set(null);
    this.historyLoading.set(false);
    this.busy.set(false);
    this.error.set(null);
    this.resultsOpen.set(false);
    if (!username) {
      return;
    }
    this.restore(username);
    this.refreshSources();
    this.refreshHistory();
  }

  updateDraft(patch: Partial<AssistantDraft>): void {
    this.draft.update((draft) => ({ ...draft, ...patch }));
  }

  toggleSource(id: string): void {
    this.updateDraft({
      sourceRootIds: this.draft().sourceRootIds.includes(id)
        ? this.draft().sourceRootIds.filter((candidate) => candidate !== id)
        : [...this.draft().sourceRootIds, id],
    });
  }

  newConversation(): void {
    if (this.busy()) {
      return;
    }
    this.requestSequence += 1;
    this.conversationId.set(this.newConversationId());
    this.turns.set([]);
    this.error.set(null);
    this.updateDraft({ text: '' });
  }

  send(): void {
    const draft = this.draft();
    const query = draft.text.trim();
    if (!query || this.busy()) {
      return;
    }
    if (draft.from && draft.to && new Date(draft.from).getTime() > new Date(draft.to).getTime()) {
      this.error.set(T('The start time must be before the end time.'));
      return;
    }
    const sequence = ++this.requestSequence;
    const conversationId = this.conversationId();
    this.busy.set(true);
    this.error.set(null);
    this.resultsOpen.set(true);
    this.turns.update((turns) => [...turns, { query }]);
    this.updateDraft({ text: '' });
    this.api.search({
      query,
      conversation_id: conversationId,
      retrieval_mode: draft.retrievalMode,
      response_preference: draft.responsePreference,
      response_preference_persist: true,
      source_root_ids: [...draft.sourceRootIds],
      source_scope: 'all',
      filter: draft.filter,
      include_audio: draft.filter === 'all' || draft.filter === 'text',
      include_documents: draft.filter === 'all' || draft.filter === 'text',
      include_images: draft.filter === 'all' || draft.filter === 'images',
      include_videos: draft.filter === 'all' || draft.filter === 'videos',
      from: this.timestamp(draft.from),
      to: this.timestamp(draft.to),
    }).pipe(finalize(() => {
      if (sequence === this.requestSequence) {
        this.busy.set(false);
      }
    })).subscribe({
      next: (response) => {
        if (sequence !== this.requestSequence || conversationId !== this.conversationId()) {
          return;
        }
        if (response.conversation_id?.trim()) {
          this.conversationId.set(response.conversation_id);
        }
        this.replacePending({ query, response });
        this.responseCompletion$.next();
        this.refreshHistory();
      },
      error: (cause: unknown) => {
        if (sequence !== this.requestSequence) {
          return;
        }
        const error = this.requestError(cause);
        this.error.set(error);
        this.replacePending({ query, error });
      },
    });
  }

  refreshHistory(): void {
    const owner = this.owner();
    if (!owner) {
      return;
    }
    const sequence = ++this.historySequence;
    this.historyLoading.set(true);
    this.historyError.set(null);
    this.api.conversations().pipe(finalize(() => {
      if (owner === this.owner() && sequence === this.historySequence) {
        this.historyLoading.set(false);
      }
    })).subscribe({
      next: (value) => {
        if (owner !== this.owner() || sequence !== this.historySequence) {
          return;
        }
        const record = this.record(value);
        if (!Array.isArray(record['conversations'])) {
          this.historyError.set(T('Conversation history is unsupported or unavailable on this server.'));
          return;
        }
        const conversations = record['conversations'];
        this.history.set(conversations.flatMap((item) => {
          const entry = this.record(item);
          return typeof entry['conversation_id'] === 'string'
            ? [{
                conversation_id: entry['conversation_id'],
                title: typeof entry['title'] === 'string' ? entry['title'] : entry['conversation_id'],
                turn_count: typeof entry['turn_count'] === 'number' ? entry['turn_count'] : 0,
              }]
            : [];
        }));
        const savedConversation = this.history().some((entry) => entry.conversation_id === this.conversationId());
        if (this.turns().length === 0 && savedConversation) {
          this.loadConversation(this.conversationId());
        }
      },
      error: () => {
        if (owner === this.owner() && sequence === this.historySequence) {
          this.historyError.set(T('Conversation history is unavailable. New messages can still be sent.'));
        }
      },
    });
  }

  loadConversation(id: string): void {
    if (this.busy()) {
      return;
    }
    const sequence = ++this.requestSequence;
    this.busy.set(true);
    this.error.set(null);
    this.api.conversation(id).pipe(finalize(() => {
      if (sequence === this.requestSequence) {
        this.busy.set(false);
      }
    })).subscribe({
      next: (value) => {
        if (sequence !== this.requestSequence) {
          return;
        }
        const detail = this.record(value);
        if (detail['conversation_id'] !== id || !Array.isArray(detail['turns'])) {
          this.error.set(T('This conversation could not be restored.'));
          return;
        }
        this.conversationId.set(id);
        this.turns.set(detail['turns'].flatMap((item) => {
          const turn = this.record(item);
          if (typeof turn['query'] !== 'string') {
            return [];
          }
          try {
            return [{ query: turn['query'], response: normalizeHarborAssistantSearchResponse(turn['response'], id) }];
          } catch {
            return [];
          }
        }));
        this.resultsOpen.set(true);
        this.responseCompletion$.next();
      },
      error: () => {
        if (sequence === this.requestSequence) {
          this.error.set(T('This conversation could not be restored.'));
        }
      },
    });
  }

  refreshSources(): void {
    const owner = this.owner();
    this.settingsApi.getKnowledgeSettings().subscribe({
      next: (settings) => {
        if (owner !== this.owner()) {
          return;
        }
        const sources = settings.source_roots.filter((root) => root.enabled);
        this.sources.set(sources);
        const available = new Set(sources.map((root) => root.root_id));
        this.updateDraft({ sourceRootIds: this.draft().sourceRootIds.filter((id) => available.has(id)) });
      },
      error: () => {
        if (owner === this.owner()) {
          this.error.set(T('Data sources are unavailable. Ordinary chat remains available.'));
        }
      },
    });
  }

  private restore(username: string): void {
    try {
      const stored = JSON.parse(sessionStorage.getItem(this.storageKey(username)) ?? '{}') as Record<string, unknown>;
      if (typeof stored['conversationId'] === 'string') {
        this.conversationId.set(stored['conversationId']);
      }
      const draft = this.record(stored['draft']);
      this.draft.set({
        text: typeof draft['text'] === 'string' ? draft['text'] : '',
        sourceRootIds: Array.isArray(draft['sourceRootIds'])
          ? draft['sourceRootIds'].filter((id): id is string => typeof id === 'string')
          : [],
        retrievalMode: ['auto', 'on', 'off'].includes(String(draft['retrievalMode']))
          ? draft['retrievalMode'] as AssistantRetrievalMode
          : 'auto',
        responsePreference: ['auto', 'fast', 'careful'].includes(String(draft['responsePreference']))
          ? draft['responsePreference'] as AssistantResponsePreference
          : 'fast',
        filter: ['all', 'text', 'images', 'videos'].includes(String(draft['filter']))
          ? draft['filter'] as AssistantResultFilter
          : 'all',
        from: typeof draft['from'] === 'string' ? draft['from'] : '',
        to: typeof draft['to'] === 'string' ? draft['to'] : '',
      });
    } catch {
      this.draft.set(emptyDraft());
    }
  }

  private requestError(cause: unknown): string {
    if (cause instanceof HttpErrorResponse) {
      const detail = this.record(cause.error);
      const nested = this.record(detail['error']);
      const reason = nested['message'] ?? detail['message'] ?? detail['error'] ?? detail['detail'];
      if (typeof reason === 'string' && reason.trim()) {
        return reason.slice(0, 600);
      }
    }
    return T('Harbor Assistant could not answer. Your question is kept in the result panel.');
  }

  private replacePending(turn: AssistantTurn): void {
    this.turns.update((turns) => [...turns.slice(0, -1), turn]);
  }

  private timestamp(value: string): string | null {
    const timestamp = new Date(value).getTime();
    return value && Number.isFinite(timestamp) ? String(Math.floor(timestamp / 1000)) : null;
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private storageKey(username: string): string {
    return `harborAssistant.composer.v1:${username}`;
  }

  private newConversationId(): string {
    return `harbor-web-${generateUuid()}`;
  }
}

import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, OnInit, ViewChild, computed, effect, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { MatCard, MatCardContent } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressBar } from '@angular/material/progress-bar';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { TnIconComponent } from '@truenas/ui-components';
import { MarkdownModule } from 'ngx-markdown';
import { filter as filterOperator, finalize, switchMap } from 'rxjs/operators';
import { WINDOW } from 'app/helpers/window.helper';
import { DialogService } from 'app/modules/dialog/dialog.service';
import {
  KnowledgeIndexJobRecord,
  KnowledgeSourceRoot,
} from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import {
  HarborAssistantContentApiService,
  normalizeHarborAssistantSearchResponse,
} from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import {
  buildHarborAssistantSearchPayload,
  buildHarborAssistantSearchWaterfallItems,
  harborAssistantSearchErrorMessage,
  harborAssistantSearchHasNoResults,
} from 'app/pages/harbor-assistant/shared/harbor-assistant-results';
import {
  HarborAssistantRetrievalSettingsDialogComponent,
  HarborAssistantRetrievalSettingsDialogData,
} from 'app/pages/harbor-assistant/shared/harbor-assistant-retrieval-settings-dialog.component';
import {
  HarborTimeRangeDialogComponent,
  HarborTimeRangeValue,
} from 'app/pages/harbor-assistant/shared/harbor-assistant-time-range-dialog.component';
import {
  HarborAssistantSearchResultFilter,
  HarborAssistantSearchHit,
  HarborAssistantSearchResponse,
  HarborAssistantSearchWaterfallItem,
  HarborAssistantConversationSummary,
  HarborAssistantRetrievalMode,
  HarborAssistantRetrievalSettings,
} from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

interface HarborAssistantSearchPromptSuggestion {
  label: string;
  query: string;
  filter: HarborAssistantSearchResultFilter;
}

interface HarborAssistantChatTurn {
  id: number;
  query: string;
  filter: HarborAssistantSearchResultFilter;
  useRetrieval: boolean;
  response?: HarborAssistantSearchResponse;
  error?: string;
}

interface HarborAssistantRetrievalSource {
  id: string;
  label: string;
  description: string;
}

@Component({
  selector: 'ix-harbor-assistant-search',
  templateUrl: './harbor-assistant-search.component.html',
  styleUrl: './harbor-assistant-search.component.scss',
  host: {
    '(document:click)': 'closeSearchSettingsOnOutsideClick($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    TranslateModule,
    NgClass,
    MatButton,
    MatButtonToggle,
    MatButtonToggleGroup,
    MatCard,
    MatCardContent,
    MatProgressBar,
    MarkdownModule,
    TnIconComponent,
  ],
})
export class HarborAssistantSearchComponent implements OnInit {
  private nextTurnId = 1;
  private searchRequestSequence = 0;
  private conversationLoadSequence = 0;
  private retrievalSourcesInitialized = false;
  private readonly searchHistoryStorageKey = 'harborAssistant.searchTerms.v1';
  private readonly formBuilder = inject(NonNullableFormBuilder);
  private readonly api = inject(HarborAssistantContentApiService);
  private readonly dialog = inject(MatDialog);
  private readonly dialogService = inject(DialogService);
  private readonly translate = inject(TranslateService);
  private readonly window = inject<Window>(WINDOW);
  @ViewChild('chatScroll') private chatScroll?: ElementRef<HTMLElement>;
  @ViewChild('searchSettings') private searchSettings?: ElementRef<HTMLDetailsElement>;

  readonly knowledgeSourceRoots = input<KnowledgeSourceRoot[]>([]);
  readonly knowledgeIndexJob = input<KnowledgeIndexJobRecord | null>(null);

  protected readonly form = this.formBuilder.group({
    query: ['', Validators.required],
    filter: ['all' as HarborAssistantSearchResultFilter, Validators.required],
    from: [''],
    to: [''],
    retrievalMode: ['auto' as HarborAssistantRetrievalMode, Validators.required],
  });

  protected readonly conversationSettingsForm = this.formBuilder.group({
    history_limit: [10, [Validators.required, Validators.min(1), Validators.max(100)]],
    context_turn_limit: [3, [Validators.required, Validators.min(0), Validators.max(20)]],
    context_token_limit: [8192, [Validators.required, Validators.min(4096), Validators.max(8192)]],
  });

  protected readonly loading = signal(false);
  protected readonly promptSuggestions = signal<HarborAssistantSearchPromptSuggestion[]>([]);
  protected readonly response = signal<HarborAssistantSearchResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly searchHistory = signal<string[]>([]);
  protected readonly conversations = signal<HarborAssistantConversationSummary[]>([]);
  protected readonly activeConversationId = signal(this.newConversationId());
  protected readonly conversationHistoryLoading = signal(false);
  protected readonly conversationSettingsSaving = signal(false);
  protected readonly deletingConversationIds = signal<ReadonlySet<string>>(new Set());
  protected readonly retrievalSettingsBusy = signal(false);
  protected readonly conversationBusy = computed(() => this.loading()
    || this.conversationHistoryLoading()
    || this.conversationSettingsSaving()
    || this.deletingConversationIds().size > 0);

  protected readonly retrievalSources = computed<HarborAssistantRetrievalSource[]>(() => this.knowledgeSourceRoots()
    .filter((root) => root.enabled)
    .map((root) => ({ id: root.root_id, label: root.label || root.path, description: root.path })));

  protected readonly selectedRetrievalSources = signal<string[]>([]);

  private readonly syncRetrievalSources = effect(() => {
    const availableIds = this.retrievalSources().map((source) => source.id);
    this.selectedRetrievalSources.update((selected) => {
      if (!this.retrievalSourcesInitialized && availableIds.length > 0) {
        this.retrievalSourcesInitialized = true;
        return availableIds;
      }
      const available = new Set(availableIds);
      const next = selected.filter((sourceId) => available.has(sourceId));
      if (selected.length > 0 && next.length === 0) {
        this.form.controls.retrievalMode.setValue('off');
      }
      return next;
    });
  });

  protected readonly chatTurns = signal<HarborAssistantChatTurn[]>([]);
  protected readonly pendingQuery = signal<string | null>(null);

  ngOnInit(): void {
    this.removeLegacySearchHistory();
    this.refreshPromptSuggestions();
    this.refreshConversations();
  }

  search(): void {
    if (this.form.invalid || this.conversationBusy()) {
      return;
    }

    const query = this.form.controls.query.value.trim();
    const filter = this.form.controls.filter.value;
    const sourceRootIds = this.selectedRetrievalSources();
    const retrievalMode = sourceRootIds.length === 0 ? 'off' : this.form.controls.retrievalMode.value;
    if (retrievalMode !== this.form.controls.retrievalMode.value) {
      this.form.controls.retrievalMode.setValue(retrievalMode);
    }
    const useRetrieval = retrievalMode !== 'off';
    this.rememberSearchTerm(query);
    const payload = buildHarborAssistantSearchPayload(
      query,
      filter,
      null,
      {
        from: this.localDateTimeToUnixSeconds(this.form.controls.from.value),
        sourceRootIds,
        sourceScope: 'all',
        to: this.localDateTimeToUnixSeconds(this.form.controls.to.value),
        retrievalMode,
      },
    );
    if (sourceRootIds.length === 0) {
      delete payload.source_root_ids;
    }
    payload.conversation_id = this.activeConversationId();
    const requestConversationId = payload.conversation_id;
    const requestId = ++this.searchRequestSequence;

    this.loading.set(true);
    this.error.set(null);
    this.pendingQuery.set(query);
    this.form.controls.query.setValue('');
    this.scrollToLatestTurn();

    this.api.search(payload).pipe(
      finalize(() => {
        if (requestId !== this.searchRequestSequence) {
          return;
        }
        this.loading.set(false);
        this.pendingQuery.set(null);
        this.scrollToLatestTurn();
      }),
    ).subscribe({
      next: (response) => {
        if (requestId !== this.searchRequestSequence || this.activeConversationId() !== requestConversationId) {
          return;
        }
        this.response.set(response);
        this.chatTurns.update((turns) => [
          ...turns,
          {
            id: this.nextTurnId++, query, filter, useRetrieval, response,
          },
        ]);
        this.scrollToLatestTurn();
        this.refreshConversations();
      },
      error: (error: unknown) => {
        if (requestId !== this.searchRequestSequence || this.activeConversationId() !== requestConversationId) {
          return;
        }
        this.response.set(null);
        const message = harborAssistantSearchErrorMessage(error);
        this.error.set(message);
        this.chatTurns.update((turns) => [
          ...turns,
          {
            id: this.nextTurnId++, query, filter, useRetrieval, error: message,
          },
        ]);
        this.scrollToLatestTurn();
      },
    });
  }

  clearConversation(): void {
    if (this.conversationBusy()) {
      return;
    }
    this.resetConversation(this.newConversationId());
  }

  loadConversation(conversationId: string): void {
    if (this.conversationBusy() || conversationId === this.activeConversationId()) {
      return;
    }
    const requestId = ++this.conversationLoadSequence;
    this.conversationHistoryLoading.set(true);
    this.api.conversation(conversationId).pipe(
      finalize(() => {
        if (requestId === this.conversationLoadSequence) {
          this.conversationHistoryLoading.set(false);
        }
      }),
    ).subscribe({
      next: (detail) => {
        if (requestId !== this.conversationLoadSequence || detail.conversation_id !== conversationId) {
          return;
        }
        this.activeConversationId.set(detail.conversation_id);
        this.searchRequestSequence += 1;
        this.nextTurnId = 1;
        this.chatTurns.set(detail.turns.map((turn) => ({
          id: this.nextTurnId++,
          query: turn.query,
          filter: 'all',
          useRetrieval: turn.response.query_understanding?.needs_retrieval ?? true,
          response: normalizeHarborAssistantSearchResponse(turn.response, detail.conversation_id),
        })));
        const turns = this.chatTurns();
        this.response.set(turns[turns.length - 1]?.response ?? null);
        this.error.set(null);
        this.scrollToLatestTurn();
      },
      error: () => {
        if (requestId === this.conversationLoadSequence) {
          this.error.set('Unable to load this conversation.');
        }
      },
    });
  }

  deleteConversation(event: Event, conversationId: string): void {
    event.stopPropagation();
    if (this.conversationBusy()) {
      return;
    }
    this.dialogService.confirm({
      title: this.translate.instant('Delete conversation'),
      message: this.translate.instant('Are you sure you want to delete this conversation? This cannot be undone.'),
      buttonText: this.translate.instant('Delete'),
      buttonColor: 'warn',
      hideCheckbox: true,
    }).pipe(
      filterOperator(Boolean),
      switchMap(() => {
        this.setConversationDeleting(conversationId, true);
        return this.api.deleteConversation(conversationId).pipe(
          finalize(() => this.setConversationDeleting(conversationId, false)),
        );
      }),
    ).subscribe({
      next: () => {
        if (conversationId === this.activeConversationId()) {
          this.resetConversation(this.newConversationId());
        }
        this.refreshConversations();
      },
      error: () => this.error.set('Unable to delete this conversation.'),
    });
  }

  saveConversationSettings(): void {
    if (this.conversationSettingsForm.invalid || this.conversationBusy()) {
      return;
    }
    const settings = this.conversationSettingsForm.getRawValue();
    this.conversationSettingsSaving.set(true);
    this.api.saveConversationSettings(settings).pipe(
      finalize(() => this.conversationSettingsSaving.set(false)),
    ).subscribe({
      next: (saved) => {
        this.conversationSettingsForm.setValue(saved);
        this.refreshConversations();
      },
      error: () => this.error.set('Unable to save conversation settings.'),
    });
  }

  usePromptSuggestion(suggestion: HarborAssistantSearchPromptSuggestion): void {
    this.form.patchValue({
      query: suggestion.query,
      filter: suggestion.filter,
      from: '',
      to: '',
    });
    this.error.set(null);
  }

  private refreshPromptSuggestions(): void {
    this.api.suggestions().subscribe({
      next: (response) => {
        this.promptSuggestions.set(response.suggestions.map((suggestion) => {
          const template = suggestion.kind === 'describe'
            ? 'Show me content about “{subject}”'
            : 'What can I learn about “{subject}”?';
          const query = this.translate.instant(template, { subject: suggestion.subject });
          return {
            label: query,
            query,
            filter: suggestion.filter,
          };
        }));
      },
      error: () => this.promptSuggestions.set([]),
    });
  }

  useSearchHistoryTerm(term: string): void {
    this.form.controls.query.setValue(term);
    this.form.controls.query.markAsDirty();
    this.error.set(null);
  }

  clearSearchHistory(): void {
    this.searchHistory.set([]);
  }

  waterfallItems(
    result: HarborAssistantSearchResponse,
    filter: HarborAssistantSearchResultFilter,
  ): HarborAssistantSearchWaterfallItem[] {
    return buildHarborAssistantSearchWaterfallItems(result, filter);
  }

  noResults(result: HarborAssistantSearchResponse, filter: HarborAssistantSearchResultFilter): boolean {
    return this.waterfallItems(result, filter).length === 0;
  }

  toggleRetrievalSource(source: HarborAssistantRetrievalSource['id']): void {
    this.selectedRetrievalSources.update((selected) => {
      const next = selected.includes(source)
        ? selected.filter((item) => item !== source)
        : [...selected, source];
      if (next.length === 0) {
        this.form.controls.retrievalMode.setValue('off');
      }
      return next;
    });
  }

  toggleAllRetrievalSources(): void {
    const next = this.allRetrievalSourcesSelected()
      ? []
      : this.retrievalSources().map((source) => source.id);
    this.selectedRetrievalSources.set(next);
    if (next.length === 0) {
      this.form.controls.retrievalMode.setValue('off');
    }
  }

  retrievalSourceSelected(source: HarborAssistantRetrievalSource['id']): boolean {
    return this.selectedRetrievalSources().includes(source);
  }

  allRetrievalSourcesSelected(): boolean {
    const sourceCount = this.retrievalSources().length;
    return sourceCount > 0 && this.selectedRetrievalSources().length === sourceCount;
  }

  retrievalSourceLabel(): string {
    const count = this.selectedRetrievalSources().length;
    if (count === 0) {
      return 'No knowledge selected';
    }
    if (count === this.retrievalSources().length) {
      return 'All configured folders';
    }
    return this.retrievalSources().find((source) => this.retrievalSourceSelected(source.id))?.label
      ?? 'Selected folders';
  }

  retrievalModeHint(): string {
    switch (this.form.controls.retrievalMode.value) {
      case 'on':
        return 'Every message will search the selected local knowledge before answering.';
      case 'off':
        return 'Messages will use ordinary conversation without searching local knowledge.';
      case 'auto':
      default:
        return 'The assistant automatically decides between ordinary conversation and local knowledge retrieval.';
    }
  }

  retrievalModeLabel(): string {
    switch (this.form.controls.retrievalMode.value) {
      case 'on':
        return this.translate.instant('Force retrieval');
      case 'off':
        return this.translate.instant('Ordinary chat');
      case 'auto':
      default:
        return this.translate.instant('Automatic');
    }
  }

  openAdvancedRetrievalSettings(): void {
    if (this.retrievalSettingsBusy()) {
      return;
    }
    if (this.searchSettings?.nativeElement) {
      this.searchSettings.nativeElement.open = false;
    }
    this.retrievalSettingsBusy.set(true);
    this.api.retrievalSettings().pipe(
      finalize(() => this.retrievalSettingsBusy.set(false)),
    ).subscribe({
      next: (settings) => {
        this.dialog.open<
          HarborAssistantRetrievalSettingsDialogComponent,
          HarborAssistantRetrievalSettingsDialogData,
          HarborAssistantRetrievalSettings | undefined
        >(HarborAssistantRetrievalSettingsDialogComponent, {
          data: { settings },
          width: 'min(880px, calc(100vw - 24px))',
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100dvh - 24px)',
          panelClass: 'harbor-assistant-retrieval-dialog-panel',
        }).afterClosed().subscribe((saved) => {
          if (saved) {
            this.saveAdvancedRetrievalSettings(saved);
          }
        });
      },
      error: () => this.error.set('Unable to load advanced retrieval settings.'),
    });
  }

  protected closeSearchSettingsOnOutsideClick(event: Event): void {
    const settings = this.searchSettings?.nativeElement;
    const target = event.target;
    if (settings?.open && target instanceof Node && !settings.contains(target)) {
      settings.open = false;
    }
  }

  conversationResponse(result: HarborAssistantSearchResponse | null = this.response()): boolean {
    return result?.answer_intent === 'conversation';
  }

  hasAnyResult(result: HarborAssistantSearchResponse | null = this.response()): boolean {
    return !harborAssistantSearchHasNoResults(result);
  }

  embeddingUnavailable(result: HarborAssistantSearchResponse | null = this.response()): boolean {
    const reason = result?.degraded_reason?.toLowerCase() ?? '';
    const messages = [...(result?.warnings ?? []), ...(result?.blockers ?? [])];
    return reason === 'embedding_unavailable'
      || reason === 'embedding_model_unavailable'
      || messages.some((message) => this.embeddingUnavailableMessage(message));
  }

  indexJobProgress(job: KnowledgeIndexJobRecord): number {
    return Math.min(100, Math.max(0, job.progress_percent ?? 0));
  }

  indexJobPhaseLabel(job: KnowledgeIndexJobRecord): string {
    switch (job.checkpoint?.phase) {
      case 'load_or_refresh':
        return 'Scanning files and detecting changes';
      case 'embedding_warmup':
        return 'Generating missing vectors';
      default:
        return job.status === 'queued' ? 'Waiting to start' : 'Indexing knowledge files';
    }
  }

  openHarborAssistantModels(): void {
    this.window.open('/ui/harbor-assistant?tab=settings&section=ai&focus=semantic-index', '_blank', 'noopener');
  }

  openPreview(item: HarborAssistantSearchWaterfallItem): void {
    this.window.open(item.previewUrl, '_blank', 'noopener');
  }

  timeRangeLabel(): string {
    const from = this.formatLocalDateTimeLabel(this.form.controls.from.value);
    const to = this.formatLocalDateTimeLabel(this.form.controls.to.value);
    if (!from && !to) {
      return this.translate.instant('All time');
    }
    return `${from || this.translate.instant('Any')} - ${to || this.translate.instant('Any')}`;
  }

  hasTimeRange(): boolean {
    return Boolean(this.form.controls.from.value || this.form.controls.to.value);
  }

  openTimeRangeDialog(): void {
    this.dialog.open<HarborTimeRangeDialogComponent, HarborTimeRangeValue, HarborTimeRangeValue | null>(
      HarborTimeRangeDialogComponent,
      {
        width: '560px',
        data: {
          from: this.form.controls.from.value,
          to: this.form.controls.to.value,
        },
      },
    ).afterClosed().subscribe((value) => {
      if (!value) {
        return;
      }
      this.form.patchValue(value);
      this.form.markAsDirty();
    });
  }

  clearTimeRange(): void {
    this.form.patchValue({ from: '', to: '' });
    this.form.markAsDirty();
  }

  resultTrackKey(index: number, item: HarborAssistantSearchWaterfallItem): string {
    return `${item.kind}:${item.hit.path}:${item.hit.chunk_id ?? index}`;
  }

  kindLabel(item: HarborAssistantSearchWaterfallItem): string {
    if (item.kind === 'audio') {
      return 'Audio';
    }
    if (item.kind === 'image') {
      return 'Image';
    }
    if (item.kind === 'video') {
      return 'Video';
    }
    return 'Text';
  }

  scoreLabel(hit: HarborAssistantSearchHit): string {
    return `${hit.score}`;
  }

  videoPreviewUrl(item: HarborAssistantSearchWaterfallItem): string {
    return `${item.previewUrl}#t=0.1`;
  }

  sourceKinds(hit: HarborAssistantSearchHit): string {
    const kinds = hit.content_source_kinds ?? [];
    if (kinds.length > 0) {
      return kinds.join(', ');
    }
    return hit.provenance || hit.source_path || 'indexed';
  }

  matchedTerms(hit: HarborAssistantSearchHit): string {
    return (hit.matched_terms ?? []).join(', ');
  }

  summary(hit: HarborAssistantSearchHit): string {
    return hit.snippet || hit.provenance || hit.path;
  }

  emptyMessage(
    result: HarborAssistantSearchResponse,
    query: string,
    filter: HarborAssistantSearchResultFilter,
  ): string {
    const localizedSpring = this.translate.instant('spring');
    if (
      filter === 'images'
      && (query.toLowerCase().includes('spring') || query.includes(localizedSpring))
    ) {
      return 'The current image filter has no related results. Switch to All to inspect other clues, or add and index a folder with spring photos.';
    }
    if (this.hasAnyResult(result)) {
      return 'No results for the current filter. Switch to a result type that has matches.';
    }
    return result.empty_guidance || result.empty_reason || 'No results found. Try another phrasing, or confirm the data sources are indexed in settings.';
  }

  filterLabel(filter: HarborAssistantSearchResultFilter): string {
    switch (filter) {
      case 'audio':
        return 'Audio';
      case 'images':
        return 'Image';
      case 'text':
        return 'Text';
      case 'videos':
        return 'Video';
      case 'all':
      default:
        return 'All';
    }
  }

  searchStatusLabel(result: HarborAssistantSearchResponse): string {
    if (result.degraded) {
      return 'Degraded';
    }
    return result.status === 'ok' ? 'Complete' : result.status;
  }

  userFacingSearchNotice(message: string): string {
    if (this.embeddingUnavailableMessage(message)) {
      return 'Vector search model is unavailable, so local lexical search was used temporarily.';
    }
    return message;
  }

  private embeddingUnavailableMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    const identifiesEmbedding = normalized.includes('embedding') || normalized.includes('/v1/embeddings');
    const identifiesFailure = [
      'unavailable',
      'not available',
      'not configured',
      'connection refused',
      'failed to connect',
    ].some((failureSignal) => normalized.includes(failureSignal));
    return identifiesEmbedding && identifiesFailure;
  }

  submitOnEnter(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.shiftKey || keyboardEvent.isComposing) {
      return;
    }
    keyboardEvent.preventDefault();
    this.search();
  }

  private localDateTimeToUnixSeconds(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const timestamp = new Date(trimmed).getTime();
    if (!Number.isFinite(timestamp)) {
      return null;
    }
    return Math.floor(timestamp / 1000).toString();
  }

  private saveAdvancedRetrievalSettings(settings: HarborAssistantRetrievalSettings): void {
    this.retrievalSettingsBusy.set(true);
    this.api.saveRetrievalSettings(settings).pipe(
      finalize(() => this.retrievalSettingsBusy.set(false)),
    ).subscribe({
      next: () => this.error.set(null),
      error: () => this.error.set('Unable to save advanced retrieval settings.'),
    });
  }

  private formatLocalDateTimeLabel(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) {
      return '';
    }
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
  }

  private scrollToLatestTurn(): void {
    setTimeout(() => {
      const element = this.chatScroll?.nativeElement;
      element?.scrollTo?.({ top: element.scrollHeight, behavior: 'smooth' });
    });
  }

  private refreshConversations(): void {
    this.api.conversations().subscribe({
      next: (result) => {
        this.conversations.set(result.conversations);
        if (result.settings) {
          this.conversationSettingsForm.setValue(result.settings);
        }
      },
      error: () => {
        // Conversation history is supplementary; keep the active chat usable.
      },
    });
  }

  private newConversationId(): string {
    return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private rememberSearchTerm(value: string): void {
    const term = value.trim().replace(/\s+/g, ' ');
    if (!term) {
      return;
    }
    const next = [
      term,
      ...this.searchHistory().filter((item) => item !== term),
    ].slice(0, 10);
    this.searchHistory.set(next);
  }

  private removeLegacySearchHistory(): void {
    try {
      this.window.localStorage.removeItem(this.searchHistoryStorageKey);
    } catch {
      // The in-memory suggestions remain available when browser storage is disabled.
    }
  }

  private resetConversation(conversationId: string): void {
    this.searchRequestSequence += 1;
    this.conversationLoadSequence += 1;
    this.activeConversationId.set(conversationId);
    this.chatTurns.set([]);
    this.pendingQuery.set(null);
    this.response.set(null);
    this.error.set(null);
  }

  protected conversationDeleting(conversationId: string): boolean {
    return this.deletingConversationIds().has(conversationId);
  }

  private setConversationDeleting(conversationId: string, deleting: boolean): void {
    this.deletingConversationIds.update((current) => {
      const next = new Set(current);
      if (deleting) {
        next.add(conversationId);
      } else {
        next.delete(conversationId);
      }
      return next;
    });
  }
}

import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnDestroy, ViewChild, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { RouterLink } from '@angular/router';
import { marker as T } from '@biesbjerg/ngx-translate-extract-marker';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { WINDOW } from 'app/helpers/window.helper';
import { AuthService } from 'app/modules/auth/auth.service';
import { AssistantResponsePreference, AssistantSessionStore, AssistantRetrievalMode, AssistantResultFilter } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import { HarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

@Component({
  selector: 'ix-global-assistant-composer',
  host: { '[class.assistant-results-open]': 'session.resultsOpen()' },
  templateUrl: './global-assistant-composer.component.html',
  styleUrl: './global-assistant-composer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButton, MatMenu, MatMenuItem, MatMenuTrigger, RouterLink, TranslateModule],
})
export class GlobalAssistantComposerComponent implements AfterViewInit, OnDestroy {
  protected readonly session = inject(AssistantSessionStore);
  private readonly auth = inject(AuthService);
  private readonly window = inject(WINDOW);
  private readonly previewUrls = new Set<string>();
  private readonly imageRequests = new Map<string, Subscription>();
  protected readonly imagePreviewUrls = signal<Record<string, string>>({});
  protected readonly imagePreviewErrors = signal<Record<string, boolean>>({});
  private readonly api = inject(HarborAssistantContentApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private resizeObserver?: ResizeObserver;
  @ViewChild('composer') private composer?: ElementRef<HTMLElement>;
  protected readonly options = signal<'sources' | 'time' | 'history' | null>(null);
  protected readonly citationError = signal<string | null>(null);

  constructor() {
    this.auth.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      this.session.bindUser(user?.pw_name ?? '');
    });
    effect(() => {
      const paths = this.session.resultsOpen()
        ? this.session.turns().flatMap((turn) => (turn.response?.images ?? []).map((image) => image.path))
        : [];
      untracked(() => this.syncImagePreviews(new Set(paths.filter((path) => path?.startsWith('/')))));
    });
  }

  ngAfterViewInit(): void {
    const composer = this.composer?.nativeElement;
    const layout = this.element.nativeElement.closest<HTMLElement>('ix-admin-layout');
    if (!composer || !layout || typeof ResizeObserver === 'undefined') {
      return;
    }
    const updateHeight = (): void => {
      layout.style.setProperty('--assistant-composer-height', `${composer.getBoundingClientRect().height}px`);
    };
    this.resizeObserver = new ResizeObserver(updateHeight);
    this.resizeObserver.observe(composer);
    updateHeight();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.syncImagePreviews(new Set());
    this.previewUrls.forEach((url) => URL.revokeObjectURL(url));
    this.element.nativeElement.closest<HTMLElement>('ix-admin-layout')?.style.removeProperty('--assistant-composer-height');
  }

  private syncImagePreviews(paths: Set<string>): void {
    for (const [path, request] of this.imageRequests) {
      if (paths.has(path)) {
        continue;
      }
      request.unsubscribe();
      this.imageRequests.delete(path);
      const objectUrl = this.imagePreviewUrls()[path];
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      this.imagePreviewUrls.update((urls) => {
        const next = { ...urls };
        delete next[path];
        return next;
      });
      this.imagePreviewErrors.update((errors) => {
        const next = { ...errors };
        delete next[path];
        return next;
      });
    }
    for (const path of paths) {
      if (this.imageRequests.has(path)) {
        continue;
      }
      const request = new Subscription();
      this.imageRequests.set(path, request);
      request.add(this.api.preview(path).subscribe({
        next: (blob) => {
          if (this.imageRequests.get(path) !== request) {
            return;
          }
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) {
            this.imagePreviewErrors.update((errors) => ({ ...errors, [path]: true }));
            return;
          }
          const objectUrl = URL.createObjectURL(blob);
          const previous = this.imagePreviewUrls()[path];
          if (previous) {
            URL.revokeObjectURL(previous);
          }
          this.imagePreviewUrls.update((urls) => ({ ...urls, [path]: objectUrl }));
        },
        error: () => {
          if (this.imageRequests.get(path) === request) {
            this.imagePreviewErrors.update((errors) => ({ ...errors, [path]: true }));
          }
        },
      }));
    }
  }

  protected photoDescription(snippet: string): string {
    return Array.from(snippet).slice(0, 220).join('');
  }

  protected imagePreviewFailed(path: string): void {
    if (!this.imageRequests.has(path)) {
      return;
    }
    const objectUrl = this.imagePreviewUrls()[path];
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    this.imagePreviewUrls.update((urls) => {
      const next = { ...urls };
      delete next[path];
      return next;
    });
    this.imagePreviewErrors.update((errors) => ({ ...errors, [path]: true }));
  }

  protected openImage(path: string): void {
    this.openCitation(this.api.previewUrl(path));
  }

  protected openOptions(option: 'sources' | 'time' | 'history'): void {
    this.options.set(option);
    if (option === 'sources') {
      this.session.refreshSources();
    }
    if (option === 'history') {
      this.session.refreshHistory();
    }
  }

  protected setRetrievalMode(value: string): void {
    this.session.updateDraft({ retrievalMode: value as AssistantRetrievalMode });
  }

  protected responsePreferenceLabel(): string {
    if (this.session.draft().responsePreference === 'fast') {
      return T('Fast');
    }
    if (this.session.draft().responsePreference === 'careful') {
      return T('Careful');
    }
    return T('Automatic');
  }

  protected setResponsePreference(value: string): void {
    this.session.updateDraft({ responsePreference: value as AssistantResponsePreference });
  }

  protected setFilter(value: string): void {
    this.session.updateDraft({ filter: value as AssistantResultFilter });
  }

  protected send(event: Event): void {
    event.preventDefault();
    this.options.set(null);
    this.session.send();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.session.send();
    }
  }

  protected summary(response: HarborAssistantSearchResponse): string {
    return response.reply_pack?.summary?.trim() ?? '';
  }

  protected verificationNotice(response: HarborAssistantSearchResponse): string | null {
    const status = response.verification_status ?? response.image_verification?.status;
    if (status === 'skipped') {
      return T('Indexed results · not visually verified');
    }
    if (status === 'not_run') {
      return T('No matching candidates · not visually verified');
    }
    if (status === 'completed') {
      return T('Visual verification completed');
    }
    if (status === 'degraded' || status === 'failed') {
      return T('Visual verification incomplete · review the blockers');
    }
    return null;
  }

  protected answerNotice(response: HarborAssistantSearchResponse): string {
    if (response.degraded || response.blockers?.length || response.warnings?.length) {
      return T('Knowledge search returned a degraded result. Review the blockers and indexed evidence before relying on it.');
    }
    if (response.total_matches > 0 || response.reply_pack?.citations?.length) {
      return T('Indexed evidence was found, but no generated answer was returned.');
    }
    return T('No indexed evidence or generated answer was returned.');
  }

  protected modelRows(response: HarborAssistantSearchResponse): { label: string; value: string }[] {
    if (typeof response.model === 'string') {
      return response.model.trim() ? [{ label: T('Model'), value: response.model }] : [];
    }
    if (!response.model || typeof response.model !== 'object') {
      return [];
    }
    const model = response.model;
    const metadata = model['metadata'] && typeof model['metadata'] === 'object'
      ? model['metadata'] as Record<string, unknown>
      : {};
    const fields = [
      [T('Model'), model['model_name'] ?? model['name']],
      [T('Runtime'), model['runtime_backend_kind'] ?? metadata['runtime_backend_kind']],
      [T('Device'), model['runtime_device'] ?? metadata['runtime_device']],
      [T('Base URL'), model['base_url'] ?? metadata['base_url']],
      [T('Persistent'), model['persistent'] ?? metadata['persistent']],
    ];
    return fields.flatMap(([label, value]) => {
      return (typeof value === 'string' && value.trim()) || typeof value === 'boolean'
        ? [{ label: String(label), value: String(value) }]
        : [];
    });
  }

  protected citationLabel(citation: unknown): string {
    if (typeof citation === 'string') {
      return citation;
    }
    if (citation && typeof citation === 'object') {
      const record = citation as Record<string, unknown>;
      return String(record['title'] || record['source_path'] || record['path'] || record['citation_id'] || T('Source'));
    }
    return T('Source');
  }

  protected openCitation(url: string): void {
    this.citationError.set(null);
    const preview = this.window.open('about:blank', '_blank');
    if (!preview) {
      this.citationError.set(T('Allow pop-ups to open the source preview.'));
      return;
    }
    preview.opener = null;
    const path = new URL(url, this.window.location.origin).searchParams.get('path');
    if (!path?.startsWith('/')) {
      preview.close();
      this.citationError.set(T('The source preview could not be loaded. Check source access and availability.'));
      return;
    }
    this.api.preview(path).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        const safeTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
        const previewBlob = new Blob([blob], { type: safeTypes.includes(blob.type) ? blob.type : 'text/plain' });
        const objectUrl = URL.createObjectURL(previewBlob);
        this.previewUrls.add(objectUrl);
        preview.location.href = objectUrl;
      },
      error: () => {
        preview.close();
        this.citationError.set(T('The source preview could not be loaded. Check source access and availability.'));
      },
    });
  }

  protected citationUrl(citation: unknown): string | null {
    if (!citation || typeof citation !== 'object') {
      return null;
    }
    const record = citation as Record<string, unknown>;
    const path = record['source_path'] || record['path'];
    return typeof path === 'string' && path.startsWith('/') ? this.api.previewUrl(path) : null;
  }
}

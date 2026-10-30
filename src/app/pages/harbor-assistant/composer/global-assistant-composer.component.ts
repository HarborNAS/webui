import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from 'app/modules/auth/auth.service';
import { AssistantSessionStore, AssistantRetrievalMode, AssistantResultFilter } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import { HarborAssistantSearchResponse } from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

@Component({
  selector: 'ix-global-assistant-composer',
  templateUrl: './global-assistant-composer.component.html',
  styleUrl: './global-assistant-composer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButton, MatMenu, MatMenuItem, MatMenuTrigger, TranslateModule],
})
export class GlobalAssistantComposerComponent implements AfterViewInit, OnDestroy {
  protected readonly session = inject(AssistantSessionStore);
  private readonly auth = inject(AuthService);
  private readonly api = inject(HarborAssistantContentApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private resizeObserver?: ResizeObserver;
  @ViewChild('composer') private composer?: ElementRef<HTMLElement>;
  protected readonly options = signal<'sources' | 'time' | 'history' | null>(null);

  constructor() {
    this.auth.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      this.session.bindUser(user?.pw_name ?? '');
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
    this.element.nativeElement.closest<HTMLElement>('ix-admin-layout')?.style.removeProperty('--assistant-composer-height');
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
    return response.reply_pack?.summary || 'The server returned no answer.';
  }

  protected citationLabel(citation: unknown): string {
    if (typeof citation === 'string') {
      return citation;
    }
    if (citation && typeof citation === 'object') {
      const record = citation as Record<string, unknown>;
      return String(record['title'] || record['source_path'] || record['path'] || record['citation_id'] || 'Source');
    }
    return 'Source';
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

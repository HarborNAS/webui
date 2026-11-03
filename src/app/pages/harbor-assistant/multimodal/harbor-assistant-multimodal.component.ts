import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import { AssistantSessionStore } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { ModelEndpointRecord, ModelRoutePolicyRecord } from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import {
  AssistantAudioLanguage,
  AssistantMultimodalKind,
  AssistantVoice,
  HarborAssistantMultimodalApiService,
} from 'app/pages/harbor-assistant/multimodal/harbor-assistant-multimodal-api.service';

interface MultimodalStatus {
  kind: AssistantMultimodalKind;
  endpoint: ModelEndpointRecord | undefined;
}

const mib = 1024 * 1024;

@Component({
  selector: 'ix-harbor-assistant-multimodal',
  templateUrl: './harbor-assistant-multimodal.component.html',
  styleUrls: ['./harbor-assistant-multimodal.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButton, TranslateModule],
})
export class HarborAssistantMultimodalComponent {
  private readonly api = inject(HarborAssistantMultimodalApiService);
  private readonly session = inject(AssistantSessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private imageFile: File | null = null;
  private audioFile: File | null = null;
  private imageReader: FileReader | null = null;
  private speechSequence = 0;

  readonly endpoints = input<readonly ModelEndpointRecord[]>([]);
  readonly routePolicies = input<readonly ModelRoutePolicyRecord[]>([]);
  readonly endpointsLoading = input(false);
  readonly endpointsError = input<string | null>(null);
  protected readonly statuses = computed<MultimodalStatus[]>(() => {
    const policies = { vlm: 'retrieval.vision_summary', asr: 'retrieval.asr', tts: 'assistant.tts' };
    return (['vlm', 'asr', 'tts'] as const).map((kind) => {
      const policy = this.routePolicies().find((candidate) => candidate.route_policy_id === policies[kind]);
      const pin = policy?.metadata?.['model_endpoint_id'];
      let endpoint: ModelEndpointRecord | undefined;
      if (typeof pin === 'string' && pin.trim()) {
        if (policy?.status === 'active') {
          endpoint = this.endpoints().find(
            (candidate) => candidate.model_endpoint_id === pin
              && candidate.model_kind === kind
              && candidate.status === 'active',
          );
        }
      } else {
        endpoint = this.endpoints().find((candidate) => candidate.model_kind === kind && candidate.status === 'active')
          ?? this.endpoints().find((candidate) => candidate.model_kind === kind);
      }
      return { kind, endpoint };
    });
  });

  protected readonly imageName = signal('');
  protected readonly imagePreview = signal('');
  protected readonly question = signal('');
  protected readonly imageReply = signal('');
  protected readonly imageError = signal<string | null>(null);
  protected readonly imageBusy = signal(false);
  protected readonly audioName = signal('');
  protected readonly language = signal<AssistantAudioLanguage>('auto');
  protected readonly transcript = signal('');
  protected readonly transcriptionError = signal<string | null>(null);
  protected readonly transcriptionBusy = signal(false);
  protected readonly transcriptCopied = signal(false);
  protected readonly speechText = signal('');
  protected readonly voice = signal<AssistantVoice>('');
  protected readonly speechUrl = signal('');
  protected readonly speechError = signal<string | null>(null);
  protected readonly speechBusy = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.imageReader?.abort();
      this.revokeUrl(this.imagePreview());
      this.revokeUrl(this.speechUrl());
    });
  }

  protected selectImage(event: Event): void {
    const file = this.selectedFile(event);
    if (!file) {
      return;
    }
    this.imageReply.set('');
    this.imageError.set(null);
    this.imageFile = null;
    this.imageName.set('');
    this.revokeUrl(this.imagePreview());
    this.imagePreview.set('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * mib) {
      this.imageError.set('Choose a PNG, JPEG or WebP image up to 10 MiB.');
      return;
    }
    this.imageFile = file;
    this.imageName.set(file.name);
    this.imagePreview.set(URL.createObjectURL(file));
  }

  protected describeImage(): void {
    const question = this.question().trim();
    if (!this.imageFile || !question || this.imageBusy()) {
      return;
    }
    this.imageBusy.set(true);
    this.imageError.set(null);
    this.imageReply.set('');
    const reader = new FileReader();
    this.imageReader = reader;
    reader.onerror = (): void => {
      this.imageReader = null;
      this.imageError.set('The selected image could not be read.');
      this.imageBusy.set(false);
    };
    reader.onload = (): void => {
      this.imageReader = null;
      if (typeof reader.result !== 'string') {
        this.imageError.set('The selected image could not be read.');
        this.imageBusy.set(false);
        return;
      }
      this.api.describeImage(reader.result, question).pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.imageBusy.set(false)),
      ).subscribe({
        next: (response) => {
          const answer = response.choices?.[0]?.message?.content?.trim();
          if (!answer) {
            this.imageError.set('The image endpoint returned no answer.');
            return;
          }
          this.imageReply.set(answer);
        },
        error: (error: unknown) => this.imageError.set(this.errorMessage(error)),
      });
    };
    reader.readAsDataURL(this.imageFile);
  }

  protected selectAudio(event: Event): void {
    const file = this.selectedFile(event);
    if (!file) {
      return;
    }
    this.audioFile = null;
    this.audioName.set('');
    this.transcript.set('');
    this.transcriptCopied.set(false);
    this.transcriptionError.set(null);
    if (file.size > 25 * mib || !/\.(wav|mp3|m4a|webm|ogg|flac|mp4)$/i.test(file.name)) {
      this.transcriptionError.set('Choose a WAV, MP3, M4A, WebM, OGG, FLAC or MP4 audio file up to 25 MiB.');
      return;
    }
    this.audioFile = file;
    this.audioName.set(file.name);
  }

  protected transcribe(): void {
    if (!this.audioFile || this.transcriptionBusy()) {
      return;
    }
    this.transcriptionBusy.set(true);
    this.transcriptionError.set(null);
    this.transcript.set('');
    this.transcriptCopied.set(false);
    this.api.transcribe(this.audioFile, this.language()).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.transcriptionBusy.set(false)),
    ).subscribe({
      next: (response) => {
        if (!response.text?.trim()) {
          this.transcriptionError.set('The transcription endpoint returned no text.');
          return;
        }
        this.transcript.set(response.text.trim());
      },
      error: (error: unknown) => this.transcriptionError.set(this.errorMessage(error)),
    });
  }

  protected useTranscript(): void {
    if (!this.transcript().trim()) {
      return;
    }
    const previous = this.session.draft().text.trim();
    this.session.updateDraft({ text: [previous, this.transcript().trim()].filter(Boolean).join('\n') });
    this.transcriptCopied.set(true);
  }

  protected speak(): void {
    const text = this.speechText().trim();
    if (!text || this.speechBusy()) {
      return;
    }
    this.speechError.set(null);
    if (text.length > 2000) {
      this.speechError.set('Use up to 2000 characters for speech.');
      return;
    }
    const sequence = ++this.speechSequence;
    this.speechBusy.set(true);
    this.revokeUrl(this.speechUrl());
    this.speechUrl.set('');
    this.api.speak(text, this.voice()).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.speechBusy.set(false)),
    ).subscribe({
      next: (audio) => {
        if (!audio.size || !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(audio.type.split(';')[0])) {
          this.speechError.set('The speech endpoint returned no WAV audio.');
          return;
        }
        this.speechUrl.set(URL.createObjectURL(audio));
      },
      error: async (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
          try {
            const detail: unknown = JSON.parse(await error.error.text());
            if (this.destroyRef.destroyed || sequence !== this.speechSequence) {
              return;
            }
            this.speechError.set(this.errorMessage(new HttpErrorResponse({ status: error.status, error: detail })));
            return;
          } catch {
            // Preserve the real HTTP failure when the response body cannot be decoded.
          }
        }
        if (!this.destroyRef.destroyed && sequence === this.speechSequence) {
          this.speechError.set(this.errorMessage(error));
        }
      },
    });
  }

  protected metadata(endpoint: ModelEndpointRecord, key: string): string {
    const value = endpoint.metadata?.[key];
    return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' ? String(value) : '';
  }

  private selectedFile(event: Event): File | null {
    return event.target instanceof HTMLInputElement ? event.target.files?.[0] ?? null : null;
  }

  private revokeUrl(url: string): void {
    if (url) {
      URL.revokeObjectURL(url);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const detail: unknown = error.error;
      if (detail && typeof detail === 'object') {
        const record = detail as Record<string, unknown>;
        const nested = record['error'];
        if (nested && typeof nested === 'object') {
          const message = (nested as Record<string, unknown>)['message'];
          if (typeof message === 'string') {
            return message.slice(0, 600);
          }
        }
        for (const key of ['message', 'error', 'detail']) {
          if (typeof record[key] === 'string') {
            return (record[key] as string).slice(0, 600);
          }
        }
      }
      return error.status === 0
        ? 'The endpoint could not be reached. Check its runtime and connection.'
        : `Endpoint request failed (HTTP ${error.status}). Check the configured runtime.`;
    }
    return 'The endpoint request failed. Check the configured runtime.';
  }
}

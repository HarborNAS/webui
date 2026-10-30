import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ChatCompletionResponse } from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import { harborAssistantBeaconApiUrl } from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';

export type AssistantAudioLanguage = 'auto' | 'en' | 'zh';
export type AssistantVoice = '' | 'zh_CN-huayan-medium' | 'en_US-lessac-medium';
export type AssistantMultimodalKind = 'vlm' | 'asr' | 'tts';

export interface AssistantTranscription {
  text: string;
  language?: string;
}

@Injectable({ providedIn: 'root' })
export class HarborAssistantMultimodalApiService {
  private readonly http = inject(HttpClient);

  describeImage(imageDataUrl: string, question: string): Observable<ChatCompletionResponse> {
    return this.http.post<ChatCompletionResponse>(harborAssistantBeaconApiUrl('/inference/v1/vision/chat/completions'), {
      model: 'automatic',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      }],
      stream: false,
      max_tokens: 128,
    });
  }

  transcribe(file: File, language: AssistantAudioLanguage): Observable<AssistantTranscription> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('language', language);
    return this.http.post<AssistantTranscription>(harborAssistantBeaconApiUrl('/inference/v1/audio/transcriptions'), form);
  }

  speak(input: string, voice: AssistantVoice): Observable<Blob> {
    return this.http.post(harborAssistantBeaconApiUrl('/inference/v1/audio/speech'), {
      input,
      response_format: 'wav',
      ...(voice ? { voice } : {}),
    }, { responseType: 'blob' });
  }
}

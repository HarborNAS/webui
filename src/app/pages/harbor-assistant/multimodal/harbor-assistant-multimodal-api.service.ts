import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ChatCompletionResponse } from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import { harborAssistantBeaconApiUrl } from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';

export type AssistantAudioLanguage = 'auto' | 'en' | 'zh';
export type AssistantVoice = '' | 'zh_CN-huayan-medium' | 'en_US-lessac-medium';
export type AssistantMultimodalKind = 'vlm' | 'asr' | 'tts';

const visionPromptInstruction = [
  'Analyze the attached image using only visible evidence.',
  'If it is an application screen, identify the visible page and its main purpose before answering.',
  'For each visible object, report its own shape and color independently; do not transfer attributes between objects or infer a shared color.',
  'Then answer the user request concisely and include the requested visible details.',
  'Do not invent unreadable text, hidden state, or facts that are not visible.',
].join(' ');
const visionMaxTokens = 192;

export interface AssistantTranscription {
  text: string;
  language?: string;
}

@Injectable({ providedIn: 'root' })
export class HarborAssistantMultimodalApiService {
  private readonly http = inject(HttpClient);

  describeImage(imageDataUrl: string, question: string): Observable<ChatCompletionResponse> {
    const prompt = `${visionPromptInstruction} User request: ${question.trim()}`;
    return this.http.post<ChatCompletionResponse>(harborAssistantBeaconApiUrl('/inference/v1/vision/chat/completions'), {
      model: 'automatic',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      }],
      stream: false,
      temperature: 0,
      max_tokens: visionMaxTokens,
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

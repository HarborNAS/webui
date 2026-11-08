import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { harborAssistantGateApiUrl, harborAssistantSetupApiUrl } from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';

export interface AssistantWeixinLogin {
  status: string;
  qrcode_url?: string | null;
  expires_in_seconds?: number;
}

export interface AssistantSetupStatus {
  session_code: string;
  feishu: { app_id?: string; configured: boolean };
  weixin: { configured: boolean; login?: AssistantWeixinLogin | null };
}

export interface AssistantIdentityChallengeStatus {
  challenge_id: string;
  expires_at: string;
  status: 'pending' | 'bound' | 'expired' | 'failed';
}

export interface AssistantIdentityChallenge extends AssistantIdentityChallengeStatus {
  challenge_text: string;
}

export interface AssistantConnectionResult {
  success?: boolean;
  ok?: boolean;
  weixin_login?: AssistantWeixinLogin;
}

@Injectable({ providedIn: 'root' })
export class AssistantConnectionsApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = harborAssistantSetupApiUrl('');

  createFeishuIdentityChallenge(): Observable<AssistantIdentityChallenge> {
    return this.http.post<AssistantIdentityChallenge>(harborAssistantGateApiUrl('/im/feishu/identity-challenges'), {});
  }

  feishuIdentityChallengeStatus(challengeId: string): Observable<AssistantIdentityChallengeStatus> {
    return this.http.get<AssistantIdentityChallengeStatus>(
      harborAssistantGateApiUrl(`/im/feishu/identity-challenges/${encodeURIComponent(challengeId)}`),
    );
  }

  status(): Observable<AssistantSetupStatus> {
    return this.http.get<AssistantSetupStatus>(`${this.baseUrl}/status`);
  }

  configureFeishu(payload: {
    session_code: string; app_id: string; app_secret: string; verification_token: string;
  }): Observable<AssistantConnectionResult> {
    return this.http.post<AssistantConnectionResult>(`${this.baseUrl}/feishu/configure`, payload);
  }

  startWeixinLogin(): Observable<AssistantConnectionResult> {
    return this.http.post<AssistantConnectionResult>(`${this.baseUrl}/weixin/login/start`, {});
  }

  weixinLoginStatus(): Observable<AssistantConnectionResult> {
    return this.http.get<AssistantConnectionResult>(`${this.baseUrl}/weixin/login/status`);
  }

  unbindWeixin(): Observable<AssistantConnectionResult> {
    return this.http.post<AssistantConnectionResult>(`${this.baseUrl}/weixin/unbind`, {});
  }
}

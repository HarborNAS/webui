import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { marker as T } from '@biesbjerg/ngx-translate-extract-marker';
import { TranslateModule } from '@ngx-translate/core';
import { QrCodeModule } from 'ng-qrcode';
import { EMPTY, Subscription, catchError, finalize, switchMap, timer } from 'rxjs';
import {
  AssistantConnectionResult, AssistantConnectionsApiService, AssistantIdentityChallenge,
  AssistantSetupStatus, AssistantWeixinLogin,
} from 'app/pages/harbor-assistant/connections/assistant-connections-api.service';
import { harborAssistantGateRequiresUserToken } from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';

@Component({
  selector: 'ix-assistant-connections',
  templateUrl: './assistant-connections.component.html',
  styleUrl: './assistant-connections.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatButton, MatFormField, MatLabel, MatInput, TranslateModule, QrCodeModule],
})
export class AssistantConnectionsComponent implements OnInit {
  private readonly api = inject(AssistantConnectionsApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private readonly fb = inject(NonNullableFormBuilder);
  private sessionCode = '';
  private challengeExpirySubscription?: Subscription;
  protected readonly pairingAvailable = harborAssistantGateRequiresUserToken();
  protected readonly pairingChallenge = signal<AssistantIdentityChallenge | null>(null);
  protected readonly status = signal<Pick<AssistantSetupStatus, 'feishu' | 'weixin'> | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly login = signal<AssistantWeixinLogin | null>(null);
  protected readonly form = this.fb.group({
    appId: ['', Validators.required], appSecret: ['', Validators.required], verificationToken: [''],
  });

  ngOnInit(): void {
    this.refresh();
    this.zone.runOutsideAngular(() => {
      timer(3000, 3000).pipe(
        switchMap(() => (this.login() && ['wait', 'scanned', 'scaned_but_redirect'].includes(this.login().status)
          ? this.api.weixinLoginStatus().pipe(catchError(() => {
              this.error.set(T('Connection status could not be refreshed.'));
              return EMPTY;
            }))
          : EMPTY)),
        takeUntilDestroyed(this.destroyRef),
      ).subscribe({
        next: (result) => {
          if (result.weixin_login) {
            this.login.set(result.weixin_login);
            if (result.weixin_login.status === 'confirmed') {
              this.message.set(T('WeChat account connected.'));
              this.refresh();
            }
          }
        },
        error: () => this.error.set(T('Connection status could not be refreshed.')),
      });
    });
  }

  protected refresh(): void {
    this.api.status().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        this.sessionCode = value.session_code;
        this.status.set({ feishu: value.feishu, weixin: value.weixin });
        this.login.set(value.weixin.login ?? null);
        this.form.controls.appId.setValue(value.feishu.app_id ?? '');
      },
      error: () => this.error.set(T('Connection settings are unavailable. Administrator access is required.')),
    });
  }

  protected saveFeishu(): void {
    if (this.form.invalid || !this.sessionCode || this.busy()) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    const value = this.form.getRawValue();
    this.api.configureFeishu({
      session_code: this.sessionCode,
      app_id: value.appId.trim(),
      app_secret: value.appSecret,
      verification_token: value.verificationToken,
    }).pipe(
      finalize(() => {
        this.busy.set(false);
        this.form.controls.appSecret.reset();
        this.form.controls.verificationToken.reset();
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (result) => {
        if (result.success === true) {
          this.message.set(T('Feishu connection saved and verified.'));
          this.refresh();
        } else {
          this.error.set(T('Feishu connection could not be verified. Check the credentials and try again.'));
        }
      },
      error: () => this.error.set(T('Feishu connection could not be verified. Check the credentials and try again.')),
    });
  }

  protected createIdentityPairing(): void {
    if (!this.pairingAvailable || this.busy() || !this.status()?.feishu?.configured) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    const request$ = this.api.createFeishuIdentityChallenge();
    request$.pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (challenge) => {
        const remaining = Date.parse(challenge.expires_at) - Date.now();
        if (challenge.status !== 'pending' || !challenge.challenge_text?.trim()
          || !Number.isFinite(remaining) || remaining <= 0) {
          this.error.set(T('A valid pairing code could not be created.'));
          return;
        }
        this.pairingChallenge.set(challenge);
        this.challengeExpirySubscription?.unsubscribe();
        this.zone.runOutsideAngular(() => {
          const expiry$ = timer(remaining).pipe(takeUntilDestroyed(this.destroyRef));
          this.challengeExpirySubscription = expiry$.subscribe(() => {
            this.pairingChallenge.set(null);
            this.message.set(T('Pairing code expired. Create a new code.'));
          });
        });
      },
      error: () => this.error.set(T('A valid pairing code could not be created.')),
    });
  }

  protected refreshIdentityPairing(): void {
    const challenge = this.pairingChallenge();
    if (!challenge || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const request$ = this.api.feishuIdentityChallengeStatus(challenge.challenge_id);
    request$.pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        if (result.status === 'pending') {
          this.message.set(T('Waiting for the pairing message from your Feishu account.'));
          return;
        }
        this.challengeExpirySubscription?.unsubscribe();
        this.pairingChallenge.set(null);
        if (result.status === 'failed') {
          this.error.set(T('Pairing could not be completed. Create a new code.'));
        } else {
          this.message.set(result.status === 'bound'
            ? T('Feishu account connected.')
            : T('Pairing code expired. Create a new code.'));
        }
      },
      error: () => this.error.set(T('Pairing status could not be refreshed.')),
    });
  }

  protected startWeixin(): void {
    this.runWeixinAction('start');
  }

  protected unbindWeixin(): void {
    this.runWeixinAction('unbind');
  }

  private runWeixinAction(action: 'start' | 'unbind'): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    const request$ = action === 'start' ? this.api.startWeixinLogin() : this.api.unbindWeixin();
    request$.pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result: AssistantConnectionResult) => {
        if (result.ok !== true) {
          this.error.set(T('The WeChat action did not complete.'));
          return;
        }
        this.login.set(action === 'start' ? result.weixin_login ?? null : null);
        this.message.set(action === 'start' ? T('Scan the QR code in WeChat to connect.') : T('WeChat account disconnected.'));
        if (action === 'unbind') {
          this.refresh();
        }
      },
      error: () => this.error.set(T('The WeChat action did not complete.')),
    });
  }
}

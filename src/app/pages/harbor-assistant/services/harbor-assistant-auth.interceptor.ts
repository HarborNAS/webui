import { HttpInterceptorFn } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import { defer, switchMap } from 'rxjs';
import { AuthService } from 'app/modules/auth/auth.service';
import { harborAssistantGateRequiresUserToken } from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';

/** Single-use middleware identity is sent only to the same-origin Assistant proxy. */
export const harborAssistantAuthInterceptor: HttpInterceptorFn = (request, next) => {
  const injector = inject(Injector);
  const protectedPath = /^\/api\/harbor-(?:beacon|gate)(?:\/|$)/.test(request.url);
  if (!harborAssistantGateRequiresUserToken() || !protectedPath || request.headers.has('X-HarborOS-Auth-Token')) {
    return next(request);
  }
  return defer(() => injector.get(AuthService).getHarborAssistantOneTimeToken()).pipe(
    switchMap((token) => next(request.clone({ setHeaders: { 'X-HarborOS-Auth-Token': token } }))),
  );
};

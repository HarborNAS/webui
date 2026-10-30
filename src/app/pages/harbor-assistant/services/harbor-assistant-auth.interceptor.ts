import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import {
  defer, switchMap, take, throwIfEmpty, timeout,
} from 'rxjs';
import { WINDOW } from 'app/helpers/window.helper';
import { ApiService } from 'app/modules/websocket/api.service';

/** The edge exchanges this user token for a server-side Gate credential. */
export const harborAssistantAuthInterceptor: HttpInterceptorFn = (request, next) => {
  const window = inject<Window>(WINDOW);
  const currentUrl = new URL(window.location.href);
  const requestUrl = new URL(request.url, currentUrl);
  if (requestUrl.origin !== currentUrl.origin || !requestUrl.pathname.startsWith('/api/harbor-beacon/')) {
    return next(request);
  }

  const api = inject(ApiService);
  // Reconnect tokens are single-use token chains. Generate a separate short-lived
  // token on every subscription, including retries, without consuming that chain.
  return defer(() => api.call('auth.generate_token', [60, {}, false, true])).pipe(
    take(1),
    timeout({ first: 10000 }),
    throwIfEmpty(() => new Error('User session token was not generated.')),
    switchMap((token) => {
      if (!token) {
        throw new Error('User session token was not generated.');
      }
      return next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
    }),
  );
};

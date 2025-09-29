import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { tap } from 'rxjs/operators';
import { appBarOpened, appBarMinimized, appBarClosed } from './app-bar.actions';

@Injectable()
export class AppBarEffects {
  private router = inject(Router);
  private actions$ = inject(Actions);

  openAppBarState$ = createEffect(
    () => this.actions$.pipe(
      ofType(appBarOpened),
      tap(({ item }) => {
        if (item.state) {
          this.router.navigate(['/', ...item.state.split('/')]);
        }
      }),
    ),
    { dispatch: false },
  );

  minimizeAppBarState$ = createEffect(
    () => this.actions$.pipe(
      ofType(appBarMinimized, appBarClosed),
      tap(() => {
        this.router.navigate(['/desktop']);
      }),
    ),
    { dispatch: false },
  );
}

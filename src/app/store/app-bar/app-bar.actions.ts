import { createAction, props } from '@ngrx/store';

export const appBarOpened = createAction(
  '[AppBar] Opened',
  props<{ name: string }>(),
);

export const appBarClosed = createAction(
  '[AppBar] Closed',
  props<{ name: string }>(),
);

export const appBarToggled = createAction(
  '[AppBar] Toggled',
  props<{ name: string }>(),
);

export const appBarFixedChanged = createAction(
  '[AppBar] Fixed Changed',
  props<{ name: string; fixed: boolean }>(),
);

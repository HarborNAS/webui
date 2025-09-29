import { createFeatureSelector, createSelector } from '@ngrx/store';
import { AppBarState } from './app-bar.reducer';

export const selectAppBarState = createFeatureSelector<AppBarState>('app-bar');

export const selectAppBarOpen = createSelector(
  selectAppBarState,
  (state) => state.open,
);

export const selectAppBarFixed = createSelector(
  selectAppBarState,
  (state) => state.fixed,
);

import { createFeatureSelector, createSelector } from '@ngrx/store';
import { AppBarState } from './app-bar.reducer';

export const appBarStateKey = 'app-bar';

// 选择整个 appBar 数组
export const selectAppBarState = createFeatureSelector<AppBarState[]>('app-bar');

// 获取所有打开的 appBar 项
export const selectAppBarOpenItems = createSelector(
  selectAppBarState,
  (state) => state.filter((item) => item.open),
);

// 获取所有固定的 appBar 项
export const selectAppBarFixedItems = createSelector(
  selectAppBarState,
  (state) => state.filter((item) => item.fixed),
);

// 获取所有最小化的 appBar 项
export const selectAppBarMinimizedItems = createSelector(
  selectAppBarState,
  (state) => state.filter((item) => item.minimize),
);


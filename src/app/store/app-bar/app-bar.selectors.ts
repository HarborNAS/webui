import { createFeatureSelector } from '@ngrx/store';
import { AppBarState } from './app-bar.reducer';

export const appBarStateKey = 'app-bar';

// 选择整个 appBar 数组
export const selectAppBarState = createFeatureSelector<AppBarState[]>('app-bar');

import { createReducer, on } from '@ngrx/store';
import { AppBarItem } from 'app/interfaces/app-bar.interface';
import { iconMarker } from 'app/modules/ix-icon/icon-marker.util';
import {
  appBarOpened,
  appBarClosed,
  appBarMinimized,
  appBarAdded,
} from './app-bar.actions';

export type AppBarState = AppBarItem;

export const initialState: AppBarItem[] = [
  {
    status: 'minimized',
    name: 'Desktop',
    icon: iconMarker('mdi-monitor'),
    state: 'desktop',
  },
  // 可以在这里添加更多初始项
];

function updateItem(state: AppBarState[], name: string, changes: Partial<AppBarState>): AppBarState[] {
  return state.map((item) => (item.name === name ? { ...item, ...changes } : item));
}

export const appBarReducer = createReducer(
  initialState,
  on(appBarOpened, (state, { item }) => {
    const itemExists = state.some((i) => i.name === item.name);
    if (itemExists) {
      return updateItem(state, item.name, { status: 'open' as const });
    }

    return [...state, { ...item, status: 'open' as const }];
  }),
  on(appBarClosed, (state, { name }) => state.filter((item) => item.name !== name)),
  on(appBarMinimized, (state, { name }) => updateItem(state, name, { status: 'minimized' as const })),
  on(appBarAdded, (state, { item }) => {
    const itemExists = state.some((i) => i.name === item.name);
    if (itemExists) {
      return state;
    }
    return [...state, item];
  }),
);

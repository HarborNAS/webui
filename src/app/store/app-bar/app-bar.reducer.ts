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

function updateItem(state: AppBarState[], stateId: string, changes: Partial<AppBarState>): AppBarState[] {
  return state.map((item) => (item.state === stateId ? { ...item, ...changes } : item));
}

export const appBarReducer = createReducer(
  initialState,
  on(appBarOpened, (state, { item }) => {
    const itemExists = state.some((i) => i.state === item.state);
    if (itemExists) {
      return updateItem(state, item.state, { ...item, status: 'open' as const });
    }

    return [...state, { ...item, status: 'open' as const }];
  }),
  on(appBarClosed, (state, { stateName }) => state.filter((item) => item.state !== stateName)),
  on(appBarMinimized, (state, { stateName }) => updateItem(state, stateName, { status: 'minimized' as const })),
  on(appBarAdded, (state, { item }) => {
    const itemExists = state.some((i) => i.state === item.state);
    if (itemExists) {
      return state;
    }
    return [...state, item];
  }),
);

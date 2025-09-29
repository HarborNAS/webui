import { createReducer, on } from '@ngrx/store';
import { AppBarItem } from 'app/interfaces/app-bar.interface';
import { iconMarker } from 'app/modules/ix-icon/icon-marker.util';
import {
  appBarOpened,
  appBarClosed,
  appBarToggled,
  appBarFixedChanged,
} from './app-bar.actions';

export interface AppBarState extends AppBarItem {
  open: boolean;
  fixed: boolean;
  minimize: boolean;
}

export const initialState: AppBarState[] = [
  {
    open: false,
    fixed: true,
    minimize: false,
    name: 'Desktop',
    icon: iconMarker('desktop'),
  },
  // 可以在这里添加更多初始项
];

function updateItem(state: AppBarState[], name: string, changes: Partial<AppBarState>): AppBarState[] {
  return state.map((item) => (item.name === name ? { ...item, ...changes } : item));
}

export const appBarReducer = createReducer(
  initialState,
  on(appBarOpened, (state, { name }) => updateItem(state, name, { open: true, minimize: false })),
  on(appBarClosed, (state, { name }) => updateItem(state, name, { open: false, minimize: true })),
  on(appBarToggled, (state, { name }) => state.map((item) => (item.name === name
    ? { ...item, open: !item.open, minimize: !item.open }
    : item))),
  on(appBarFixedChanged, (state, { name, fixed }) => updateItem(state, name, { fixed })),
);

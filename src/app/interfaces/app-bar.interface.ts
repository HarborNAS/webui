import { MarkedIcon } from 'app/modules/ix-icon/icon-marker.util';

export interface AppBarItem {
  name: string;
  icon: MarkedIcon;
  state: string;
  status: 'open' | 'minimized';
  fixed: boolean;
}

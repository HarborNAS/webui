import { Routes } from '@angular/router';
import { marker as T } from '@biesbjerg/ngx-translate-extract-marker';
import { MultimodalSearchComponent } from './multimodal-search.component';

export const multimodalSearchRoutes: Routes = [
  {
    path: '',
    component: MultimodalSearchComponent,
    data: { breadcrumb: T('Multimodal Search') },
  },
];

import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { of } from 'rxjs';
import {
  HarborAssistantFolderBrowserDialogComponent,
  HarborAssistantFolderBrowserDialogData,
} from 'app/pages/harbor-assistant/shared/harbor-assistant-folder-browser-dialog.component';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';

describe('HarborAssistantFolderBrowserDialogComponent', () => {
  let spectator: Spectator<HarborAssistantFolderBrowserDialogComponent>;
  let api: { browseFiles: jest.Mock };
  let dialogRef: { close: jest.Mock };
  let data: HarborAssistantFolderBrowserDialogData;

  const createComponent = createComponentFactory({
    component: HarborAssistantFolderBrowserDialogComponent,
    providers: [
      {
        provide: HarborAssistantApiService,
        useFactory: () => api,
      },
      {
        provide: MatDialogRef,
        useFactory: () => dialogRef,
      },
      {
        provide: MAT_DIALOG_DATA,
        useFactory: () => data,
      },
    ],
  });

  beforeEach(() => {
    api = {
      browseFiles: jest.fn((path: string) => of({
        path,
        parent: path === '/mnt' ? null : '/mnt',
        readonly: true,
        allowed_roots: ['/mnt'],
        entries: [
          { name: 'photos', path: '/mnt/photos', is_dir: true },
          { name: 'clip.mp4', path: '/mnt/clip.mp4', is_dir: false },
        ],
      })),
    };
    dialogRef = {
      close: jest.fn(),
    };
    data = {
      title: 'Add data source',
      currentPath: '/mnt',
      excludePaths: ['/mnt/existing'],
    };
  });

  it('browses folders through the Harbor Assistant API and returns the selected path', () => {
    spectator = createComponent();
    spectator.detectChanges();

    expect(api.browseFiles).toHaveBeenCalledWith('/mnt');
    expect(spectator.query('.folder-browser-list')).toHaveText('photos');
    expect(spectator.element.textContent).not.toContain('clip.mp4');

    const component = spectator.component as unknown as {
      useFolder: (path: string) => void;
    };
    component.useFolder('/mnt/photos');

    expect(dialogRef.close).toHaveBeenCalledWith({ path: '/mnt/photos' });
  });

  it('does not return an excluded folder path', () => {
    spectator = createComponent();
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      useFolder: (path: string) => void;
    };
    component.useFolder('/mnt/existing');

    expect(dialogRef.close).not.toHaveBeenCalled();
  });
});

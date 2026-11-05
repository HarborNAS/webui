import {
  ChangeDetectionStrategy,
  Component,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';

export interface FolderPickerDialogData {
  title: string;
  currentPath?: string;
  excludePaths?: string[];
  confirmLabel?: string;
  currentSelectionLabel?: string;
  disabledSelectionTooltip?: string;
  allowDatasetRootSelection?: boolean;
  itemSelectLabel?: string;
}

export interface FolderPickerDialogResult {
  path: string;
}

@Component({
  selector: 'ix-folder-picker-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    TranslateModule,
  ],
  templateUrl: './folder-picker-dialog.component.html',
  styleUrl: './folder-picker-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderPickerDialogComponent {
  readonly dialogRef = inject(MatDialogRef<FolderPickerDialogComponent, FolderPickerDialogResult>);
  readonly data = inject<FolderPickerDialogData>(MAT_DIALOG_DATA);

  cancel(): void {
    this.dialogRef.close();
  }
}

import { environment } from 'environments/environment';
import { ProductType } from 'app/enums/product-type.enum';

export function getCopyrightHtml(productType?: ProductType): string {
  if (productType) {
    return `HarborNAS® <br /> © ${environment.buildYear}`;
  }
  return `HarborNAS® <br /> © ${environment.buildYear}`;
}

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export interface DocumentSearchResponse {
  results: DocumentResult[];
}

export interface DocumentResult {
  id: string;
  path: string;
  similarity: string;
}



@Injectable({
  providedIn: 'root',
})
export class DocumentSearchService {
  private get API_BASE_URL(): string {
    // 生产环境使用 Nginx 反向代理路径 /multiapi/multisearch/
    return '/multiapi/multisearch';
  }

  constructor(private http: HttpClient) {}

  search(query: string): Observable<DocumentSearchResponse> {
    const params = {
      user_query: query,
    };

    return this.http
      .get<any>(`${this.API_BASE_URL}/DocumentSearch`, { params })
      .pipe(
        map((response) => {
          if (response.code === 200 && response.result) {
            const results = response.result.map((item: any) => ({
              id: item.document_path,
              path: item.document_path,
              similarity: (item.score * 100).toFixed(2),
            }));

            return { results };
          }

          return { results: [] };
        }),
        catchError((error) => {
          console.error('Document search error:', error);
          return throwError(() => this.handleError(error));
        }),
      );
  }

  private handleError(error: any): Error {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new Error('请求超时，请检查网络连接或稍后重试');
    }
    if (error.message?.includes('Network Error')) {
      return new Error('网络连接失败，请检查网络设置');
    }
    return new Error('搜索失败：' + (error.message || '未知错误'));
  }
}

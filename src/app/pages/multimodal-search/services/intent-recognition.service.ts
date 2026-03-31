import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export interface IntentRecognitionResponse {
  intent: string;
}



@Injectable({
  providedIn: 'root',
})
export class IntentRecognitionService {
  private get API_BASE_URL(): string {
    // 生产环境使用 Nginx 反向代理路径 /api/search/
    // 开发环境使用代理路径 /api
    return '/api/search';
  }

  constructor(private http: HttpClient) {}

  recognizeIntent(query: string): Observable<string> {
    const params = {
      user_query: query,
    };

    return this.http
      .get<any>(`${this.API_BASE_URL}/IntentRecognition`, { params })
      .pipe(
        map((response) => {
          if (response.code === 200 && response.result) {
            return response.result;
          }

          return 'C';
        }),
        catchError((error) => {
          console.error('Intent recognition error:', error);
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
    return new Error('意图识别失败：' + (error.message || '未知错误'));
  }
}

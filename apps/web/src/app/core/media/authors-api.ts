import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { authorSchema, type Author } from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

/** The authors of a collection (KBC-049); a sub-collection answers with its parent's. */
export const authorsUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/authors`;

/** Registers authors; the list is read with httpResource and `authorsUrl`. */
@Injectable({ providedIn: 'root' })
export class AuthorsApi {
  private readonly http = inject(HttpClient);

  /** The new author, or the one the name already is. */
  create(topic: string, name: string): Observable<Author> {
    return this.http
      .post(authorsUrl(topic), { name })
      .pipe(map((body) => authorSchema.parse(body)));
  }
}

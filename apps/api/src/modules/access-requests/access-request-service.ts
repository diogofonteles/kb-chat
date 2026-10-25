import { randomUUID } from 'node:crypto';
import type { RequestState } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { SerialDocument } from '../../serial-document.js';
import type { PeopleService, StoredPerson } from '../auth/index.js';
import * as rules from './request-rules.js';
import type {
  RequestDraft,
  Requester,
  RequestsDocument,
  StoredRequest,
} from './request-rules.js';

export interface AccessRequestServiceDeps {
  readonly store: DocumentStorePort;
  readonly people: PeopleService;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const fullName = (request: StoredRequest): string =>
  `${request.firstName} ${request.lastName}`.trim();

/** Access requests (KBC-014): who asked, and what masters decided. */
export class AccessRequestService {
  private readonly doc: SerialDocument<RequestsDocument>;

  constructor(private readonly deps: AccessRequestServiceDeps) {
    this.doc = new SerialDocument({
      store: deps.store,
      parse: (raw) => {
        const parsed = rules.requestsDocumentSchema.safeParse(raw);
        if (!parsed.success)
          throw new AppError('INTERNAL', 'access-requests.json is invalid');
        return parsed.data;
      },
      empty: () => ({ version: 1, requests: [] }),
    });
  }

  async pending(): Promise<StoredRequest[]> {
    const { requests } = await this.doc.read();
    return requests.filter((r) => r.status === 'pending');
  }

  async stateFor(who: Requester): Promise<RequestState> {
    const { requests } = await this.doc.read();
    return rules.stateOf(requests, who, this.now().getTime());
  }

  create(draft: RequestDraft): Promise<StoredRequest> {
    const context = {
      now: this.now().toISOString(),
      newId: this.deps.newId ?? randomUUID,
    };
    return this.change((requests) =>
      rules.addRequest(requests, draft, context),
    );
  }

  /** The request becomes a person (BR-6); it leaves the list only once the person exists. */
  approve(id: string, by: string): Promise<StoredPerson> {
    return this.change(async (requests) => {
      const taken = rules.takePending(requests, id);
      const request = taken.result;
      // Invited meanwhile (or signed up twice): the request is done, the person stays.
      const existing = await this.personFor(request);
      if (existing) return { requests: taken.requests, result: existing };
      const person = await this.deps.people.approve({
        email: request.email,
        name: fullName(request),
        phone: request.phone,
        sub: request.sub,
        picture: request.picture,
        approvedBy: by,
      });
      return { requests: taken.requests, result: person };
    });
  }

  private async personFor(
    request: StoredRequest,
  ): Promise<StoredPerson | null> {
    const people = await this.deps.people.list();
    return (
      people.find(
        (p) =>
          p.email === request.email ||
          (request.sub !== null && p.sub === request.sub),
      ) ?? null
    );
  }

  refuse(id: string, by: string): Promise<StoredRequest> {
    const now = this.now().toISOString();
    return this.change((requests) =>
      rules.refuseRequest(requests, { id, by }, now),
    );
  }

  private change<T>(
    apply: (
      requests: readonly StoredRequest[],
    ) => rules.RequestsChange<T> | Promise<rules.RequestsChange<T>>,
  ): Promise<T> {
    return this.doc.change(async (doc) => {
      const { requests, result } = await apply(doc.requests);
      return { doc: { version: 1, requests: [...requests] }, result };
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

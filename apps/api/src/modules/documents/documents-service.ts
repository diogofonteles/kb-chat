import type { KbDocument } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import { splitFrontmatter, type CatalogRegistry } from '../catalog/index.js';

const SAFE_ID = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+\.md$/;

export const isSafeDocumentId = (id: string): boolean => SAFE_ID.test(id);

export interface DocumentsServiceDeps {
  readonly catalog: CatalogRegistry;
  readonly vault: VaultReaderPort;
}

export class DocumentsService {
  constructor(private readonly deps: DocumentsServiceDeps) {}

  async getDocument(topic: string, id: string): Promise<KbDocument> {
    if (!isSafeDocumentId(id))
      throw new AppError('VALIDATION_FAILED', 'Invalid document id');
    const catalog = this.deps.catalog.get(topic);
    if (!catalog)
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    const entry = catalog.entries.get(id);
    const text = entry ? await this.deps.vault.readDocument(topic, id) : null;
    if (!entry || text === null)
      throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
    return {
      ...entry,
      concepts: [...entry.concepts],
      body: splitFrontmatter(text).body.trim(),
    };
  }
}

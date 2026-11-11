export {
  AUTHORS_PER_COLLECTION_MAX,
  AuthorDirectory,
  type CollectionAuthors,
  type StoredAuthor,
} from './author-directory.js';
export {
  AuthorsService,
  type AuthorsServiceDeps,
  type MainAuthor,
} from './authors-service.js';
export {
  LEGACY_MAIN_AUTHOR,
  seedLegacyAuthors,
  type LegacySeedDeps,
} from './legacy-seed.js';
export { authorRoutes, type AuthorRoutesDeps } from './routes.js';

/**
 * A vault shaped like production's collections (ADR 0028): two top-level collections,
 * `hermetismo` and `udv`, and `udv/palavra-do-mestre` inside `udv`. Words that only UDV
 * says ("chacrona", "mariri"), one only Hermetismo says ("caibalion"), one all of them say
 * ("ritmo"), and one id both top-level collections have (`raw/articles/comum.md`), each with
 * its own text. Each collection has a track document too.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FsVaultAdapter } from '../src/adapters/fs-vault-adapter.js';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { CatalogRegistry } from '../src/modules/catalog/index.js';
import { ResearchTools } from '../src/modules/research/index.js';
import { SearchService } from '../src/modules/search/index.js';
import { createSearchIndex } from '../src/search-index-factory.js';
import type { TrackShelf } from '../src/ports/track-shelf.js';

export const TRACK_IDS = {
  hermetismo: 'raw/media/rec-h/6f1c2b9a-0d4e-4c1a-9a51-1b2c3d4e5f60.md',
  udv: 'raw/media/rec-u/7a2d3c8b-1e5f-4d2b-8b62-2c3d4e5f6a71.md',
  palavra: 'raw/media/rec-p/8b3e4d7c-2f60-4e3c-9c73-3d4e5f6a7b82.md',
} as const;

const mediaIdOf = (id: string): string =>
  id.replace(/^.*\//, '').replace(/\.md$/, '');

const text = (
  front: Record<string, string | readonly string[]>,
  body: string,
): string => {
  const lines = Object.entries(front).map(([key, value]) =>
    typeof value === 'string'
      ? `${key}: ${JSON.stringify(value)}`
      : `${key}:\n${value.map((one) => `  - ${JSON.stringify(one)}`).join('\n')}`,
  );
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
};

const track =
  (title: string, recording: string, body: string) => (id: string) =>
    text(
      {
        title,
        type: 'source',
        kb_chat_media_id: mediaIdOf(id),
        kb_chat_recording_id: recording,
        kb_chat_recording_title: `Gravação ${recording}`,
        kb_chat_media_kind: 'track',
        kb_chat_fingerprint: `fp-${recording}`,
      },
      body,
    );

/** Files per collection folder: path inside the vault → its text. */
const FILES: Record<string, string> = {
  'hermetismo/topic.yaml': 'title: Hermetismo\n',
  'hermetismo/raw/articles/caibalion.md': text(
    {
      title: 'O Caibalion',
      summary: 'Os princípios herméticos.',
      entities: ['Hermes Trismegisto'],
    },
    'O Caibalion ensina o princípio do ritmo e da polaridade.',
  ),
  'hermetismo/raw/articles/comum.md': text(
    { title: 'Comum Hermetismo' },
    'Um texto hermético sobre o ritmo das marés.',
  ),
  [`hermetismo/${TRACK_IDS.hermetismo}`]: track(
    'Faixa Hermetismo',
    'rec-h',
    'Fala sobre o Caibalion e o ritmo.',
  )(TRACK_IDS.hermetismo),
  'udv/topic.yaml': 'title: UDV\n',
  'udv/raw/sessoes/vegetal.md': text(
    {
      title: 'O Vegetal',
      summary: 'Mariri e chacrona.',
      entities: ['Mestre Gabriel'],
    },
    'O chá é feito de mariri e chacrona, no ritmo da sessão.',
  ),
  'udv/raw/articles/comum.md': text(
    { title: 'Comum UDV' },
    'A chacrona colhida no ritmo da lua.',
  ),
  [`udv/${TRACK_IDS.udv}`]: track(
    'Faixa UDV',
    'rec-u',
    'Fala sobre a chacrona e o ritmo.',
  )(TRACK_IDS.udv),
  'udv/palavra-do-mestre/topic.yaml': 'title: Palavra do Mestre\n',
  'udv/palavra-do-mestre/raw/articles/palavra.md': text(
    {
      title: 'A Palavra',
      summary: 'Ensinos sobre o mariri.',
      entities: ['Mestre Gabriel'],
    },
    'O Mestre fala do mariri, da chacrona e do ritmo.',
  ),
  [`udv/palavra-do-mestre/${TRACK_IDS.palavra}`]: track(
    'Faixa Palavra',
    'rec-p',
    'O Mestre fala da chacrona e do ritmo.',
  )(TRACK_IDS.palavra),
};

/**
 * A shelf that confirms every track in every collection: the scope must hold by the
 * collection alone, never because the shelf happened to refuse another's track.
 */
export const OPEN_SHELF: TrackShelf = {
  trackOf: (_topic, { mediaId }) => ({
    mediaId,
    title: mediaId,
    confidence: 'normal',
  }),
  segmentsOf: () => [],
};

export interface ScopeWorld {
  readonly root: string;
  readonly catalog: CatalogRegistry;
  readonly search: SearchService;
  readonly tools: ResearchTools;
}

/** The vault on disk, its catalog, the in-process index, the search and the research tools. */
export async function scopeWorld(): Promise<ScopeWorld> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-scope-'));
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const config = loadConfig({ KB_VAULT: root, KB_CHAT_SEARCH: 'fixture' });
  const vault = new FsVaultAdapter(root);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const search = new SearchService({ catalog, index, vault });
  return {
    root,
    catalog,
    search,
    tools: new ResearchTools({ search, catalog, vault }),
  };
}

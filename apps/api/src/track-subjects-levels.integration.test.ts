import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { leakageWorld } from '../test/leakage-world.js';

/*
 * Found by the leakage suite (KBC-111): the subjects of a track answered by its recording's
 * level, so Ana (CI, with "Classificar mídia por assunto") read the title of a CDC track of a
 * CI recording. A track answers by its own level (ADR 0036, KBC-106 "Visibility").
 */

afterEach(closeApp);

describe('the subjects of a track above the person (KBC-111)', () => {
  it('answer 404 like a track that does not exist, naming nothing; the master reads them', async () => {
    const { world, ana, hidden } = await leakageWorld({ sentinels: true });
    const url = `/api/v1/media/${hidden?.track}/subjects`;
    const missing = await ana.call(
      'GET',
      '/api/v1/media/00000000-0000-4000-8000-000000000000/subjects',
    );

    const asAna = await ana.call('GET', url);
    const asMaster = await world.owner('GET', url);

    expect(asAna.statusCode).toBe(404);
    expect(asAna.json()).toEqual(missing.json());
    expect(asAna.body).not.toMatch(/zqx/i);
    expect(asMaster.statusCode, asMaster.body).toBe(200);
    expect(asMaster.json()).toMatchObject({
      title: 'Zqxfaixa Velada Qvkfaixa',
    });
  });
});

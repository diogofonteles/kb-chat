import { describe, expect, it } from 'vitest';
import { relevanceOf } from './relevance.js';

const of = (
  title: string,
  asked: { subject?: string; author?: string | null } = {},
  rest: { snippet?: string; url?: string } = {},
) =>
  relevanceOf(
    { title, snippet: rest.snippet ?? '', url: rest.url ?? 'https://a.org/x' },
    { subject: asked.subject ?? 'Cocriação', author: asked.author ?? null },
  );

describe('relevanceOf (KBC-185)', () => {
  it.each([
    'A chave para CoCriação Consciente',
    'Cocriar é sentir',
    'Você é um cocriador',
    'Processos de co-criação',
  ])('"%s" is about "Cocriação"', (title) => {
    expect(of(title).subject).toBe(true);
  });

  // What the engine really filled a list with on 2026-11-25.
  it.each([
    'Internet Archive: Digital Library of Free & Borrowable Texts',
    'Petite Miss and Junior Miss Pageants - 2016 W.C. Fair',
    'Corel DRAW 12 : Free Download, Borrow, and Streaming',
    'ibisPaint X v11.1.0 (Premium)',
    'MAME 0.202 BIOS Devices',
    'COCORICO Podcast - Apple Podcasts',
    'Film Complet en Français 720p - YouTube',
    'SOUTH PARK : Free Download, Borrow, and Streaming',
  ])('"%s" is not', (title) => {
    expect(of(title, { author: 'Joseph Murphy' })).toEqual({
      subject: false,
      author: false,
    });
  });

  it('reads the extract and the address too', () => {
    expect(of('Aula 3', {}, { snippet: 'sobre cocriação' }).subject).toBe(true);
    const url = 'https://a.org/a-cocria%C3%A7%C3%A3o';
    expect(of('Aula 3', {}, { url }).subject).toBe(true);
  });

  it('wants half of a longer subject', () => {
    const subject = 'os sete princípios herméticos';
    expect(of('Os 7 Princípios Herméticos', { subject }).subject).toBe(true);
    expect(of('Sete anões', { subject }).subject).toBe(false);
  });

  it.each([
    ['Joseph Murph', 'O poder do subconsciente de Joseph Murphy'],
    ['Helio Couto', 'A Grande Transformação, por Hélio Couto'],
    ['Helio Couto', 'Cocriar e sentir #heliocouto'],
    ['Maria do Socorro', 'MARIA DO SOCORRO ensina'],
    ['Hermes', 'A tábua de Hermes'],
  ])('%s is named in "%s"', (author, title) => {
    expect(of(title, { author }).author).toBe(true);
  });

  it.each([
    ['Maria do Socorro', 'Ave Maria com Américo Barbosa'],
    ['Americo Barbosa', 'Rui Barbosa e a República'],
    ['Joseph Murphy', 'Joseph Capriati (last tracks)'],
  ])('%s is not named in "%s"', (author, title) => {
    expect(of(title, { author }).author).toBe(false);
  });

  it('takes a subject with no telling word as it comes', () => {
    expect(of('Qualquer coisa', { subject: 'o que é' }).subject).toBe(true);
  });
});

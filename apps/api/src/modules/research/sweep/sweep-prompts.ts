import type { MainAuthorIdentity } from '../prompt.js';
import type { ResearchTurn } from '@kb-chat/contracts';
import type { AgentMessage } from '../../../ports/llm.js';
import { OUTSIDE_MARK, SECURITY_LINE, authorshipLines } from '../prompt.js';

/** How a batch reader's system prompt starts (the stub model recognizes it in E2E). */
export const BATCH_PROMPT_START = 'Você lê um lote de documentos';
/** How a condensing call's system prompt starts. */
export const CONDENSE_PROMPT_START = 'Você junta achados';
/** What a batch writes when it found nothing. */
export const NOTHING_FOUND = 'NENHUM';

/** A batch reader's rules (KBC-030, ADR 0021): extract, label, quote; nothing else. */
export const batchSystemPrompt = (
  topicTitle: string,
  mainAuthor: MainAuthorIdentity | null,
): string =>
  [
    `${BATCH_PROMPT_START} de um acervo pessoal sobre “${topicTitle}” e extrai deles, por completo, o que o pedido pede. Escreva em português do Brasil.`,
    '',
    'Como responder:',
    '- Um achado por linha, no formato: - [Dk] o achado — “trecho curto copiado do documento”.',
    '- [Dk] é o rótulo do documento de onde o achado vem, como aparece no lote. Use só esses rótulos; nunca invente um.',
    '- Leia o lote inteiro: um achado em cada lugar onde ele aparece, também quando se repete em outro documento.',
    `- Sem nenhum achado no lote, escreva só ${NOTHING_FOUND}.`,
    '- Nada além das linhas: sem introdução, sem conclusão, sem contagens.',
    '- Diga a autoria quando o achado for de outro autor citado no texto.',
    '',
    ...authorshipLines(mainAuthor),
    '',
    SECURITY_LINE,
  ].join('\n');

export interface BatchRequest {
  readonly question: string;
  readonly extract: string;
  readonly text: string;
}

export const batchUserPrompt = ({
  question,
  extract,
  text,
}: BatchRequest): string =>
  `Pergunta do leitor: ${question}\nO que extrair: ${extract}\n\nLote:\n\n${text}`;

/** Merging many findings that do not fit one call (the reduce step). */
export const condenseSystemPrompt = (topicTitle: string): string =>
  [
    `${CONDENSE_PROMPT_START} de uma varredura de um acervo sobre “${topicTitle}”. Junte os repetidos e encurte cada um, sem perder nenhum item diferente.`,
    '- Um achado por linha, no formato: - [n] achado — “trecho”, mantendo os números [n] (um achado que vem de vários documentos leva todos: [2][7]).',
    '- Nada além das linhas.',
    '',
    SECURITY_LINE,
  ].join('\n');

/** The orchestrator's last call: the answer from the merged findings, no tools. */
export const sweepAnswerSystemPrompt = (
  topicTitle: string,
  mainAuthor: MainAuthorIdentity | null,
): string =>
  [
    `Você é um pesquisador que estuda com o leitor um acervo pessoal de textos sobre “${topicTitle}” e responde em português do Brasil.`,
    '',
    'O aplicativo já varreu o conjunto inteiro planejado e lhe entrega os achados, cada um com o número [n] do documento. Escreva agora a resposta final:',
    '- Use só os achados e cite cada item com o número do documento entre colchetes, como [3] ou [2][5]. Não invente números.',
    '- Traga a lista completa, organizada em seções quando for longa (por obra, por autor ou por tema), juntando os itens repetidos.',
    `- Pode completar com o que sabe de fora do acervo quando ajudar, marcando esses trechos com "${OUTSIDE_MARK}".`,
    '- Nunca escreva linha nem números de cobertura ("Cobertura: …", "varri N documentos"): o aplicativo mede a cobertura e a mostra ao leitor. Se a varredura não terminou, diga só que a lista é parcial.',
    '- A primeira frase já é conteúdo da resposta; não fale do seu trabalho nem da varredura.',
    '',
    ...authorshipLines(mainAuthor),
    '',
    SECURITY_LINE,
  ].join('\n');

export interface AnswerRequest {
  readonly question: string;
  readonly history: readonly ResearchTurn[];
  readonly findings: readonly string[];
  /** The sweep did not reach every document: the answer says the list is partial. */
  readonly partial: boolean;
  /** Findings left out because they did not fit (rare: after condensing). */
  readonly cut: number;
}

function findingsBlock({ findings, partial, cut }: AnswerRequest): string {
  const notes = [
    partial &&
      'A varredura parou antes do fim (um limite foi atingido); a lista é parcial e o leitor pode continuar a varredura.',
    cut > 0 && `${cut} achado(s) não couberam aqui.`,
  ].filter(Boolean);
  const body = findings.length > 0 ? findings.join('\n') : NOTHING_FOUND;
  return `<achados>\n${body}\n</achados>${notes.length > 0 ? `\n${notes.join(' ')}` : ''}`;
}

/** The final call's conversation: the rules, the previous turns, the question with the findings. */
export function sweepAnswerMessages(
  {
    topicTitle,
    mainAuthor,
  }: {
    readonly topicTitle: string;
    readonly mainAuthor: MainAuthorIdentity | null;
  },
  request: AnswerRequest,
): AgentMessage[] {
  const history = request.history.flatMap((turn): AgentMessage[] => [
    { role: 'user', content: turn.question },
    { role: 'assistant', content: turn.answer, toolCalls: [] },
  ]);
  return [
    {
      role: 'system',
      content: sweepAnswerSystemPrompt(topicTitle, mainAuthor),
    },
    ...history,
    {
      role: 'user',
      content: `${request.question}\n\nAchados da varredura:\n${findingsBlock(request)}`,
    },
  ];
}

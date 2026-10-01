/**
 * Preparación de entrevista: la parte que es un HECHO, no una conversación.
 *
 * De `/interview` de `MadsLorentzen/ai-job-search` se toma solo el *consistency brief*, que es su
 * única pieza determinista. Lo demás de allá —redactar respuestas STAR, investigar la empresa,
 * simular la entrevista— necesita un modelo y necesita ida y vuelta: eso es una conversación en el
 * chat, no una función en un pipeline, y fingir lo contrario produciría respuestas enlatadas.
 *
 * Lo que sí es un hecho, y lo único que de verdad se olvida antes de una entrevista: **qué afirmaste
 * exactamente en el paquete que enviaste.** Contradecirse con tu propio CV es el fallo más barato de
 * evitar y el más caro de cometer, y para evitarlo basta releer lo que dice, no inventar nada.
 */
import type { CandidateFacts } from './candidacy.ts';
import type { Opportunity, Profile } from './contracts.ts';
import { beforeSending, type Confirmation } from './application-draft.ts';
import { money, place, visa } from './digest.ts';
import { skillHit } from './relevance.ts';
import { canonical } from './text.ts';

export interface ClaimedFact {
  /** La frase LITERAL que viajó en el paquete. */
  claim: string;
  /** De dónde salió, para poder abrir el archivo y verlo. */
  source: string;
}
export interface InterviewBrief {
  schemaVersion: 1;
  opportunity: { title: string; company: string; url?: string };
  /** El titular que mandaste. Si te presentas distinto en la llamada, ya te contradijiste. */
  headline?: string;
  /** Todo lo que el paquete afirma sobre ti, literal. */
  claims: ClaimedFact[];
  /** Habilidades que ESTA oferta pide y tu material respalda: de ahí salen los ejemplos. */
  supported: string[];
  /** Las que pide y tu material NO respalda. Hay que reconocerlas, no esquivarlas. */
  gaps: string[];
  /** Lo que la oferta nunca dijo y conviene preguntar. Sale de los huecos del registro. */
  ask: Confirmation[];
  /** Datos de la vacante tal como el digest los redacta, para no contradecir al tablero. */
  posting: { pay: string; mode: string; sponsorship?: string };
}

/**
 * Arma el brief. Puro.
 *
 * `supported` y `gaps` cruzan lo que la oferta pide con lo que el material declara usando el MISMO
 * matcher que el ranker, alias incluidos. Con una comparación literal el brief decía que tu material
 * no respalda `llm`, `rag` ni `docker` mientras las frases decían "GPT-4", "Pinecone" y
 * "containerised infrastructure" — y una brecha falsa antes de una entrevista es peor que no tener
 * brief: te convence de que no puedes hablar de algo que sí hiciste.
 */
export function interviewBrief(inputs: { facts: CandidateFacts; opportunity: Opportunity; profile: Profile; matched: readonly string[] }): InterviewBrief {
  const { facts, opportunity, profile, matched } = inputs;
  const claims: ClaimedFact[] = [
    ...facts.highlights.map(claim => ({ claim, source: 'highlights' })),
    ...(facts.experience ?? []).flatMap(entry => entry.achievements.map(claim => ({ claim, source: `${entry.role} — ${entry.company}` }))),
  ];
  const haystack = canonical(claims.map(c => c.claim).join(' . '));
  const aliases = profile.relevance.skillAliases;
  const supported = matched.filter(skill => skillHit(haystack, skill, aliases));
  const gaps = matched.filter(skill => !skillHit(haystack, skill, aliases));
  return {
    schemaVersion: 1,
    opportunity: { title: opportunity.title, company: opportunity.company, ...(opportunity.url ? { url: opportunity.url } : {}) },
    ...(facts.headline ? { headline: facts.headline } : {}),
    claims, supported, gaps,
    // Lo que había que confirmar ANTES de enviar sigue sin confirmarse si nadie preguntó: la misma
    // lista es la de preguntas para la llamada, y así no se mantienen dos listas que divergen.
    ask: beforeSending(opportunity, profile).filter(c => c.item !== 'confirm the listing is still open'),
    posting: { pay: money(opportunity, profile), mode: place(opportunity), ...(visa(opportunity) ? { sponsorship: visa(opportunity)! } : {}) },
  };
}

/** El brief en Markdown. Cero prosa nueva: todo lo de aquí ya estaba escrito en otro sitio. */
export function renderInterviewBrief(brief: InterviewBrief): string {
  const list = (items: readonly string[], empty: string) => items.length ? items.map(i => `- ${i}`).join('\n') : `- ${empty}`;
  return `# Entrevista: ${brief.opportunity.title} — ${brief.opportunity.company}

> Lo que SÍ es un hecho antes de una entrevista: qué afirmaste en el paquete que enviaste.
> Contradecir tu propio CV es el fallo más barato de evitar.

## Te presentaste como

${brief.headline ?? '[POR REVISAR: el paquete no declaraba titular]'}

## Lo que afirmaste, literal

${brief.claims.length ? brief.claims.map(c => `- ${c.claim}  \n  _(${c.source})_`).join('\n') : '- [POR REVISAR: el paquete no afirmaba nada sobre ti]'}

## Lo que esta oferta pide y tu material respalda

${list(brief.supported, 'ninguna: el paquete no respalda ningún término de esta oferta')}

## Lo que pide y tu material NO respalda

${list(brief.gaps, 'ninguna')}

Reconocerlas y enlazar con experiencia adyacente. Inventar una es otra cosa.

## Qué preguntar

${brief.ask.length ? brief.ask.map(c => `- ${c.item}${c.detail ? `  \n  _(${c.detail})_` : ''}`).join('\n') : '- La oferta declaraba todo; preguntar por el equipo y el alcance del puesto'}

## La vacante, como la lee el tablero

- Pago: ${brief.posting.pay}
- Modalidad: ${brief.posting.mode}
${brief.posting.sponsorship ? `- Patrocinio: ${brief.posting.sponsorship}\n` : ''}${brief.opportunity.url ? `- ${brief.opportunity.url}\n` : ''}
> Las respuestas STAR, la investigación de la empresa y el simulacro NO están aquí a propósito:
> necesitan un modelo y necesitan ida y vuelta. Eso es una conversación, no un archivo.
`;
}

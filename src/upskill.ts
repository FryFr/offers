/**
 * Qué piden las ofertas que quieres y tú no declaras. Puro, sin red, sin LLM.
 *
 * La idea viene de `/upskill` de `MadsLorentzen/ai-job-search`, pero allá el agregado lo arma un
 * agente a partir de `gaps` que otro agente escribió antes. Aquí encaja mejor: `relevance()` ya corre
 * sobre TODAS las capturas y ya sabe, término por término, qué pidió cada oferta y qué de eso tienes
 * declarado. El informe es una agregación de datos que el pipeline produce de todos modos.
 *
 * Lo que NO hace, a propósito: recomendar cursos ni estimar horas de estudio. Eso exige juicio sobre
 * material que cambia cada mes, no cabe en una función pura, y lo que decide es el dato — "catorce de
 * las ofertas que te sirven piden Terraform y tu CV no lo menciona" ya basta para elegir qué estudiar.
 */
import type { Opportunity, Profile } from './contracts.ts';
import type { evaluate } from './evaluate.ts';
import { canonical, contains } from './text.ts';

export interface SkillGap {
  /** El término tal como lo nombra el perfil, o el candidato léxico si no lo declara. */
  skill: string;
  /** Cuántas ofertas del pool lo piden. */
  demand: number;
  /** De esas, cuántas son `strong`. La demanda en lo mejor del pool pesa más. */
  strongDemand: number;
  /** `core` y `secondary` ya las tienes; `undeclared` es la brecha real. */
  status: 'core' | 'secondary' | 'undeclared';
  /** Dos títulos reales que lo piden, para poder comprobarlo a mano. */
  examples: string[];
}
export interface UpskillReport {
  schemaVersion: 1;
  /** Ofertas consideradas: verificadas y relevantes. */
  pool: number;
  /** Lo que el pool pide y el perfil no declara, de más pedido a menos. */
  gaps: SkillGap[];
  /** Lo que declaras y el pool casi nunca pide. Diluye el denominador del puntaje. */
  unused: SkillGap[];
}
export interface UpskillRecord { id: string; opportunity: Opportunity; evaluation: ReturnType<typeof evaluate> }

/**
 * Vocabulario candidato a brecha.
 *
 * Es una lista EXPLÍCITA y no una extracción libre del texto, por la misma razón que
 * `roleExcludedTerms` lo es: contar n-gramas de una descripción produce "team", "experience" y
 * "customer" en el top, y un informe así no se vuelve a abrir. Cada entrada es una tecnología
 * nombrable que alguien podría ponerse a estudiar el lunes.
 */
export const GAP_VOCABULARY: readonly string[] = [
  'kubernetes', 'terraform', 'golang', 'rust', 'scala', 'kotlin', 'swift', 'ruby', 'php', 'elixir',
  'graphql', 'grpc', 'kafka', 'rabbitmq', 'redis', 'elasticsearch', 'clickhouse', 'cassandra', 'dynamodb', 'mongodb',
  'snowflake', 'databricks', 'bigquery', 'dbt', 'airflow', 'dagster', 'spark', 'flink', 'hadoop',
  'terraform cloud', 'ansible', 'puppet', 'chef', 'helm', 'argocd', 'istio', 'prometheus', 'grafana', 'datadog',
  'aws', 'gcp', 'azure', 'cloudflare', 'vercel', 'serverless', 'lambda',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'remix', 'tailwind', 'typescript',
  'pytorch', 'tensorflow', 'jax', 'scikit-learn', 'hugging face', 'langchain', 'llamaindex', 'langgraph',
  'pinecone', 'weaviate', 'qdrant', 'pgvector', 'milvus', 'chroma',
  'mlflow', 'kubeflow', 'sagemaker', 'vertex ai', 'bedrock', 'triton', 'vllm', 'ray',
  // `evaluation` salió en 13 ofertas y casi ninguna hablaba de evaluar modelos: "evaluation of
  // candidates" es boilerplate de reclutamiento. Un término ambiguo infla el informe y lo vuelve ruido.
  'fine-tuning', 'rlhf', 'llm evaluation', 'observability', 'guardrails', 'prompt engineering',
  'ros2', 'moveit', 'slam', 'opencv', 'cuda', 'tensorrt', 'embedded linux', 'rtos',
  'terragrunt', 'pulumi', 'github actions', 'gitlab ci', 'jenkins', 'circleci',
  'playwright', 'cypress', 'selenium', 'jest', 'vitest', 'pytest',
  'salesforce', 'sap', 'workday', 'netsuite', 'zapier', 'make.com', 'n8n', 'uipath',
];

const EXAMPLES = 2;

/**
 * Agrega la demanda del pool contra lo que el perfil declara.
 *
 * El pool son las ofertas **verificadas y relevantes**: contar sobre todo lo capturado mediría el
 * mercado entero, y la pregunta no es qué pide el mercado sino qué piden las ofertas que te sirven.
 */
export function upskillReport(records: readonly UpskillRecord[], profile: Profile): UpskillReport {
  const relevant = records.filter(r => r.evaluation.verification.status === 'verified'
    && ['strong', 'possible'].includes(r.evaluation.relevance.tier));
  const core = new Set(profile.skills);
  const secondary = new Set(profile.secondarySkills);
  const aliases = profile.relevance.skillAliases;
  // El vocabulario candidato más todo lo que el perfil declara: así el informe mide las dos
  // direcciones con la misma regla, y una habilidad declarada que nadie pide también sale.
  const terms = [...new Set([...GAP_VOCABULARY, ...core, ...secondary])];
  const tally = new Map<string, { demand: number; strongDemand: number; examples: string[] }>();
  for (const record of relevant) {
    const haystack = canonical([record.opportunity.title, record.opportunity.description, ...record.opportunity.skills].filter(Boolean).join(' '));
    const strong = record.evaluation.relevance.tier === 'strong';
    for (const term of terms) {
      // Se busca con los MISMOS alias que usa el ranker: `llm` tiene que encontrar "LLMs" aquí igual
      // que allá, o el informe contradiría al puntaje sobre la misma oferta.
      const found = [term, ...(aliases[term] ?? [])].some(variant => contains(haystack, canonical(variant)));
      if (!found) continue;
      const entry = tally.get(term) ?? { demand: 0, strongDemand: 0, examples: [] };
      entry.demand++;
      if (strong) entry.strongDemand++;
      if (entry.examples.length < EXAMPLES) entry.examples.push(record.opportunity.title);
      tally.set(term, entry);
    }
  }
  /**
   * Un término que es ALIAS de algo declarado está DECLARADO.
   *
   * Sin esto el informe decía que `github actions` era una brecha, cuando el perfil la declara como
   * alias de `ci/cd` y el ranker ya la encuentra. Recomendar estudiar algo que ya tienes es la forma
   * más rápida de que un informe no se vuelva a abrir.
   */
  const declaredAs = new Map<string, SkillGap['status']>();
  for (const [skill, variants] of [...[...core].map(s => [s, 'core'] as const), ...[...secondary].map(s => [s, 'secondary'] as const)]
    .flatMap(([skill, kind]) => [skill, ...(aliases[skill] ?? [])].map(variant => [canonical(variant), kind] as const))) {
    if (!declaredAs.has(skill)) declaredAs.set(skill, variants);
  }
  const status = (term: string): SkillGap['status'] => declaredAs.get(canonical(term)) ?? 'undeclared';
  const rows: SkillGap[] = [...tally].map(([skill, v]) => ({ skill, demand: v.demand, strongDemand: v.strongDemand, status: status(skill), examples: v.examples }));
  // Orden: primero la demanda en lo `strong`, luego la total, y el nombre para que sea reproducible.
  const byDemand = (a: SkillGap, b: SkillGap) => b.strongDemand - a.strongDemand || b.demand - a.demand || a.skill.localeCompare(b.skill);
  return {
    schemaVersion: 1,
    pool: relevant.length,
    gaps: rows.filter(r => r.status === 'undeclared').sort(byDemand),
    /**
     * Lo declarado que el pool casi nunca pide. No es decoración: el puntaje de habilidades divide por
     * `profile.skills.length`, así que una del núcleo que nadie pide baja el puntaje de TODAS las
     * ofertas por igual. Esta lista es la que dice cuál mover a secundarias.
     */
    unused: [...core]
      .filter(skill => (tally.get(skill)?.demand ?? 0) === 0)
      .sort()
      .map(skill => ({ skill, demand: 0, strongDemand: 0, status: 'core' as const, examples: [] })),
  };
}

/** Informe en Markdown. Determinista, y sin una sola recomendación que no salga de los datos. */
export function renderUpskill(report: UpskillReport, top = 15): string {
  const row = (g: SkillGap) => `| ${g.skill} | ${g.demand} | ${g.strongDemand} | ${g.examples.map(e => e.replace(/\|/g, '/')).join(' · ') || '—'} |`;
  const gaps = report.gaps.slice(0, top);
  return `# Brechas de habilidades

Sobre ${report.pool} ofertas **verificadas y relevantes**. No es el mercado entero: son las que te sirven.

## Lo que piden y no declaras

${gaps.length ? `| Habilidad | Ofertas | De esas, strong | Ejemplos |\n| --- | --- | --- | --- |\n${gaps.map(row).join('\n')}` : 'Ninguna del vocabulario candidato aparece en este pool.'}

## Lo que declaras y el pool no pide

${report.unused.length ? report.unused.map(g => `- \`${g.skill}\``).join('\n') : 'Todo lo del núcleo aparece al menos una vez.'}

> El puntaje de habilidades divide por el tamaño de tu núcleo, así que una habilidad del núcleo que
> ninguna oferta pide baja el puntaje de TODAS por igual. Las de arriba son candidatas a mover a
> \`secondarySkills\`, donde suman cuando aparecen y nunca restan.
>
> Este informe cuenta apariciones del término en el texto publicado. Que aparezca no dice a qué nivel
> se pide, y que no aparezca no dice que no importe: la oferta puede nombrarlo de otra forma.
`;
}

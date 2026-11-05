/** Fixed community vocabularies. The database enforces the same sets (migrations 0030 and 0031). */
export const COMMUNITY_TOPICS = [
  { slug: "b2b-saas", name: "B2B SaaS" },
  { slug: "climate-tech", name: "Climate Tech" },
  { slug: "ai-data", name: "AI & Data" },
  { slug: "product", name: "Product" },
  { slug: "fintech", name: "FinTech" },
  { slug: "founders", name: "Founders Circle" },
] as const;

export const COMMUNITY_STAGES = [
  { code: "idea", label: "Idea" },
  { code: "pre_seed", label: "Pre-seed" },
  { code: "seed", label: "Seed" },
  { code: "series_a", label: "Series A" },
  { code: "growth", label: "Growth" },
  { code: "any", label: "Any stage" },
] as const;

export const TOPIC_SLUGS: string[] = COMMUNITY_TOPICS.map((topic) => topic.slug);
export const STAGE_CODES: string[] = COMMUNITY_STAGES.map((stage) => stage.code);

const topicNames = new Map<string, string>(COMMUNITY_TOPICS.map((topic) => [topic.slug, topic.name]));
const stageLabels = new Map<string, string>(COMMUNITY_STAGES.map((stage) => [stage.code, stage.label]));

export const topicName = (slug: string): string => topicNames.get(slug) ?? slug;
export const stageLabel = (code: string): string => stageLabels.get(code) ?? code;

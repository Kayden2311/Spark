/** Fixed community vocabularies, the same sets the API and the database enforce. */

import { countryName } from "../format";
import type { CommunityVisibility } from "../types";

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

export const MIN_TOPICS = 1;
export const MAX_TOPICS = 4;
export const NAME_MAX = 80;
export const TAGLINE_MAX = 90;
export const DESCRIPTION_MAX = 2000;
export const CITY_MAX = 80;

const stageLabels = new Map<string, string>(COMMUNITY_STAGES.map((stage) => [stage.code, stage.label]));

/** "Pre-seed" for "pre_seed". An unknown code is shown as "Not set" rather than as a raw code. */
export function stageLabel(code: string | null | undefined): string {
  return (code && stageLabels.get(code)) || "Not set";
}

export const VISIBILITY_OPTIONS: Array<{ value: CommunityVisibility; label: string; help: string }> = [
  { value: "public", label: "Public", help: "Anyone can find it in the directory and join right away." },
  { value: "private", label: "Private", help: "Anyone can find it, but people ask to join and a manager approves each request." },
  { value: "hidden", label: "Hidden", help: "Only members can see it. Managers add people from your workspace." },
];

/** What changes for people when a manager switches visibility. */
export function visibilityChangeNote(from: CommunityVisibility, to: CommunityVisibility): string | null {
  if (from === to) return null;
  if (to === "hidden") return "The community disappears from the directory. Only current members can still open it; new people can only be added from your workspace.";
  if (to === "private") {
    return from === "hidden"
      ? "The community appears in the directory. People can see its summary and ask to join; you approve each request."
      : "New people will have to ask to join and wait for approval. Current members stay.";
  }
  return from === "hidden"
    ? "The community appears in the directory and anyone signed in can join right away."
    : "Anyone signed in can join right away, without asking first. Current members stay.";
}

/** ISO 3166-1 alpha-2 codes; names come from the browser's Intl data. */
const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

let countries: Array<{ code: string; name: string }> | null = null;

/** Every country as { code, name }, sorted by name. */
export function countryOptions(): Array<{ code: string; name: string }> {
  countries ??= COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  return countries;
}

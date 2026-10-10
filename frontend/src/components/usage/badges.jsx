import { Badge } from "../ui";
import { LEVEL_BADGE, LEVEL_WORD, SITE_BADGE } from "./format";
// Site state and check level as the house badges (text always present).
export function SiteBadge({ state }) {
  const [value, text] = SITE_BADGE[state] || SITE_BADGE.unknown;
  return <Badge value={value}>{text}</Badge>;
}
export function LevelBadge({ level }) {
  if (!LEVEL_BADGE[level]) return null;
  return <Badge value={LEVEL_BADGE[level]}>{LEVEL_WORD[level]}</Badge>;
}

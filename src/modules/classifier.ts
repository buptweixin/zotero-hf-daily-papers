/**
 * Auto tagging & topic classification for HF daily papers.
 *
 * - Tags: HF `ai_keywords` + source tag + a "hot" tag for high-upvote papers.
 * - Topic collections: user-editable rules, one per line: `<regex> -> <name>`.
 *   A paper matching multiple rules goes into all matched collections.
 */

import { HFPaper } from "./hf-api";
import { getPref } from "../utils/prefs";

export interface TopicRule {
  pattern: string;
  collection: string;
}

export const HOT_TAG = "🔥Hot";

/** One problem found by `validateTopicRules` in user-edited rule text. */
export interface TopicRuleProblem {
  line: number;
  pattern: string;
  error: string;
}

export function parseTopicRules(text: string): TopicRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("->");
      if (idx === -1) {
        return null;
      }
      const pattern = line.slice(0, idx).trim();
      const collection = line.slice(idx + 2).trim();
      if (!pattern || !collection) {
        return null;
      }
      return { pattern, collection };
    })
    .filter((r): r is TopicRule => r !== null);
}

export function getTopicRules(): TopicRule[] {
  return parseTopicRules(getPref("topicRules"));
}

/**
 * Check topic-rule text line by line and report every invalid line.
 * An empty result means the whole rule text is valid.
 */
export function validateTopicRules(text: string): TopicRuleProblem[] {
  const problems: TopicRuleProblem[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      return;
    }
    const idx = line.indexOf("->");
    if (idx === -1) {
      problems.push({
        line: index + 1,
        pattern: line,
        error: "missing '->' separator",
      });
      return;
    }
    const pattern = line.slice(0, idx).trim();
    const collection = line.slice(idx + 2).trim();
    if (!pattern) {
      problems.push({
        line: index + 1,
        pattern,
        error: "empty pattern",
      });
    } else {
      try {
        // Use the same flags as classification so validation is accurate.
        new RegExp(pattern, "i");
      } catch (e) {
        const detail = e instanceof SyntaxError ? e.message : String(e);
        problems.push({
          line: index + 1,
          pattern,
          error: `invalid regex: ${detail}`,
        });
      }
    }
    if (!collection) {
      problems.push({
        line: index + 1,
        pattern,
        error: "empty collection name",
      });
    }
  });
  return problems;
}

// Upper bound for the compiled-pattern cache. Once reached the cache is
// cleared, so patterns from old preference edits cannot pile up unbounded.
const COMPILED_CACHE_LIMIT = 500;

// Compiled patterns keyed by pattern text. A null value marks a broken
// pattern so it is neither recompiled nor re-logged on every sync.
const compiledPatterns = new Map<string, RegExp | null>();

/** Compile a rule pattern (cached); returns null for an invalid pattern. */
function compilePattern(pattern: string): RegExp | null {
  const cached = compiledPatterns.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, "i");
  } catch (e) {
    // Invalid regex in user rule; skip it.
    ztoolkit.log(`Invalid topic rule pattern: ${pattern}`, e);
  }
  if (compiledPatterns.size >= COMPILED_CACHE_LIMIT) {
    compiledPatterns.clear();
  }
  compiledPatterns.set(pattern, re);
  return re;
}

/** Lowercased title + AI keywords; the text topic rules are matched on. */
export function buildHaystack(paper: HFPaper): string {
  return `${paper.title} ${paper.aiKeywords.join(" ")}`.toLowerCase();
}

/** All collection names a paper should be filed into, in rule order. */
export function classifyPaper(paper: HFPaper, rules: TopicRule[]): string[] {
  if (rules.length === 0) {
    return [];
  }
  const haystack = buildHaystack(paper);
  const matched: string[] = [];
  for (const rule of rules) {
    const re = compilePattern(rule.pattern);
    if (re && re.test(haystack) && !matched.includes(rule.collection)) {
      matched.push(rule.collection);
    }
  }
  return matched;
}

const MAX_TAG_LENGTH = 64;

// Whitespace/punctuation trimmed from tag edges. Internal hyphens and
// slashes survive, and so do symbols such as the HOT_TAG emoji.
const TAG_SPACES_RE = /\s+/g;
const TAG_EDGE_RE = /^[\s\p{P}]+|[\s\p{P}]+$/gu;
const TAG_TRAILING_RE = /[\s\p{P}]+$/u;

/** Normalize one raw tag; returns "" when nothing usable is left. */
function cleanTag(raw: string): string {
  let tag = raw.trim().replace(TAG_SPACES_RE, " ").replace(TAG_EDGE_RE, "");
  if (tag.length > MAX_TAG_LENGTH) {
    // Truncation may expose a new trailing separator; trim it again.
    tag = tag.slice(0, MAX_TAG_LENGTH).replace(TAG_TRAILING_RE, "");
  }
  return tag;
}

/** Build the tag list for a paper. */
export function buildTagsForPaper(
  paper: HFPaper,
): { tag: string; type: number }[] {
  const tags: { tag: string; type: number }[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const tag = cleanTag(raw);
    if (!tag) {
      return;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    tags.push({ tag, type: 0 });
  };

  if (getPref("tagKeywords")) {
    // Cap keyword tags so one paper doesn't flood the tag list.
    for (const kw of paper.aiKeywords.slice(0, 6)) {
      push(kw);
    }
  }
  push(getPref("sourceTag"));
  if (paper.upvotes >= getPref("hotThreshold")) {
    push(HOT_TAG);
  }
  return tags;
}

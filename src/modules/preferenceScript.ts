/**
 * Preference pane bindings. All controls are bound manually (load value from
 * prefs, save on change) so we don't rely on Zotero's automatic
 * `preference` attribute handling.
 */

import { FluentMessageId } from "../../typings/i10n";
import { getLocaleID } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { validateTopicRules } from "./classifier";

/**
 * Default topic rules, restored by the "Restore default rules" button.
 *
 * NOTE: Keep this string in sync with the `topicRules` default in
 * `addon/prefs.js` — the two must remain identical.
 */
export const DEFAULT_TOPIC_RULES =
  "\\bllm\\b|large language model|language model -> LLM\nmultimodal|vision[- ]language|vlm|image[- ]text -> Multimodal\nagent|tool use|tool[- ]calling|planning -> Agents\nreinforcement learning|\\brl\\b|reward model|rlhf|grpo -> Reinforcement Learning\ndiffusion|flow matching|stable diffusion|text[- ]to[- ]image|image generation -> Generative Models\n\\brag\\b|retrieval[- ]augmented|retrieval augmented -> RAG\nfine[- ]?tun|lora|peft|instruction tuning|\\bsft\\b|dpo -> Fine-tuning\nbenchmark|evaluation|\\beval\\b -> Benchmarks\nspeech|audio|voice|\\basr\\b|\\btts\\b -> Speech\n\\bvision\\b|\\bimages?\\b|\\bvideos?\\b -> Vision\nsafety|alignment|jailbreak|red[- ]team -> Safety\nreasoning|chain[- ]of[- ]thought|\\bcot\\b|\\bmath\\b -> Reasoning\nquantization|pruning|distill|efficien|compression|inference accele -> Efficiency\nrobot -> Robotics\ntranslation|machine translation -> NLP";

type BindKind = "checkbox" | "number" | "text" | "textarea";

interface Binding {
  id: string;
  pref: string;
  kind: BindKind;
  /** Inclusive bounds for `number` inputs; out-of-range values are clamped. */
  min?: number;
  max?: number;
  /** Fallback written back into empty `text` inputs (after trimming). */
  fallback?: string;
}

const BINDINGS: Binding[] = [
  { id: "hfp-autoSync", pref: "autoSync", kind: "checkbox" },
  {
    id: "hfp-lookbackDays",
    pref: "lookbackDays",
    kind: "number",
    min: 1,
    max: 30,
  },
  {
    id: "hfp-minUpvotes",
    pref: "minUpvotes",
    kind: "number",
    min: 0,
    max: 999,
  },
  { id: "hfp-downloadPdf", pref: "downloadPdf", kind: "checkbox" },
  {
    id: "hfp-rootCollectionName",
    pref: "rootCollectionName",
    kind: "text",
    fallback: "HF Daily Papers",
  },
  {
    id: "hfp-sourceTag",
    pref: "sourceTag",
    kind: "text",
    fallback: "HF Papers",
  },
  { id: "hfp-tagKeywords", pref: "tagKeywords", kind: "checkbox" },
  {
    id: "hfp-hotThreshold",
    pref: "hotThreshold",
    kind: "number",
    min: 1,
    max: 999,
  },
  {
    id: "hfp-createDateSubcollections",
    pref: "createDateSubcollections",
    kind: "checkbox",
  },
  {
    id: "hfp-createTopicCollections",
    pref: "createTopicCollections",
    kind: "checkbox",
  },
  { id: "hfp-topicRules", pref: "topicRules", kind: "textarea" },
];

export async function registerPrefsScripts(win: Window) {
  const doc = win.document;
  for (const binding of BINDINGS) {
    const node = doc.querySelector(`#${binding.id}`) as any;
    if (!node) {
      continue;
    }
    const load = () => {
      const value = getPref(binding.pref as any);
      if (binding.kind === "checkbox") {
        node.checked = !!value;
      } else if (binding.kind === "number") {
        node.value = String(value);
      } else {
        node.value = value ?? "";
      }
    };
    /**
     * Persist the control's value.
     * @param commit `true` when editing finished (`change`): clamp numbers
     *   back into range and write fallbacks into the field. `false` while
     *   typing (`input`): never touch the field itself.
     */
    const save = (commit: boolean) => {
      if (binding.kind === "checkbox") {
        setPref(binding.pref as any, !!node.checked);
      } else if (binding.kind === "number") {
        const parsed = parseInt(node.value, 10);
        if (isNaN(parsed)) {
          if (commit) {
            // Empty/invalid on commit: restore the stored value.
            node.value = String(getPref(binding.pref as any));
          }
          return;
        }
        const clamped = Math.min(
          binding.max ?? Number.POSITIVE_INFINITY,
          Math.max(binding.min ?? Number.NEGATIVE_INFINITY, parsed),
        );
        if (commit && clamped !== parsed) {
          node.value = String(clamped);
        }
        setPref(binding.pref as any, clamped);
      } else if (binding.kind === "text") {
        const trimmed = String(node.value ?? "").trim();
        if (!trimmed && !commit) {
          return; // while typing, keep the old pref until commit
        }
        const value = trimmed || binding.fallback || "";
        if (commit && !trimmed && binding.fallback) {
          node.value = value;
        }
        setPref(binding.pref as any, value);
      } else {
        setPref(binding.pref as any, String(node.value ?? ""));
      }
    };
    load();
    node.addEventListener(
      binding.kind === "checkbox" ? "command" : "change",
      () => save(true),
    );
    // XUL checkbox fires `command`, HTML input fires `input` while typing.
    if (binding.kind !== "checkbox") {
      node.addEventListener("input", () => {
        if (binding.kind === "textarea") {
          return; // textarea saves on change (blur), like Zotero's own panes
        }
        save(false);
      });
    }
  }
  registerTopicRulesEditor(win);
}

/** Format a message from preferences.ftl through the pane's document.l10n. */
async function prefString(
  doc: Document,
  id: FluentMessageId,
  args?: Record<string, unknown>,
): Promise<string> {
  const fullId = getLocaleID(id);
  try {
    const l10n = (doc as any).l10n;
    if (l10n?.formatValue) {
      const text = await l10n.formatValue(fullId, args);
      if (text) {
        return text;
      }
    }
  } catch (e) {
    ztoolkit.log(`Missing localization for ${fullId}`, e);
  }
  return fullId;
}

/** Wire the "Validate rules" and "Restore default rules" buttons. */
function registerTopicRulesEditor(win: Window) {
  const doc = win.document;
  const rulesInput = doc.querySelector("#hfp-topicRules") as any;
  const validateButton = doc.querySelector("#hfp-validateRules") as any;
  const resetButton = doc.querySelector("#hfp-resetRules") as any;
  const resultNode = doc.querySelector("#hfp-topicRulesValidation") as any;
  if (!rulesInput || !validateButton || !resetButton || !resultNode) {
    return;
  }

  const showResult = (text: string, valid: boolean) => {
    resultNode.textContent = text;
    resultNode.classList.toggle("hfp-pref-ok", valid);
    resultNode.classList.toggle("hfp-pref-err", !valid);
    resultNode.hidden = false;
  };

  const validate = async () => {
    const errors = validateTopicRules(String(rulesInput.value ?? ""));
    if (errors.length === 0) {
      showResult(await prefString(doc, "pref-rules-valid"), true);
      return;
    }
    const lines = await Promise.all(
      errors.map((error) =>
        prefString(doc, "pref-rules-invalid-line", {
          line: error.line,
          pattern: error.pattern,
          error: error.error,
        }),
      ),
    );
    showResult(lines.join("\n"), false);
  };

  validateButton.addEventListener("click", () => {
    void validate();
  });

  resetButton.addEventListener("click", () => {
    void (async () => {
      const confirmed = win.confirm(
        await prefString(doc, "pref-reset-rules-confirm"),
      );
      if (!confirmed) {
        return;
      }
      rulesInput.value = DEFAULT_TOPIC_RULES;
      setPref("topicRules", DEFAULT_TOPIC_RULES);
      await validate();
    })();
  });
}

// Default preferences. The scaffold rewrites these keys to
// `extensions.zotero.hfdailypapers.<key>` at build time.
pref("autoSync", true);
pref("lookbackDays", 1);
pref("minUpvotes", 30);
pref("downloadPdf", true);
pref("hotThreshold", 50);
pref("createDateSubcollections", true);
pref("createTopicCollections", true);
pref("tagKeywords", true);
pref("rootCollectionName", "HF Daily Papers");
pref("sourceTag", "HF Papers");
// One rule per line: `<regex pattern> -> <collection name>`
// NOTE: Keep this string in sync with DEFAULT_TOPIC_RULES in
// src/modules/preferenceScript.ts — the two must remain identical.
pref(
  "topicRules",
  "\\bllm\\b|large language model|language model -> LLM\nmultimodal|vision[- ]language|vlm|image[- ]text -> Multimodal\nagent|tool use|tool[- ]calling|planning -> Agents\nreinforcement learning|\\brl\\b|reward model|rlhf|grpo -> Reinforcement Learning\ndiffusion|flow matching|stable diffusion|text[- ]to[- ]image|image generation -> Generative Models\n\\brag\\b|retrieval[- ]augmented|retrieval augmented -> RAG\nfine[- ]?tun|lora|peft|instruction tuning|\\bsft\\b|dpo -> Fine-tuning\nbenchmark|evaluation|\\beval\\b -> Benchmarks\nspeech|audio|voice|\\basr\\b|\\btts\\b -> Speech\n\\bvision\\b|\\bimages?\\b|\\bvideos?\\b -> Vision\nsafety|alignment|jailbreak|red[- ]team -> Safety\nreasoning|chain[- ]of[- ]thought|\\bcot\\b|\\bmath\\b -> Reasoning\nquantization|pruning|distill|efficien|compression|inference accele -> Efficiency\nrobot -> Robotics\ntranslation|machine translation -> NLP",
);
pref("lastSyncDate", "");

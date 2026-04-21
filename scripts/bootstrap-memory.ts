import { brain } from "@/clients/brain";
import { persona, policies, seedEntities } from "@/config";
import { log } from "@/util/log";

/**
 * One-time seed of brainctl with persona, goals, banned topics, and the
 * core policy catalog. Idempotent on brainctl's side — safe to re-run.
 */
async function main(): Promise<void> {
  log.info({}, "bootstrap.start");

  await brain.agent_register({
    persona: `@${persona.handle}: ${persona.voice}`,
    goals: persona.goals,
  });

  const beliefs = [
    { key: "voice", value: persona.voice },
    ...persona.topics.map((t, i) => ({ key: `topic.${i}`, value: t })),
    ...persona.banned_topics.map((t, i) => ({ key: `banned_topic.${i}`, value: t })),
    ...persona.style_notes.map((n, i) => ({ key: `style.${i}`, value: n })),
  ];
  await brain.belief_seed({ beliefs });

  // Core policies — read-only in brainctl, used for policy_match at reasoning time.
  const catalog: Array<{ policy_id: string; description: string; rule: string; priority?: number }> = [
    {
      policy_id: "dm.mutual_only",
      description: "DMs only to mutuals who engaged in last 14 days",
      rule: "action.kind == 'dm' => target.mutual == true AND last_engagement_days < 14",
      priority: 100,
    },
    {
      policy_id: "relevance.reply",
      description: "Reply must clear reply relevance threshold",
      rule: `action.kind == 'reply' => relevance >= ${policies.thresholds.min_relevance_reply}`,
      priority: 90,
    },
    {
      policy_id: "cooldown.per_target",
      description: "No repeat action on same target within cooldown",
      rule: `cooldown_minutes(target, any) <= now - last_action(target)`,
      priority: 95,
    },
    {
      policy_id: "cap.daily",
      description: "Daily caps per action kind",
      rule: "count(action.kind, day) < policies.caps_per_day[action.kind] * ramp_multiplier",
      priority: 80,
    },
    {
      policy_id: "banned_topic",
      description: "No banned topics in output text",
      rule: "action.text does not contain any persona.banned_topics",
      priority: 100,
    },
  ];

  for (const p of catalog) {
    await brain.policy_add(p);
  }

  await brain.budget_set({ scope: "xai_tokens_monthly", amount: 500_000_000, unit: "tokens" });
  await brain.budget_set({ scope: "xai_tool_calls_monthly", amount: 10_000, unit: "calls" });

  // Seed watch users + topics as entities
  for (const handle of seedEntities.watch_users) {
    await brain.entity_create({ kind: "person", name: handle, aliases: [handle] });
  }
  for (const topic of seedEntities.watch_topics) {
    await brain.entity_create({ kind: "topic", name: topic });
  }

  log.info({ policies: catalog.length }, "bootstrap.done");
  process.exit(0);
}

void main().catch((err) => {
  log.error({ err }, "bootstrap.failed");
  process.exit(1);
});

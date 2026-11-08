import type { SkillDefinition, SkillResult } from "./types.ts";

export interface TimeSkillData {
  isoTimestamp: string;
  timezone: string;
  localTime: string;
}

/** Answer clock questions from the local system clock, without a model call. */
export function createTimeSkill(): SkillDefinition<TimeSkillData> {
  return {
    id: "time",
    name: "Local time",
    description: "Read the current time in Ultron's configured time zone.",
    priority: 8,
    routes: [
      {
        phrases: [
          "what time is it",
          "what is the time",
          "what's the time",
          "tell me the time",
          "what's the current time",
          "current time",
          "time now",
          "अभी क्या समय है",
          "समय क्या हुआ है",
          "কয়টা বাজে",
          "এখন কয়টা",
        ],
        weight: 15,
      },
    ],
    async execute(context): Promise<SkillResult<TimeSkillData>> {
      const localTime = new Intl.DateTimeFormat("en-IN", {
        timeZone: context.config.timezone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "long",
      }).format(context.now);
      return {
        skill: "time",
        timestamp: context.now.toISOString(),
        summary: `It's ${localTime}.`,
        sections: [],
        data: {
          isoTimestamp: context.now.toISOString(),
          timezone: context.config.timezone,
          localTime,
        },
        warnings: [],
      };
    },
  };
}

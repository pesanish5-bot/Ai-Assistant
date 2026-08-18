import type { SkillDefinition } from "./types.ts";

type UnknownSkillDefinition = SkillDefinition<unknown>;

export class SkillRegistry {
  private readonly skills = new Map<string, UnknownSkillDefinition>();

  register<TData>(definition: SkillDefinition<TData>): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(definition.id)) {
      throw new Error(`Malformed skill id: ${definition.id}`);
    }
    if (!definition.name.trim() || !definition.description.trim()) {
      throw new Error(`Skill ${definition.id} requires a name and description.`);
    }
    if (definition.routes.length === 0 || definition.routes.some((route) => route.phrases.length === 0)) {
      throw new Error(`Skill ${definition.id} requires at least one routing phrase.`);
    }
    if (this.skills.has(definition.id)) {
      throw new Error(`Skill already registered: ${definition.id}`);
    }

    this.skills.set(definition.id, definition as UnknownSkillDefinition);
  }

  get(id: string): UnknownSkillDefinition {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    return skill;
  }

  list(): UnknownSkillDefinition[] {
    return [...this.skills.values()];
  }
}

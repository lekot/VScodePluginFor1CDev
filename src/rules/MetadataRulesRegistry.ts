// src/rules/MetadataRulesRegistry.ts
import { IMetadataRulesRegistry, MetadataObjectRules } from './types';

export class MetadataRulesRegistry implements IMetadataRulesRegistry {
    private readonly rules = new Map<string, MetadataObjectRules>();

    register(rules: MetadataObjectRules): void {
        this.rules.set(rules.rootTag, rules);
    }

    get(rootTag: string): MetadataObjectRules | undefined {
        return this.rules.get(rootTag);
    }

    allRootTags(): readonly string[] {
        return Array.from(this.rules.keys());
    }
}

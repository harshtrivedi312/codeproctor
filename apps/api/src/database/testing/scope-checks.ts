// The completeness rules for the org scope map (ADR 0006 section 1: "a test fails if any model has
// neither org_id nor a scope path"), as a pure function over a rule map and model metadata. The
// real test runs it on ORG_SCOPE and the generated client's models and expects no problems. The
// same function is run on deliberately broken input to show that each rule can fail.
import type { OrgScopeRule } from '../org-scope-map';
import type { ModelMeta } from './data-model';

function hasOrgIdColumn(model: ModelMeta): boolean {
  return model.fields.some((f) => f.kind === 'scalar' && f.dbName === 'org_id');
}

/** Problems with `rules`, one sentence each; an empty list means the map is complete and sound. */
export function findScopeProblems(
  rules: Readonly<Record<string, OrgScopeRule>>,
  models: Readonly<Record<string, ModelMeta>>,
): string[] {
  const problems: string[] = [];

  for (const name of Object.keys(models)) {
    if (!Object.hasOwn(rules, name)) {
      problems.push(
        `${name} has neither an org_id nor a scope path: add it to ORG_SCOPE in org-scope-map.ts.`,
      );
    }
  }
  for (const name of Object.keys(rules)) {
    if (!Object.hasOwn(models, name)) {
      problems.push(`ORG_SCOPE has an entry for ${name}, which is not a model in the schema.`);
    }
  }

  for (const [name, model] of Object.entries(models)) {
    const rule = rules[name];
    if (rule === undefined) continue;
    const ownsColumn = hasOrgIdColumn(model);

    switch (rule.kind) {
      case 'direct':
        if (!model.fields.some((f) => f.name === 'orgId' && f.dbName === 'org_id')) {
          problems.push(`${name} is declared direct but has no field orgId mapped to org_id.`);
        }
        break;
      case 'self':
        if (name !== 'Organization')
          problems.push(`${name} is declared self; only Organization is.`);
        break;
      case 'unscoped':
        if (rule.reason.trim() === '') problems.push(`${name} is unscoped without a reason.`);
        if (ownsColumn) problems.push(`${name} has an org_id column but is declared unscoped.`);
        break;
      case 'path': {
        if (ownsColumn) {
          problems.push(`${name} has an org_id column, so it must be direct, not path-scoped.`);
        }
        let from: ModelMeta = model;
        for (const [index, relation] of rule.path.entries()) {
          const field = from.fields.find((f) => f.name === relation);
          if (field?.kind !== 'object') {
            problems.push(`${name}: ${from.name}.${relation} is not a relation field.`);
            break;
          }
          if (field.isList === true) {
            problems.push(
              `${name}: ${from.name}.${relation} is a list; a path needs to-one relations.`,
            );
          }
          if (field.isOptional === true) {
            problems.push(
              `${name}: ${from.name}.${relation} is optional, so rows with no parent would escape the filter.`,
            );
          }
          if (field.holdsForeignKey !== true) {
            problems.push(
              `${name}: ${from.name}.${relation} does not hold the foreign key; a path must climb to the parent.`,
            );
          }
          const target = models[field.type];
          if (target === undefined) {
            problems.push(
              `${name}: ${from.name}.${relation} points to unknown model ${field.type}.`,
            );
            break;
          }
          const isLast = index === rule.path.length - 1;
          if (isLast && !hasOrgIdColumn(target)) {
            problems.push(`${name}: the path ends at ${target.name}, which has no org_id.`);
          }
          if (!isLast && hasOrgIdColumn(target)) {
            problems.push(
              `${name}: the path passes ${target.name}, which already has org_id; end the path there (nearest ancestor).`,
            );
          }
          from = target;
        }
        break;
      }
    }
  }

  return problems;
}

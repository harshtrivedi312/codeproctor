import { SetMetadata } from '@nestjs/common';

export const AUDITED = 'audit:audited';

export interface AuditedOptions {
  readonly action: string;
  readonly entityType: string;
  /** Route parameter that holds the entity id, e.g. 'id' for GET /review/sessions/:id. */
  readonly idParam?: string;
}

/**
 * Marks a route whose successful call writes an audit_logs row (FR-105): who (the signed-in
 * user), what (action, entity type, entity id from a route parameter), when, from which IP.
 * Use it on every staff route that reads or changes candidate data. The row is written before the
 * response is sent; if the write fails the request fails and no data is returned.
 */
export const Audited = (
  action: string,
  entityType: string,
  options: { idParam?: string } = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AuditedOptions>(AUDITED, { action, entityType, ...options });

// Walks the Nest module graph and lists every controller route with the access its decorators
// declare, so the matrix can be checked against what is really registered.
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { UserRole } from '../../generated/prisma/client';
import { IS_PUBLIC, ROLES } from './decorators';
import { ROUTE_PERMISSIONS } from './route-permissions';

export interface RegisteredRoute {
  /** "METHOD /path", without the global prefix, e.g. "POST /auth/2fa/reset/:userId". */
  key: string;
  handler: string;
  isPublic: boolean;
  roles: readonly UserRole[];
}

function firstPath(value: unknown): string {
  const raw = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof raw === 'string' ? raw : '';
}

function join(...parts: string[]): string {
  const clean = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return `/${clean.join('/')}`;
}

export function listRoutes(modules: ModulesContainer): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype;
      if (typeof cls !== 'function') continue;
      const proto = cls.prototype as Record<string, unknown>;
      const base = firstPath(Reflect.getMetadata(PATH_METADATA, cls));
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (verb === undefined) continue;
        const path = firstPath(Reflect.getMetadata(PATH_METADATA, handler));
        const pick = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls)) as T | undefined;
        routes.push({
          key: `${RequestMethod[verb]} ${join(base, path)}`,
          handler: `${cls.name}.${name}`,
          isPublic: pick<boolean>(IS_PUBLIC) === true,
          roles: pick<UserRole[]>(ROLES) ?? [],
        });
      }
    }
  }
  return routes;
}

/** Problems between the matrix and the registered controllers; empty when they agree. */
export function matrixProblems(routes: readonly RegisteredRoute[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    seen.add(route.key);
    const entry = Object.hasOwn(ROUTE_PERMISSIONS, route.key)
      ? ROUTE_PERMISSIONS[route.key]
      : undefined;
    if (entry === undefined) {
      problems.push(`${route.key} (${route.handler}) is not in ROUTE_PERMISSIONS`);
    } else if (route.isPublic && route.roles.length > 0) {
      problems.push(`${route.key} (${route.handler}) carries both @Public() and @Roles()`);
    } else if (entry === 'public') {
      if (!route.isPublic) problems.push(`${route.key} is public in the matrix but not @Public()`);
    } else if (route.isPublic) {
      problems.push(`${route.key} is @Public() but the matrix lists roles for it`);
    } else if (
      route.roles.length !== entry.roles.length ||
      !entry.roles.every((r) => route.roles.includes(r))
    ) {
      problems.push(`${route.key} @Roles() differs from the matrix`);
    }
  }
  for (const key of Object.keys(ROUTE_PERMISSIONS)) {
    if (!seen.has(key)) problems.push(`${key} is in ROUTE_PERMISSIONS but no controller serves it`);
  }
  return problems;
}

// Walks the Nest module graph and lists every controller route with the access its decorators
// declare, so the matrix can be checked against what is really registered.
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { UserRole } from '../../generated/prisma/client';
import { AUDITED } from '../../audit/audited.decorator';
import { CANDIDATE_ROUTE } from './candidate-route.decorator';
import { IS_PUBLIC, ROLES } from './decorators';
import { ROUTE_PERMISSIONS, isCandidate, isPublic } from './route-permissions';

export interface RegisteredRoute {
  /** "METHOD /path", without the global prefix, e.g. "POST /auth/2fa/reset/:userId". */
  key: string;
  handler: string;
  isPublic: boolean;
  roles: readonly UserRole[];
  /** The handler or its class carries @Audited. */
  audited: boolean;
  /** Permission set by @CandidateRoute, or null when the route does not carry the marker. */
  candidatePermission: string | null;
}

function join(...parts: string[]): string {
  const clean = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return `/${clean.join('/')}`;
}

function pathsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : ''));
  return [typeof value === 'string' ? value : ''];
}

/** Method names of a controller and of every class it extends (inherited routes count). */
function handlerNames(cls: object): Map<string, object> {
  const found = new Map<string, object>();
  for (
    let proto: object | null = (cls as { prototype: object }).prototype;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || found.has(name)) continue;
      const value = (proto as Record<string, unknown>)[name];
      if (typeof value === 'function') found.set(name, value);
    }
  }
  return found;
}

export function listRoutes(modules: ModulesContainer): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype;
      if (typeof cls !== 'function') continue;
      const bases = pathsOf(Reflect.getMetadata(PATH_METADATA, cls));
      for (const [name, handler] of handlerNames(cls)) {
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (verb === undefined) continue;
        const paths = pathsOf(Reflect.getMetadata(PATH_METADATA, handler));
        const pick = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls)) as T | undefined;
        // One entry per path: @Get(['a', 'b']) and @Controller(['x', 'y']) register every combination.
        for (const base of bases) {
          for (const path of paths) {
            routes.push({
              key: `${RequestMethod[verb]} ${join(base, path)}`,
              handler: `${cls.name}.${name}`,
              isPublic: pick<boolean>(IS_PUBLIC) === true,
              roles: pick<UserRole[]>(ROLES) ?? [],
              audited: pick<unknown>(AUDITED) !== undefined,
              candidatePermission: pick<string>(CANDIDATE_ROUTE) ?? null,
            });
          }
        }
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
    if (seen.has(route.key)) {
      problems.push(`${route.key} (${route.handler}) is served by more than one handler`);
    }
    seen.add(route.key);
    const entry = Object.hasOwn(ROUTE_PERMISSIONS, route.key)
      ? ROUTE_PERMISSIONS[route.key]
      : undefined;
    if (entry === undefined) {
      problems.push(`${route.key} (${route.handler}) is not in ROUTE_PERMISSIONS`);
    } else if (route.isPublic && route.roles.length > 0) {
      problems.push(`${route.key} (${route.handler}) carries both @Public() and @Roles()`);
    } else if (isCandidate(entry)) {
      if (!route.isPublic) {
        problems.push(
          `${route.key} is a CANDIDATE route in the matrix but not @Public(), so the staff guard would refuse it`,
        );
      }
      if (route.candidatePermission === null) {
        problems.push(
          `${route.key} is a CANDIDATE route in the matrix but has no @CandidateRoute()`,
        );
      } else if (route.candidatePermission !== entry.permission) {
        problems.push(`${route.key} @CandidateRoute() permission differs from the matrix`);
      }
      if (route.roles.length > 0) {
        problems.push(`${route.key} is a CANDIDATE route but carries @Roles()`);
      }
      if (route.audited && entry.audited !== true) {
        problems.push(
          `${route.key} is a CANDIDATE route with @Audited(); candidate routes write no audit rows (ADR 0013)`,
        );
      } else if (!route.audited && entry.audited === true) {
        problems.push(`${route.key} is audited in the matrix but has no @Audited()`);
      }
    } else if (route.candidatePermission !== null) {
      problems.push(
        route.roles.length > 0
          ? `${route.key} (${route.handler}) is a staff route (@Roles()) but carries @CandidateRoute()`
          : `${route.key} (${route.handler}) carries @CandidateRoute() but the matrix does not list it as CANDIDATE`,
      );
    } else if (isPublic(entry)) {
      if (!route.isPublic) problems.push(`${route.key} is public in the matrix but not @Public()`);
    } else if (route.isPublic) {
      problems.push(`${route.key} is @Public() but the matrix lists roles for it`);
    } else if (
      route.roles.length !== entry.roles.length ||
      !entry.roles.every((r) => route.roles.includes(r))
    ) {
      problems.push(`${route.key} @Roles() differs from the matrix`);
    } else {
      const marked = entry.audited === true;
      if (marked && !route.audited) {
        problems.push(`${route.key} is audited in the matrix but has no @Audited()`);
      } else if (!marked && route.audited) {
        problems.push(`${route.key} has @Audited() but the matrix does not say audited`);
      }
      if (entry.candidateData === true && !marked) {
        problems.push(`${route.key} touches candidate data but is not audited (FR-105)`);
      }
    }
  }
  for (const key of Object.keys(ROUTE_PERMISSIONS)) {
    if (!seen.has(key)) problems.push(`${key} is in ROUTE_PERMISSIONS but no controller serves it`);
  }
  return problems;
}

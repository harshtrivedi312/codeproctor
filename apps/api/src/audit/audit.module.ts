import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit.interceptor';

/** Turns on the @Audited() interceptor for every route (FR-105). */
@Global()
@Module({ providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }] })
export class AuditModule {}

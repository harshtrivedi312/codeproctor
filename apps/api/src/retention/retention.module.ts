// RetentionModule (FR-704, NFR-05). Not imported by AppModule yet. It needs two things from outside:
// a module that exports ObjectStorePort (BE-09's MediaModule, with its S3ObjectStore adapter) and
// a scheduler that calls RetentionService.runDaily() (the BullMQ module). The port is never bound
// here, so a build that forgets the store cannot start a run with a fake one:
//
//   RetentionModule.forRoot({ objectStore: MediaModule })
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database';
import { LegalHoldPort, NoLegalHold } from './legal-hold.port';
import { loadRetentionConfig } from './retention.config';
import { RetentionRepository } from './retention.repository';
import { RETENTION_CONFIG, RetentionService } from './retention.service';

export interface RetentionModuleOptions {
  /** A module that exports ObjectStorePort. */
  readonly objectStore: NonNullable<ModuleMetadata['imports']>[number];
  /** Optional: a module that exports LegalHoldPort (OQ-10). The default holds nothing. */
  readonly legalHold?: NonNullable<ModuleMetadata['imports']>[number];
}

@Module({})
export class RetentionModule {
  static forRoot(options: RetentionModuleOptions): DynamicModule {
    return {
      module: RetentionModule,
      imports: [
        DatabaseModule,
        options.objectStore,
        ...(options.legalHold ? [options.legalHold] : []),
      ],
      providers: [
        RetentionRepository,
        RetentionService,
        { provide: RETENTION_CONFIG, useFactory: () => loadRetentionConfig(process.env) },
        ...(options.legalHold ? [] : [{ provide: LegalHoldPort, useClass: NoLegalHold }]),
      ],
      exports: [RetentionService],
    };
  }
}

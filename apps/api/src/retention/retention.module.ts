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
import { ConsentRetentionRepository } from './consent-retention.repository';
import {
  ErasureAlertPort,
  ErasureNoticePort,
  ErasureSchedulerPort,
  SessionFencePort,
  UnconfiguredErasureAlert,
  UnconfiguredErasureNotice,
  UnconfiguredErasureScheduler,
  UnconfiguredSessionFence,
} from './erasure/erasure.ports';
import { ErasureRepository } from './erasure/erasure.repository';
import { ErasureService } from './erasure/erasure.service';
import { RetentionRepository } from './retention.repository';
import { RETENTION_CONFIG, RetentionService } from './retention.service';

export interface RetentionModuleOptions {
  /** A module that exports ObjectStorePort. */
  readonly objectStore: NonNullable<ModuleMetadata['imports']>[number];
  /** Optional: a module that exports LegalHoldPort (OQ-10). The default holds nothing. */
  readonly legalHold?: NonNullable<ModuleMetadata['imports']>[number];
  /** Optional: a module that exports SessionFencePort, ErasureSchedulerPort, ErasureNoticePort and ErasureAlertPort. Without it every erasure call is refused (fail closed). */
  readonly erasure?: NonNullable<ModuleMetadata['imports']>[number];
}

@Module({})
export class RetentionModule {
  static forRoot(options: RetentionModuleOptions): DynamicModule {
    // A legal hold that is switched on but has no port bound would delete anyway: refuse to build.
    if (loadRetentionConfig(process.env).RETENTION_LEGAL_HOLD && !options.legalHold) {
      throw new Error(
        'RETENTION_LEGAL_HOLD is on but RetentionModule.forRoot got no legalHold module',
      );
    }
    return {
      module: RetentionModule,
      imports: [
        DatabaseModule,
        options.objectStore,
        ...(options.legalHold ? [options.legalHold] : []),
        ...(options.erasure ? [options.erasure] : []),
      ],
      providers: [
        RetentionRepository,
        ConsentRetentionRepository,
        RetentionService,
        { provide: RETENTION_CONFIG, useFactory: () => loadRetentionConfig(process.env) },
        ...(options.legalHold ? [] : [{ provide: LegalHoldPort, useClass: NoLegalHold }]),
        ErasureRepository,
        ErasureService,
        ...(options.erasure
          ? []
          : [
              { provide: SessionFencePort, useClass: UnconfiguredSessionFence },
              { provide: ErasureSchedulerPort, useClass: UnconfiguredErasureScheduler },
              { provide: ErasureNoticePort, useClass: UnconfiguredErasureNotice },
              { provide: ErasureAlertPort, useClass: UnconfiguredErasureAlert },
            ]),
      ],
      exports: [RetentionService, ErasureService],
    };
  }
}

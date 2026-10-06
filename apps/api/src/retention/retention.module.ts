// RetentionModule (FR-704, NFR-05). Not imported by AppModule yet: BE-09 binds a real
// ObjectStorePort and the scheduler (BE-13 or the BullMQ module) calls RetentionService.runDaily().
// Until a store is bound, a run refuses to start (UnconfiguredObjectStore).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database';
import { LegalHoldPort, NoLegalHold } from './legal-hold.port';
import { ObjectStorePort, UnconfiguredObjectStore } from './object-store.port';
import { loadRetentionConfig } from './retention.config';
import { RetentionRepository } from './retention.repository';
import { RETENTION_CONFIG, RetentionService } from './retention.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    RetentionRepository,
    RetentionService,
    { provide: RETENTION_CONFIG, useFactory: () => loadRetentionConfig(process.env) },
    { provide: ObjectStorePort, useClass: UnconfiguredObjectStore },
    { provide: LegalHoldPort, useClass: NoLegalHold },
  ],
  exports: [RetentionService],
})
export class RetentionModule {}

import { Module } from '@nestjs/common';
import { ClientErrorsController } from './client-errors.controller';
import { ClientErrorsService } from './client-errors.service';

@Module({ controllers: [ClientErrorsController], providers: [ClientErrorsService] })
export class ClientErrorsModule {}

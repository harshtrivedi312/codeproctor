import { Module } from '@nestjs/common';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { VariantsController } from './variants.controller';
import { VariantsService } from './variants.service';

@Module({
  controllers: [QuestionsController, VariantsController],
  providers: [QuestionsService, VariantsService],
})
export class QuestionsModule {}

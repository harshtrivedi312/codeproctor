// Candidate question read (ADR 0013 CS-4.6; FR-301, FR-501). The id is a session_questions.id,
// validated as a UUID and resolved only under the token's session (CS-2): a question of another
// session or org is a 404, a question outside the open section is 409 SECTION_NOT_OPEN.
import { Controller, Get, Header, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Candidate, CandidateScoped } from '../candidate/candidate.decorators';
import type { CandidateContext } from '../candidate/candidate.types';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { QuestionViewService } from './question-view.service';
import type { QuestionView } from './question-view.service';

const NO_STORE = 'no-store';

@ApiTags('candidate')
@Controller('candidate')
export class QuestionsController {
  constructor(
    private readonly questions: QuestionViewService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @Get('questions/:questionId')
  @Header('Cache-Control', NO_STORE)
  @CandidateScoped('candidate_session:read')
  @ApiOperation({
    summary: 'The candidate-safe view of one question of the open section (ADR 0013 CS-4.6)',
    description:
      'Statement, languages, starter code, sample tests (and for MCQ the options without the key). Never hidden tests, the reference solution or the answer key. Reads are allowed in every pause.',
  })
  @ApiOkResponse({ description: 'QuestionView' })
  @ApiConflictResponse({ description: 'SECTION_NOT_OPEN, SESSION_NOT_ACTIVE' })
  @ApiNotFoundResponse({ description: 'The question is not one of this session' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async view(
    @Candidate() ctx: CandidateContext,
    @Param('questionId', ParseUUIDPipe) questionId: string,
  ): Promise<QuestionView> {
    await this.limiter.hit('question-read', ctx.sessionId, 120, 60);
    return this.questions.view(ctx, questionId);
  }
}

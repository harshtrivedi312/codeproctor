// Candidate answer routes and finish (FR-502, FR-504, FR-505, FR-506; ADR 0002 S-5; ADR 0013 5.10,
// 5.11). The session is the token's: no route has a :sessionId. `:questionId` is a
// session_questions.id, validated as a UUID and resolved only under the token's session (CS-2); an id
// of another session or org answers 404. Write routes also run SessionWritableGuard (DL-17).
import {
  Body,
  Controller,
  Header,
  HttpCode,
  ParseUUIDPipe,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { candidateVisibleStatus } from '../session/candidate-visible-status';
import { Candidate, CandidateScoped } from '../candidate/candidate.decorators';
import type { CandidateContext } from '../candidate/candidate.types';
import { SubmitFlowService } from '../grading/submit-flow.service';
import { SessionWritableGuard } from '../session/session-write-gate';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { AnswersService } from './answers.service';
import {
  DraftDto,
  DraftSavedDto,
  RunDto,
  RunResultDto,
  SectionFinishDto,
  SectionFinishQueuedDto,
  SessionFinishedDto,
  SubmitAcceptedDto,
  SubmitDto,
} from './dto/answers.dto';

const NO_STORE = 'no-store';
const QUESTION_ID = new ParseUUIDPipe();

@ApiTags('candidate')
@Controller('candidate')
export class AnswersController {
  constructor(
    private readonly answers: AnswersService,
    private readonly flow: SubmitFlowService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @Post('answers/:questionId/run')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(SessionWritableGuard)
  @CandidateScoped('candidate_answer:run')
  @ApiOperation({
    summary: 'Run the code against the sample tests (FR-502)',
    description:
      'Sample tests of the question variant only. One run per 5 s per session. The code is autosaved and a RUN row is stored. Only questions of the open section are accepted.',
  })
  @ApiOkResponse({ type: RunResultDto })
  @ApiConflictResponse({ description: 'SECTION_NOT_OPEN, SESSION_NOT_ACTIVE, SESSION_PAUSED' })
  @ApiNotFoundResponse({ description: 'The question is not one of this session' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED: one run per 5 s' })
  async run(
    @Candidate() ctx: CandidateContext,
    @Param('questionId', QUESTION_ID) questionId: string,
    @Body() dto: RunDto,
  ): Promise<RunResultDto> {
    const view = await this.answers.run(ctx, questionId, dto);
    return { ...view, serverTime: view.serverTime.toISOString(), results: [...view.results] };
  }

  @Put('answers/:questionId/draft')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(SessionWritableGuard)
  @CandidateScoped('candidate_answer:draft')
  @ApiOperation({
    summary: 'Autosave a draft every 10 s (FR-504)',
    description:
      'CODING: code and language. MCQ: answer { optionIds }. SHORT_ANSWER: answer { text }. The client keeps an unsaved draft on 409 SESSION_PAUSED and retries after the pause.',
  })
  @ApiOkResponse({ type: DraftSavedDto })
  @ApiConflictResponse({ description: 'SECTION_NOT_OPEN, SESSION_NOT_ACTIVE, SESSION_PAUSED' })
  @ApiNotFoundResponse({ description: 'The question is not one of this session' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async draft(
    @Candidate() ctx: CandidateContext,
    @Param('questionId', QUESTION_ID) questionId: string,
    @Body() dto: DraftDto,
  ): Promise<DraftSavedDto> {
    const savedAt = await this.answers.draft(ctx, questionId, dto);
    return { savedAt: savedAt.toISOString() };
  }

  @Post('session/section/finish')
  @HttpCode(202)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(SessionWritableGuard)
  @CandidateScoped('candidate_section:finish')
  @ApiOperation({
    summary: 'Finish the section at a position of this session (ADR 0002 S-5)',
    description:
      'Enqueues the close of the section (snapshot of the saved code, next section opens). Body { position }. Idempotent: a section that is already closing or closed is a no-op (202), so a retry never touches the next section. A closed section cannot be reopened (FR-301). 409 SESSION_PAUSED during a pause that locks writes; 409 SECTION_NOT_OPEN for a later section that has not opened; 404 for a position the session does not have.',
  })
  @ApiAcceptedResponse({ type: SectionFinishQueuedDto })
  @ApiConflictResponse({ description: 'SECTION_NOT_OPEN, SESSION_NOT_ACTIVE, SESSION_PAUSED' })
  @ApiNotFoundResponse({ description: 'The session has no section at that position' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async finishSection(
    @Candidate() ctx: CandidateContext,
    @Body() dto: SectionFinishDto,
  ): Promise<SectionFinishQueuedDto> {
    await this.answers.finishSection(ctx, dto.position);
    return { accepted: true };
  }

  @Post('answers/:questionId/submit')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(SessionWritableGuard)
  @CandidateScoped('candidate_answer:submit')
  @ApiOperation({
    summary: 'Submit the code of a coding question (FR-506)',
    description:
      'Stores a SUBMIT row and the saved code. Returns only { accepted, submissionId }: no test result, weight or score. One per 10 s per session, 20 per question. Grading runs after the test.',
  })
  @ApiOkResponse({ type: SubmitAcceptedDto })
  @ApiConflictResponse({
    description: 'SECTION_NOT_OPEN, SESSION_NOT_ACTIVE, SESSION_PAUSED, SUBMIT_LIMIT_REACHED',
  })
  @ApiNotFoundResponse({ description: 'The question is not one of this session' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED: one submit per 10 s' })
  async submit(
    @Candidate() ctx: CandidateContext,
    @Param('questionId', QUESTION_ID) questionId: string,
    @Body() dto: SubmitDto,
  ): Promise<SubmitAcceptedDto> {
    const { submissionId } = await this.answers.submit(ctx, questionId, dto);
    return { accepted: true, submissionId };
  }

  @Post('session/finish')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @CandidateScoped('candidate_session:finish')
  @ApiOperation({
    summary: 'Finish the test (IN_PROGRESS or PAUSED to SUBMITTED)',
    description:
      'Allowed while paused. Repeating the call answers with the current state. Grading is queued; the candidate sees a "submitted" page only.',
  })
  @ApiOkResponse({ type: SessionFinishedDto })
  @ApiConflictResponse({ description: 'SESSION_NOT_ACTIVE' })
  async finish(@Candidate() ctx: CandidateContext): Promise<SessionFinishedDto> {
    await this.limiter.hit('finish', ctx.sessionId, 6, 60);
    const outcome = await this.flow.finish(ctx.orgId, ctx.sessionId);
    return { status: candidateVisibleStatus(outcome.status), serverTime: new Date().toISOString() };
  }
}

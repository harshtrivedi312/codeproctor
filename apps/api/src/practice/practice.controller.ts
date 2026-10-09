// Practice question routes (FR-406). Fixed content from code; nothing is stored, timed or graded.
// The session is the token's. The run is allowed only before the test (OPENED, CONSENTED, VERIFIED).
import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Candidate, CandidateScoped } from '../candidate/candidate.decorators';
import type { CandidateContext } from '../candidate/candidate.types';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { CandidateRoute } from '../common/auth/candidate-route.decorator';
import { sessionNotActive } from '../session/session-write-gate';
import { PRACTICE_QUESTION } from './practice.content';
import { PracticeQuestionDto, PracticeRunDto, PracticeRunResultDto } from './practice.dto';
import { PracticeService } from './practice.service';

const NO_STORE = 'no-store';
const PRE_TEST = ['OPENED', 'CONSENTED', 'VERIFIED'] as const;
/** Mirrors the real run limit (one run per 5 s per session) as a per-minute window. */
export const PRACTICE_RUN_LIMIT = { limit: 12, windowSeconds: 60 } as const;
const PRACTICE_READ_LIMIT = { limit: 30, windowSeconds: 60 } as const;

@ApiTags('candidate')
@CandidateScoped()
@Controller('candidate/session/practice')
export class PracticeController {
  constructor(
    private readonly practice: PracticeService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @CandidateRoute('candidate_session:read')
  @Get()
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'The practice question (FR-406): fixed, not part of the test' })
  @ApiOkResponse({ type: PracticeQuestionDto })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async get(@Candidate() ctx: CandidateContext): Promise<PracticeQuestionDto> {
    await this.limiter.hit(
      'practice-get',
      ctx.sessionId,
      PRACTICE_READ_LIMIT.limit,
      PRACTICE_READ_LIMIT.windowSeconds,
    );
    return {
      title: PRACTICE_QUESTION.title,
      statementMarkdown: PRACTICE_QUESTION.statementMarkdown,
      languages: [...PRACTICE_QUESTION.languages],
      starterCode: { ...PRACTICE_QUESTION.starterCode },
      sampleTests: PRACTICE_QUESTION.sampleTests.map((s) => ({ ...s })),
    };
  }

  @CandidateRoute('candidate_answer:run')
  @Post('run')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Run code against the practice samples (FR-406)',
    description:
      'Nothing is stored, timed or graded. Before the test only (OPENED, CONSENTED, VERIFIED). 12 per minute per session. Local stub: stub true, no per-test status.',
  })
  @ApiOkResponse({ type: PracticeRunResultDto })
  @ApiBadRequestResponse({ description: 'Unsupported language or code over 20000 characters' })
  @ApiConflictResponse({ description: 'SESSION_NOT_ACTIVE with the current status' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async run(
    @Candidate() ctx: CandidateContext,
    @Body() dto: PracticeRunDto,
  ): Promise<PracticeRunResultDto> {
    await this.limiter.hit(
      'practice-run',
      ctx.sessionId,
      PRACTICE_RUN_LIMIT.limit,
      PRACTICE_RUN_LIMIT.windowSeconds,
    );
    if (!(PRE_TEST as readonly string[]).includes(ctx.status)) throw sessionNotActive(ctx.status);
    return this.practice.run(dto);
  }
}

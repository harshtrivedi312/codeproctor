import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { hasPermission } from '@codeproctor/shared';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import {
  CandidateQuestionPreviewDto,
  CreateQuestionDto,
  CreateTestCaseDto,
  PublishQuestionDto,
  QuestionDetailDto,
  QuestionIdParamDto,
  QuestionListDto,
  QuestionListQueryDto,
  QuestionSummaryDto,
  QuestionUpdateResultDto,
  RevisionResultDto,
  TestCaseMutationDto,
  TestCaseParamDto,
  UpdateQuestionDto,
  UpdateTestCaseDto,
  VersionParamDto,
  VersionQueryDto,
} from './dto/questions.dto';
import { RevisionQueryDto } from './dto/variants.dto';
import { QuestionsService } from './questions.service';
import type { Actor } from './questions.service';
import type { CandidateQuestionView } from './candidate-view';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

/**
 * The ONE place that decides between the full and the staff read view of a version: callers
 * without question:update (recruiters) never get answers or hidden test data (staff-view.ts).
 */
function canSeeAnswers(req: AuthedRequest): boolean {
  return req.user !== undefined && hasPermission(req.user.role, 'question:update');
}

const READERS = [UserRole.SUPER_ADMIN, UserRole.RECRUITER, UserRole.AUTHOR] as const;
const WRITERS = [UserRole.SUPER_ADMIN, UserRole.AUTHOR] as const;

// FR-201..FR-205, M2. Permissions: question:read (GET), question:create (POST /questions),
// question:update (everything else that changes a question). See route-permissions.ts.
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Get()
  @Roles(...READERS)
  @ApiOperation({ summary: 'List questions with tag, difficulty and type filters (FR-201)' })
  @ApiOkResponse({ type: QuestionListDto })
  list(@Query() query: QuestionListQueryDto, @Req() req: AuthedRequest): Promise<QuestionListDto> {
    return this.questions.list(query, canSeeAnswers(req));
  }

  @Post()
  @Roles(...WRITERS)
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a question with a draft version 1 (FR-201, FR-202, FR-205)' })
  @ApiCreatedResponse({ type: QuestionDetailDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({ description: 'The slug is taken in this organization' })
  create(@Body() dto: CreateQuestionDto, @Req() req: AuthedRequest): Promise<QuestionDetailDto> {
    return this.questions.create(actorOf(req), dto, ctxOf(req), canSeeAnswers(req));
  }

  @Get(':id')
  @Roles(...READERS)
  @ApiOperation({
    summary:
      'One question with a version (latest by default). Without question:update only published versions are visible (a draft or never-published question is 404), and the reference solution, answer_spec, validation report and hidden test data are left out.',
  })
  @ApiOkResponse({ type: QuestionDetailDto })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: VersionQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<QuestionDetailDto> {
    return this.questions.get(id, query.version, canSeeAnswers(req));
  }

  @Get(':id/preview')
  @Roles(...READERS)
  @ApiOperation({
    summary:
      'The candidate-facing view of a version (published by default): statement, samples only, no answers (TC-011)',
  })
  @ApiOkResponse({ type: CandidateQuestionPreviewDto })
  @ApiNotFoundResponse({ description: 'No such question or version in your organization' })
  preview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: VersionQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<CandidateQuestionView> {
    return this.questions.preview(id, query.version, canSeeAnswers(req));
  }

  @Patch(':id')
  @Roles(...WRITERS)
  @ApiOperation({
    summary:
      'Edit a question: updates the latest draft in place; if the latest version is published, creates the next version as a draft (FR-204)',
  })
  @ApiOkResponse({ type: QuestionUpdateResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or no field sent' })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  @ApiConflictResponse({ description: 'The question is archived, or a concurrent change won' })
  update(
    @Param() params: QuestionIdParamDto,
    @Body() dto: UpdateQuestionDto,
    @Req() req: AuthedRequest,
  ): Promise<QuestionUpdateResultDto> {
    return this.questions.update(actorOf(req), params.id, dto, ctxOf(req));
  }

  @Post(':id/publish')
  @Roles(...WRITERS)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Publish the latest draft once its content is complete (FR-201, FR-202)',
  })
  @ApiOkResponse({ type: QuestionDetailDto })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  @ApiConflictResponse({ description: 'No draft to publish, or the question is archived' })
  @ApiUnprocessableEntityResponse({ description: 'The draft is incomplete; errors lists what' })
  publish(
    @Param() params: QuestionIdParamDto,
    @Body() dto: PublishQuestionDto,
    @Req() req: AuthedRequest,
  ): Promise<QuestionDetailDto> {
    return this.questions.publish(
      actorOf(req),
      params.id,
      ctxOf(req),
      canSeeAnswers(req),
      dto.expectedRevision,
    );
  }

  @Post(':id/archive')
  @Roles(...WRITERS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-archive a question: hidden from lists, never deleted' })
  @ApiOkResponse({ type: QuestionSummaryDto })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  archive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<QuestionSummaryDto> {
    return this.questions.setArchived(actorOf(req), id, true, ctxOf(req));
  }

  @Post(':id/unarchive')
  @Roles(...WRITERS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore an archived question' })
  @ApiOkResponse({ type: QuestionSummaryDto })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  unarchive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<QuestionSummaryDto> {
    return this.questions.setArchived(actorOf(req), id, false, ctxOf(req));
  }

  @Post(':id/versions/:version/test-cases')
  @Roles(...WRITERS)
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a test case to a draft version (FR-202)' })
  @ApiCreatedResponse({ type: TestCaseMutationDto })
  @ApiNotFoundResponse({ description: 'No such question or version in your organization' })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale expectedRevision',
  })
  @ApiUnprocessableEntityResponse({ description: 'Not a coding question, or too many test cases' })
  addTestCase(
    @Param() params: VersionParamDto,
    @Body() dto: CreateTestCaseDto,
    @Req() req: AuthedRequest,
  ): Promise<TestCaseMutationDto> {
    return this.questions.addTestCase(actorOf(req), params.id, params.version, dto, ctxOf(req));
  }

  @Patch(':id/versions/:version/test-cases/:testCaseId')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Change a test case of a draft version (FR-202)' })
  @ApiOkResponse({ type: TestCaseMutationDto })
  @ApiNotFoundResponse({
    description: 'No such question, version or test case in your organization',
  })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale expectedRevision',
  })
  updateTestCase(
    @Param() params: TestCaseParamDto,
    @Body() dto: UpdateTestCaseDto,
    @Req() req: AuthedRequest,
  ): Promise<TestCaseMutationDto> {
    return this.questions.updateTestCase(
      actorOf(req),
      params.id,
      params.version,
      params.testCaseId,
      dto,
      ctxOf(req),
    );
  }

  @Delete(':id/versions/:version/test-cases/:testCaseId')
  @Roles(...WRITERS)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Remove a test case from a draft version; answers the new revision of the version (FR-202)',
  })
  @ApiOkResponse({ type: RevisionResultDto })
  @ApiNotFoundResponse({
    description: 'No such question, version or test case in your organization',
  })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale expectedRevision',
  })
  removeTestCase(
    @Param() params: TestCaseParamDto,
    @Query() q: RevisionQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<RevisionResultDto> {
    return this.questions.removeTestCase(
      actorOf(req),
      params.id,
      params.version,
      params.testCaseId,
      q.expectedRevision,
      ctxOf(req),
    );
  }
}

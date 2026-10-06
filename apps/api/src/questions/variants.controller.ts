import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { CandidateQuestionPreviewDto, VersionParamDto } from './dto/questions.dto';
import {
  CreateVariantDto,
  RevisionQueryDto,
  UpdateVariantDto,
  VariantListDto,
  VariantMutationDto,
  VariantOverrideFieldsDto,
  VariantParamDto,
  VariantTestCaseParamDto,
} from './dto/variants.dto';
import { VariantTestCaseOverrideDto } from './dto/questions.dto';
import type { CandidateQuestionView } from './candidate-view';
import type { Actor } from './question-tx';
import { VariantsService } from './variants.service';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

const READERS = [UserRole.SUPER_ADMIN, UserRole.RECRUITER, UserRole.AUTHOR] as const;
const WRITERS = [UserRole.SUPER_ADMIN, UserRole.AUTHOR] as const;

// Question variants (FR-203, ADR 0007; BE-04 slice 4b). Everything that shows params or
// overrides needs question:update; the variant preview (question:read) is the candidate-shaped
// view and never shows params, hidden cases, reference solutions or answer_spec.
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions/:id/versions/:version/variants')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class VariantsController {
  constructor(private readonly variants: VariantsService) {}

  @Get()
  @Roles(...WRITERS)
  @ApiOperation({
    summary: 'List the variants of a version with params and per-slot overrides (FR-203)',
  })
  @ApiOkResponse({ type: VariantListDto })
  @ApiNotFoundResponse({ description: 'No such question or version in your organization' })
  list(@Param() p: VersionParamDto): Promise<VariantListDto> {
    return this.variants.list(p.id, p.version);
  }

  @Post()
  @Roles(...WRITERS)
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Add a variant to a draft version. Every {{placeholder}} of the statement, starter code and reference solution must have a param (FR-203, ADR 0007 V-2)',
  })
  @ApiCreatedResponse({ type: VariantMutationDto })
  @ApiBadRequestResponse({ description: 'Validation failed or a placeholder has no param' })
  @ApiNotFoundResponse({ description: 'No such question or version in your organization' })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale revision',
  })
  @ApiUnprocessableEntityResponse({ description: 'Not a coding question, or too many variants' })
  create(
    @Param() p: VersionParamDto,
    @Body() dto: CreateVariantDto,
    @Req() req: AuthedRequest,
  ): Promise<VariantMutationDto> {
    return this.variants.create(actorOf(req), p.id, p.version, dto, ctxOf(req));
  }

  @Get(':variantId/preview')
  @Roles(...READERS)
  @ApiOperation({
    summary:
      'The candidate-facing view of one variant: rendered statement and starter code, its own sample cases only, no params, hidden data, reference solution or answer_spec (TC-011, ADR 0013). Without question:update only published versions and active variants are visible.',
  })
  @ApiOkResponse({ type: CandidateQuestionPreviewDto })
  @ApiNotFoundResponse({ description: 'No such question, version or variant in your organization' })
  preview(@Param() p: VariantParamDto, @Req() req: AuthedRequest): Promise<CandidateQuestionView> {
    const full = req.user !== undefined && hasPermission(req.user.role, 'question:update');
    return this.variants.preview(p.id, p.version, p.variantId, full);
  }

  @Patch(':variantId')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Change the params or the active flag of a variant of a draft' })
  @ApiOkResponse({ type: VariantMutationDto })
  @ApiBadRequestResponse({
    description: 'Validation failed, a placeholder has no param, or no field',
  })
  @ApiNotFoundResponse({ description: 'No such question, version or variant in your organization' })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale revision',
  })
  update(
    @Param() p: VariantParamDto,
    @Body() dto: UpdateVariantDto,
    @Req() req: AuthedRequest,
  ): Promise<VariantMutationDto> {
    return this.variants.update(actorOf(req), p.id, p.version, p.variantId, dto, ctxOf(req));
  }

  @Delete(':variantId')
  @Roles(...WRITERS)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a variant and its overrides from a draft' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'No such question, version or variant in your organization' })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale revision',
  })
  async remove(
    @Param() p: VariantParamDto,
    @Query() q: RevisionQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.variants.remove(
      actorOf(req),
      p.id,
      p.version,
      p.variantId,
      q.expectedRevision,
      ctxOf(req),
    );
  }

  @Put(':variantId/test-cases/:testCaseId')
  @Roles(...WRITERS)
  @ApiOperation({
    summary:
      "Override the input and expected output of one test slot for a variant (ADR 0007 V-1). The slot must belong to the same version (V-6); its hidden flag and weight stay the slot's",
  })
  @ApiOkResponse({ type: VariantTestCaseOverrideDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({
    description: 'No such question, version, variant or test slot in your organization',
  })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale revision',
  })
  setOverride(
    @Param() p: VariantTestCaseParamDto,
    @Body() dto: VariantOverrideFieldsDto,
    @Req() req: AuthedRequest,
  ): Promise<VariantTestCaseOverrideDto> {
    return this.variants.setOverride(
      actorOf(req),
      p.id,
      p.version,
      p.variantId,
      p.testCaseId,
      dto,
      ctxOf(req),
    );
  }

  @Delete(':variantId/test-cases/:testCaseId')
  @Roles(...WRITERS)
  @HttpCode(204)
  @ApiOperation({ summary: "Remove an override: the slot's default input and output apply again" })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'No such question, version, variant or override in your organization',
  })
  @ApiConflictResponse({
    description:
      'The version is published (immutable), the question is archived, or stale revision',
  })
  async removeOverride(
    @Param() p: VariantTestCaseParamDto,
    @Query() q: RevisionQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.variants.removeOverride(
      actorOf(req),
      p.id,
      p.version,
      p.variantId,
      p.testCaseId,
      q.expectedRevision,
      ctxOf(req),
    );
  }
}

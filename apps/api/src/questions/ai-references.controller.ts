import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
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
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import { AiReferencesService } from './ai-references.service';
import {
  AiReferenceDto,
  AiReferenceListDto,
  AiReferenceParamDto,
  CreateAiReferenceDto,
  SupersedeAiReferenceDto,
  SupersedeResultDto,
} from './dto/ai-references.dto';
import { VersionParamDto } from './dto/questions.dto';
import type { Actor } from './question-tx';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

const WRITERS = [UserRole.SUPER_ADMIN, UserRole.AUTHOR] as const;

// AI reference solutions (ADR 0005 AI-1..AI-6; BE-04 slice 4c). Permissions ai_reference:read,
// ai_reference:create, ai_reference:supersede. Rows are append-only, never shown to recruiters or
// candidates and never used for grading.
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions/:id/versions/:version/ai-references')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class AiReferencesController {
  constructor(private readonly refs: AiReferencesService) {}

  @Get()
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'List the AI reference solutions of a version, current and superseded' })
  @ApiOkResponse({ type: AiReferenceListDto })
  @ApiNotFoundResponse({ description: 'No such question or version in your organization' })
  list(@Param() p: VersionParamDto): Promise<AiReferenceListDto> {
    return this.refs.list(p.id, p.version);
  }

  @Post()
  @Roles(...WRITERS)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Record an AI reference solution for a language of a version (append-only, AI-1)',
  })
  @ApiCreatedResponse({ type: AiReferenceDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'No such question, version or variant in your organization' })
  @ApiConflictResponse({ description: 'The question is archived' })
  @ApiUnprocessableEntityResponse({
    description: 'Not a coding question, or the language is not an allowed language of the version',
  })
  create(
    @Param() p: VersionParamDto,
    @Body() dto: CreateAiReferenceDto,
    @Req() req: AuthedRequest,
  ): Promise<AiReferenceDto> {
    return this.refs.create(actorOf(req), p.id, p.version, dto, ctxOf(req));
  }

  @Post(':aiReferenceId/supersede')
  @Roles(...WRITERS)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Retire an AI reference solution (sets superseded_at; the row stays), optionally inserting its replacement in the same transaction (AI-1)',
  })
  @ApiOkResponse({ type: SupersedeResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({
    description: 'No such question, version or AI reference solution in your organization',
  })
  @ApiConflictResponse({ description: 'Already superseded, or the question is archived' })
  @ApiUnprocessableEntityResponse({ description: 'The replacement language is not allowed' })
  supersede(
    @Param() p: AiReferenceParamDto,
    @Body() dto: SupersedeAiReferenceDto,
    @Req() req: AuthedRequest,
  ): Promise<SupersedeResultDto> {
    return this.refs.supersede(actorOf(req), p.id, p.version, p.aiReferenceId, dto, ctxOf(req));
  }
}

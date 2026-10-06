import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { QuestionIdParamDto } from './dto/questions.dto';
import {
  StartValidationDto,
  ValidationStartedDto,
  ValidationStatusDto,
} from './dto/validation.dto';
import type { Actor } from './question-tx';
import { ValidationService } from './validation.service';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

const WRITERS = [UserRole.SUPER_ADMIN, UserRole.AUTHOR] as const;

// Reference validation (FR-203, TC-012; BE-04 slice 4c). Permission question:validate for both
// routes: the report holds author data, so recruiters never see it.
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions/:id')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class ValidationController {
  constructor(private readonly validation: ValidationService) {}

  @Post('validate')
  @Roles(...WRITERS)
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Start validating the latest draft: the reference solution of every allowed language runs on every test slot of every active variant with that variant data (FR-203, TC-012). The run happens after the response; poll GET /questions/:id/validation. The result is bound to the revision returned here.',
  })
  @ApiAcceptedResponse({ type: ValidationStartedDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  @ApiConflictResponse({
    description:
      'No draft to validate, the question is archived, a run is already in progress, or the draft changed since expectedRevision',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Not a coding question, or a variant does not render; errors lists what',
  })
  start(
    @Param() params: QuestionIdParamDto,
    @Body() dto: StartValidationDto,
    @Req() req: AuthedRequest,
  ): Promise<ValidationStartedDto> {
    return this.validation.start(actorOf(req), params.id, dto, ctxOf(req));
  }

  @Get('validation')
  @Roles(...WRITERS)
  @ApiOperation({
    summary:
      'The state of the latest validation run of the latest version and its stored report (per variant and language). A run whose content changed meanwhile is STALE and never opens the publish gate.',
  })
  @ApiOkResponse({ type: ValidationStatusDto })
  @ApiNotFoundResponse({ description: 'No such question in your organization' })
  status(@Param() params: QuestionIdParamDto): Promise<ValidationStatusDto> {
    return this.validation.status(params.id);
  }
}

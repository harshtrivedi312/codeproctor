import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UserRole } from '../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InviteStaffUserDto {
  @ApiProperty({ example: 'new.recruiter@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Casey Newhire' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role!: UserRole;
}

export class UpdateStaffUserDto {
  @ApiPropertyOptional({ enum: UserRole, description: 'New role; revokes the refresh sessions.' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({
    description: 'false deactivates (revokes every refresh session at once); true reactivates.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 50;
}

export class StaffUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ enum: ['invited', 'active', 'deactivated'] })
  status!: 'invited' | 'active' | 'deactivated';
  @ApiProperty({ description: 'SUPER_ADMIN callers only (these routes are SUPER_ADMIN only).' })
  locked!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lockedUntil!: string | null;
  @ApiProperty() totpEnabled!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class StaffUserListDto {
  @ApiProperty({ type: [StaffUserDto] }) items!: StaffUserDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class LockEventDto {
  @ApiProperty({ description: 'audit_logs id, as a string' }) id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) lockedAt!: string;
}

export class LockEventListDto {
  @ApiProperty({ type: [LockEventDto] }) items!: LockEventDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

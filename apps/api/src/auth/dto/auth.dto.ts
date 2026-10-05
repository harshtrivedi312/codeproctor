import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

/** Bounds the Argon2id work an anonymous caller can trigger (matches shared MAX_PASSWORD_LENGTH). */
export const MAX_PASSWORD_LENGTH = 1024;
export const MIN_NEW_PASSWORD_LENGTH = 12;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LoginDto {
  @ApiProperty({ example: 'reviewer@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(1, MAX_PASSWORD_LENGTH)
  password!: string;
}

export class ChallengeDto {
  @ApiProperty({ description: 'Short-lived token returned by POST /auth/login' })
  @IsString()
  @Length(20, 2048)
  challengeToken!: string;
}

export class ChallengeCodeDto extends ChallengeDto {
  @ApiProperty({
    example: '123456',
    description: '6-digit TOTP code, or (verify only) one of the recovery codes',
  })
  @Transform(trim)
  @IsString()
  @Length(6, 40)
  code!: string;
}

/** Re-authentication for the signed-in 2FA routes (FU-BE-39). */
export class CurrentPasswordDto {
  @ApiProperty({ writeOnly: true, description: 'The signed-in user current password' })
  @IsString()
  @Length(1, MAX_PASSWORD_LENGTH)
  currentPassword!: string;
}

/** Disabling 2FA needs the password and a current 6-digit TOTP code (ADR 0011); no recovery code. */
export class DisableTwoFactorDto extends CurrentPasswordDto {
  @ApiProperty({ example: '123456', writeOnly: true, description: 'Current 6-digit TOTP code' })
  @Transform(trim)
  @Matches(/^\d{6}$/)
  totpCode!: string;
}

export class SetupStartDto extends CurrentPasswordDto {}

export class SetupConfirmDto extends CurrentPasswordDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @Transform(trim)
  @Matches(/^\d{6}$/)
  code!: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use token from the emailed link' })
  @IsString()
  @Length(20, 200)
  token!: string;

  @ApiProperty({ writeOnly: true, minLength: MIN_NEW_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_NEW_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

export class AuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'] }) role!: string;
  @ApiProperty() orgName!: string;
  @ApiProperty({
    readOnly: true,
    description: "Whether the caller's own two-factor authentication is on.",
  })
  totpEnabled!: boolean;
}

export class AuthSessionDto {
  @ApiProperty({ description: 'Access JWT, 15 minutes. Keep it in memory only.' })
  accessToken!: string;
  @ApiProperty({ type: AuthUserDto }) user!: AuthUserDto;
}

export class LoginResultDto {
  @ApiProperty({ enum: ['authenticated', 'two_factor_required', 'two_factor_enrollment_required'] })
  status!: 'authenticated' | 'two_factor_required' | 'two_factor_enrollment_required';
  @ApiProperty({ required: false, type: AuthSessionDto }) session?: AuthSessionDto;
  @ApiProperty({ required: false, description: 'Only finishes 2FA; 5 minutes.' })
  challengeToken?: string;
}

export class TotpEnrollmentDto {
  @ApiProperty({ description: 'Base32 secret for manual entry' }) manualKey!: string;
  @ApiProperty({ description: 'otpauth:// URI' }) otpauthUri!: string;
  @ApiProperty({ description: 'QR code as a PNG data URL' }) qrDataUrl!: string;
}

export class EnrollmentConfirmedDto {
  @ApiProperty({ required: false, type: AuthSessionDto }) session?: AuthSessionDto;
  @ApiProperty({ type: [String], description: 'Shown once. Store them safely.' })
  recoveryCodes!: string[];
}

export class RecoveryCodesDto {
  @ApiProperty({ type: [String], description: 'Shown once. Store them safely.' })
  recoveryCodes!: string[];
}

export class AcceptedDto {
  @ApiProperty({ example: 'If the account exists, a reset link has been sent.' })
  message!: string;
}

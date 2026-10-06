import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgSettingsController } from './org-settings.controller';
import { OrgSettingsService } from './org-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [OrgSettingsController],
  providers: [OrgSettingsService],
})
export class OrgSettingsModule {}

import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';

@Module({ controllers: [PrescriptionsController], providers: [PrescriptionsService] })
export class PrescriptionsModule {}

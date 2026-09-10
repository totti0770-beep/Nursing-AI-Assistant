import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document, DocumentApproval, DocumentVersion } from '../entities';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { InventoryService } from './inventory.service';
import { ApprovalService } from '../approval/approval.service';
import { RagModule } from '../rag/rag.module';

/** DocumentsModule also hosts the approval-workflow endpoints/services. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentVersion, DocumentApproval]),
    RagModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, ApprovalService, InventoryService],
  exports: [DocumentsService, ApprovalService, InventoryService],
})
export class DocumentsModule {}

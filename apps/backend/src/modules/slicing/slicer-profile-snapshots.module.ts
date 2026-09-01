import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { SlicerProfileSnapshotService } from "./slicer-profile-snapshot.service";

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [SlicerProfileSnapshotService],
  exports: [SlicerProfileSnapshotService],
})
export class SlicerProfileSnapshotsModule {}

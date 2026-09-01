CREATE TYPE "production_artifact_format" AS ENUM ('gcode_3mf', 'bgcode', 'gcode');

ALTER TABLE "machine_profiles"
ADD COLUMN "production_artifact_format" "production_artifact_format" NOT NULL DEFAULT 'gcode_3mf';

ALTER TABLE "machine_profiles"
ALTER COLUMN "production_artifact_format" DROP DEFAULT;

import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { OperatorAuthService } from "./modules/admin-access/operator-auth.service";

const POLL_MILLISECONDS = 15 * 60 * 1_000;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const auth = app.get(OperatorAuthService);
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    await auth.purgeExpired();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MILLISECONDS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
  }
  await app.close();
}

void main();

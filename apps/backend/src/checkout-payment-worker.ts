import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { CheckoutPaymentDeadlineService } from "./modules/payments/checkout-payment-deadline.service";
import { PaymentOutboxDispatcherService } from "./modules/payments/payment-outbox-dispatcher.service";

const IDLE_POLL_MILLISECONDS = 5_000;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const deadlines = app.get(CheckoutPaymentDeadlineService);
  const outbox = app.get(PaymentOutboxDispatcherService);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    const [closed, delivered] = await Promise.all([
      deadlines.runOnce(),
      outbox.runOnce(),
    ]);
    if (closed + delivered === 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, IDLE_POLL_MILLISECONDS);
      });
    }
  }
  await app.close();
}

void main();

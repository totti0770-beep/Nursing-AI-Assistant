import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  InventoryService,
  renderInventoryTable,
} from '../documents/inventory.service';

/**
 * Clinical reference inventory, from the command line.
 *
 *   npm run inventory -w @bnp/api            # human table
 *   npm run inventory -w @bnp/api -- --json  # deterministic JSON
 *
 * The same report is served by `GET /documents/inventory`, and that is the
 * one that matters in production: the API container ships without a shell, so
 * this script cannot be run against the live deployment. It is for local use,
 * for CI, and for a machine that can reach the database directly.
 *
 * It boots an application *context* rather than an HTTP server — no port, no
 * listener — so it composes the real InventoryService with the real
 * EmbeddingService and reports exactly what the route would.
 *
 * JSON goes to stdout and nothing else does, so `--json > report.json` yields
 * a file that diffs cleanly against yesterday's.
 */
async function main() {
  const asJson = process.argv.includes('--json');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // Keep the boot chatter off stdout; it would corrupt --json output and
    // there is nothing in it a reader of this report needs.
    logger: asJson ? false : ['error', 'warn'],
  });

  try {
    const report = await app.get(InventoryService).build();
    console.log(
      asJson
        ? JSON.stringify(report, null, 2)
        : renderInventoryTable(report, new Date()),
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`inventory failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

import simpleGit from "simple-git";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Creates a sample git repo with ~10 commits from 3 authors.
 * Covers: additions, modifications, deletions, renames, multi-file changes.
 */
export async function createSampleRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();

  const setAuthor = async (name: string, email: string) => {
    await git.addConfig("user.name", name);
    await git.addConfig("user.email", email);
  };

  // 1. Initial setup (Alice)
  await setAuthor("Alice Chen", "alice@acme.com");
  writeFileSync(
    join(dir, "package.json"),
    '{"name": "sample-project", "version": "1.0.0"}',
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/index.ts"),
    'export function main() { console.log("hello"); }',
  );
  await git.add(".");
  await git.commit("chore: initial project setup");

  // 2. Add billing module (Alice)
  mkdirSync(join(dir, "src/billing"));
  writeFileSync(
    join(dir, "src/billing/processor.ts"),
    "export class BillingProcessor { process() {} }",
  );
  writeFileSync(
    join(dir, "src/billing/types.ts"),
    "export interface Invoice { id: string; amount: number; }",
  );
  await git.add(".");
  await git.commit("feat: add billing processor module");

  // 3. Add payments module (Bob)
  await setAuthor("Bob Martinez", "bob@acme.com");
  mkdirSync(join(dir, "src/payments"));
  writeFileSync(
    join(dir, "src/payments/handler.ts"),
    "export async function handlePayment(req: any) { return { ok: true }; }",
  );
  await git.add(".");
  await git.commit("feat: add REST payment handler");

  // 4. Integrate billing with payments (Bob)
  writeFileSync(
    join(dir, "src/billing/processor.ts"),
    'import { handlePayment } from "../payments/handler";\nexport class BillingProcessor {\n  async process(invoice: any) {\n    return handlePayment(invoice);\n  }\n}',
  );
  await git.add(".");
  await git.commit("feat: integrate billing with payments service");

  // 5. Add auth middleware (Alice)
  await setAuthor("Alice Chen", "alice@acme.com");
  mkdirSync(join(dir, "src/middleware"));
  writeFileSync(
    join(dir, "src/middleware/auth.ts"),
    "export function authenticate(req: any) { return true; }",
  );
  await git.add(".");
  await git.commit("feat: add authentication middleware");

  // 6. Migrate payments REST → gRPC (Alice)
  writeFileSync(
    join(dir, "src/payments/handler.ts"),
    'export class PaymentsService {\n  async charge(request: any) { return { success: true }; }\n}',
  );
  mkdirSync(join(dir, "src/proto"), { recursive: true });
  writeFileSync(
    join(dir, "src/proto/payments.proto"),
    'syntax = "proto3";\nservice PaymentsService { rpc Charge(ChargeRequest) returns (ChargeResponse); }',
  );
  await git.add(".");
  await git.commit("feat: migrate payments endpoint from REST to gRPC");

  // 7. Update billing for gRPC (Bob)
  await setAuthor("Bob Martinez", "bob@acme.com");
  writeFileSync(
    join(dir, "src/billing/processor.ts"),
    'import { PaymentsService } from "../payments/handler";\nexport class BillingProcessor {\n  private payments = new PaymentsService();\n  async process(invoice: any) {\n    return this.payments.charge(invoice);\n  }\n}',
  );
  await git.add(".");
  await git.commit("fix: update billing to use gRPC payments client");

  // 8. Add docs (Carlos)
  await setAuthor("Carlos Ruiz", "carlos@acme.com");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs/api.md"),
    "# API Documentation\n## Payments\nThe payments service uses gRPC.",
  );
  await git.add(".");
  await git.commit("docs: add API documentation for gRPC migration");

  // 9. Refactor shared types (Bob)
  await setAuthor("Bob Martinez", "bob@acme.com");
  mkdirSync(join(dir, "src/shared"), { recursive: true });
  writeFileSync(
    join(dir, "src/shared/types.ts"),
    "export interface Invoice { id: string; amount: number; currency: string; }\nexport interface Payment { id: string; invoiceId: string; status: string; }",
  );
  unlinkSync(join(dir, "src/billing/types.ts"));
  writeFileSync(
    join(dir, "src/billing/processor.ts"),
    'import { Invoice } from "../shared/types";\nimport { PaymentsService } from "../payments/handler";\nexport class BillingProcessor {\n  private payments = new PaymentsService();\n  async process(invoice: Invoice) {\n    return this.payments.charge(invoice);\n  }\n}',
  );
  await git.add(".");
  await git.commit("refactor: extract shared types, remove billing/types.ts");

  // 10. Add tests (Alice)
  await setAuthor("Alice Chen", "alice@acme.com");
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "tests/billing.test.ts"),
    'test("processes invoice", () => {});',
  );
  writeFileSync(
    join(dir, "tests/payments.test.ts"),
    'test("charges payment", () => {});',
  );
  await git.add(".");
  await git.commit("test: add billing and payments test suites");
}

# Ordira AI source

Private review snapshot of Ordira’s AI interpretation, safety controls, WhatsApp conversation flows and evaluation suite.

**Source:** [ordira-server at `259bbb0`](https://github.com/VictorOluwaseun/ordira-server/tree/259bbb0d53abe1fdfb08c6ca3ffa8eed8c0fe5bc).
**Scope:** 121 source, test and documentation files, preserving their original paths.

## Start here

- [Live intent interpreter](docs/WHATSAPP_INTENT_INTERPRETER.md)
- [Conversation behavior and interactive questions](docs/WHATSAPP_CONVERSATIONAL_FOLLOWUPS.md)
- [AI technical design, including planned capabilities](docs/CUSTOMER_AI_TECHNICAL_DESIGN.md)
- [Main WhatsApp entry point](src/modules/whatsapp-conversations/whatsapp-conversations.service.ts)
- [Bounded live interpreter](src/modules/customer-ai/customer-ai-intent.service.ts)

## How the pieces fit

Familiar commands and contextual replies are checked locally first. Eligible unrecognized text can reach the bounded AI interpreter. The interpreter proposes a supported action; backend handlers verify context, ownership, availability and payment state before acting. Interactive questions use backend-owned choices. Shadow orchestration and its evaluation/promotion machinery are separate from the live interpreter.

## Using this snapshot

This repository is for reading and sharing the AI implementation. It is not an independently runnable service: imports depend on the original server’s shared utilities, configuration schema, persistence, checkout, menu, branch and payment modules. Run builds, tests and evaluations in ordira-server at the recorded revision. Design documents may describe work not yet implemented; their inclusion does not imply that every proposal is live.

No environment files, credentials, runtime reports, database exports or customer records are part of this export. Test fixtures remain with their respective code. No source Git history is copied.

The source files are snapshots, not automatically synchronized. [SOURCE_MANIFEST.json](SOURCE_MANIFEST.json) records each source path, size and SHA-256 digest so later updates can be reviewed.

## Code groups

### 01 — Overview and architecture

5 files.

- [docs/CUSTOMER_AI_TECHNICAL_DESIGN.md](docs/CUSTOMER_AI_TECHNICAL_DESIGN.md)
- [docs/WHATSAPP_CONVERSATIONAL_FOLLOWUPS.md](docs/WHATSAPP_CONVERSATIONAL_FOLLOWUPS.md)
- [docs/WHATSAPP_INTENT_INTERPRETER.md](docs/WHATSAPP_INTENT_INTERPRETER.md)
- [docs/WHATSAPP_ORDER_MODIFICATIONS.md](docs/WHATSAPP_ORDER_MODIFICATIONS.md)
- [docs/WHATSAPP_STANDARD_FLOW_ACCEPTANCE.md](docs/WHATSAPP_STANDARD_FLOW_ACCEPTANCE.md)

### 02 — AI interpretation and runtime

36 files.

- [src/config/customer-ai.config.ts](src/config/customer-ai.config.ts)
- [src/customer-ai-index-migration.ts](src/customer-ai-index-migration.ts)
- [src/modules/customer-ai/customer-ai-index-migration.spec.ts](src/modules/customer-ai/customer-ai-index-migration.spec.ts)
- [src/modules/customer-ai/customer-ai-index-migration.ts](src/modules/customer-ai/customer-ai-index-migration.ts)
- [src/modules/customer-ai/customer-ai-intent.service.spec.ts](src/modules/customer-ai/customer-ai-intent.service.spec.ts)
- [src/modules/customer-ai/customer-ai-intent.service.ts](src/modules/customer-ai/customer-ai-intent.service.ts)
- [src/modules/customer-ai/customer-ai-orchestrator.service.spec.ts](src/modules/customer-ai/customer-ai-orchestrator.service.spec.ts)
- [src/modules/customer-ai/customer-ai-orchestrator.service.ts](src/modules/customer-ai/customer-ai-orchestrator.service.ts)
- [src/modules/customer-ai/customer-ai-provider-result.validator.spec.ts](src/modules/customer-ai/customer-ai-provider-result.validator.spec.ts)
- [src/modules/customer-ai/customer-ai-provider-result.validator.ts](src/modules/customer-ai/customer-ai-provider-result.validator.ts)
- [src/modules/customer-ai/customer-ai-queue.constants.ts](src/modules/customer-ai/customer-ai-queue.constants.ts)
- [src/modules/customer-ai/customer-ai-queue.service.spec.ts](src/modules/customer-ai/customer-ai-queue.service.spec.ts)
- [src/modules/customer-ai/customer-ai-queue.service.ts](src/modules/customer-ai/customer-ai-queue.service.ts)
- [src/modules/customer-ai/customer-ai-read-tools.service.spec.ts](src/modules/customer-ai/customer-ai-read-tools.service.spec.ts)
- [src/modules/customer-ai/customer-ai-read-tools.service.ts](src/modules/customer-ai/customer-ai-read-tools.service.ts)
- [src/modules/customer-ai/customer-ai-response-compiler.service.spec.ts](src/modules/customer-ai/customer-ai-response-compiler.service.spec.ts)
- [src/modules/customer-ai/customer-ai-response-compiler.service.ts](src/modules/customer-ai/customer-ai-response-compiler.service.ts)
- [src/modules/customer-ai/customer-ai-routing.service.spec.ts](src/modules/customer-ai/customer-ai-routing.service.spec.ts)
- [src/modules/customer-ai/customer-ai-routing.service.ts](src/modules/customer-ai/customer-ai-routing.service.ts)
- [src/modules/customer-ai/customer-ai-shadow.service.spec.ts](src/modules/customer-ai/customer-ai-shadow.service.spec.ts)
- [src/modules/customer-ai/customer-ai-shadow.service.ts](src/modules/customer-ai/customer-ai-shadow.service.ts)
- [src/modules/customer-ai/customer-ai-source-revision.spec.ts](src/modules/customer-ai/customer-ai-source-revision.spec.ts)
- [src/modules/customer-ai/customer-ai-source-revision.ts](src/modules/customer-ai/customer-ai-source-revision.ts)
- [src/modules/customer-ai/customer-ai-worker.module.ts](src/modules/customer-ai/customer-ai-worker.module.ts)
- [src/modules/customer-ai/customer-ai.module.ts](src/modules/customer-ai/customer-ai.module.ts)
- [src/modules/customer-ai/customer-ai.processor.ts](src/modules/customer-ai/customer-ai.processor.ts)
- [src/modules/customer-ai/customer-ai.repository.spec.ts](src/modules/customer-ai/customer-ai.repository.spec.ts)
- [src/modules/customer-ai/customer-ai.repository.ts](src/modules/customer-ai/customer-ai.repository.ts)
- [src/modules/customer-ai/customer-ai.types.ts](src/modules/customer-ai/customer-ai.types.ts)
- [src/modules/customer-ai/providers/fake-customer-ai.provider.ts](src/modules/customer-ai/providers/fake-customer-ai.provider.ts)
- [src/modules/customer-ai/providers/openai-customer-ai.provider.spec.ts](src/modules/customer-ai/providers/openai-customer-ai.provider.spec.ts)
- [src/modules/customer-ai/providers/openai-customer-ai.provider.ts](src/modules/customer-ai/providers/openai-customer-ai.provider.ts)
- [src/modules/customer-ai/schemas/customer-ai-run.schema.ts](src/modules/customer-ai/schemas/customer-ai-run.schema.ts)
- [src/modules/customer-ai/schemas/customer-ai-session.schema.ts](src/modules/customer-ai/schemas/customer-ai-session.schema.ts)
- [src/modules/customer-ai/schemas/customer-ai-tool-execution.schema.ts](src/modules/customer-ai/schemas/customer-ai-tool-execution.schema.ts)
- [src/modules/customer-ai/schemas/customer-ai-ttl-indexes.spec.ts](src/modules/customer-ai/schemas/customer-ai-ttl-indexes.spec.ts)

### 03 — Safety, spending and evidence

24 files.

- [src/customer-ai-runtime-safety-report.ts](src/customer-ai-runtime-safety-report.ts)
- [src/modules/customer-ai/customer-ai-evaluation-evidence.repository.spec.ts](src/modules/customer-ai/customer-ai-evaluation-evidence.repository.spec.ts)
- [src/modules/customer-ai/customer-ai-evaluation-evidence.repository.ts](src/modules/customer-ai/customer-ai-evaluation-evidence.repository.ts)
- [src/modules/customer-ai/customer-ai-evaluation-evidence.service.spec.ts](src/modules/customer-ai/customer-ai-evaluation-evidence.service.spec.ts)
- [src/modules/customer-ai/customer-ai-evaluation-evidence.service.ts](src/modules/customer-ai/customer-ai-evaluation-evidence.service.ts)
- [src/modules/customer-ai/customer-ai-metrics.service.spec.ts](src/modules/customer-ai/customer-ai-metrics.service.spec.ts)
- [src/modules/customer-ai/customer-ai-metrics.service.ts](src/modules/customer-ai/customer-ai-metrics.service.ts)
- [src/modules/customer-ai/customer-ai-policy-evidence.service.spec.ts](src/modules/customer-ai/customer-ai-policy-evidence.service.spec.ts)
- [src/modules/customer-ai/customer-ai-policy-evidence.service.ts](src/modules/customer-ai/customer-ai-policy-evidence.service.ts)
- [src/modules/customer-ai/customer-ai-policy.service.spec.ts](src/modules/customer-ai/customer-ai-policy.service.spec.ts)
- [src/modules/customer-ai/customer-ai-policy.service.ts](src/modules/customer-ai/customer-ai-policy.service.ts)
- [src/modules/customer-ai/customer-ai-promotion-readiness.service.spec.ts](src/modules/customer-ai/customer-ai-promotion-readiness.service.spec.ts)
- [src/modules/customer-ai/customer-ai-promotion-readiness.service.ts](src/modules/customer-ai/customer-ai-promotion-readiness.service.ts)
- [src/modules/customer-ai/customer-ai-provider-health.service.spec.ts](src/modules/customer-ai/customer-ai-provider-health.service.spec.ts)
- [src/modules/customer-ai/customer-ai-provider-health.service.ts](src/modules/customer-ai/customer-ai-provider-health.service.ts)
- [src/modules/customer-ai/customer-ai-runtime-safety-environment.spec.ts](src/modules/customer-ai/customer-ai-runtime-safety-environment.spec.ts)
- [src/modules/customer-ai/customer-ai-runtime-safety-environment.ts](src/modules/customer-ai/customer-ai-runtime-safety-environment.ts)
- [src/modules/customer-ai/customer-ai-runtime-safety-evidence.spec.ts](src/modules/customer-ai/customer-ai-runtime-safety-evidence.spec.ts)
- [src/modules/customer-ai/customer-ai-runtime-safety-evidence.ts](src/modules/customer-ai/customer-ai-runtime-safety-evidence.ts)
- [src/modules/customer-ai/customer-ai-shadow-promotion-gate.service.spec.ts](src/modules/customer-ai/customer-ai-shadow-promotion-gate.service.spec.ts)
- [src/modules/customer-ai/customer-ai-shadow-promotion-gate.service.ts](src/modules/customer-ai/customer-ai-shadow-promotion-gate.service.ts)
- [src/modules/customer-ai/customer-ai-spend-guard.service.spec.ts](src/modules/customer-ai/customer-ai-spend-guard.service.spec.ts)
- [src/modules/customer-ai/customer-ai-spend-guard.service.ts](src/modules/customer-ai/customer-ai-spend-guard.service.ts)
- [src/modules/customer-ai/schemas/customer-ai-evaluation-evidence.schema.ts](src/modules/customer-ai/schemas/customer-ai-evaluation-evidence.schema.ts)

### 04 — WhatsApp commands and conversation flows

29 files.

- [src/modules/whatsapp-conversations/whatsapp-budget-combinations.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-budget-combinations.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-combinations.util.ts](src/modules/whatsapp-conversations/whatsapp-budget-combinations.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-modifiers.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-budget-modifiers.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-modifiers.util.ts](src/modules/whatsapp-conversations/whatsapp-budget-modifiers.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-quote.service.spec.ts](src/modules/whatsapp-conversations/whatsapp-budget-quote.service.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-quote.service.ts](src/modules/whatsapp-conversations/whatsapp-budget-quote.service.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-suggestions.service.spec.ts](src/modules/whatsapp-conversations/whatsapp-budget-suggestions.service.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget-suggestions.service.ts](src/modules/whatsapp-conversations/whatsapp-budget-suggestions.service.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-budget.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-budget.util.ts](src/modules/whatsapp-conversations/whatsapp-budget.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-checkout-flow-action-registry.ts](src/modules/whatsapp-conversations/whatsapp-checkout-flow-action-registry.ts)
- [src/modules/whatsapp-conversations/whatsapp-checkout-flow.service.spec.ts](src/modules/whatsapp-conversations/whatsapp-checkout-flow.service.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-checkout-flow.service.ts](src/modules/whatsapp-conversations/whatsapp-checkout-flow.service.ts)
- [src/modules/whatsapp-conversations/whatsapp-checkout-flow.util.ts](src/modules/whatsapp-conversations/whatsapp-checkout-flow.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-conversations.service.spec.ts](src/modules/whatsapp-conversations/whatsapp-conversations.service.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-conversations.service.ts](src/modules/whatsapp-conversations/whatsapp-conversations.service.ts)
- [src/modules/whatsapp-conversations/whatsapp-followup.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-followup.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-followup.util.ts](src/modules/whatsapp-conversations/whatsapp-followup.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-language.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-language.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-language.util.ts](src/modules/whatsapp-conversations/whatsapp-language.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-question.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-question.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-question.util.ts](src/modules/whatsapp-conversations/whatsapp-question.util.ts)
- [src/modules/whatsapp-conversations/whatsapp-standard-flow-action-registry.ts](src/modules/whatsapp-conversations/whatsapp-standard-flow-action-registry.ts)
- [src/modules/whatsapp-conversations/whatsapp-standard-flow-copy.registry.spec.ts](src/modules/whatsapp-conversations/whatsapp-standard-flow-copy.registry.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-standard-flow-copy.registry.ts](src/modules/whatsapp-conversations/whatsapp-standard-flow-copy.registry.ts)
- [src/modules/whatsapp-conversations/whatsapp-standard-flow.service.spec.ts](src/modules/whatsapp-conversations/whatsapp-standard-flow.service.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-standard-flow.service.ts](src/modules/whatsapp-conversations/whatsapp-standard-flow.service.ts)
- [src/modules/whatsapp-conversations/whatsapp-text-action.util.spec.ts](src/modules/whatsapp-conversations/whatsapp-text-action.util.spec.ts)
- [src/modules/whatsapp-conversations/whatsapp-text-action.util.ts](src/modules/whatsapp-conversations/whatsapp-text-action.util.ts)

### 05 — Evaluations and scenarios

27 files.

- [src/customer-ai-eval.ts](src/customer-ai-eval.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-budget.spec.ts](src/modules/customer-ai/evals/customer-ai-eval-budget.spec.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-budget.ts](src/modules/customer-ai/evals/customer-ai-eval-budget.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-command.spec.ts](src/modules/customer-ai/evals/customer-ai-eval-command.spec.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-command.ts](src/modules/customer-ai/evals/customer-ai-eval-command.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-grader-names.ts](src/modules/customer-ai/evals/customer-ai-eval-grader-names.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-graders.spec.ts](src/modules/customer-ai/evals/customer-ai-eval-graders.spec.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-graders.ts](src/modules/customer-ai/evals/customer-ai-eval-graders.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-runner.spec.ts](src/modules/customer-ai/evals/customer-ai-eval-runner.spec.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-runner.ts](src/modules/customer-ai/evals/customer-ai-eval-runner.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-scenario-runner.ts](src/modules/customer-ai/evals/customer-ai-eval-scenario-runner.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-tool-contract.spec.ts](src/modules/customer-ai/evals/customer-ai-eval-tool-contract.spec.ts)
- [src/modules/customer-ai/evals/customer-ai-eval-tool-contract.ts](src/modules/customer-ai/evals/customer-ai-eval-tool-contract.ts)
- [src/modules/customer-ai/evals/customer-ai-model-comparison.spec.ts](src/modules/customer-ai/evals/customer-ai-model-comparison.spec.ts)
- [src/modules/customer-ai/evals/customer-ai-model-comparison.ts](src/modules/customer-ai/evals/customer-ai-model-comparison.ts)
- [test/customer-ai-runtime-safety.e2e-spec.ts](test/customer-ai-runtime-safety.e2e-spec.ts)
- [test/fixtures/customer-ai/evals/adversarial-money-and-facts.jsonl](test/fixtures/customer-ai/evals/adversarial-money-and-facts.jsonl)
- [test/fixtures/customer-ai/evals/adversarial-prompt-and-scope.jsonl](test/fixtures/customer-ai/evals/adversarial-prompt-and-scope.jsonl)
- [test/fixtures/customer-ai/evals/checkout-drafts.jsonl](test/fixtures/customer-ai/evals/checkout-drafts.jsonl)
- [test/fixtures/customer-ai/evals/discovery.jsonl](test/fixtures/customer-ai/evals/discovery.jsonl)
- [test/fixtures/customer-ai/evals/failures-and-handoffs.jsonl](test/fixtures/customer-ai/evals/failures-and-handoffs.jsonl)
- [test/fixtures/customer-ai/evals/language-variants-extended.jsonl](test/fixtures/customer-ai/evals/language-variants-extended.jsonl)
- [test/fixtures/customer-ai/evals/menus-and-modifiers.jsonl](test/fixtures/customer-ai/evals/menus-and-modifiers.jsonl)
- [test/fixtures/customer-ai/evals/pidgin-and-typos.jsonl](test/fixtures/customer-ai/evals/pidgin-and-typos.jsonl)
- [test/fixtures/customer-ai/evals/reliability-and-concurrency-extended.jsonl](test/fixtures/customer-ai/evals/reliability-and-concurrency-extended.jsonl)
- [test/fixtures/customer-ai/evals/routing-and-ambiguity-extended.jsonl](test/fixtures/customer-ai/evals/routing-and-ambiguity-extended.jsonl)
- [test/fixtures/customer-ai/evals/safety-and-scope.jsonl](test/fixtures/customer-ai/evals/safety-and-scope.jsonl)

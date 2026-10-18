import { CONTRACT_FIXTURE_SOURCE, runSpecRepositoryContractTests } from "./repository-contract.js";
import { MemoryRepository } from "./memory-repository.js";

// The shared repository contract and the ADR-0055 operation sequences, against the pure layer. The
// filesystem repository (packages/cli) and the Postgres one (packages/server) run the same file.
runSpecRepositoryContractTests({
  createRepository: async () => new MemoryRepository(CONTRACT_FIXTURE_SOURCE),
});

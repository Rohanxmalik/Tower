import type {
  ClaimIntentInput,
  ClaimIntentOutput,
  CheckCollisionInput,
  CheckCollisionOutput,
  HeartbeatInput,
  HeartbeatOutput,
  CompleteClaimInput,
  ReleaseClaimInput,
  OkOutput,
  ListClaimsInput,
  ListClaimsOutput,
  LogDecisionInput,
  LogDecisionOutput,
  GetDecisionsInput,
  GetDecisionsOutput,
  NextTaskInput,
  NextTaskOutput,
} from "@tower/shared";
import { TowerStore } from "./store/sqlite.js";
import { detectCollisions } from "./engine/collision.js";
import { nextTask, type Policy } from "./engine/sequencer.js";

const EMPTY_POLICY: Policy = { modules: [], maxAgentsPerModule: null };

export interface TowerServiceOptions {
  store?: TowerStore;
  policy?: Policy;
}

/**
 * The transport-agnostic core of Tower. Wires the store, collision engine and
 * sequencer into the nine operations exposed over MCP. Kept free of MCP/HTTP so it
 * can be unit-tested directly and reused by any transport.
 */
export class TowerService {
  readonly store: TowerStore;
  private policy: Policy;

  constructor(opts: TowerServiceOptions = {}) {
    this.store = opts.store ?? new TowerStore();
    this.policy = opts.policy ?? EMPTY_POLICY;
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  claimIntent(input: ClaimIntentInput): ClaimIntentOutput {
    const active = this.store.activeClaims(input.repo, input.branch);
    const conflicts = detectCollisions(
      { agentId: input.agentId, files: input.files, symbols: input.symbols },
      active,
    );
    const claim = this.store.createClaim({
      agentId: input.agentId,
      repo: input.repo,
      branch: input.branch,
      files: input.files,
      symbols: input.symbols,
      purpose: input.purpose,
      ...(input.etaMinutes != null ? { etaMinutes: input.etaMinutes } : {}),
    });
    return { claimId: claim.id, conflicts };
  }

  checkCollision(input: CheckCollisionInput): CheckCollisionOutput {
    const active = this.store.activeClaims(input.repo, input.branch);
    const conflicts = detectCollisions(
      {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        files: input.files,
        symbols: input.symbols,
      },
      active,
    );
    return { conflicts };
  }

  heartbeat(input: HeartbeatInput): HeartbeatOutput {
    return this.store.heartbeat(input.claimId);
  }

  completeClaim(input: CompleteClaimInput): OkOutput {
    return { ok: this.store.completeClaim(input.claimId, input.commitSha) };
  }

  releaseClaim(input: ReleaseClaimInput): OkOutput {
    return { ok: this.store.releaseClaim(input.claimId) };
  }

  listClaims(input: ListClaimsInput): ListClaimsOutput {
    return { claims: this.store.listClaims(input) };
  }

  logDecision(input: LogDecisionInput): LogDecisionOutput {
    const d = this.store.logDecision(input);
    return { id: d.id };
  }

  getDecisions(input: GetDecisionsInput): GetDecisionsOutput {
    return { decisions: this.store.getDecisions(input) };
  }

  nextTask(input: NextTaskInput): NextTaskOutput {
    // Sequencer reasons over all active claims regardless of branch.
    const active = this.store.listClaims({ repo: input.repo, status: "active" });
    return nextTask(this.policy, input.candidates, active, input.agentId);
  }
}

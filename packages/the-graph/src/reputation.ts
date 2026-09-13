/**
 * Workspace reputation + ERC-8004 agent identity — the client contract for the
 * desk header chip (Plan 213).
 *
 * These types deliberately do NOT import from `@bu/services`: api-types is
 * consumed cross-surface (expo, fx), so the provision union mirrors
 * `AgentIdentityProvisionResult` literally and the app route's typecheck
 * (`satisfies ProvisionAgentIdentityResponse`) catches drift.
 */

/** Response of `GET /api/reputation/summary`. Additive over the shipped shape. */
export type WorkspaceReputationSummary =
  | {
      teamId: string;
      hasIdentity: false;
      /** True only when an ARC-TESTNET agent wallet exists (dev). False in prod
       *  by construction (AGENT_WALLET_CHAINS.mainnet has no Arc) — the chip's
       *  mainnet-silence signal. */
      hasAgentWallet: boolean;
      /** True while a mint is submitted and not yet reconciled — the face says
       *  "minting…" instead of offering a second mint (which the service would
       *  refuse anyway, but the offer itself is a lie). */
      mintPending?: boolean;
      /** True when a mint for this team is marked `failed` (a `mint_state =
       *  'failed'` row exists). The service refuses to mint again until a human
       *  reconciles the Circle transaction, so the chip must not offer a mint —
       *  the click would only come back `skipped`. Pre-landing review, 2026-09-07. */
      mintFailed?: boolean;
      walletAddress: string | null;
      count: 0;
      averageScore: 0;
      stars: 0;
    }
  | {
      teamId: string;
      hasIdentity: true;
      hasAgentWallet: true;
      agentId: string;
      walletAddress: string | null;
      count: number;
      /** 0-100 contract domain. */
      averageScore: number;
      /** averageScore/20 rounded to 1 decimal; 0 when count===0 (never rendered). */
      stars: number;
      chain: string; // 'arc-testnet'
      /** https://testnet.arcscan.app/address/<walletAddress>, server-computed. */
      explorerUrl: string | null;
    };

/** Response of `POST /api/reputation/provision`. */
export type ProvisionAgentIdentityResponse =
  | { status: 'minted'; agentId: string; transactionHash: string }
  | { status: 'submitted'; transactionId: string }
  | {
      status: 'skipped';
      reason: // Must stay a superset of `AgentIdentitySkipReason`
      // (`@bu/services/agent-identity-provisioning.service`) — that service
      // IS the producer, and the route returns its result verbatim under a
      // `satisfies` clause. `not-identity-chain` was added there when the
      // chain gate generalised past the single Arc-testnet check; omitting it
      // here made the route uncompilable rather than mis-typed.
        | 'not-identity-chain'
        | 'anchor-not-recordable'
        | 'not-arc-testnet'
        | 'already-provisioned'
        | 'mint-failed-awaiting-reconcile'
        | 'signer-not-configured'
        | 'no-agent-wallet';
    }
  | { status: 'failed'; error: string };

/**
 * One on-chain rating of a workspace, read from the ERC-8004 reputation
 * subgraph (plan 342). `comment` is the free text the rater wrote (the
 * contract's `endpoint` string field carries it); `tag` is the category the
 * rating was filed under (`invoice`, `payroll`, …).
 */
export interface WorkspaceReputationFeedbackEntry {
  /** Subgraph entity id; opaque, use as the pagination cursor. */
  id: string;
  /** Rater's agent wallet address, lowercased. */
  clientAddress: string;
  /** 0-100 contract domain. */
  score: number;
  /** score/20 rounded to 1 decimal. */
  stars: number;
  tag: string;
  comment: string;
  /** Unix seconds. */
  createdAt: number;
  transactionHash: string;
  /** https://testnet.arcscan.app/tx/<hash>, server-computed; null when no explorer is known. */
  explorerUrl: string | null;
}

/** Response of `GET /api/reputation/feedback`. */
export type WorkspaceReputationFeedback =
  | { teamId: string; hasIdentity: false; items: []; nextCursor: null }
  | {
      teamId: string;
      hasIdentity: true;
      agentId: string;
      chain: string; // 'arc-testnet'
      items: WorkspaceReputationFeedbackEntry[];
      /** Pass back as `?cursor=` for the next page; null when exhausted. */
      nextCursor: string | null;
    };

// One mapping module for the three data sources (the manifest points every
// handler here). Identity and reputation handlers are adapted from Space
// Object's hackathon subgraph; commerce handlers are re-cut to Circle's Arc
// escrow; the `bufi/` helpers are the workspace-graph logic on top.

export { handleHookWhitelistUpdated, handleUpgraded } from './commerce/admin';
export {
  handleBudgetSet,
  handleJobCompleted,
  handleJobCreated,
  handleJobExpired,
  handleJobFunded,
  handleJobRejected,
  handleJobSubmitted,
  handleProviderSet,
} from './commerce/job';
export { handleEvaluatorFeePaid, handlePaymentReleased, handleRefunded } from './commerce/payments';
export {
  handleApproval,
  handleApprovalForAll,
  handleMetadataSet,
  handleRegistered,
  handleTransfer,
  handleURIUpdated,
} from './identity/identity-registry';
export {
  handleFeedbackRevoked,
  handleNewFeedback,
  handleResponseAppended,
} from './identity/reputation-registry';

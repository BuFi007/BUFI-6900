import {
  EvaluatorFeePaid,
  PaymentReleased,
  Refunded,
} from '../../generated/AgenticCommerce/AgenticCommerce';
import { getOrCreateAccount } from '../shared/account';
import { contextChainId } from './agentic-commerce';
import { createJobEvent, getJob, jobEntityId, touchJob } from './job';
import { markSettledIfPaid, recordRefund } from './settlement';

export function handlePaymentReleased(event: PaymentReleased): void {
  const job = getJob(jobEntityId(contextChainId(), event.address, event.params.jobId));
  if (job == null) return;
  job.providerPayment = job.providerPayment.plus(event.params.amount);
  touchJob(job, event);
  markSettledIfPaid(job, event);
  job.save();

  const record = createJobEvent(event, job, 'PAYMENT_RELEASED');
  record.actor = getOrCreateAccount(event.params.provider).id;
  record.amount = event.params.amount;
  record.save();
}

export function handleEvaluatorFeePaid(event: EvaluatorFeePaid): void {
  const job = getJob(jobEntityId(contextChainId(), event.address, event.params.jobId));
  if (job == null) return;
  job.evaluatorFeePaid = job.evaluatorFeePaid.plus(event.params.amount);
  touchJob(job, event);
  job.save();

  const record = createJobEvent(event, job, 'EVALUATOR_FEE_PAID');
  record.actor = getOrCreateAccount(event.params.evaluator).id;
  record.amount = event.params.amount;
  record.save();
}

export function handleRefunded(event: Refunded): void {
  const job = getJob(jobEntityId(contextChainId(), event.address, event.params.jobId));
  if (job == null) return;
  job.refundedAmount = job.refundedAmount.plus(event.params.amount);
  touchJob(job, event);
  job.save();
  recordRefund(job, event.params.amount, event);

  const record = createJobEvent(event, job, 'REFUNDED');
  record.actor = getOrCreateAccount(event.params.client).id;
  record.amount = event.params.amount;
  record.save();
}

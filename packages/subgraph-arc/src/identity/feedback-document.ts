import { BigDecimal, Bytes, crypto, JSONValue, json, TypedMap } from '@graphprotocol/graph-ts';

import {
  FeedbackAttachment,
  FeedbackDocument,
  FeedbackDocumentFeature,
  PaymentProof,
} from '../../generated/schema';
import {
  asObject,
  asObjectArray,
  asString,
  asStringArray,
  asStringOrNumber,
  asWholeBigInt,
  asWholeI32,
  isDecimalString,
} from '../shared/json';
import { classifyUri, decodeDataUri, URI_KIND_DATA } from '../shared/uri';

/**
 * Parses a `data:` feedbackURI (or responseURI) into a `FeedbackDocument`
 * entity tree, following the community 8004scan feedback data profile. It
 * accepts both the profile's flat `skill`/`domain`/`capability` fields and
 * the nested `a2a`/`oasf`/`mcp` fields described in README.md, and maps them
 * to `FeedbackDocumentFeature` rows. Returns the entity's ID, or null when
 * `sourceURIKind` is not `DATA` or the payload cannot be parsed as a JSON
 * object.
 *
 * The ID is keccak256(feedback entity ID + source URI), so two feedback
 * records may reuse one URI without sharing a document entity, and `feedback`
 * is a true 1-to-1 back-reference.
 *
 * As with `resolveAgentRegistration`, the content is entirely
 * client-controlled, so every read goes through the guarded helpers in
 * `../utils/json.ts`.
 */
export function resolveFeedbackDocument(
  feedbackId: Bytes,
  sourceURI: string,
  sourceURIKind: string
): Bytes | null {
  if (sourceURIKind != URI_KIND_DATA) return null;

  const rawJSON = decodeDataUri(sourceURI);
  if (rawJSON == null) return null;

  const id = Bytes.fromByteArray(crypto.keccak256(feedbackId.concat(Bytes.fromUTF8(sourceURI))));
  if (FeedbackDocument.load(id) != null) return id;

  const parsed = json.try_fromString(rawJSON!);
  if (!parsed.isOk) return null;
  const obj = asObject(parsed.value);
  if (obj == null) return null;

  const document = new FeedbackDocument(id);
  document.feedback = feedbackId;
  document.sourceURI = sourceURI;
  document.sourceURIKind = sourceURIKind;
  document.contentHash = Bytes.fromByteArray(crypto.keccak256(Bytes.fromUTF8(rawJSON!)));
  document.rawJSON = rawJSON!;

  document.agentRegistry = asString(obj.get('agentRegistry'));
  document.agentId = asWholeBigInt(obj.get('agentId'));
  document.clientAddress = asString(obj.get('clientAddress'));
  document.createdAt = asString(obj.get('createdAt'));

  const value = asString(obj.get('value'));
  if (value != null && isDecimalString(value!)) document.value = BigDecimal.fromString(value!);
  const valueDecimals = asWholeI32(obj.get('valueDecimals'), 0, 18);
  if (valueDecimals.present) document.valueDecimals = valueDecimals.value;

  document.tag1 = asString(obj.get('tag1'));
  document.tag2 = asString(obj.get('tag2'));
  document.endpoint = asString(obj.get('endpoint'));
  document.reasoning = asString(obj.get('reasoning'));
  document.context = asString(obj.get('context'));
  document.task = asString(obj.get('task'));

  const a2a = asObject(obj.get('a2a'));
  document.a2aContextId =
    a2a != null
      ? firstNonNull(asString(a2a.get('contextId')), asString(obj.get('a2aContextId')))
      : asString(obj.get('a2aContextId'));
  document.a2aTaskId =
    a2a != null
      ? firstNonNull(asString(a2a.get('taskId')), asString(obj.get('a2aTaskId')))
      : asString(obj.get('a2aTaskId'));

  // PaymentProof is 1:1 with its document and reuses the document's ID, so
  // the reference can be set before the first (and only) save.
  const paymentProof = asObject(obj.get('proofOfPayment'));
  if (paymentProof != null) document.proofOfPayment = id;

  document.save();

  if (paymentProof != null) savePaymentProof(id, paymentProof);

  const attachments = asObjectArray(obj.get('attachments'));
  for (let i = 0; i < attachments.length; i++) {
    saveAttachment(id, i, attachments[i]);
  }

  saveFeatures(id, obj, a2a);

  return id;
}

function saveFeatures(
  documentId: Bytes,
  obj: TypedMap<string, JSONValue>,
  a2a: TypedMap<string, JSONValue> | null
): i32 {
  let position = 0;

  const oasf = asObject(obj.get('oasf'));
  const mcp = asObject(obj.get('mcp'));

  if (a2a != null)
    position = saveFeatureList(documentId, position, 'A2A_SKILL', listOfStrings(a2a, 'skills'));
  if (oasf != null) {
    position = saveFeatureList(documentId, position, 'OASF_SKILL', listOfStrings(oasf, 'skills'));
    position = saveFeatureList(documentId, position, 'OASF_DOMAIN', listOfStrings(oasf, 'domains'));
  }

  const flatDomain = asString(obj.get('domain'));
  if (flatDomain != null) position = saveFeature(documentId, position, 'OASF_DOMAIN', flatDomain!);

  const flatSkill = asString(obj.get('skill'));
  if (flatSkill != null) position = saveFeature(documentId, position, 'SKILL', flatSkill!);

  const flatCapability = asString(obj.get('capability'));
  if (flatCapability != null)
    position = saveFeature(documentId, position, 'MCP_CAPABILITY', flatCapability!);

  if (mcp != null) {
    const tool = asString(mcp.get('tool'));
    if (tool != null) position = saveFeature(documentId, position, 'MCP_TOOL', tool!);
    const prompt = asString(mcp.get('prompt'));
    if (prompt != null) position = saveFeature(documentId, position, 'MCP_PROMPT', prompt!);
    const resource = asString(mcp.get('resource'));
    if (resource != null) position = saveFeature(documentId, position, 'MCP_RESOURCE', resource!);
    const completion = asString(mcp.get('completion'));
    if (completion != null)
      position = saveFeature(documentId, position, 'MCP_COMPLETION', completion!);
  }

  return position;
}

function saveFeature(documentId: Bytes, position: i32, kind: string, value: string): i32 {
  const feature = new FeedbackDocumentFeature(documentId.concatI32(position));
  feature.document = documentId;
  feature.position = position;
  feature.kind = kind;
  feature.value = value;
  feature.save();
  return position + 1;
}

function saveFeatureList(
  documentId: Bytes,
  startPosition: i32,
  kind: string,
  values: Array<string>
): i32 {
  let position = startPosition;
  for (let i = 0; i < values.length; i++) {
    position = saveFeature(documentId, position, kind, values[i]);
  }
  return position;
}

function listOfStrings(obj: TypedMap<string, JSONValue>, key: string): Array<string> {
  return asStringArray(obj.get(key));
}

function savePaymentProof(documentId: Bytes, proof: TypedMap<string, JSONValue>): void {
  const entity = new PaymentProof(documentId);
  entity.document = documentId;
  entity.fromAddress = asString(proof.get('fromAddress'));
  entity.toAddress = asString(proof.get('toAddress'));
  entity.chainId = asStringOrNumber(proof.get('chainId'));
  entity.transactionHash = firstNonNull(
    asString(proof.get('txHash')),
    asString(proof.get('transactionHash'))
  );
  entity.transactionSignature = firstNonNull(
    asString(proof.get('txSignature')),
    asString(proof.get('transactionSignature'))
  );
  entity.amount = asString(proof.get('amount'));
  entity.currency = asString(proof.get('currency'));
  entity.protocol = asString(proof.get('protocol'));
  entity.timestamp = asString(proof.get('timestamp'));
  const decimals = asWholeI32(proof.get('decimals'), 0, 255);
  if (decimals.present) entity.decimals = decimals.value;
  entity.save();
}

function saveAttachment(
  documentId: Bytes,
  position: i32,
  attachment: TypedMap<string, JSONValue>
): void {
  const name = asString(attachment.get('name'));
  const uri = asString(attachment.get('uri'));
  const mimeType = asString(attachment.get('mimeType'));
  if (name == null || uri == null || mimeType == null) return;

  const entity = new FeedbackAttachment(documentId.concatI32(position));
  entity.document = documentId;
  entity.position = position;
  entity.name = name!;
  entity.uri = uri!;
  entity.uriKind = classifyUri(uri!);
  entity.mimeType = mimeType!;
  entity.size = asWholeBigInt(attachment.get('size'));
  entity.description = asString(attachment.get('description'));
  entity.uploadedAt = asString(attachment.get('uploadedAt'));
  entity.save();
}

function firstNonNull(a: string | null, b: string | null): string | null {
  return a != null ? a : b;
}

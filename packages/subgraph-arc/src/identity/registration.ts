import { Bytes, crypto, JSONValue, json, TypedMap } from '@graphprotocol/graph-ts';

import {
  AgentRegistration,
  AgentRegistrationReference,
  AgentService,
  AgentServiceAttribute,
  AgentServiceFeature,
  AgentTrust,
} from '../../generated/schema';
import { parseCaip10 } from '../shared/caip';
import {
  asBool,
  asObject,
  asObjectArray,
  asString,
  asStringArray,
  asWholeBigInt,
  describeJsonValue,
} from '../shared/json';
import { decodeDataUri, URI_KIND_DATA } from '../shared/uri';

/**
 * Parses a `data:` agentURI into an `AgentRegistration` entity tree, following
 * the community 8004scan agent metadata profile (services, supportedTrust,
 * registrations). Returns the entity's ID, or null when `sourceURIKind` is
 * not `DATA` or the payload cannot be parsed as a JSON object.
 *
 * The ID is keccak256(agent entity ID + source URI), so each agent owns its
 * own copy of the parsed document and `agent` is a true 1-to-1 back-reference,
 * while the same agent re-announcing an identical URI reuses the entity.
 *
 * The content is entirely agent-controlled, so nothing here trusts its shape:
 * every read goes through the guarded helpers in `../utils/json.ts`, and a
 * malformed document simply yields null instead of a partial or crashed
 * handler.
 */
export function resolveAgentRegistration(
  agentId: Bytes,
  sourceURI: string,
  sourceURIKind: string
): Bytes | null {
  if (sourceURIKind != URI_KIND_DATA) return null;

  const rawJSON = decodeDataUri(sourceURI);
  if (rawJSON == null) return null;

  const id = Bytes.fromByteArray(crypto.keccak256(agentId.concat(Bytes.fromUTF8(sourceURI))));
  if (AgentRegistration.load(id) != null) return id;

  const parsed = json.try_fromString(rawJSON!);
  if (!parsed.isOk) return null;
  const obj = asObject(parsed.value);
  if (obj == null) return null;

  const registration = new AgentRegistration(id);
  registration.agent = agentId;
  registration.sourceURI = sourceURI;
  registration.sourceURIKind = sourceURIKind;
  registration.contentHash = Bytes.fromByteArray(crypto.keccak256(Bytes.fromUTF8(rawJSON!)));
  registration.rawJSON = rawJSON!;
  registration.profileType = asString(obj.get('type'));
  registration.name = asString(obj.get('name'));
  registration.description = asString(obj.get('description'));
  registration.image = asString(obj.get('image'));

  const active = asBool(obj.get('active'));
  if (active.present) registration.active = active.value;
  const x402Support = asBool(obj.get('x402Support'));
  if (x402Support.present) registration.x402Support = x402Support.value;

  // EIP-8004 renamed `endpoints` to `services` in January 2026; accept both,
  // preferring `services` when a document somehow has both.
  const servicesField = obj.get('services');
  const usedServices = servicesField != null && !servicesField.isNull();
  registration.usedLegacyEndpointsField = !usedServices && obj.get('endpoints') != null;
  const servicesValue = usedServices ? servicesField : obj.get('endpoints');

  const services = asObjectArray(servicesValue);
  for (let i = 0; i < services.length; i++) {
    saveAgentService(registration.id, i, services[i]);
  }

  const registrations = asObjectArray(obj.get('registrations'));
  for (let i = 0; i < registrations.length; i++) {
    saveAgentRegistrationReference(registration.id, i, registrations[i]);
  }

  const supportedTrust = asStringArray(obj.get('supportedTrust'));
  for (let i = 0; i < supportedTrust.length; i++) {
    saveAgentTrust(registration.id, i, supportedTrust[i]);
  }

  registration.save();
  return id;
}

function saveAgentService(
  registrationId: Bytes,
  position: i32,
  service: TypedMap<string, JSONValue>
): void {
  const name = asString(service.get('name'));
  const endpoint = asString(service.get('endpoint'));
  if (name == null || endpoint == null) return;

  const entity = new AgentService(registrationId.concatI32(position));
  entity.registration = registrationId;
  entity.position = position;
  entity.kind = classifyServiceKind(name!);
  entity.name = name!;
  entity.endpoint = endpoint!;
  entity.version = asString(service.get('version'));
  // Every feature and attribute below comes from an explicit document field;
  // this parser never guesses at capabilities, so it is always false.
  entity.capabilitiesInferred = false;
  entity.save();

  let featurePosition = 0;
  featurePosition = saveServiceFeatures(
    entity.id,
    featurePosition,
    'CAPABILITY',
    asStringArray(service.get('capabilities'))
  );
  featurePosition = saveServiceFeatures(
    entity.id,
    featurePosition,
    'MCP_TOOL',
    asStringArray(service.get('mcpTools'))
  );
  featurePosition = saveServiceFeatures(
    entity.id,
    featurePosition,
    'MCP_PROMPT',
    asStringArray(service.get('mcpPrompts'))
  );
  featurePosition = saveServiceFeatures(
    entity.id,
    featurePosition,
    'MCP_RESOURCE',
    asStringArray(service.get('mcpResources'))
  );
  featurePosition = saveServiceFeatures(
    entity.id,
    featurePosition,
    'A2A_SKILL',
    asStringArray(service.get('a2aSkills'))
  );
  featurePosition = saveServiceFeatures(
    entity.id,
    featurePosition,
    'OASF_SKILL',
    asStringArray(service.get('skills'))
  );
  saveServiceFeatures(
    entity.id,
    featurePosition,
    'OASF_DOMAIN',
    asStringArray(service.get('domains'))
  );

  saveServiceAttributes(entity.id, service);
}

function saveServiceFeatures(
  serviceId: Bytes,
  startPosition: i32,
  kind: string,
  values: Array<string>
): i32 {
  let position = startPosition;
  for (let i = 0; i < values.length; i++) {
    const feature = new AgentServiceFeature(serviceId.concatI32(position));
    feature.service = serviceId;
    feature.position = position;
    feature.kind = kind;
    feature.value = values[i];
    feature.save();
    position++;
  }
  return position;
}

// Every other service key, including description and method, becomes a
// forward-compatible attribute so custom or future service fields are not
// silently dropped.
const KNOWN_SERVICE_KEYS = [
  'name',
  'endpoint',
  'version',
  'capabilities',
  'mcpTools',
  'mcpPrompts',
  'mcpResources',
  'a2aSkills',
  'skills',
  'domains',
];

function saveServiceAttributes(serviceId: Bytes, service: TypedMap<string, JSONValue>): void {
  let position = 0;
  for (let i = 0; i < service.entries.length; i++) {
    const key = service.entries[i].key;
    if (KNOWN_SERVICE_KEYS.includes(key)) continue;

    const described = describeJsonValue(service.entries[i].value);
    const attribute = new AgentServiceAttribute(serviceId.concatI32(position));
    attribute.service = serviceId;
    attribute.position = position;
    attribute.key = key;
    attribute.value = described.value;
    attribute.valueType = described.valueType;
    attribute.save();
    position++;
  }
}

function saveAgentRegistrationReference(
  registrationId: Bytes,
  position: i32,
  reference: TypedMap<string, JSONValue>
): void {
  const agentRegistry = asString(reference.get('agentRegistry'));
  if (agentRegistry == null) return;

  const caip10 = parseCaip10(agentRegistry!);

  const entity = new AgentRegistrationReference(registrationId.concatI32(position));
  entity.registration = registrationId;
  entity.position = position;
  entity.agentRegistry = agentRegistry!;
  entity.namespace = caip10.namespace;
  entity.chainId = caip10.chainId;
  entity.registryAddress = caip10.reference;
  entity.agentId = asWholeBigInt(reference.get('agentId'));
  entity.save();
}

function saveAgentTrust(registrationId: Bytes, position: i32, name: string): void {
  const entity = new AgentTrust(registrationId.concatI32(position));
  entity.registration = registrationId;
  entity.position = position;
  entity.kind = classifyTrustKind(name);
  entity.name = name;
  entity.save();
}

function classifyServiceKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower == 'web') return 'WEB';
  if (lower == 'a2a') return 'A2A';
  if (lower == 'mcp') return 'MCP';
  if (lower == 'webmcp') return 'WEBMCP';
  if (lower == 'x402') return 'X402';
  if (lower == 'oasf') return 'OASF';
  if (lower == 'ens') return 'ENS';
  if (lower == 'did') return 'DID';
  if (lower == 'email') return 'EMAIL';
  if (lower == 'agentwallet') return 'AGENT_WALLET';
  return 'CUSTOM';
}

function classifyTrustKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower == 'reputation') return 'REPUTATION';
  if (lower == 'crypto-economic') return 'CRYPTO_ECONOMIC';
  if (lower == 'tee-attestation') return 'TEE_ATTESTATION';
  if (lower == 'social-graph') return 'SOCIAL_GRAPH';
  return 'CUSTOM';
}

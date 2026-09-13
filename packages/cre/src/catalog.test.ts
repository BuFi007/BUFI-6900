import {
  CRE_CONTROL_PLANE_AUDIT,
  CRE_NETWORK_CATALOG,
  CRE_PRODUCTION_FORWARDERS,
  CRE_RECEIVER_DEPLOYMENT_PREFLIGHTS,
  CRE_RECEIVER_DEPLOYMENTS,
  CRE_TENANT_CHAIN_AUDIT,
  CRE_WORKFLOW_CATALOG,
  CRE_WORKFLOW_DEPLOYMENTS,
  creReceiverDeployment,
} from './catalog';
import {
  ATTESTATION_CONTRACTS,
  ATTESTATION_OP_TYPES,
  CRE_CHAIN_SELECTORS,
  CRE_RECEIVER_ADDRESSES,
  type CREChainSelector,
} from './constants';
import { describe, expect, test } from 'bun:test';

describe('CRE workflow catalog', () => {
  test('keeps the authenticated tenant chain audit testnet-only and catalog-bound', () => {
    expect(CRE_TENANT_CHAIN_AUDIT.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.isNaN(Date.parse(CRE_TENANT_CHAIN_AUDIT.verifiedAt))).toBe(false);

    const catalogSelectors = CRE_NETWORK_CATALOG.map(network => network.selector);
    const enabledSelectors = CRE_TENANT_CHAIN_AUDIT.enabledSelectors;

    expect(new Set(catalogSelectors).size).toBe(catalogSelectors.length);
    expect(new Set(enabledSelectors).size).toBe(enabledSelectors.length);
    expect([...enabledSelectors].sort()).toEqual([...catalogSelectors].sort());
    expect(CRE_NETWORK_CATALOG.map(network => network.chainId).sort()).toEqual(
      [11155111, 43113, 84532, 421614, 80002].sort()
    );
    expect(CRE_TENANT_CHAIN_AUDIT.reason).toContain('not receiver deployment');
    expect(CRE_TENANT_CHAIN_AUDIT.reason).toContain('listing approval');
  });

  test('keeps authenticated control-plane evidence separate from deployment readiness', () => {
    expect(CRE_CONTROL_PLANE_AUDIT).toMatchObject({
      deploymentAccess: 'request_submitted',
      registryWorkflowCount: 0,
      cliVersion: '1.23.0',
      registryVerifiedAt: '2026-07-19T05:55:30.525Z',
    });
    expect(CRE_WORKFLOW_DEPLOYMENTS).toEqual([]);
  });

  test('uses declared networks and never promotes retired or external flows', () => {
    const selectors = new Set(CRE_NETWORK_CATALOG.map(network => network.selector));
    for (const workflow of CRE_WORKFLOW_CATALOG) {
      expect(workflow.networks.every(selector => selectors.has(selector))).toBe(true);
      if (workflow.readiness === 'simulation_verified') {
        expect(workflow.owner).toBe('desk');
        expect(workflow.networks.length).toBeGreaterThan(0);
      }
      if (workflow.readiness === 'fixture_verified') {
        expect(workflow.owner).toBe('desk');
        expect(workflow.networks.length).toBeGreaterThan(0);
      }
      if (workflow.owner === 'external') {
        expect(workflow.readiness).not.toBe('simulation_verified');
      }
    }
  });

  test('keeps receiver deployment preflights explicit, non-broadcast, and network-correct', () => {
    expect(CRE_RECEIVER_DEPLOYMENT_PREFLIGHTS).toHaveLength(3);
    const selectors = new Set<string>();
    for (const preflight of CRE_RECEIVER_DEPLOYMENT_PREFLIGHTS) {
      expect(selectors.has(preflight.selector)).toBe(false);
      selectors.add(preflight.selector);
      expect(preflight.status).toBe('dry_run_succeeded');
      expect(preflight.broadcast).toBe(false);
      expect(preflight.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(preflight.gasEstimate).toBeGreaterThan(0);
      const expectedForwarder = CRE_PRODUCTION_FORWARDERS[preflight.selector];
      if (!expectedForwarder) throw new Error(`Missing forwarder for ${preflight.selector}`);
      expect(preflight.forwarderAddress).toBe(expectedForwarder);
      expect(
        CRE_NETWORK_CATALOG.find(network => network.selector === preflight.selector)?.chainId
      ).toBe(preflight.chainId);
    }
  });

  test('keeps checked workflow deployments unique and tied to declared networks', () => {
    const keys = new Set<string>();
    for (const deployment of CRE_WORKFLOW_DEPLOYMENTS) {
      const key = `${deployment.workflow}:${deployment.selector}:${deployment.target}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      expect(
        CRE_WORKFLOW_CATALOG.some(
          workflow =>
            workflow.name === deployment.workflow &&
            workflow.owner === 'desk' &&
            workflow.networks.includes(deployment.selector)
        )
      ).toBe(true);
      expect(deployment.configDigest).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(deployment.workflowId.length).toBeGreaterThan(0);
      expect(deployment.reason.length).toBeGreaterThan(0);
    }
  });
});

/*
 * Copyright (c) 2026, BUFI. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { zeroHash } from 'viem'

import { buildBufiGrant } from '../actions/plugins/sessionKey/buildBufiGrant'
import { encodeAddSessionKey } from '../actions/plugins/sessionKey/encodeAddSessionKey'
import { encodeInstallSessionKeyPlugin } from '../actions/plugins/sessionKey/encodeInstallSessionKeyPlugin'

import type {
  BufiGrant,
  EncodedCall,
  SessionKeyRegistration,
  StackDeployment,
} from '../types'
import type { Address, Hex } from 'viem'

export interface AgentGrant {
  /**
   * The session key the agent signs with.
   */
  sessionKey: Address
  /**
   * An optional 32-byte tag identifying the key (for example a hash of the agent id). Defaults to zero.
   */
  tag?: Hex
  /**
   * The policy the key operates under. See {@link BufiGrant}.
   */
  grant: BufiGrant
}

export interface BuildAgentFaceCallsParameters {
  /**
   * The agent modular smart contract account.
   */
  account: Address
  /**
   * The agents to authorize.
   */
  agents: readonly AgentGrant[]
  /**
   * The stack deployment. Must carry `bufiSessionKey`.
   */
  deployment: StackDeployment
}

export interface AgentFaceCalls {
  /**
   * Submit this (alone, in its own user operation) when the session key plugin is NOT yet installed: it installs the
   * plugin and seeds every agent key through the install data.
   */
  installSessionKeyPlugin: EncodedCall
  /**
   * Submit these when the session key plugin IS already installed: one `addSessionKey` call per agent. They are all
   * owner-validated plugin execution functions, so they may share one user operation.
   */
  addSessionKeys: EncodedCall[]
  /**
   * The compiled registrations, useful for persisting the policy that was granted.
   */
  registrations: SessionKeyRegistration[]
}

/**
 * Builds the calls that turn an account into a BUFI agent face: an account whose agents act through session keys
 * under an explicit `{ scope, budget, expiry }` policy.
 *
 * Which output to submit depends on `getInstalledPlugins`: read it first, and never assume the plugin is installed
 * because an install was built or submitted earlier. Plugin installs stay one per user operation and must follow,
 * never share, the user operation that re-weights the owners (see `buildTreasuryBootstrapCalls`).
 * @param parameters - Parameters to use. See {@link BuildAgentFaceCallsParameters}.
 * @returns The calls. See {@link AgentFaceCalls}.
 * @throws Error if the deployment has no session key plugin or a grant is invalid.
 */
export function buildAgentFaceCalls({
  account,
  agents,
  deployment,
}: BuildAgentFaceCallsParameters): AgentFaceCalls {
  const registrations = agents.map((agent) => ({
    sessionKey: agent.sessionKey,
    tag: agent.tag ?? zeroHash,
    permissionUpdates: buildBufiGrant(agent.grant),
  }))

  return {
    installSessionKeyPlugin: encodeInstallSessionKeyPlugin({
      account,
      registrations,
      deployment,
    }),
    addSessionKeys: registrations.map((registration) => ({
      to: account,
      value: 0n,
      data: encodeAddSessionKey(registration),
    })),
    registrations,
  }
}

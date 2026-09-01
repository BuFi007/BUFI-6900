/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
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

import { encodeAbiParameters, encodeFunctionData } from 'viem'

import { INITIALIZING_DATA_ABI_PARAMS } from '../../abis'
import { CIRCLE_CANONICAL_DEPLOYMENT, UPGRADABLE_MSCA } from '../../constants'

import { getPluginInstallParams } from './getPluginInstallParams'

import type { StackDeployment } from '../../types'
import type { Hex, LocalAccount } from 'viem'
import type { WebAuthnAccount } from 'viem/account-abstraction'

/**
 * Gets the encoded initializeUpgradableMSCA function data from an owner.
 * @param owner - The owner.
 * @param deployment - The stack deployment whose ownership plugin is installed. Defaults to the canonical Circle
 * deployment. BUFI modification.
 * @returns The encoded initializeUpgradableMSCA function data.
 */
export function getInitializeUpgradableMSCAData(
  owner: WebAuthnAccount | LocalAccount,
  deployment: StackDeployment = CIRCLE_CANONICAL_DEPLOYMENT,
): Hex {
  const pluginInstallParams = getPluginInstallParams(owner)

  return encodeFunctionData({
    abi: UPGRADABLE_MSCA.abi,
    functionName: 'initializeUpgradableMSCA',
    args: [
      [deployment.weightedWebauthnMultisig.address],
      [deployment.weightedWebauthnMultisig.manifestHash],
      [pluginInstallParams],
    ],
  })
}

/**
 * Gets the encoded initializeUpgradableMSCA function parameters from an owner.
 * @param owner - The owner.
 * @param deployment - The stack deployment whose ownership plugin is installed. Defaults to the canonical Circle
 * deployment. BUFI modification.
 * @returns The encoded initializeUpgradableMSCA function parameters.
 */
export function getInitializeUpgradableMSCAParams(
  owner: LocalAccount | WebAuthnAccount,
  deployment: StackDeployment = CIRCLE_CANONICAL_DEPLOYMENT,
): Hex {
  const pluginInstallParams = getPluginInstallParams(owner)

  return encodeAbiParameters(INITIALIZING_DATA_ABI_PARAMS, [
    [deployment.weightedWebauthnMultisig.address],
    [deployment.weightedWebauthnMultisig.manifestHash],
    [pluginInstallParams],
  ])
}

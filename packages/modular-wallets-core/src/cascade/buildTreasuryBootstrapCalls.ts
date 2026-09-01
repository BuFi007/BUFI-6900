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

import { encodeInstallAddressBook } from '../actions/plugins/addressBook/encodeInstallAddressBook'
import { encodeUpdateMultisigWeights } from '../actions/plugins/weightedMultisig/encodeUpdateMultisigWeights'
import { CIRCLE_CANONICAL_DEPLOYMENT } from '../constants'

import type { EncodeUpdateMultisigWeightsParameters } from '../actions/plugins/weightedMultisig/encodeUpdateMultisigWeights'
import type { EncodedCall, StackDeployment } from '../types'
import type { Address } from 'viem'

export interface BuildTreasuryBootstrapCallsParameters {
  /**
   * The treasury modular smart contract account.
   */
  account: Address
  /**
   * The final owner weights and threshold. See {@link EncodeUpdateMultisigWeightsParameters}.
   */
  weights: EncodeUpdateMultisigWeightsParameters
  /**
   * The initial transfer allowlist: typically the operations wallet plus every member's individual wallet.
   */
  allowedRecipients: readonly Address[]
  /**
   * The stack deployment. Defaults to the canonical Circle deployment.
   */
  deployment?: StackDeployment
}

export interface TreasuryBootstrapCalls {
  /**
   * Submit 1: re-weights the bootstrap signer to the treasury's final weights and threshold.
   */
  updateMultisigWeights: EncodedCall
  /**
   * Submit 2: installs the ColdStorageAddressBookPlugin seeded with the initial allowlist.
   */
  installAddressBook: EncodedCall
}

/**
 * Builds the two user operations that turn a freshly deployed account into a BUFI treasury face.
 *
 * They MUST be submitted as two separate user operations, in this order, never batched into one. The re-weighting
 * changes the ownership plugin's validation state for the account, and a plugin whose manifest depends on that
 * validation (the address book) is wired to it at install time: installing in the same user operation that
 * re-weights would be validated by the old weights and could leave the install bound to a configuration the
 * treasury never approved. The address book only gates ERC-20/721/1155 transfer recipients; it does not gate owner
 * changes, so signers who join after this bootstrap are unaffected.
 * @param parameters - Parameters to use. See {@link BuildTreasuryBootstrapCallsParameters}.
 * @returns The calls in submit order. See {@link TreasuryBootstrapCalls}.
 */
export function buildTreasuryBootstrapCalls({
  account,
  weights,
  allowedRecipients,
  deployment = CIRCLE_CANONICAL_DEPLOYMENT,
}: BuildTreasuryBootstrapCallsParameters): TreasuryBootstrapCalls {
  return {
    updateMultisigWeights: {
      to: account,
      value: 0n,
      data: encodeUpdateMultisigWeights(weights),
    },
    installAddressBook: encodeInstallAddressBook({
      account,
      recipients: allowedRecipients,
      deployment,
    }),
  }
}

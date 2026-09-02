/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ARC_TESTNET_DEPLOYMENT,
  AVAX_FUJI_DEPLOYMENT,
  BUFI_TESTNET_PLUGINS,
  CIRCLE_CANONICAL_DEPLOYMENT,
} from '../../constants'
import { toStackDeployment } from '../../utils/deployment'

const REPO_ROOT = resolve(__dirname, '../../../../..')

describe('testnet deployments', () => {
  it.each([
    ['avax-fuji', AVAX_FUJI_DEPLOYMENT, 43113],
    ['arc-testnet', ARC_TESTNET_DEPLOYMENT, 5042002],
  ])(
    '%s constant equals contracts/deployments/%s.json',
    (name, constant, chainId) => {
      const json = JSON.parse(
        readFileSync(
          resolve(REPO_ROOT, `contracts/deployments/${name}.json`),
          'utf8',
        ),
      ) as unknown
      const fromFile = toStackDeployment(json)
      expect(constant.chainId).toBe(chainId)
      expect(fromFile.upgradableMscaFactory).toBe(
        constant.upgradableMscaFactory,
      )
      expect(fromFile.bufiSessionKey).toEqual(constant.bufiSessionKey)
      expect(fromFile.bufiEarnModule).toEqual(constant.bufiEarnModule)
      expect(fromFile.weightedWebauthnMultisig).toEqual(
        constant.weightedWebauthnMultisig,
      )
    },
  )

  it('keeps the Circle canonical stack unchanged on testnets', () => {
    for (const d of [AVAX_FUJI_DEPLOYMENT, ARC_TESTNET_DEPLOYMENT]) {
      expect(d.entryPoint).toBe(CIRCLE_CANONICAL_DEPLOYMENT.entryPoint)
      expect(d.pluginManager).toBe(CIRCLE_CANONICAL_DEPLOYMENT.pluginManager)
      expect(d.upgradableMsca).toBe(CIRCLE_CANONICAL_DEPLOYMENT.upgradableMsca)
      expect(d.coldStorageAddressBook).toEqual(
        CIRCLE_CANONICAL_DEPLOYMENT.coldStorageAddressBook,
      )
    }
  })

  it('pins the same plugin addresses on every chain (CREATE2)', () => {
    expect(AVAX_FUJI_DEPLOYMENT.bufiSessionKey).toEqual(
      BUFI_TESTNET_PLUGINS.bufiSessionKey,
    )
    expect(ARC_TESTNET_DEPLOYMENT.bufiSessionKey).toEqual(
      BUFI_TESTNET_PLUGINS.bufiSessionKey,
    )
  })
})

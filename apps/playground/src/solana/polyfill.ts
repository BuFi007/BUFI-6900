/*
 * Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * web3.js 1.x and spl-token expect Node's Buffer as a global. Imported first by the Solana view.
 */
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer
